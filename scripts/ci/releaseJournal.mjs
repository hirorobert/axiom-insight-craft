// The controlled PR #34 production release journal (Lovable, 2026-09-26): Drizzle entries 0013–0021 — explicitly
// REVIEWED here, entry by entry. Not an allow-list: each entry is pinned by its exact SHA-256 AND re-validated
// structurally, and any other `_pr34_` entry, or any change to these, fails the migration-authority guard.
//
//   0013  probe            reports the migration session identity; creates the empty table public._pr34_probe
//   0014  staging table    public._pr34_migration_bodies (verbatim authorized bodies + SHA-256); RLS on; no client role
//   0015  apply            20260925100000 (template "verbatim")
//   0016  apply prereq     20260915100000_financial_statement_documents.sql (template "verbatim_bytes"; applied out of
//                          source order on purpose: an older migration first applied in this release)
//   0017–0021  apply       20260925110000 … 20260925150000 (template "verbatim_once")
//   0022  apply            20260926160000 processing entitlement wall (template "verbatim_noop"; reviewed at f21a58f)
//
// An apply wrapper must be BYTE-IDENTICAL to its reviewed template rendered with its own source name, the SHA-256 of
// that source file in this repository (and, where pinned, its byte count). The templates below were reviewed once:
// each selects exactly ONE staged body by a constant name (WHERE name = v_name — no dynamic selection), refuses a
// missing body or a digest (or byte-count) mismatch, EXECUTEs exactly that body, and records applied_at only AFTER the
// EXECUTE, inside the same DO statement — so a failure rolls back the execution and the record atomically. No wrapper
// grants anything. The structural assertions below re-check these properties with the lexer.
//
// Release-only objects public._pr34_probe and public._pr34_migration_bodies remain in production PENDING CLEANUP.

import crypto from "node:crypto";
import { lexSql } from "./atomicEnvelope.mjs";

const REVIEWED_HEAD = "c2c1e8e171f4c23b428d7affc14ae3ee103020ed";

const header = (name) => `-- Applies authorized migration ${name}
-- verbatim from the release staging table, after asserting its SHA-256 digest matches the
-- reviewed file at head ${REVIEWED_HEAD}.
`;
const prologue = (name, digest, withBytes) => `DO $pr34$
DECLARE
  v_name TEXT := '${name}';
  v_expected TEXT := '${digest}';
  v_body TEXT;
  v_sha  TEXT;${withBytes ? "\n  v_bytes INT;" : ""}
BEGIN
  SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex')${withBytes ? ", octet_length(body)" : ""}
    INTO v_body, v_sha${withBytes ? ", v_bytes" : ""}
    FROM public._pr34_migration_bodies WHERE name = v_name;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'PR34: authorized body % is not staged. Nothing was changed.', v_name USING ERRCODE = '55000';
  END IF;
`;
const shaCheck = (word) => `  IF v_sha <> v_expected THEN
    RAISE EXCEPTION 'PR34: staged body % digest % does not match the ${word} digest %. Nothing was changed.', v_name, v_sha, v_expected USING ERRCODE = '55000';
  END IF;
`;
const epilogue = `  EXECUTE v_body;
  UPDATE public._pr34_migration_bodies SET applied_at = now() WHERE name = v_name;
END
$pr34$;`;

// The processing-correction wrapper (0022, reviewed 2026-09-26 against approved head f21a58f): same safety properties
// (constant name, digest check, one EXECUTE, applied_at only after it, no grants); a second application RETURNs as a
// no-op instead of raising.
const noopWrapper = ({ name, digest, head }) => `-- Digest-guarded application of the reviewed, authorized migration
-- supabase/migrations/${name}
-- (approved head ${head}, SHA-256
--  ${digest}).
-- The body is read verbatim from the staging table public._pr34_migration_bodies and is executed only
-- when its digest matches exactly. Applying a second time is a no-op (applied_at already set).
DO $pr34_wrap_${name.slice(0, 14)}$
DECLARE
  v_name TEXT := '${name}';
  v_expected TEXT := '${digest}';
  v_body TEXT;
  v_sha TEXT;
  v_applied TIMESTAMPTZ;
BEGIN
  SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), applied_at
    INTO v_body, v_sha, v_applied
  FROM public._pr34_migration_bodies WHERE name = v_name;

  IF v_body IS NULL THEN
    RAISE EXCEPTION 'refused: reviewed migration body % is not staged', v_name USING ERRCODE = '55000';
  END IF;
  IF v_sha IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'refused: staged body digest % does not match the authorized digest %', v_sha, v_expected USING ERRCODE = '55000';
  END IF;
  IF v_applied IS NOT NULL THEN
    RAISE NOTICE 'already applied at %, nothing to do', v_applied;
    RETURN;
  END IF;

  EXECUTE v_body;

  UPDATE public._pr34_migration_bodies SET applied_at = now() WHERE name = v_name;
END
$pr34_wrap_${name.slice(0, 14)}$;`;   // (no trailing newline: exactly the reviewed file)

