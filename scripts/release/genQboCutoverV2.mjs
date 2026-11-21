#!/usr/bin/env node
// Generates the three Phase C v2 cutover migrations (20261231100000-20261231300000) with every installed function body pinned by SHA-256.
// The bodies that Phase C v1 (PR #282, acdee94) installed are taken from its committed text and changed only where Phase C v2 requires; the
// fiscal wrapper's new body is derived from the body the real chain installs (a disposable local database), never guessed.
//   DB_PROOF_MODULES_DIR=<dir with embedded-postgres + pg> node scripts/release/genQboCutoverV2.mjs        (local; writes the three files)
//   ... genQboCutoverV2.mjs --check   (regenerates in memory and fails if a committed file differs)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDatabase, applyChainBefore, REPO } from "../db-proof/lib/reportingKit.mjs";

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const V1 = "acdee94";   // PR #282's cutover commit: the reviewed v1 text this generator starts from
const v1 = (f) => execFileSync("git", ["show", `${V1}:supabase/migrations/${f}`], { cwd: REPO, encoding: "utf8" });
const F1 = "20261231100000_qbo_realm_protection_cutover_schema.sql";
const F2 = "20261231200000_qbo_realm_protection_cutover_functions.sql";
const F2B = "20261231250000_qbo_realm_rotation_post_redaction.sql";
const F3 = "20261231300000_qbo_realm_protection_cutover_redaction.sql";
const bar = "-- " + "═".repeat(137);
// The hosted guards on journal 119 (20261230500000, verified read-only on 2026-11-20/21).
const HOSTED_GUARDS = { conn: "db305b361f0dfc402501a21437dfe7282cbe95769eef8e3d3a95dc162d38d0c8", ops: "819623c9a8339c85513f4acf0c922629d9438f844cd2a99f6ceaa19918f4ce69" };
const bodyOf = (block) => { const a = block.indexOf("$f$") + 3; return block.slice(a, block.lastIndexOf("$f$")); };
const between = (text, start, endMarker) => {
  const a = text.indexOf(start); if (a < 0) throw new Error(`not found: ${start.slice(0, 60)}`);
  const b = text.indexOf(endMarker, a); if (b < 0) throw new Error(`end not found after: ${start.slice(0, 60)}`);
  return text.slice(a, b + endMarker.length);
};
const once = (s, a, b) => { if (s.split(a).length !== 2) throw new Error(`expected exactly one: ${a.slice(0, 70)}`); return s.replace(a, b); };
// One compact check: true when any listed function's body digest differs from its pin (or the function is missing).
const pinsDiffer = (pins) => `EXISTS (SELECT 1 FROM (VALUES ${pins.map(([f, d]) => `('${f}', '${d}')`).join(",\n       ")}) v(f, d)
     WHERE (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure(v.f)) IS DISTINCT FROM v.d)`;
// The same check over pins declared once in the block (pinsDecl): keeps the reviewed list in one place and the file small.
const pinsDecl = (name, pins) => `  ${name}_f constant text[] := ARRAY[${pins.map(([f]) => `'${f}'`).join(",\n    ")}];
  ${name}_d constant text[] := ARRAY[${pins.map(([, d]) => `'${d}'`).join(",\n    ")}];`;
const pinsVar = (name) => `EXISTS (SELECT 1 FROM unnest(${name}_f, ${name}_d) v(f, d)
     WHERE (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure(v.f)) IS DISTINCT FROM v.d)`;
const digestOf = (fn) => `(SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('${fn}'))`;

// ── Part 1: guards (every earlier rule, the v1 redaction transition, the reseal and reindex transitions with monotonic key versions) ─────────
const KEY_VERSION = `
    SELECT CASE WHEN p_key_id ~ ('^' || p_kind || '[1-9][0-9]{0,8}$') THEN substring(p_key_id FROM length(p_kind) + 1)::integer END;
  `;
// Index-key homogeneity: true while any live connection or pending revocation carries an index made by a key other than p_key_id.
const MIXED = `
    SELECT EXISTS (SELECT 1 FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_index IS NOT NULL AND split_part(realm_index, '.', 2) IS DISTINCT FROM p_key_id)
        OR EXISTS (SELECT 1 FROM public.qbo_disconnect_operations WHERE outcome = 'pending' AND realm_index IS NOT NULL AND split_part(realm_index, '.', 2) IS DISTINCT FROM p_key_id);
  `;
const transitions = (who) => `
      -- [20261230400000/20261231100000] reseal: the envelope under a strictly NEWER token key, the index unchanged, a fresh verification;
      -- [20261230500000/20261231100000] reindex: the index under a strictly NEWER index key, the envelope unchanged, a fresh verification.
      IF NOT coalesce(
           (coalesce(current_setting('qbo.realm_reseal', true), '') = '${who}'
            AND OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS NOT NULL
            AND public.qbo_key_version(split_part(NEW.realm_envelope, '.', 2), 'k') > public.qbo_key_version(split_part(OLD.realm_envelope, '.', 2), 'k')
            AND NEW.realm_index IS NOT DISTINCT FROM OLD.realm_index AND NEW.realm_verified_at IS NOT NULL)
        OR (coalesce(current_setting('qbo.realm_reindex', true), '') = '${who}'
            AND OLD.realm_index IS NOT NULL AND NEW.realm_index IS NOT NULL
            AND public.qbo_key_version(split_part(NEW.realm_index, '.', 2), 'idx') > public.qbo_key_version(split_part(OLD.realm_index, '.', 2), 'idx')
            AND NEW.realm_envelope IS NOT DISTINCT FROM OLD.realm_envelope AND NEW.realm_verified_at IS NOT NULL), false) THEN`;
