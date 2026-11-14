// Exact-byte transport for the four large migrations of the consolidated Ready-for-Reporting release (D7–D10 of
// Claude outputs/HOSTED_EXECUTION_MANIFEST_2026-11-12.md): 20261223100000 (first-period governed review), 20261224100000
// (contra-account designation), 20261225100000 (Ready for Reporting pilot) and 20261226100000 (issued comparative schedules).
//
// Why: the hosted migrator takes ONE SQL string as a tool argument from Lovable's AI, which proved (2026-11-14, two attempts on
// 20261223100000, both rolled back cleanly) that it cannot pass a 73 KB file verbatim; 22 KB succeeded. The four bodies are
// therefore STAGED as inert data (a plain INSERT over a connection that owns the private schema; the insert trigger re-hashes
// the body against the literal identities below and refuses anything else) and EXECUTED exactly once each by a SMALL,
// deterministic, registered apply wrapper submitted through the canonical migrator, which keeps owning the journal row.
//
// Protocol follows sourceAccessStagedTransport.mjs (private schema, exact journal predecessor, re-hash before execution,
// preservation baseline, pinned search_path with a SESSION-level restore, atomic consumption). Specific to this release:
//   (1) the predecessor is hosted id 106 = Lovable's plain mirror 0105 of 20261228100000 (D12, applied 2026-11-14 BEFORE
//       D7–D11 by owner decision to admit compiler identity 3); accepted in both journal forms of the committed bytes;
//   (2) four batches in a fixed order; each apply requires the previous batch consumed (D10's own PREFLIGHT also requires
//       D7 and D9 installed; D11 — 20261227100000, 13 KB — is applied directly by the migrator after rfr-4);
//   (3) none of the four touches the compiler digest CHECK or fs_record_server_compilation (asserted by the test); the
//       baseline additionally pins fs_server_compilations, the account mappings/decisions and the reports/publications.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PRESERVED_TABLES as PREDECESSOR_PRESERVED } from "./sourceAccessStagedTransport.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TRANSPORT_DIR = "release/staged-transport-rfr";
/** The commit that carries the migration bytes (origin/main after Lovable's mirror of D12). Identity is byte count + SHA-256; if
 *  the commit is unreachable the same bytes are read from the working tree and held to the same identity. */
export const SOURCE_COMMIT = "122069b46f201b6714ed50d6d2e00380dd41d170";
export const SCHEMA = "cfoclose_rfr_release";
const sha256Hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const journalHashes = (text) => [sha256Hex(Buffer.from(text, "utf8")), sha256Hex(Buffer.from(text + "\n", "utf8"))];