export const TEMPLATES = {
  verbatim_noop: noopWrapper,
  verbatim: ({ name, digest }) => header(name) + prologue(name, digest, false) + shaCheck("reviewed") + epilogue,
  verbatim_once: ({ name, digest }) => header(name) + prologue(name, digest, false) + shaCheck("reviewed") + `  IF (SELECT applied_at FROM public._pr34_migration_bodies WHERE name = v_name) IS NOT NULL THEN
    RAISE EXCEPTION 'PR34: % is already recorded as applied. Nothing was changed.', v_name USING ERRCODE = '55000';
  END IF;
` + epilogue,
  verbatim_bytes: ({ name, digest, bytes, blob }) => `-- Applies authorized prerequisite ${name}
-- verbatim from the release staging table, after asserting its SHA-256 digest matches the
-- reviewed Git blob ${blob} at head
-- ${REVIEWED_HEAD} (${bytes} bytes).
` + prologue(name, digest, true) + shaCheck("authorized") + `  IF v_bytes <> ${bytes} THEN
    RAISE EXCEPTION 'PR34: staged body % has % bytes, expected ${bytes}. Nothing was changed.', v_name, v_bytes USING ERRCODE = '55000';
  END IF;
` + epilogue,
};

/** The reviewed release journal. Changing, adding or removing an entry requires a new review here. */
export const RELEASE_JOURNAL = {
  "0013_pr34_probe_session_identity": { kind: "probe", sha256: "c57e8d89f4e3716a4cb6d6539d41726b8e67cf3b15624d13cf420600a177e878",
    objects: ["public._pr34_probe"], pendingCleanup: true },
  "0014_pr34_release_staging_table": { kind: "staging_table", sha256: "f53362ad4bb0360b6c50b848414576b451d01eb64752cdce169ed7921c8d4c01",
    objects: ["public._pr34_migration_bodies"], pendingCleanup: true },
  "0015_pr34_apply_20260925100000": { kind: "apply", template: "verbatim", source: "20260925100000_global_capabilities_entitlements_pricing.sql",
    digest: "e864eacbd0a111463d03da7df170774f22683716a2a10cc99f5c569c42951297", sha256: "0779b2357547d76675da00fcfdc9b30f2f862c878f373209624929f0ba12ba74" },
  "0016_pr34_apply_prereq_20260915100000": { kind: "apply_prerequisite", template: "verbatim_bytes", source: "20260915100000_financial_statement_documents.sql",
    digest: "e996b26738bce27dea1a7154400ec8828a333e2e0ae99eac91632f93dd0a6712", bytes: 18569, blob: "cc830915b2cc7a93b25a0b4514458f056294b9fb",
    sha256: "4ea7042035c128267655c277202f53856c50b556adf5cfe4f54356a0f6854a77", outOfOrder: true },
  "0017_pr34_apply_20260925110000": { kind: "apply", template: "verbatim_once", source: "20260925110000_named_user_billing_suspension_and_invitation_lifecycle.sql",
    digest: "e2acec5154d7f9f71011a88033fa18fdfb6130089eb1845c42efe44c96fca8fa", sha256: "c3008b2435d00bd06341a99c666db5521848d1856b7da1a684fd7f5716b4e0e8" },
  "0018_pr34_apply_20260925120000": { kind: "apply", template: "verbatim_once", source: "20260925120000_reporting_pack_issuance_binding.sql",
    digest: "2be7dc36c3fbf9432b8eb606f35c2139bd834301ad7416694adc3a163b2550d3", sha256: "ee1ac0b111e69cac5a9a3ea720d36f03469f29907ce9f88873c722dcb0e24bd6" },
  "0019_pr34_apply_20260925130000": { kind: "apply", template: "verbatim_once", source: "20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql",
    digest: "f0fb1b2b665a7562f761a2493faebc7f452f1df38844f5bdd49f8f45c6ef2fa1", sha256: "d96f22ec537b35bac157efd13c5d5d6c21506d4138a8f064f1c093414114882c" },
  "0020_pr34_apply_20260925140000": { kind: "apply", template: "verbatim_once", source: "20260925140000_workspace_capability_authorization.sql",
    digest: "c26e47f3a78b4fd0d47a5a2fab82a69caf13bfe2344e69687f9b30c13a8e5f9a", sha256: "e92be771abd9b197c743032efffbd80a717de720228fe1deb9120dfeb58982e2" },
  "0021_pr34_apply_20260925150000": { kind: "apply", template: "verbatim_once", source: "20260925150000_can_user_act_on_workspace_minimum_grant.sql",
    digest: "3011c3414d7a0b5811015218ae35f8721663eaa32ddd7e5233f269fcb91daacb", sha256: "05b399d1baf6fa502ebfa2a6f89df2536c199699d78a409c52c6eb99337a1188" },
  // The approved processing correction (release blocker P-1), applied by Lovable after review at f21a58f.
  "0022_pr34_apply_20260926160000": { kind: "apply", template: "verbatim_noop", source: "20260926160000_trial_balance_processing_entitlement_wall.sql",
    digest: "d032fb0821210b59937e8f513d5de126fb31bbcffff151a91d459dd33914e868", head: "f21a58f7a8e9e2aa09840e5af716e445f6ab0b8b",
    sha256: "71f4353f1a599b534fbbf696440c9252d2d7debd64b56a36f83d1d1148c2d5a1" },
};

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const code = (text) => lexSql(text).filter((t) => t.type !== "ws" && t.type !== "comment");
const words = (toks) => toks.filter((t) => t.type === "word").map((t) => t.text.toUpperCase());
const RELEASE_OBJECTS = new Set(["_PR34_PROBE", "_PR34_MIGRATION_BODIES"]);
const CLIENT_ROLES = new Set(["PUBLIC", "ANON", "AUTHENTICATED", "SERVICE_ROLE"]);