const CONN_GUARD = `
  BEGIN
    IF OLD.status = 'disconnected' THEN
      RAISE EXCEPTION 'QBO_CONNECTION_TERMINAL: a disconnected connection cannot change. [id=%]', OLD.id USING ERRCODE = '23001';
    END IF;
    -- [20261231100000] the one transition of the plaintext realm: a verified row's realm_id to NULL; never back, never another value.
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR (NEW.realm_id IS DISTINCT FROM OLD.realm_id AND NOT (NEW.realm_id IS NULL AND OLD.realm_index IS NOT NULL AND OLD.realm_verified_at IS NOT NULL))
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'QBO_CONNECTION_IDENTITY_FIXED: company, realm, environment and creation time never change. [id=%]', OLD.id USING ERRCODE = '23001';
    END IF;
    -- [20261230100000] an envelope, an index and a verification, once written, are never changed or removed, except:
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope) OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN${transitions("connection:' || OLD.id::text || '")}
        RAISE EXCEPTION 'QBO_REALM_PROTECTION_FIXED: the realm protection of a connection is written once. [id=%]', OLD.id USING ERRCODE = '23001';
      END IF;
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END;
  `.replace("'connection:' || OLD.id::text || ''", "'connection:' || OLD.id::text").replaceAll("= 'connection:' || OLD.id::text || ''", "= 'connection:' || OLD.id::text");
const OPS_GUARD = `
  BEGIN
    -- [20261231100000] the one transition of the plaintext realm: a verified operation's realm_id to NULL; never back, never another value.
    IF NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR (NEW.realm_id IS DISTINCT FROM OLD.realm_id AND NOT (NEW.realm_id IS NULL AND OLD.realm_index IS NOT NULL AND OLD.realm_verified_at IS NOT NULL))
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id THEN
      RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
    END IF;
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope)
       OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN${transitions("operation:' || OLD.connection_id::text || '")}
        RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
      END IF;
    END IF;
    RETURN NEW;
  END;
  `.replaceAll("= 'operation:' || OLD.connection_id::text || ''", "= 'operation:' || OLD.connection_id::text");

async function fiscalBodies() {
  const db = await openDatabase("qbo_cutover_v2_gen");
  try {
    const failed = await applyChainBefore(db, F1);
    if (failed) throw new Error(`chain: ${failed}`);
    const r = await db.one("select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.qbo_record_fiscal_pull_intent(uuid,jsonb,uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text)')");
    const anchor = "OR c.realm_id<>p_realm_id OR c.environment<>p_environment";
    if (r.prosrc.split(anchor).length !== 2) throw new Error("fiscal anchor not exactly once");
    return { before: sha(r.prosrc), after: sha(r.prosrc.replace(anchor, "OR c.realm_index IS NULL OR c.environment<>p_environment")) };
  } finally { await db.close(); }
}