export const sha256 = sha256Hex;
export function committedBytes(rel, commit, repo = REPO) {
  try { return execFileSync("git", ["show", `${commit}:${rel}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return fs.readFileSync(path.join(repo, rel)); } // unreachable commit: the identity check in artifactBytes still applies
}

/** Hosted id 106: Lovable's plain mirror of D12 (20261228100000, 8,124 B, f319b460…), the journal head the bootstrap must follow.
 *  The journal recorded the committed bytes exactly; the LF form is accepted as well (the migrator's one final LF). */
export const PREDECESSOR_SOURCE = Object.freeze({
  path: "supabase/migrations/20261228100000_statement_compiler_casting_declaration.sql", bytes: 8124,
  sha256: "f319b4600a013871c0c734ef4e5a7451becfada0787f88f4a5ca40a80d420294", commit: SOURCE_COMMIT,
});
export const BOOTSTRAP_PREDECESSOR = Object.freeze({
  id: 106, tag: "0105_statement_compiler_casting_declaration",
  hashes: Object.freeze([PREDECESSOR_SOURCE.sha256, sha256Hex(Buffer.concat([committedBytes(PREDECESSOR_SOURCE.path, SOURCE_COMMIT), Buffer.from("\n")]))]),
});
export const BOOTSTRAP_NAME = "rfr_staged_transport";

const fnPresent = (f) => `to_regprocedure('public.${f}') IS NOT NULL`;
const tblPresent = (t) => `to_regclass('public.${t}') IS NOT NULL`;
const inBlockers = (needle) => `position('${needle}' IN pg_get_functiondef(to_regprocedure('public.fs_publication_blockers(uuid, text, integer)'))) > 0`;
const CONTRA_COLUMN = "EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.account_mappings') AND attname = 'is_contra_account' AND NOT attisdropped)";

/** What each source creates (its own PREFLIGHT refuses when any of these exists) and what proves it installed. */
export const BATCHES = Object.freeze([
  Object.freeze({
    batch: "rfr-1", name: "rfr_1_staged_apply", source: "20261223100000_first_period_governed_review_standalone.sql",
    tables: ["fs_first_period_evidence", "fs_first_period_claims", "fs_first_period_decisions"],
    functions: ["_fs_first_period_assess(uuid, integer)", "_fs_first_period_pending(uuid, integer)", "_fs_opening_pending(uuid, integer)", "fs_first_period_status(uuid, integer)",
      "fs_decide_first_period(uuid, integer, text, boolean, text, uuid, text)", "fs_submit_first_period_claim(uuid, integer, text, jsonb, text, uuid[], uuid)",
      "fs_record_first_period_evidence(uuid, integer, text, text, date, date, text, text, boolean, uuid)", "fs_withdraw_first_period(uuid, integer, text, text, uuid)"],
    prerequisites: { tables: ["fs_first_period_declarations", "financial_statement_reports", "financial_statement_publications"],
      functions: ["fs_first_period_declared(uuid, integer)", "_fs_earlier_period_history(uuid, integer)", "_fs_scope_lock(uuid, integer)", "get_authoritative_certification(uuid, integer)",
        "workspace_capability_allowed(uuid, uuid, text)", "fs_rollout_allows(uuid)", "_cr_member(uuid, uuid)", "close_review_readable(uuid)", "close_review_events_guard()", "fs_publication_blockers(uuid, text, integer)"] },
    anyPresent: ["fs_first_period_evidence", "fs_first_period_claims", "fs_first_period_decisions"].map(tblPresent).concat([fnPresent("_fs_first_period_assess(uuid, integer)"), inBlockers("_fs_first_period_pending")]).join(" OR "),
    installed: ["fs_first_period_evidence", "fs_first_period_claims", "fs_first_period_decisions"].map(tblPresent).concat([fnPresent("fs_first_period_status(uuid, integer)"), fnPresent("_fs_first_period_pending(uuid, integer)"), inBlockers("_fs_first_period_pending"), inBlockers("_fs_opening_pending")]).join(" AND "),
    artifacts: { source: Object.freeze({ path: "supabase/migrations/20261223100000_first_period_governed_review_standalone.sql", bytes: 73411, sha256: "e7542b78ebfad1cf359ea77ea83307cabe63d3b49d7a0b937f73c4152040e3c4", commit: SOURCE_COMMIT }) },
  }),
  Object.freeze({
    batch: "rfr-2", name: "rfr_2_staged_apply", source: "20261224100000_contra_account_designation.sql",
    tables: [],
    functions: [],
    prerequisites: { tables: ["account_mappings", "account_review_decisions"],
      functions: ["resolve_account_review_batch(uuid, uuid, uuid, jsonb)", "close_review_refresh_findings(uuid, integer)",
        "account_mapping_content(public.financial_statement, public.account_classification, text, text, boolean, boolean, boolean)", "account_mappings_provenance_guard()"] },
    // The column is the only new object; the five functions it re-creates exist before and after (CREATE OR REPLACE from their live text).
    anyPresent: CONTRA_COLUMN,
    installed: `${CONTRA_COLUMN} AND position('is_contra_account' IN pg_get_functiondef(to_regprocedure('public.resolve_account_review_batch(uuid, uuid, uuid, jsonb)'))) > 0`
      + ` AND position('is_contra_account' IN pg_get_functiondef(to_regprocedure('public.account_mappings_provenance_guard()'))) > 0`
      + ` AND NOT has_column_privilege('authenticated', 'public.account_mappings', 'is_contra_account', 'INSERT') AND NOT has_column_privilege('authenticated', 'public.account_mappings', 'is_contra_account', 'UPDATE')`,
    artifacts: { source: Object.freeze({ path: "supabase/migrations/20261224100000_contra_account_designation.sql", bytes: 38243, sha256: "4539d9eff542352f370f234819cf792170a832ba66ca9f6621468fb80ead35ff", commit: SOURCE_COMMIT }) },
  }),
  Object.freeze({
    batch: "rfr-3", name: "rfr_3_staged_apply", source: "20261225100000_ready_for_reporting_pilot.sql",
    tables: ["rfr_scope_events", "rfr_inputs", "rfr_corrections", "rfr_runs", "rfr_reviews", "rfr_source_attestations", "rfr_finalization_manifests"],
    functions: ["_rfr_blockers(uuid, text, integer)", "rfr_status(uuid, integer)", "rfr_set_scope(uuid, integer, text, text, jsonb, text)", "rfr_register_input(uuid, integer, text, text, jsonb, text, text, uuid)",
      "rfr_withdraw_input(uuid, integer, text, text, text, uuid)", "rfr_record_run(uuid, integer, text, jsonb)", "rfr_load_inputs(uuid, integer)", "rfr_content_digest(uuid, integer)", "rfr_append_only_guard()"],
    prerequisites: { tables: ["financial_statement_reports", "financial_statement_publications"],
      functions: ["_fs_scope_lock(uuid, integer)", "fs_publication_blockers(uuid, text, integer)"] },
    anyPresent: ["rfr_scope_events", "rfr_inputs", "rfr_runs"].map(tblPresent).concat([fnPresent("_rfr_blockers(uuid, text, integer)"), inBlockers("_rfr_blockers")]).join(" OR "),
    installed: ["rfr_scope_events", "rfr_inputs", "rfr_corrections", "rfr_runs", "rfr_reviews", "rfr_source_attestations", "rfr_finalization_manifests"].map(tblPresent)
      .concat([fnPresent("_rfr_blockers(uuid, text, integer)"), fnPresent("rfr_status(uuid, integer)"), inBlockers("_rfr_blockers")]).join(" AND "),
    artifacts: { source: Object.freeze({ path: "supabase/migrations/20261225100000_ready_for_reporting_pilot.sql", bytes: 56101, sha256: "5374bb124399bfd37ddc17617a14af125b1c93c15dbf476c82a4f38a66d824d5", commit: SOURCE_COMMIT }) },
  }),
  Object.freeze({
    batch: "rfr-4", name: "rfr_4_staged_apply", source: "20261226100000_issued_comparative_schedules.sql",
    tables: ["fs_issued_comparatives", "fs_restatement_authorizations"],
    functions: ["fs_record_issued_comparative(uuid, integer, text, text, date, jsonb, jsonb, uuid)", "fs_authorize_restatement(uuid, text, text, text, uuid)", "fs_issued_comparative_reconciliation(uuid, integer)",
      "fs_propose_restatement_from_issued(uuid, integer, uuid, text, uuid)", "_fs_issued_comparative_blockers(uuid, integer)", "_fs_issued_comparative_lines(uuid, integer)"],
    prerequisites: { tables: ["fs_first_period_claims", "rfr_runs"],
      functions: ["fs_propose_restatement(uuid, integer, jsonb, text, text, uuid)", "fs_statement_composition(uuid, integer)", "_rfr_blockers(uuid, text, integer)", "_fs_first_period_pending(uuid, integer)", "fs_publication_blockers(uuid, text, integer)"] },
    anyPresent: ["fs_issued_comparatives", "fs_restatement_authorizations"].map(tblPresent).concat([fnPresent("fs_record_issued_comparative(uuid, integer, text, text, date, jsonb, jsonb, uuid)"), inBlockers("_fs_issued_comparative_blockers")]).join(" OR "),
    installed: ["fs_issued_comparatives", "fs_restatement_authorizations"].map(tblPresent).concat([fnPresent("fs_record_issued_comparative(uuid, integer, text, text, date, jsonb, jsonb, uuid)"), inBlockers("_fs_issued_comparative_blockers")]).join(" AND "),
    artifacts: { source: Object.freeze({ path: "supabase/migrations/20261226100000_issued_comparative_schedules.sql", bytes: 34059, sha256: "8ff7c5f97b8a1222230ab9ceb5aad02850d68b62c2b9f970df8dac3ceef37320", commit: SOURCE_COMMIT }) },
  }),
]);
export const MAX_BODY_BYTES = Math.max(...BATCHES.map((b) => b.artifacts.source.bytes));

/** The exact bytes of one artifact, checked against its pinned identity. */
export function artifactBytes(index, kind, repo = REPO) {
  const b = BATCHES[index]; const a = b?.artifacts[kind];
  if (!a) throw new Error(`no artifact ${index}/${kind}`);
  const bytes = committedBytes(a.path, a.commit, repo);
  if (bytes.length !== a.bytes || sha256(bytes) !== a.sha256) throw new Error(`${b.batch}/${kind} is not its pinned identity (${bytes.length} ${sha256(bytes)})`);
  return bytes;
}
export const kindsOf = (index) => Object.keys(BATCHES[index].artifacts);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (xs) => `ARRAY[${xs.map(q).join(", ")}]::text[]`;
const LOCK = `PERFORM pg_advisory_xact_lock(hashtextextended('${SCHEMA}_transport', 0));`;
export function entryHashes(index) { return index < 0 ? [...BOOTSTRAP_PREDECESSOR.hashes] : journalHashes(index === 0 ? renderBootstrap() : renderApply(index - 1)); }

const predecessorCheck = (index = -1) => `  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1 OR v_pred_id <> ${BOOTSTRAP_PREDECESSOR.id + index + 1}
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;`;

// Fixed, reviewed relation names only. Beyond the predecessor's set: the account mappings and review decisions (rfr-2 adds a column
// and re-creates their functions), the reports and publications (every batch splices fs_publication_blockers), the legacy first-period
// declarations (rfr-1 supersedes them), the pilot allow-list and the compiler receipts (none of the four may touch them).
export const PRESERVED_TABLES = Object.freeze([...new Set([...PREDECESSOR_PRESERVED, "account_mappings", "account_review_decisions", "financial_statement_reports",
  "financial_statement_publications", "fs_first_period_declarations", "financial_statements_rollout_companies", "fs_server_compilations"])]);
const preservedTables = () => [...PRESERVED_TABLES];
const preserveLocks = () => `  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE ${preservedTables().sort().map((t) => `public.${t}`).join(", ")} IN SHARE MODE;`;
// rfr-2 adds the nullable column account_mappings.is_contra_account: every existing row gains the key with NULL, which is not a changed
// record. That one key is excluded from the mapping rows' projection (before and after), so any OTHER change still fails the apply.
const rowJson = (t) => (t === "account_mappings" ? "(to_jsonb(t) - 'is_contra_account')" : "to_jsonb(t)");
const baseline = () => `SELECT encode(sha256(convert_to(jsonb_build_array(
${preservedTables().map((t) => `    coalesce((SELECT jsonb_agg(${rowJson(t)} ORDER BY ${rowJson(t)}::text) FROM public.${t} t), '[]'::jsonb)`).join(",\n")}
  )::text, 'UTF8')), 'hex')`;
/** The compiler-identity state D12 installed; none of the four may narrow or widen it. */
const COMPILER_PIN = `(SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = to_regclass('public.fs_server_compilations') AND c.conname = 'fs_server_compilations_compiler_sha256_check')`
  + ` || ':' || md5(pg_get_functiondef(to_regprocedure('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)')))`;

const approvedRows = () => BATCHES.flatMap((b) => Object.entries(b.artifacts).map(([k, a]) => `        (${q(b.batch)}, ${q(k)}, ${a.bytes}, ${q(a.sha256)})`)).join(",\n");

export function renderBootstrap() {
  return `-- CFOClose Ready-for-Reporting (consolidated 2026-11-12) staged transport bootstrap. GENERATED by scripts/release/rfrStagedTransport.mjs; do not edit.
-- The four sources (20261223100000, 20261224100000, 20261225100000, 20261226100000) are inert until a registered apply executes each once.
DO $cfoclose_rfr_transport_bootstrap$
DECLARE
  c_predecessor CONSTANT text[] := ${arr(BOOTSTRAP_PREDECESSOR.hashes)};
  v_n bigint;
  v_pred_id bigint;
  v_role name;
BEGIN
  ${LOCK}
${predecessorCheck()}
  IF to_regnamespace('${SCHEMA}') IS NOT NULL THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_ALREADY_INSTALLED: the transport schema exists; uncertain state requires review' USING ERRCODE = '55000';
  END IF;
  CREATE SCHEMA ${SCHEMA};
  COMMENT ON SCHEMA ${SCHEMA} IS 'Release-only exact-byte transport for the consolidated Ready-for-Reporting release (D7-D10); never exposed to clients.';
  CREATE TABLE ${SCHEMA}.staged_artifacts (
    batch text NOT NULL, kind text NOT NULL CHECK (kind IN ('source','wrapper','preflight','postcondition')), body text NOT NULL CHECK (octet_length(convert_to(body, 'UTF8')) <= ${MAX_BODY_BYTES}),
    body_bytes integer NOT NULL, body_sha256 text NOT NULL, staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    staged_by name NOT NULL DEFAULT session_user, consumed_at timestamptz,
    PRIMARY KEY (batch, kind)
  );
  CREATE TABLE ${SCHEMA}.transport_events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch text NOT NULL,
    event text NOT NULL CHECK (event IN ('staged','applied')), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT clock_timestamp(), by_role name NOT NULL DEFAULT session_user
  );
  CREATE FUNCTION ${SCHEMA}.approved_artifact(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT a.bytes, a.sha256 FROM (VALUES
${approvedRows()}
      ) AS a(batch, kind, bytes, sha256) WHERE a.batch = p_batch AND a.kind = p_kind
    $fn$;
  CREATE FUNCTION ${SCHEMA}.staged_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE v_ok record;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'RFR_TRANSPORT_STAGE_REFUSED: staged rows start unconsumed' USING ERRCODE = '55000'; END IF;
        NEW.body_bytes := octet_length(convert_to(NEW.body, 'UTF8'));
        NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        SELECT * INTO v_ok FROM ${SCHEMA}.approved_artifact(NEW.batch, NEW.kind);
        IF v_ok.bytes IS NULL OR v_ok.bytes <> NEW.body_bytes OR v_ok.sha256 <> NEW.body_sha256 THEN
          RAISE EXCEPTION 'RFR_TRANSPORT_STAGE_REFUSED: % % is not an approved exact byte identity', NEW.batch, NEW.kind USING ERRCODE = '55000';
        END IF;
        INSERT INTO ${SCHEMA}.transport_events(batch, event, detail)
          VALUES (NEW.batch, 'staged', jsonb_build_object('kind', NEW.kind, 'bytes', NEW.body_bytes, 'sha256', NEW.body_sha256));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF coalesce(current_setting('${SCHEMA}.applying', true), '') <> OLD.batch
           OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
           OR (NEW.batch, NEW.kind, NEW.body, NEW.body_bytes, NEW.body_sha256, NEW.staged_at, NEW.staged_by)
              IS DISTINCT FROM (OLD.batch, OLD.kind, OLD.body, OLD.body_bytes, OLD.body_sha256, OLD.staged_at, OLD.staged_by)
          THEN RAISE EXCEPTION 'RFR_TRANSPORT_STAGE_IMMUTABLE: only the owning apply may consume a row' USING ERRCODE = '55000'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'RFR_TRANSPORT_STAGE_IMMUTABLE: evidence is append-only' USING ERRCODE = '55000';
    END
    $fn$;
  CREATE FUNCTION ${SCHEMA}.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN RAISE EXCEPTION 'RFR_TRANSPORT_EVIDENCE_IMMUTABLE: % is refused', TG_OP USING ERRCODE = '55000'; END
    $fn$;
  CREATE TRIGGER trg_staged_artifacts_guard BEFORE INSERT OR UPDATE OR DELETE ON ${SCHEMA}.staged_artifacts
    FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.staged_artifacts_guard();
  CREATE TRIGGER trg_staged_artifacts_no_truncate BEFORE TRUNCATE ON ${SCHEMA}.staged_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION ${SCHEMA}.append_only_guard();
  CREATE TRIGGER trg_transport_events_append_only BEFORE UPDATE OR DELETE ON ${SCHEMA}.transport_events
    FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.append_only_guard();
  CREATE TRIGGER trg_transport_events_no_truncate BEFORE TRUNCATE ON ${SCHEMA}.transport_events
    FOR EACH STATEMENT EXECUTE FUNCTION ${SCHEMA}.append_only_guard();
  ALTER TABLE ${SCHEMA}.staged_artifacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${SCHEMA}.transport_events ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION ${SCHEMA}.approved_artifact(text, text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION ${SCHEMA}.staged_artifacts_guard() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION ${SCHEMA}.append_only_guard() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ${SCHEMA} FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION ${SCHEMA}.approved_artifact(text, text) FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION ${SCHEMA}.staged_artifacts_guard() FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION ${SCHEMA}.append_only_guard() FROM %I', v_role);
    END IF;
  END LOOP;
END
$cfoclose_rfr_transport_bootstrap$;`;
}

const pick = (b, k) => `  SELECT s.body INTO v_${k} FROM ${SCHEMA}.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = '${k}' AND s.consumed_at IS NULL
     AND s.body_bytes = ${b.artifacts[k].bytes} AND s.body_sha256 = '${b.artifacts[k].sha256}'
     AND octet_length(convert_to(s.body, 'UTF8')) = ${b.artifacts[k].bytes}
     AND encode(sha256(convert_to(s.body, 'UTF8')), 'hex') = '${b.artifacts[k].sha256}';
  IF v_${k} IS NULL THEN RAISE EXCEPTION 'RFR_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % ${k} is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;`;

// What every batch must leave behind, role by role: anon reaches nothing new; no client role can write a new table; the blockers
// splice point stays service-only; each new function is executable by anon by no one.
const privilegePostcondition = (b) => `  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN CONTINUE; END IF;
    IF has_function_privilege(v_role, 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE') AND v_role <> 'service_role'
${b.tables.map((t) => `       OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.${t}'::regclass)
       OR has_table_privilege(v_role, 'public.${t}', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR (v_role = 'anon' AND has_table_privilege(v_role, 'public.${t}', 'SELECT'))`).join("\n")}
${b.functions.map((f) => `       OR (v_role = 'anon' AND has_function_privilege(v_role, 'public.${f}', 'EXECUTE'))`).join("\n")}
    THEN
      RAISE EXCEPTION 'RFR_TRANSPORT_PRIVILEGE_POSTCONDITION: % has an unexpected privilege on the installed objects; rolled back', v_role USING ERRCODE = '55000';
    END IF;
  END LOOP;`;

export function renderApply(index) {
  const b = BATCHES[index]; if (!b) throw new Error(`no rfr batch ${index}`);
  const prior = index === 0 ? null : BATCHES[index - 1];
  const kinds = Object.keys(b.artifacts);
  const tag = `$cfoclose_rfr_transport_${b.batch.replace(/-/g, "_")}$`;
  return `-- CFOClose Ready-for-Reporting staged transport: apply ${b.source}. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing mappings, decisions, reports, publications, declarations, the pilot allow-list,
-- the compiler receipts and identity, earlier records, grants, memberships and runtime settings must be unchanged. One atomic statement.
DO ${tag}
DECLARE
  c_batch CONSTANT text := ${q(b.batch)};
  c_prior CONSTANT text := ${prior ? q(prior.batch) : "NULL"};
  c_prior_kinds CONSTANT integer := ${prior ? Object.keys(prior.artifacts).length : 0};
  c_predecessor CONSTANT text[] := ${arr(entryHashes(index))};
  v_n bigint; v_pred_id bigint; v_baseline text; v_compiler text; v_role text; v_search_path text; v_${kinds.join(" text; v_")} text;
BEGIN
  ${LOCK}
${predecessorCheck(index)}
  IF to_regnamespace('${SCHEMA}') IS NULL THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(${arr(b.prerequisites.tables.map((t) => "public." + t))}) t WHERE to_regclass(t) IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(${arr(b.prerequisites.functions.map((f) => "public." + f))}) f WHERE to_regprocedure(f) IS NULL) THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_PREREQUISITE_MISSING: an object ${b.source} builds on is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM ${SCHEMA}.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM ${SCHEMA}.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM ${SCHEMA}.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM ${SCHEMA}.staged_artifacts WHERE batch = c_batch) <> ${kinds.length} THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly ${kinds.length} staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF ${b.anyPresent} THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_UNCERTAIN_STATE: % has objects present without a consumed transport record', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
${kinds.map((k) => pick(b, k)).join("\n")}
${preserveLocks()}
  v_baseline := (${baseline()});
  v_compiler := ${COMPILER_PIN};
  PERFORM set_config('${SCHEMA}.applying', c_batch, true);
  -- The source binds unqualified names through the executing session's search_path and itself contains session-level SET search_path
  -- statements. Pin the path for the source, then restore the ORIGINAL path at SESSION level so the source's SET cannot outlive this transaction.
  v_search_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog, public', true);
${kinds.includes("preflight") ? "  EXECUTE v_preflight;\n" : ""}  EXECUTE v_source;
${kinds.includes("postcondition") ? "  EXECUTE v_postcondition;\n" : ""}  PERFORM set_config('search_path', v_search_path, false);
  IF NOT (${b.installed}) THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_POSTCONDITION: % did not install its target', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
${privilegePostcondition(b)}
  IF (${COMPILER_PIN}) IS DISTINCT FROM v_compiler THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_COMPILER_IDENTITY_CHANGED: the compiler receipt pin or the receipt function changed; rolled back' USING ERRCODE = '55000';
  END IF;
  IF (${baseline()}) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'RFR_TRANSPORT_BASELINE_CHANGED: a preserved financial record, mapping, decision, report, publication, declaration, allow-list row, receipt, grant, membership or runtime setting changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE ${SCHEMA}.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO ${SCHEMA}.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', ${q(b.source)}, 'baseline_sha256', v_baseline,
${kinds.map((k) => `      '${k}_sha256', '${b.artifacts[k].sha256}'`).join(",\n")}));
  PERFORM set_config('${SCHEMA}.applying', '', true);
END
${tag};`;
}

export function renderStage(index, kind, repo = REPO) {
  const b = BATCHES[index]; if (!b?.artifacts[kind]) throw new Error("invalid rfr artifact");
  const text = artifactBytes(index, kind, repo).toString("utf8");
  const dq = `$cfoclose_rfr_stage_${b.artifacts[kind].sha256.slice(0, 16)}$`;
  if (text.includes(dq)) throw new Error(`${b.batch}/${kind} contains its staging quote`);
  return `INSERT INTO ${SCHEMA}.staged_artifacts(batch, kind, body) VALUES (${q(b.batch)}, ${q(kind)}, ${dq}${text}${dq});\n`;
}

export function renderAll(repo = REPO) {
  const out = { [`${TRANSPORT_DIR}/00_${BOOTSTRAP_NAME}.sql`]: renderBootstrap() };
  BATCHES.forEach((b, i) => {
    out[`${TRANSPORT_DIR}/${i + 1}0_${b.name}.sql`] = renderApply(i);
    for (const k of kindsOf(i)) out[`${TRANSPORT_DIR}/stage/${i + 1}_${b.batch}.${k}.sql`] = renderStage(i, k, repo);
  });
  return out;
}

export function transportForms() {
  return [{ name: BOOTSTRAP_NAME, role: "bootstrap", text: renderBootstrap() }, ...BATCHES.map((b, i) => ({ name: b.name, role: "apply", batch: b.batch, source: b.source, text: renderApply(i) }))]
    .map((x) => ({ ...x, bytes: Buffer.byteLength(x.text), hashes: journalHashes(x.text) }));
}

/** Reviewed transport forms (pinned renderings). Hosted journal entries are registered only after canonical execution: none is registered yet. */
export const REGISTERED_TRANSPORT_FORMS = Object.freeze({
  rfr_staged_transport: "bcf562d1a5d3ac13fb32967f96d3d463e827bbf1911abff5e69e548b28a4f3cf",
  rfr_1_staged_apply: "a2a4cca5bc06a333aa9265d9ad2f24efc36952c6165c8273600c8577a22d82b7",
  rfr_2_staged_apply: "8b8ba1fad2787d0cca6a138905f51a286e45b16e7f66fb04ced2d032ebd28d7a",
  rfr_3_staged_apply: "7d7b3629bba1eaeed7375cd59b213cbdbb56f5788fff64896fd104b1b9e1c2a5",
  rfr_4_staged_apply: "a3b04e91bdfeaffe01efa506f02eb687d13148ff70b8f9278924d4116923290d",
});

export function checkTransportMirror(tag, text) {
  const f = transportForms().find((x) => tag.endsWith(`_${x.name}`));
  if (!f) return { problems: [`${tag} is not a registered rfr transport entry`] };
  const problems = [];
  if (text !== f.text && text !== `${f.text}\n`) problems.push(`${tag} is not exactly the registered ${f.name}`);
  if (f.hashes[0] !== REGISTERED_TRANSPORT_FORMS[f.name]) problems.push(`${tag}: rendering drifted from its pinned registration`);
  return f.role === "apply" ? { covers: f.source, problems } : { problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const files = renderAll();
  if (process.argv.includes("--write")) {
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true }); fs.writeFileSync(path.join(REPO, rel), text); }
  }
  let bad = 0;
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(REPO, rel); if (!(fs.existsSync(p) && fs.readFileSync(p, "utf8") === text)) { console.error(`DRIFT: ${rel}`); bad++; }
  }
  for (const f of transportForms()) console.log(`${f.role.padEnd(9)} ${f.name}  ${f.bytes} B  sha256 ${f.hashes[0]}`);
  console.log(bad ? `RFR_STAGED_TRANSPORT: DRIFT (${bad})` : `RFR_STAGED_TRANSPORT: OK (${Object.keys(files).length} files)`);
  process.exitCode = bad ? 1 : 0;
}