/** Tokens of a DO body (the single top-level DO statement), or null. */
function doBody(text) {
  const top = code(text);
  if (top.length !== 3 || top[0].text.toUpperCase() !== "DO" || top[1].type !== "dollar" || top[2].text !== ";") return null;
  return { tag: top[1].tag, toks: code(top[1].body) };
}

/** Structural re-check of an apply wrapper (on top of the exact template match). Returns problems. */
export function checkApplyWrapperStructure(text) {
  const problems = [];
  const d = doBody(text);
  if (!d) return ["is not exactly one DO statement"];
  const w = words(d.toks);
  const exec = w.flatMap((x, i) => (x === "EXECUTE" ? [i] : []));
  if (exec.length !== 1 || w[exec[0] + 1] !== "V_BODY") problems.push("must EXECUTE exactly the staged body v_body, once");
  const upd = w.indexOf("UPDATE");
  if (upd < 0 || upd < exec[0]) problems.push("applied_at must be recorded only after the EXECUTE succeeded");
  if (w.filter((x) => x === "UPDATE").length !== 1) problems.push("must record applied_at in exactly one UPDATE");
  if (w.some((x) => ["GRANT", "REVOKE", "INSERT", "DELETE", "TRUNCATE", "ALTER", "DROP", "CREATE", "FORMAT"].includes(x))) problems.push("contains SQL beyond selecting, checking, executing and recording its body");
  // Selection is only ever by the constant name: every FROM _pr34_migration_bodies is followed by WHERE name = v_name.
  const t = d.toks.map((x) => x.text).join(" ");
  const froms = t.match(/FROM public \. _pr34_migration_bodies WHERE name = v_name/g) ?? [];
  const tableRefs = t.match(/_pr34_migration_bodies/g) ?? [];
  if (froms.length + 1 !== tableRefs.length || !/UPDATE public \. _pr34_migration_bodies SET applied_at = now \( \) WHERE name = v_name/.test(t)) problems.push("selects or records a body other than the one named by its constant");
  if (!/v_name TEXT : = '[0-9]{14}_[a-z0-9_]+\.sql'/.test(t)) problems.push("the migration name must be a constant");
  return problems;
}