export async function generate() {
  const m1v1 = v1(F1), m2v1 = v1(F2), m3v1 = v1(F3);
  const D = { connGuard: sha(CONN_GUARD), opsGuard: sha(OPS_GUARD), keyVersion: sha(KEY_VERSION), mixed: sha(MIXED) };

  // ── PART 1 ──
  const m1Gate = between(m1v1, "  SELECT count(*) INTO v_conn", "  END IF;\n");
  const m1Schema = between(m1v1, "  -- The plaintext becomes optional; every row keeps one of the two.", "consumed_at + interval '10 minutes')));\n");
  const p1 = `${bar}
-- 20261231100000 — QuickBooks realmID protection, Phase C v2 (CUTOVER), part 1 of 4: the schema accepts rows without a plaintext realm, and the
-- realm guards keep every earlier rule. AUTHORED, NOT APPLIED. *** Phase C is IRREVERSIBLE FOR THE PLAINTEXT once part 4 (20261231300000) runs. ***
--   SUPERSEDES PR #282 (v1, acdee94), whose part 1 replaced both guards with bodies that predate the token-key reseal (20261230400000), its guard
--   repair (20261230410000) and the index-key rotation (20261230500000): applying v1 would have silently removed both key-rotation paths.
--   GATE (before anything changes): every live connection and every disconnect operation carries an envelope and an index, every one that still
--   holds a plaintext realm carries a recorded verification, and every envelope and index names a VERSIONED key (k<N>, idx<N>). Otherwise
--   QBO_REALM_CUTOVER_REFUSED and nothing changes. Needs 20261230500000 applied (the guards must be exactly its reviewed bodies), qbo-realm-protect
--   "verify" at 100 %, A CONFIRMED DATABASE BACKUP and the owner's explicit go. Design and order: docs/release/qbo-realm-protection-r1/README.md.
--   WHAT IT DOES (no row is changed): realm_id becomes nullable on connections, disconnect operations, intents and pulls, and every row must hold
--   the plaintext or the protection; the OAuth state's handoff is paired with the plaintext or the protected realm; public.qbo_key_version()
--   reads a key id's version; public.qbo_index_key_mixed() says whether live indexes are on more than one index key (used from part 2; executable
--   by its owner only); the connection and operation guards keep every rule they have and allow exactly:
--     (a) a VERIFIED row's realm_id to NULL (never back, never another value: plaintext can never be reintroduced);
--     (b) the reseal transition, now only onto a strictly NEWER token key version (no downgrade, no same-key rewrite);
--     (c) the reindex transition, now only onto a strictly NEWER index key version.
--   Append-only guards and RLS are untouched.
-- SELF-VERIFYING: it refuses unless the two guards are exactly the reviewed 20261230500000 bodies, and it accepts its result only if every body it
--   installs hashes to the digest pinned below; any transcription difference fails the whole block and nothing changes. A replay with the reviewed
--   bodies is a no-op; a replay over anything else is refused.
${bar}
DO $qbo_realm_cutover_schema$
DECLARE v_conn integer; v_ops integer; v_unversioned integer; t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') THEN   -- replay: only the reviewed result is accepted
    IF ${digestOf("public.qbo_connections_guard()")} IS DISTINCT FROM '${D.connGuard}'
       OR ${digestOf("public.qbo_disconnect_operations_guard()")} IS DISTINCT FROM '${D.opsGuard}'
       OR ${digestOf("public.qbo_key_version(text,text)")} IS DISTINCT FROM '${D.keyVersion}'
       OR ${digestOf("public.qbo_index_key_mixed(text)")} IS DISTINCT FROM '${D.mixed}' THEN
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: the cutover schema is installed with unexpected guard bodies; nothing was changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;
  IF to_regprocedure('public.qbo_realm_index_coverage()') IS NULL
     OR ${digestOf("public.qbo_connections_guard()")} IS DISTINCT FROM '${HOSTED_GUARDS.conn}'
     OR ${digestOf("public.qbo_disconnect_operations_guard()")} IS DISTINCT FROM '${HOSTED_GUARDS.ops}' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the realm guards are not the reviewed 20261230500000 bodies (the reseal, its repair and the index rotation must be installed first); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
${m1Gate}  SELECT count(*) INTO v_unversioned FROM (
    SELECT realm_envelope e, realm_index i FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_envelope IS NOT NULL
    UNION ALL SELECT realm_envelope, realm_index FROM public.qbo_disconnect_operations WHERE realm_envelope IS NOT NULL) x
   WHERE split_part(x.e, '.', 2) !~ '^k[1-9][0-9]{0,8}$' OR split_part(x.i, '.', 2) !~ '^idx[1-9][0-9]{0,8}$';
  IF v_unversioned <> 0 THEN
    RAISE EXCEPTION 'QBO_REALM_CUTOVER_REFUSED: % protected row(s) name an unversioned key; nothing was changed', v_unversioned USING ERRCODE = 'P0001';
  END IF;

${m1Schema}
  CREATE FUNCTION public.qbo_key_version(p_key_id text, p_kind text)
  RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $f$${KEY_VERSION}$f$;
  REVOKE ALL ON FUNCTION public.qbo_key_version(text, text) FROM PUBLIC, anon, authenticated;
  CREATE FUNCTION public.qbo_index_key_mixed(p_key_id text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$${MIXED}$f$;
  REVOKE ALL ON FUNCTION public.qbo_index_key_mixed(text) FROM PUBLIC, anon, authenticated, service_role;

  CREATE OR REPLACE FUNCTION public.qbo_connections_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$${CONN_GUARD}$g$;
  CREATE OR REPLACE FUNCTION public.qbo_disconnect_operations_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$${OPS_GUARD}$g$;

  -- POSTCONDITION: the schema as reviewed, and every installed body exactly as reviewed, still invoker guards with their pinned search_path, attached.
  IF (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'chk\\_qbo\\_%\\_realm\\_present') <> 4
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('qbo_connections', 'qbo_disconnect_operations', 'qbo_pull_intents', 'qbo_pulls')
                AND column_name = 'realm_id' AND is_nullable = 'NO')
     OR position('realm_envelope IS NOT NULL' IN (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_qbo_state_handoff')) = 0
     OR ${digestOf("public.qbo_connections_guard()")} IS DISTINCT FROM '${D.connGuard}'
     OR ${digestOf("public.qbo_disconnect_operations_guard()")} IS DISTINCT FROM '${D.opsGuard}'
     OR ${digestOf("public.qbo_key_version(text,text)")} IS DISTINCT FROM '${D.keyVersion}'
     OR ${digestOf("public.qbo_index_key_mixed(text)")} IS DISTINCT FROM '${D.mixed}'
     OR has_function_privilege('service_role', 'public.qbo_index_key_mixed(text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.qbo_index_key_mixed(text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.qbo_connections_guard()'::regprocedure, 'public.qbo_disconnect_operations_guard()'::regprocedure)
                AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']))
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_qbo_disconnect_operations_guard' AND tgrelid = 'public.qbo_disconnect_operations'::regclass AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_qbo_connections_guard' AND tgrelid = 'public.qbo_connections'::regclass AND tgenabled = 'O')
     OR has_function_privilege('authenticated', 'public.qbo_key_version(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection cutover (part 1, schema) is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_cutover_schema$;
`;

  // ── PART 2 ──
  const fiscal = await fiscalBodies();
  let store = between(m2v1, "  CREATE OR REPLACE FUNCTION public.qbo_store_connection(", "  $f$;\n");
  store = once(store, "    PERFORM pg_advisory_xact_lock(hashtextextended('qbo-connect:'||p_environment||':'||p_realm_index,0));",
`    -- [Phase C v2] index-key homogeneity: equality on realm_index is only sound while every live row and pending revocation carries an index made
    -- by the same key as this one. During an index rotation it is refused (retry when the rotation completes), never answered by a duplicate.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('qbo-index-rotation', 0));
    IF public.qbo_index_key_mixed(split_part(p_realm_index, '.', 2)) THEN
      RAISE EXCEPTION 'QBO_INDEX_ROTATION_IN_PROGRESS: an index-key rotation is in progress; try again when it completes' USING ERRCODE = 'PT409';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('qbo-connect:'||p_environment||':'||p_realm_index,0));`);
  let disc = between(m2v1, "  CREATE OR REPLACE FUNCTION public.qbo_begin_disconnect(", "  END $f$;\n");
  disc = once(disc, "   SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection;\n",
`   PERFORM pg_advisory_xact_lock_shared(hashtextextended('qbo-index-rotation', 0));   -- [Phase C v2] no index rotation can commit inside this call
   SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection;\n`);
  disc = once(disc, "   IF EXISTS(SELECT 1 FROM public.qbo_connections x WHERE x.id<>c.id AND x.realm_index=c.realm_index AND x.environment=c.environment AND x.status='active') THEN RETURN jsonb_build_object('outcome','shared_connection'); END IF;",
`   -- [Phase C v2] the shared-realm check compares indexes: refused while they could be made by different keys (it would miss a sharer and revoke
   -- a token another workspace still uses).
   IF c.realm_index IS NOT NULL AND public.qbo_index_key_mixed(split_part(c.realm_index, '.', 2)) THEN RETURN jsonb_build_object('outcome','rotation_in_progress'); END IF;
   IF EXISTS(SELECT 1 FROM public.qbo_connections x WHERE x.id<>c.id AND x.realm_index=c.realm_index AND x.environment=c.environment AND x.status='active') THEN RETURN jsonb_build_object('outcome','shared_connection'); END IF;`);
  const oauth = between(m2v1, "  CREATE OR REPLACE FUNCTION public.qbo_record_oauth_return(", "  $f$;\n");
  const intent = between(m2v1, "  CREATE OR REPLACE FUNCTION public.qbo_record_pull_intent(", "  $f$;\n");
  const fiscalBlock = between(m2v1, "  -- The fiscal wrapper, from its live text,", "'OR c.realm_index IS NULL OR c.environment<>p_environment');\n");
  const m2Gate = between(m2v1, "  SELECT count(*) INTO v_conn", "  END IF;\n");

  const plainRule = (row) => `    -- [Phase C v2] the plaintext, while the row still holds one, must equal the caller's; once redacted it is never sent (p_realm_id NULL) and never read.
    IF p_realm_id IS NOT NULL AND ${row}.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;`;
  const RESEAL_CONN = `
  DECLARE c public.qbo_connections%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_expected_envelope IS NULL OR p_new_envelope IS NULL OR p_realm_index IS NULL
       OR p_new_envelope !~ '^v1\\.[a-z0-9-]{1,32}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
    IF c.realm_envelope IS NULL OR c.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF c.realm_envelope = p_new_envelope THEN RETURN 'already_resealed'; END IF;
    IF c.realm_envelope IS DISTINCT FROM p_expected_envelope THEN RETURN 'stale'; END IF;
${plainRule("c")}
    IF c.realm_index IS DISTINCT FROM p_realm_index THEN RETURN 'index_mismatch'; END IF;
    IF coalesce(public.qbo_key_version(split_part(p_new_envelope, '.', 2), 'k') <= public.qbo_key_version(split_part(c.realm_envelope, '.', 2), 'k'), true) THEN RETURN 'downgrade'; END IF;
    PERFORM set_config('qbo.realm_reseal', 'connection:' || c.id::text, true);
    UPDATE public.qbo_connections SET realm_envelope = p_new_envelope, realm_verified_at = clock_timestamp() WHERE id = c.id;
    PERFORM set_config('qbo.realm_reseal', '', true);
    RETURN 'resealed';
  END;
  `;
  const RESEAL_OPS = `
  DECLARE o public.qbo_disconnect_operations%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_expected_envelope IS NULL OR p_new_envelope IS NULL OR p_realm_index IS NULL
       OR p_new_envelope !~ '^v1\\.[a-z0-9-]{1,32}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO o FROM public.qbo_disconnect_operations WHERE connection_id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF o.realm_envelope IS NULL OR o.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF o.realm_envelope = p_new_envelope THEN RETURN 'already_resealed'; END IF;
    IF o.realm_envelope IS DISTINCT FROM p_expected_envelope THEN RETURN 'stale'; END IF;
${plainRule("o")}
    IF o.realm_index IS DISTINCT FROM p_realm_index THEN RETURN 'index_mismatch'; END IF;
    IF coalesce(public.qbo_key_version(split_part(p_new_envelope, '.', 2), 'k') <= public.qbo_key_version(split_part(o.realm_envelope, '.', 2), 'k'), true) THEN RETURN 'downgrade'; END IF;
    PERFORM set_config('qbo.realm_reseal', 'operation:' || o.connection_id::text, true);
    UPDATE public.qbo_disconnect_operations SET realm_envelope = p_new_envelope, realm_verified_at = clock_timestamp() WHERE connection_id = o.connection_id;
    PERFORM set_config('qbo.realm_reseal', '', true);
    RETURN 'resealed';
  END;
  `;
  const RESEAL_TOKEN = `
  DECLARE c public.qbo_connections%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_expected_envelope IS NULL OR p_new_envelope IS NULL
       OR p_new_envelope !~ '^v1\\.[a-z0-9-]{1,32}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
    IF c.refresh_token_envelope IS NULL THEN RETURN 'no_token'; END IF;
    IF c.refresh_token_envelope = p_new_envelope THEN RETURN 'already_resealed'; END IF;
    IF c.refresh_lease_until IS NOT NULL AND c.refresh_lease_until > clock_timestamp() THEN RETURN 'busy'; END IF;
    IF c.refresh_token_envelope IS DISTINCT FROM p_expected_envelope THEN RETURN 'stale'; END IF;
    IF coalesce(public.qbo_key_version(split_part(p_new_envelope, '.', 2), 'k') <= public.qbo_key_version(split_part(c.refresh_token_envelope, '.', 2), 'k'), true) THEN RETURN 'downgrade'; END IF;
    UPDATE public.qbo_connections SET refresh_token_envelope = p_new_envelope, envelope_key_id = split_part(p_new_envelope, '.', 2) WHERE id = c.id;
    RETURN 'resealed';
  END;
  `;
  const reindexBody = (tbl, row, key, who, term) => `
  DECLARE ${row} public.${tbl}%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_realm_envelope IS NULL OR p_expected_index IS NULL OR p_new_index IS NULL
       OR p_new_index !~ '^h1\\.[a-z0-9-]{1,32}\\.[0-9a-f]{64}$' THEN RETURN 'invalid'; END IF;
    -- [Phase C v2] one index move at a time, and never inside a connect or a disconnect that compares indexes (they hold this lock shared).
    PERFORM pg_advisory_xact_lock(hashtextextended('qbo-index-rotation', 0));
    SELECT * INTO ${row} FROM public.${tbl} WHERE ${key} = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;${term}
    IF ${row}.realm_envelope IS NULL OR ${row}.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF ${row}.realm_index = p_new_index THEN RETURN 'already_reindexed'; END IF;
    IF ${row}.realm_index IS DISTINCT FROM p_expected_index OR ${row}.realm_envelope IS DISTINCT FROM p_realm_envelope THEN RETURN 'stale'; END IF;
${plainRule(row)}
    IF coalesce(public.qbo_key_version(split_part(p_new_index, '.', 2), 'idx') <= public.qbo_key_version(split_part(${row}.realm_index, '.', 2), 'idx'), true) THEN RETURN 'downgrade'; END IF;
    PERFORM set_config('qbo.realm_reindex', '${who}' || ${row}.${key}::text, true);
    UPDATE public.${tbl} SET realm_index = p_new_index, realm_verified_at = clock_timestamp() WHERE ${key} = ${row}.${key};
    PERFORM set_config('qbo.realm_reindex', '', true);
    RETURN 'reindexed';
  END;
  `;
  const REINDEX_CONN = reindexBody("qbo_connections", "c", "id", "connection:", "\n    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;");
  const REINDEX_OPS = reindexBody("qbo_disconnect_operations", "o", "connection_id", "operation:", "");
  const S = { store: sha(bodyOf(store)), disc: sha(bodyOf(disc)), oauth: sha(bodyOf(oauth)), intent: sha(bodyOf(intent)),
    resealConn: sha(RESEAL_CONN), resealOps: sha(RESEAL_OPS), resealToken: sha(RESEAL_TOKEN), reindexConn: sha(REINDEX_CONN), reindexOps: sha(REINDEX_OPS), fiscal: fiscal.after };
  const RESEAL_C = "public.qbo_reseal_connection_realm(uuid,text,text,text,text)", RESEAL_O = "public.qbo_reseal_disconnect_realm(uuid,text,text,text,text)";
  const RESEAL_T = "public.qbo_reseal_refresh_token(uuid,text,text)", REINDEX_C = "public.qbo_reindex_connection_realm(uuid,text,text,text,text)";
  const REINDEX_O = "public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)", MIXED_F = "public.qbo_index_key_mixed(text)";
  const C_STORE = "public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)";
  const C_FISCAL = "public.qbo_record_fiscal_pull_intent(uuid,jsonb,uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text)";
  const C_OAUTH = "public.qbo_record_oauth_return(text,text,text,text,text,text,text)";
  const C_INTENT = "public.qbo_record_pull_intent(uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text,text,text)";
  const pinned2 = [[C_STORE, S.store], ["public.qbo_begin_disconnect(uuid,uuid,uuid)", S.disc], [C_OAUTH, S.oauth], [C_INTENT, S.intent], [C_FISCAL, S.fiscal]];
  const pinned2b = [[RESEAL_C, S.resealConn], [RESEAL_O, S.resealOps], [RESEAL_T, S.resealToken], [REINDEX_C, S.reindexConn], [REINDEX_O, S.reindexOps]];
  const sig = (f, params) => f.replace(/\(.*\)$/, `(${params})`);

  const p2 = `${bar}
-- 20261231200000 — QuickBooks realmID protection, Phase C v2 (CUTOVER), part 2 of 4: the database's realm rules move to the keyed index and no NEW
-- row holds a plaintext realm. AUTHORED, NOT APPLIED. *** Phase C is IRREVERSIBLE FOR THE PLAINTEXT once part 4 (20261231300000) runs. ***
--   GATE (before anything changes): as part 1. Needs part 1 applied.
--   WHAT IT DOES (no existing row is changed):
--   (1) uniqueness, the per-realm lock, the pending-revocation and shared-realm checks use realm_index (as v1, PR #282);
--   (2) the OAuth return, store, begin-disconnect and both pull-intent writers require the protection and never store a plaintext realm (as v1);
--   (3) [v2] store and begin-disconnect compare indexes only while every live connection and pending revocation is on ONE index key
--       (qbo_index_key_mixed); mid-rotation they refuse (QBO_INDEX_ROTATION_IN_PROGRESS / 'rotation_in_progress') rather than create a duplicate
--       live connection or revoke a token another workspace still uses. Lock 'qbo-index-rotation': shared here, exclusive in every re-index;
--   (4) the backfill writers, which compare a plaintext that is about to disappear, are dropped (qbo_realm_protection_status stays).
--   Signatures and grants are unchanged.
-- SELF-VERIFYING: it accepts its result only if all five bodies it installs or replaces hash to the digests pinned below (the fiscal wrapper is rebuilt
--   from its live text by exactly one anchored replacement, its old body pinned too); otherwise the whole block fails and nothing changes.
-- PREFLIGHT: part 1 installed; a replay with the reviewed bodies is a no-op; a replay over anything else is refused.
${bar}
DO $qbo_realm_cutover_functions$
DECLARE v_conn integer; v_ops integer; v_def text;
${pinsDecl("pin", pinned2)}
  c_store constant text := '${C_STORE}';
  c_fiscal constant text := '${C_FISCAL}';
BEGIN
  IF to_regprocedure('public.qbo_protect_connection_realm(uuid,text,text,text)') IS NULL AND to_regprocedure('${MIXED_F}') IS NOT NULL THEN   -- replay (part 1 present, writers gone)
    IF ${pinsVar("pin")} THEN
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: the cutover functions are installed with unexpected bodies; nothing was changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') OR to_regprocedure('public.qbo_protect_connection_realm(uuid,text,text,text)') IS NULL
     OR ${digestOf(MIXED_F)} IS DISTINCT FROM '${D.mixed}' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection cutover part 1 (20261231100000) is not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF ${pinsDiffer([[C_FISCAL, fiscal.before]])} THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: qbo_record_fiscal_pull_intent is not the reviewed body; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
${m2Gate}
${oauth}
${store}
${disc}
  -- Import evidence: a new intent carries the connection's protection and no plaintext. The fiscal wrapper no longer compares a plaintext.
${intent}${fiscalBlock}
  DROP FUNCTION public.qbo_protect_connection_realm(uuid, text, text, text);
  DROP FUNCTION public.qbo_protect_disconnect_realm(uuid, text, text, text);
  DROP FUNCTION public.qbo_verify_connection_realm(uuid, text, text, text);
  DROP FUNCTION public.qbo_verify_disconnect_realm(uuid, text, text, text);

  -- POSTCONDITION: every installed body exactly as reviewed; the writers gone; grants unchanged.
  IF to_regprocedure('public.qbo_verify_connection_realm(uuid,text,text,text)') IS NOT NULL OR to_regprocedure('public.qbo_protect_disconnect_realm(uuid,text,text,text)') IS NOT NULL
     OR ${pinsVar("pin")}
     OR has_function_privilege('authenticated', to_regprocedure(c_store), 'EXECUTE') OR NOT has_function_privilege('service_role', to_regprocedure(c_store), 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection cutover (part 2, functions) is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_cutover_functions$;
`;

  const p2b = `${bar}
-- 20261231250000 — QuickBooks realmID protection, Phase C v2, part 3 of 4: token-key and index-key rotation WITHOUT a plaintext realm, forwards only.
-- AUTHORED, NOT APPLIED. Changes no row by itself.
--   WHY: Phase C removes the plaintext realm from every live row. The reseal (20261230400000) and reindex (20261230500000) functions compared it, so
--   after the redaction neither key could ever be rotated again, even after a suspected compromise. This part makes both rotations independent of it.
--   WHAT IT DOES: qbo_reseal_connection_realm, qbo_reseal_disconnect_realm, qbo_reseal_refresh_token, qbo_reindex_connection_realm and
--   qbo_reindex_disconnect_realm are replaced (same signatures, service role only). Per row, by compare-and-swap under a row lock:
--     · the plaintext is compared only while the row still holds one; once redacted the caller sends p_realm_id NULL and it is never read;
--     · a move goes only to a strictly NEWER key version (k<N>, idx<N>): 'downgrade' otherwise (no same-key rewrite, no rollback to an old key);
--     · a re-index holds the advisory lock 'qbo-index-rotation' EXCLUSIVE, so it can never commit inside a connect or disconnect that compares
--       indexes (they hold it shared, part 2);
--     · the guards (part 1) admit exactly these transitions and nothing else.
--   TRUST BOUNDARY: the database never holds a key, so it cannot check that a new envelope opens to the same realm. The Edge Function, which holds
--   the keys, proves it before submitting (it opens the old envelope, recomputes the stored index with the index key it names, seals, opens the
--   new envelope back). A party able to change both the deployed functions and the secrets is outside this boundary (see the release README).
-- SELF-VERIFYING: all five bodies are pinned by SHA-256; any difference fails the block and nothing changes. A replay with them is a no-op.
-- PREFLIGHT: parts 1 and 2 installed.
${bar}
DO $qbo_realm_rotation_post_redaction$
DECLARE
${pinsDecl("pin", pinned2b)}
BEGIN
  -- Part 2 is recognised by its result (the backfill writers dropped, the reviewed store body), never by a helper part 1 already created.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') OR to_regprocedure('${MIXED_F}') IS NULL
     OR to_regprocedure('public.qbo_protect_connection_realm(uuid,text,text,text)') IS NOT NULL OR ${digestOf(C_STORE)} IS DISTINCT FROM '${S.store}'
     OR to_regprocedure('${REINDEX_C}') IS NULL OR to_regprocedure('${RESEAL_T}') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection cutover parts 1 and 2, the reseal and the index rotation must be installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT ${pinsVar("pin")} THEN RETURN; END IF;   -- replay

  CREATE OR REPLACE FUNCTION ${sig(RESEAL_C, "p_connection uuid, p_realm_id text, p_expected_envelope text, p_new_envelope text, p_realm_index text")}
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$${RESEAL_CONN}$f$;
  CREATE OR REPLACE FUNCTION ${sig(RESEAL_O, "p_connection uuid, p_realm_id text, p_expected_envelope text, p_new_envelope text, p_realm_index text")}
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$${RESEAL_OPS}$f$;
  CREATE OR REPLACE FUNCTION ${sig(RESEAL_T, "p_connection uuid, p_expected_envelope text, p_new_envelope text")}
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$${RESEAL_TOKEN}$f$;
  CREATE OR REPLACE FUNCTION ${sig(REINDEX_C, "p_connection uuid, p_realm_id text, p_realm_envelope text, p_expected_index text, p_new_index text")}
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$${REINDEX_CONN}$f$;
  CREATE OR REPLACE FUNCTION ${sig(REINDEX_O, "p_connection uuid, p_realm_id text, p_realm_envelope text, p_expected_index text, p_new_index text")}
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$${REINDEX_OPS}$f$;

  -- POSTCONDITION: every body exactly as reviewed; still executable by the service role only.
  IF ${pinsVar("pin")}
     OR EXISTS (SELECT 1 FROM (VALUES ('${RESEAL_C}'), ('${RESEAL_O}'), ('${RESEAL_T}'), ('${REINDEX_C}'), ('${REINDEX_O}')) v(f)
                WHERE has_function_privilege('authenticated', v.f, 'EXECUTE') OR has_function_privilege('anon', v.f, 'EXECUTE')
                   OR NOT has_function_privilege('service_role', v.f, 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTCONDITION: the post-redaction key rotation is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_rotation_post_redaction$;
`;

  // ── PART 4 (redaction) ──
  // [v2] Scope: LIVE rows only (live connections, PENDING disconnect operations, OAuth states, which are transient and housekept). Every row
  // that is historical evidence (terminal connections, finished disconnect operations, import intents and provenance rows) is left byte for byte
  // unchanged and the migration proves it: a digest of those rows taken before any change must equal the one taken after.
  const HISTORY = `encode(sha256(convert_to(concat_ws('|',
      (SELECT string_agg(ROW(id, realm_id, realm_envelope, realm_index, realm_verified_at, status)::text, ';' ORDER BY id) FROM public.qbo_connections WHERE status = 'disconnected'),
      (SELECT string_agg(ROW(connection_id, realm_id, realm_envelope, realm_index, realm_verified_at, outcome)::text, ';' ORDER BY connection_id) FROM public.qbo_disconnect_operations WHERE outcome <> 'pending'),
      (SELECT string_agg(ROW(id, realm_id, realm_envelope, realm_index)::text, ';' ORDER BY id) FROM public.qbo_pull_intents),
      (SELECT string_agg(ROW(id, realm_id, realm_envelope, realm_index)::text, ';' ORDER BY id) FROM public.qbo_pulls), ''), 'UTF8')), 'hex')`;
  const pinned4 = [...pinned2, ...pinned2b, [MIXED_F, D.mixed], ["public.qbo_key_version(text,text)", D.keyVersion],
    ["public.qbo_connections_guard()", D.connGuard], ["public.qbo_disconnect_operations_guard()", D.opsGuard]];
  let p3 = m3v1;
  p3 = once(p3, "part 3 of 3: the plaintext realm is removed.", "part 4 of 4 (v2): the plaintext realm is removed from LIVE rows.");
  p3 = once(p3, "afterwards no live connection, no disconnect operation and no OAuth state holds a realmID in clear;",
    "afterwards no live connection, no PENDING disconnect operation and no OAuth state holds a realmID in clear;");
  p3 = once(p3, "--   (2) realm_id of every live connection and every disconnect operation is set to NULL (the guards permit it only for a verified row);",
    "--   (2) realm_id of every live connection and every PENDING disconnect operation is set to NULL (the guards permit it only for a verified row);");
  p3 = once(p3, "--   (3) final rules: a live connection, an operation and a state hold no plaintext and keep their protection;",
    "--   (3) final rules: a live connection, a pending operation and a state hold no plaintext; every connection and operation keeps its protection;");
  p3 = once(p3, "--   Disconnected (terminal) connections cannot change and keep their plaintext; historical intents and pulls keep theirs (append-only, unchanged);",
    "--   [v2] HISTORICAL EVIDENCE IS NOT MODIFIED: disconnected (terminal) connections, FINISHED disconnect operations (revoked, local_only) and every\n" +
    "--   import intent and provenance row keep their plaintext and protection byte for byte (proven by a digest taken before and after). Whether\n" +
    "--   that history must also be encrypted is an open compliance question, decided outside this migration;");
  p3 = once(p3, "-- PREFLIGHT: parts 1 and 2 installed; a replay is a no-op.", `-- [v2] It also refuses unless every function body Phase C v2 installed (parts 1-3) is exactly as reviewed (post-redaction rotation available,
--   index homogeneity enforced, the guards' rotation rules present), so the plaintext can never be removed while key rotation depends on it.
-- PREFLIGHT: parts 1, 2 and 3 installed; a replay is a no-op.`);
  p3 = once(p3, "POSTCONDITION: no plaintext in a live connection, an operation or a state.", "POSTCONDITION: no plaintext in a live connection, a pending operation or a state; history unchanged.");
  p3 = once(p3, "DECLARE v_conn integer; v_ops integer;\n", `DECLARE v_conn integer; v_ops integer; v_history text;
${pinsDecl("pin", pinned4)}
`);
  const p3Pre = `    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection cutover parts 1 and 2 (20261231100000, 20261231200000) are not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;`;
  p3 = once(p3, p3Pre, `${p3Pre}
  IF ${pinsVar("pin")} THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the Phase C v2 functions and guards are not installed exactly as reviewed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;`);
  p3 = once(p3, "  -- (1) OAuth states:", `  v_history := ${HISTORY};
  -- (1) OAuth states:`);
  p3 = once(p3, "  UPDATE public.qbo_disconnect_operations SET realm_id = NULL WHERE realm_id IS NOT NULL;",
    "  UPDATE public.qbo_disconnect_operations SET realm_id = NULL WHERE outcome = 'pending' AND realm_id IS NOT NULL;");
  p3 = once(p3, "CHECK (realm_id IS NULL AND realm_envelope IS NOT NULL AND realm_index IS NOT NULL);",
    "CHECK (realm_envelope IS NOT NULL AND realm_index IS NOT NULL AND (outcome <> 'pending' OR realm_id IS NULL));");
  p3 = once(p3, "     OR EXISTS (SELECT 1 FROM public.qbo_disconnect_operations WHERE realm_id IS NOT NULL)",
    "     OR EXISTS (SELECT 1 FROM public.qbo_disconnect_operations WHERE outcome = 'pending' AND realm_id IS NOT NULL)");
  p3 = once(p3, "     OR to_regclass('public.uq_qbo_connections_live') IS NOT NULL",
    `     OR ${HISTORY} IS DISTINCT FROM v_history
     OR to_regclass('public.uq_qbo_connections_live') IS NOT NULL`);
  p3 = once(p3, "(part 3, redaction) is not complete", "(part 4, redaction) is not complete or changed historical evidence");
  return { [F1]: p1, [F2]: p2, [F2B]: p2b, [F3]: p3, digests: { ...D, ...S, fiscalBefore: fiscal.before } };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("genQboCutoverV2.mjs")) {
  const out = await generate();
  const check = process.argv.includes("--check");
  let bad = 0;
  for (const f of [F1, F2, F2B, F3]) {
    const file = path.join(REPO, "supabase/migrations", f);
    if (check) { const cur = fs.readFileSync(file, "utf8"); if (cur !== out[f]) { console.log(`DIFFERS: ${f}`); bad++; } }
    else fs.writeFileSync(file, out[f]);
    const b = Buffer.from(out[f], "utf8");
    console.log(`${f} ${b.length} B ${sha(out[f])} | final LF removed ${b.length - 1} B ${crypto.createHash("sha256").update(b.subarray(0, b.length - 1)).digest("hex")}`);
  }
  console.log(JSON.stringify(out.digests, null, 1));
  process.exit(bad ? 1 : 0);
}
