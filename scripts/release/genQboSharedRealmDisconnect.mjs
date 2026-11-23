#!/usr/bin/env node
// Generates 20261231400000_qbo_shared_realm_local_disconnect.sql from the reviewed text of Phase C v2 part 2 (20261231200000).
// The new qbo_begin_disconnect body is derived from the installed (pinned) body by exact, single-occurrence edits; nothing is retyped by hand.
//   node scripts/release/genQboSharedRealmDisconnect.mjs           (writes the migration)
//   node scripts/release/genQboSharedRealmDisconnect.mjs --check   (regenerates in memory; fails if the committed file differs)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const SOURCE = "20261231200000_qbo_realm_protection_cutover_functions.sql";
export const TARGET = "20261231400000_qbo_shared_realm_local_disconnect.sql";
const FN = "public.qbo_begin_disconnect(uuid,uuid,uuid)";
// The body Phase C v2 part 2 installed (hosted 121, verified by the stage check on 2026-11-22/23).
export const OLD_DIGEST = "3782a5b866900544e5d680125d5a775573bb1861a57d4d8c439555a4f0f68f9e";
const bar = "-- " + "═".repeat(137);
const once = (s, a, b) => { if (s.split(a).length !== 2) throw new Error(`expected exactly one: ${a.slice(0, 80)}`); return s.replace(a, b); };

/** The reviewed part 2 definition of qbo_begin_disconnect: its CREATE OR REPLACE header and its pinned body. */
function partTwo() {
  const src = fs.readFileSync(path.join(REPO, "supabase/migrations", SOURCE), "utf8");
  const start = src.indexOf("  CREATE OR REPLACE FUNCTION public.qbo_begin_disconnect(p_connection uuid,p_actor uuid,p_request uuid)");
  if (start < 0) throw new Error("qbo_begin_disconnect not found in part 2");
  const end = src.indexOf("END $f$;", start);
  const block = src.slice(start, end + "END $f$;".length);
  const header = block.slice(0, block.indexOf("$f$") + 3);
  const oldBody = block.slice(block.indexOf("$f$") + 3, block.lastIndexOf("$f$"));
  if (sha(oldBody) !== OLD_DIGEST) throw new Error(`part 2 body digest ${sha(oldBody)} is not the pinned ${OLD_DIGEST}`);
  return { header, oldBody };
}
/** SQL that reinstalls the reviewed part 2 body (for a rolled-back replay of the Phase C redaction, whose preflight pins it). */
export const partTwoDefinition = () => { const { header, oldBody } = partTwo(); return `${header}${oldBody}$f$;`; };