/** Structural check of the probe / staging entries. Returns problems. */
export function checkReleaseInfrastructure(kind, text) {
  const problems = [];
  const all = code(text);
  // Dollar-quoted bodies AND string literals are lexed as code too: dynamic SQL (EXECUTE '...') is inspected, never hidden.
  const unquote = (s) => s.slice(1, -1).replace(/''/g, "'");
  const flat = (toks) => toks.flatMap((x) => (x.type === "dollar" ? [x, ...flat(code(x.body))] : x.type === "string" ? [x, ...flat(code(unquote(x.text)))] : [x]));
  const toks = flat(all);
  const w = words(toks);
  // No DML on any table other than the release objects; no customer or accounting data is touched.
  for (let i = 0; i < w.length; i++) {
    if (["INSERT", "UPDATE", "DELETE", "TRUNCATE"].includes(w[i])) {
      const target = w.slice(i + 1, i + 6).find((x) => !["INTO", "FROM", "ONLY", "PUBLIC", "TABLE"].includes(x));
      if (w[i] === "INSERT" && w[i - 1] === "SELECT") continue;   // "GRANT SELECT, INSERT ON ..." privilege list
      if (!RELEASE_OBJECTS.has(target ?? "")) problems.push(`${w[i]} on ${target} (release entries may not change data)`);
    }
  }
  // Every CREATE / ALTER / COMMENT names a release object only.
  for (let i = 0; i < w.length; i++) {
    if (w[i] === "CREATE" || w[i] === "ALTER" || (w[i] === "COMMENT" && w[i + 1] === "ON")) {
      const target = w.slice(i + 1, i + 8).find((x) => x.startsWith("_PR34_") || !["TABLE", "IF", "NOT", "EXISTS", "ON", "PUBLIC"].includes(x));
      if (!RELEASE_OBJECTS.has(target ?? "")) problems.push(`${w[i]} of ${target} (only the release objects may be created or altered)`);
    }
  }
  // No client role is ever granted anything.
  const s = toks.filter((x) => x.type !== "string" && x.type !== "dollar").map((x) => x.text).join(" ").toUpperCase();
  for (const m of s.matchAll(/GRANT ([A-Z ,]+) ON [A-Z0-9_. ]+ TO ([A-Z_]+)/g)) {
    if (CLIENT_ROLES.has(m[2].trim())) problems.push(`grants ${m[1].trim().replace(/\s*,\s*/g, ", ")} to ${m[2].trim()}`);
  }
  if (kind === "staging_table") {
    if (!/ENABLE ROW LEVEL SECURITY/.test(s)) problems.push("the staging table must have RLS enabled");
    for (const role of ["PUBLIC", "ANON", "AUTHENTICATED"]) if (!new RegExp(`REVOKE ALL ON PUBLIC \\. _PR34_MIGRATION_BODIES FROM ${role}`).test(s)) problems.push(`the staging table must revoke all from ${role}`);
  }
  if (kind === "probe" && !/CREATE TABLE IF NOT EXISTS PUBLIC \. _PR34_PROBE/.test(s)) problems.push("the probe may only create public._pr34_probe");
  return problems;
}

/**
 * Validates one release journal entry. Returns { covers?: source, outOfOrder?: boolean, problems: string[] }.
 * `srcBytes(name)` returns the source migration's bytes (or null when missing).
 */
export function checkReleaseEntry(tag, text, srcBytes) {
  const entry = RELEASE_JOURNAL[tag];
  if (!entry) return { problems: [`${tag} is a release entry that has not been reviewed (add it to RELEASE_JOURNAL after review)`] };
  const problems = [];
  if (sha256(Buffer.from(text, "utf8")) !== entry.sha256) problems.push(`${tag} differs from its reviewed content (SHA-256)`);
  if (entry.kind === "probe" || entry.kind === "staging_table") {
    problems.push(...checkReleaseInfrastructure(entry.kind, text).map((p) => `${tag}: ${p}`));
    return { problems };
  }
  const src = srcBytes(entry.source);
  if (!src) return { problems: [...problems, `${tag} applies an unknown migration ${entry.source}`] };
  if (sha256(src) !== entry.digest) problems.push(`${tag}: the pinned digest does not match ${entry.source} in this repository`);
  if (entry.bytes !== undefined && src.length !== entry.bytes) problems.push(`${tag}: the pinned byte count ${entry.bytes} does not match ${entry.source} (${src.length})`);
  const rendered = TEMPLATES[entry.template]?.({ name: entry.source, digest: sha256(src), bytes: src.length, blob: entry.blob, head: entry.head });
  if (rendered !== text.replace(/\r\n/g, "\n")) problems.push(`${tag} is not exactly the reviewed "${entry.template}" wrapper for ${entry.source}`);
  problems.push(...checkApplyWrapperStructure(text).map((p) => `${tag}: ${p}`));
  return { covers: entry.source, outOfOrder: entry.outOfOrder === true, problems };
}

export const isReleaseTag = (tag) => /^\d{4}_pr34_/.test(tag);