export function generate() {
  const { header, oldBody } = partTwo();

  let body = oldBody;
  body = once(body, "DECLARE c public.qbo_connections; o public.qbo_disconnect_operations; ticket uuid;",
    "DECLARE c public.qbo_connections; o public.qbo_disconnect_operations; ticket uuid; v_shared boolean; v_revoke boolean;");
  body = once(body,
    "   IF EXISTS(SELECT 1 FROM public.qbo_connections x WHERE x.id<>c.id AND x.realm_index=c.realm_index AND x.environment=c.environment AND x.status='active') THEN RETURN jsonb_build_object('outcome','shared_connection'); END IF;\n",
    "   -- [20261231400000] a realm another ACTIVE connection shares never blocks this workspace's disconnect (it used to answer 'shared_connection'\n" +
    "   -- for every sharer, so none could ever disconnect). The local disconnect always happens and this connection's token is destroyed; the\n" +
    "   -- revocation at Intuit, which ends the authorisation for EVERY connection to that QuickBooks company, is requested only by the last active\n" +
    "   -- connection. The answer is 'local_only', the same as for a connection that holds no token, so it never tells one workspace that another uses\n" +
    "   -- the same company. The per-realm lock taken above serialises sharers: exactly one of two simultaneous last disconnects sees no sharer.\n" +
    "   v_shared := EXISTS(SELECT 1 FROM public.qbo_connections x WHERE x.id<>c.id AND x.realm_index=c.realm_index AND x.environment=c.environment AND x.status='active');\n" +
    "   v_revoke := c.refresh_token_envelope IS NOT NULL AND NOT v_shared;\n");
  body = once(body,
    "   VALUES(c.id,p_request,p_actor,c.company_id,NULL,c.environment,c.refresh_token_envelope,CASE WHEN c.refresh_token_envelope IS NULL THEN 'local_only' ELSE 'pending' END,",
    "   VALUES(c.id,p_request,p_actor,c.company_id,NULL,c.environment,CASE WHEN v_revoke THEN c.refresh_token_envelope END,CASE WHEN v_revoke THEN 'pending' ELSE 'local_only' END,");
  body = once(body,
    "   RETURN jsonb_build_object('outcome',CASE WHEN c.refresh_token_envelope IS NULL THEN 'local_only' ELSE 'pending' END,'leaseId',ticket,'envelope',c.refresh_token_envelope,'companyId',c.company_id,",
    "   RETURN jsonb_build_object('outcome',CASE WHEN v_revoke THEN 'pending' ELSE 'local_only' END,'leaseId',CASE WHEN v_revoke THEN ticket END,'envelope',CASE WHEN v_revoke THEN c.refresh_token_envelope END,'companyId',c.company_id,");
  const newDigest = sha(body);
  const def = `${header}${body}$f$;`;

  const text = `${bar}
-- 20261231400000 — QuickBooks: a shared QuickBooks company no longer blocks a disconnect (launch blocker B1, sandbox acceptance 2026-11-23).
-- AUTHORED, NOT APPLIED. Changes no row by itself; replaces one function body.
--   WHY: qbo_begin_disconnect refused 'shared_connection' whenever another ACTIVE connection held the same QuickBooks company (equal keyed
--   index). With two or more such connections none could ever be disconnected, and no administrator path existed; the refusal also told one
--   workspace that another uses the same company. Intuit requires that a connection can always be disconnected.
--   WHAT IT DOES: qbo_begin_disconnect (same signature, SECURITY DEFINER, service role only) is replaced by the part 2 body with three edits:
--     · while another active connection shares the realm, the disconnect is LOCAL: the connection becomes 'disconnected', its refresh token is
--       destroyed, and the operation is recorded as 'local_only' with no pending envelope; nothing is sent to Intuit (a revocation there would
--       end the authorisation the other connection still uses);
--     · the last active connection's disconnect revokes at Intuit exactly as before ('pending' -> 'revoked');
--     · the answer for a shared realm is 'local_only', indistinguishable from a connection that holds no token.
--   UNCHANGED: the index-rotation refusal ('rotation_in_progress', checked first, so a sharer is never missed mid-rotation), request idempotency,
--   the per-realm lock, the realm protection copied to the operation (envelope + index, no plaintext), every table, guard and constraint.
--   No Edge Function change is required: qbo-disconnect already answers 'local_only' (HTTP 202) for that outcome.
-- SELF-VERIFYING: the installed body must be the reviewed part 2 body (${OLD_DIGEST.slice(0, 12)}…) or already this one (a replay is a no-op);
-- the result is pinned by SHA-256 together with its security attributes and grants; any difference fails the block and nothing changes.
-- Generated by scripts/release/genQboSharedRealmDisconnect.mjs from ${SOURCE}; regenerate, never hand-edit.
${bar}
DO $qbo_shared_realm_local_disconnect$
DECLARE
  v_old constant text := '${OLD_DIGEST}';
  v_new constant text := '${newDigest}';
  v_now text;
BEGIN
  v_now := (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('${FN}'));
  IF v_now = v_new THEN RETURN; END IF;   -- replay
  -- PREFLIGHT: Phase C v2 complete (the redaction's final rule present) and the reviewed part 2 body installed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_live_no_plaintext')
     OR to_regprocedure('public.qbo_index_key_mixed(text)') IS NULL OR v_now IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection Phase C v2 (all four parts) with the reviewed qbo_begin_disconnect body must be installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;

${def}

  -- POSTCONDITION: the body exactly as reviewed; SECURITY DEFINER with the fixed search_path; executable by the service role only.
  IF (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('${FN}')) IS DISTINCT FROM v_new
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('${FN}') AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'])
     OR has_function_privilege('authenticated', '${FN}', 'EXECUTE') OR has_function_privilege('anon', '${FN}', 'EXECUTE')
     OR NOT has_function_privilege('service_role', '${FN}', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the shared-realm local disconnect is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_shared_realm_local_disconnect$;
`;
  return { text, oldDigest: OLD_DIGEST, newDigest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { text, newDigest } = generate();
  const out = path.join(REPO, "supabase/migrations", TARGET);
  if (process.argv.includes("--check")) {
    const ok = fs.existsSync(out) && fs.readFileSync(out, "utf8") === text;
    console.log(ok ? `OK ${TARGET} matches its generator (body ${newDigest})` : `DIFFERS: ${TARGET} is not what the generator writes`);
    process.exit(ok ? 0 : 1);
  }
  fs.writeFileSync(out, text);
  console.log(`wrote ${TARGET}: ${Buffer.byteLength(text)} bytes, sha256 ${sha(text)}; new body ${newDigest}`);
}
