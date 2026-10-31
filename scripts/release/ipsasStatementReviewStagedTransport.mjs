// Exact-byte IPSAS statement-review transport. New private schema; preceding transports stay unchanged.
// Protocol follows ipsasGrantsStagedTransport.mjs, including preservation, pinned search_path and atomic consumption.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { entryHashes as predecessorEntryHashes, BATCHES as PREDECESSOR_BATCHES, PRESERVED_TABLES as PREDECESSOR_PRESERVED } from "./ipsasGrantsStagedTransport.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TRANSPORT_DIR = "release/staged-transport-ipsas-statement-review";
/** The commit that introduced the migration bytes (feat/ipsas-authenticated-statement-review). Identity is the byte count + SHA-256; if the
 *  commit is unreachable (squash merge) the same bytes are read from the working tree and held to the same identity. */
export const SOURCE_COMMIT = "4e664b377a1536033d4a2cfa21a2af5b3375568a";
const PREDECESSOR_LAST = PREDECESSOR_BATCHES.length; // entryHashes(n) = the journal forms of the n-th preparation entry after its bootstrap
/** The preceding grants transport's final expected entry (0094_ipsas_2_grants_staged_apply, expected hosted id 95): the exact journal head required. */
export const BOOTSTRAP_PREDECESSOR = Object.freeze({ id: 95, tag: "0094_ipsas_2_grants_staged_apply", hashes: Object.freeze(predecessorEntryHashes(PREDECESSOR_LAST + 0)) });
export const BOOTSTRAP_NAME = "ipsas_statement_review_staged_transport";
export const PREREQUISITES = Object.freeze({
  tables: ["companies", "tb_certifications", "fiscal_periods", "trial_balance_uploads", "ipsas_grant_revisions"],
  functions: ["_ipsas_immutable()", "_ipsas_refusal(uuid,uuid,text)", "_ipsas_authorize_mutation(uuid,uuid,text)",
    "_fs_reporting_input_compute(uuid,integer)", "_fs_scope_lock(uuid,integer)", "tb_official_output_lock(uuid,integer)", "_fs_section(text)"],
});
export const RPCS = Object.freeze(["ipsas_statement_review(uuid,integer)", "ipsas_save_presentation(uuid,integer,jsonb,uuid,text,uuid)"]);
export const INSTALLED = "to_regclass('public.ipsas_presentation_revisions') IS NOT NULL AND " + RPCS.map(f=>"to_regprocedure('public."+f+"') IS NOT NULL").join(" AND ");
export const BATCHES = Object.freeze([
  Object.freeze({ batch: "ipsas-3-statement-review", name: "ipsas_3_statement_review_staged_apply", source: "20261210100000_ipsas_statement_review.sql", installed: INSTALLED,
    artifacts: { source: Object.freeze({ path: "supabase/migrations/20261210100000_ipsas_statement_review.sql", bytes: 19538, sha256: "ec966e4fd1598f947ccd58b096cde0a1b3f842456aa02acec6bf39db508091c2", commit: SOURCE_COMMIT }) } }),
]);

export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export function committedBytes(rel, commit, repo = REPO) {
  try { return execFileSync("git", ["show", `${commit}:${rel}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return fs.readFileSync(path.join(repo, rel)); } // unreachable commit: the identity check in artifactBytes still applies
}
/** The exact bytes of one artifact (wrapper rendered from the committed source), checked against its pinned identity. */
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
const journalHashes = (text) => [sha256(Buffer.from(text, "utf8")), sha256(Buffer.from(text + "\n", "utf8"))];
const LOCK = "PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_ipsas_statement_release_transport', 0));";
export function entryHashes(index) { return index < 0 ? [...BOOTSTRAP_PREDECESSOR.hashes] : journalHashes(index === 0 ? renderBootstrap() : renderApply(index - 1)); }

const predecessorCheck = (index = -1) => `  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1 OR v_pred_id <> ${BOOTSTRAP_PREDECESSOR.id + index + 1}
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;`;

// Fixed, reviewed relation names only; no caller-supplied identifier or executable body.
export const PRESERVED_TABLES = Object.freeze([...new Set([...PREDECESSOR_PRESERVED, "ipsas_grant_revisions", "ipsas_grant_confirmations"])]);
// No financial/settings writes can race between the before/after snapshots. These short SHARE locks also protect an
// installation from misattributing a concurrent user's change. A lock timeout rolls back this migrator transaction.
const preservedTables = () => [...PRESERVED_TABLES];
const preserveLocks = (index) => `  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE ${preservedTables(index).sort().map(t => `public.${t}`).join(", ")} IN SHARE MODE;`;
const baseline = (index) => `SELECT encode(sha256(convert_to(jsonb_build_array(
${preservedTables(index).map(t => `    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.${t} t), '[]'::jsonb)`).join(",\n")}
  )::text, 'UTF8')), 'hex')`;

const approvedRows = () => BATCHES.flatMap((b) => Object.entries(b.artifacts).map(([k, a]) => `        (${q(b.batch)}, ${q(k)}, ${a.bytes}, ${q(a.sha256)})`)).join(",\n");

export function renderBootstrap() {
  return `-- CFOClose ipsas-statement-review-r1 staged transport bootstrap. GENERATED by scripts/release/ipsasStagedTransport.mjs; do not edit.
-- The IPSAS grants source is inert until a registered apply executes it.
DO $cfoclose_ipsas_statement_transport_bootstrap$
DECLARE
  c_predecessor CONSTANT text[] := ${arr(BOOTSTRAP_PREDECESSOR.hashes)};
  v_n bigint;
  v_pred_id bigint;
  v_role name;
BEGIN
  ${LOCK}
${predecessorCheck()}
  IF to_regnamespace('cfoclose_ipsas_statement_release') IS NOT NULL THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_ALREADY_INSTALLED: the transport schema exists; uncertain state requires review' USING ERRCODE = '55000';
  END IF;
  CREATE SCHEMA cfoclose_ipsas_statement_release;
  COMMENT ON SCHEMA cfoclose_ipsas_statement_release IS 'Release-only exact-byte transport for ipsas-statement-review-r1; never exposed to clients.';
  CREATE TABLE cfoclose_ipsas_statement_release.staged_artifacts (
    batch text NOT NULL, kind text NOT NULL CHECK (kind IN ('source','wrapper','preflight','postcondition')), body text NOT NULL CHECK (octet_length(convert_to(body, 'UTF8')) <= 54129),
    body_bytes integer NOT NULL, body_sha256 text NOT NULL, staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    staged_by name NOT NULL DEFAULT session_user, consumed_at timestamptz,
    PRIMARY KEY (batch, kind)
  );
  CREATE TABLE cfoclose_ipsas_statement_release.transport_events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch text NOT NULL,
    event text NOT NULL CHECK (event IN ('staged','applied')), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT clock_timestamp(), by_role name NOT NULL DEFAULT session_user
  );
  CREATE FUNCTION cfoclose_ipsas_statement_release.approved_artifact(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT a.bytes, a.sha256 FROM (VALUES
${approvedRows()}
      ) AS a(batch, kind, bytes, sha256) WHERE a.batch = p_batch AND a.kind = p_kind
    $fn$;
  CREATE FUNCTION cfoclose_ipsas_statement_release.staged_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE v_ok record;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_STAGE_REFUSED: staged rows start unconsumed' USING ERRCODE = '55000'; END IF;
        NEW.body_bytes := octet_length(convert_to(NEW.body, 'UTF8'));
        NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        SELECT * INTO v_ok FROM cfoclose_ipsas_statement_release.approved_artifact(NEW.batch, NEW.kind);
        IF v_ok.bytes IS NULL OR v_ok.bytes <> NEW.body_bytes OR v_ok.sha256 <> NEW.body_sha256 THEN
          RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_STAGE_REFUSED: % % is not an approved exact byte identity', NEW.batch, NEW.kind USING ERRCODE = '55000';
        END IF;
        INSERT INTO cfoclose_ipsas_statement_release.transport_events(batch, event, detail)
          VALUES (NEW.batch, 'staged', jsonb_build_object('kind', NEW.kind, 'bytes', NEW.body_bytes, 'sha256', NEW.body_sha256));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF coalesce(current_setting('cfoclose_ipsas_statement_release.applying', true), '') <> OLD.batch
           OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
           OR (NEW.batch, NEW.kind, NEW.body, NEW.body_bytes, NEW.body_sha256, NEW.staged_at, NEW.staged_by)
              IS DISTINCT FROM (OLD.batch, OLD.kind, OLD.body, OLD.body_bytes, OLD.body_sha256, OLD.staged_at, OLD.staged_by)
          THEN RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_STAGE_IMMUTABLE: only the owning apply may consume a row' USING ERRCODE = '55000'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_STAGE_IMMUTABLE: evidence is append-only' USING ERRCODE = '55000';
    END
    $fn$;
  CREATE FUNCTION cfoclose_ipsas_statement_release.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_EVIDENCE_IMMUTABLE: % is refused', TG_OP USING ERRCODE = '55000'; END
    $fn$;
  CREATE TRIGGER trg_staged_artifacts_guard BEFORE INSERT OR UPDATE OR DELETE ON cfoclose_ipsas_statement_release.staged_artifacts
    FOR EACH ROW EXECUTE FUNCTION cfoclose_ipsas_statement_release.staged_artifacts_guard();
  CREATE TRIGGER trg_staged_artifacts_no_truncate BEFORE TRUNCATE ON cfoclose_ipsas_statement_release.staged_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_ipsas_statement_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_append_only BEFORE UPDATE OR DELETE ON cfoclose_ipsas_statement_release.transport_events
    FOR EACH ROW EXECUTE FUNCTION cfoclose_ipsas_statement_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_no_truncate BEFORE TRUNCATE ON cfoclose_ipsas_statement_release.transport_events
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_ipsas_statement_release.append_only_guard();
  ALTER TABLE cfoclose_ipsas_statement_release.staged_artifacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cfoclose_ipsas_statement_release.transport_events ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA cfoclose_ipsas_statement_release FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_ipsas_statement_release FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA cfoclose_ipsas_statement_release FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_ipsas_statement_release.approved_artifact(text, text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_ipsas_statement_release.staged_artifacts_guard() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_ipsas_statement_release.append_only_guard() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA cfoclose_ipsas_statement_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_ipsas_statement_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA cfoclose_ipsas_statement_release FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_ipsas_statement_release.approved_artifact(text, text) FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_ipsas_statement_release.staged_artifacts_guard() FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_ipsas_statement_release.append_only_guard() FROM %I', v_role);
    END IF;
  END LOOP;
END
$cfoclose_ipsas_statement_transport_bootstrap$;`;
}

const pick = (b, k) => `  SELECT s.body INTO v_${k} FROM cfoclose_ipsas_statement_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = '${k}' AND s.consumed_at IS NULL
     AND s.body_bytes = ${b.artifacts[k].bytes} AND s.body_sha256 = '${b.artifacts[k].sha256}'
     AND octet_length(convert_to(s.body, 'UTF8')) = ${b.artifacts[k].bytes}
     AND encode(sha256(convert_to(s.body, 'UTF8')), 'hex') = '${b.artifacts[k].sha256}';
  IF v_${k} IS NULL THEN RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % ${k} is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;`;

export function renderApply(index) {
  const b = BATCHES[index]; if (!b) throw new Error(`no IPSAS batch ${index}`);
  const prior = index === 0 ? null : BATCHES[index - 1];
  const kinds = Object.keys(b.artifacts);
  const tag = `$cfoclose_ipsas_statement_transport_${b.batch.replace(/-/g, "_")}$`;
  return `-- CFOClose ipsas-statement-review-r1 staged transport: apply ${b.source}. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing schedules, disclosures, sign-offs, authority, issuances and runtime settings must be unchanged. One atomic statement.
DO ${tag}
DECLARE
  c_batch CONSTANT text := ${q(b.batch)};
  c_prior CONSTANT text := ${prior ? q(prior.batch) : "NULL"};
  c_prior_kinds CONSTANT integer := ${prior ? Object.keys(prior.artifacts).length : 0};
  c_predecessor CONSTANT text[] := ${arr(entryHashes(index))};
  v_n bigint; v_pred_id bigint; v_baseline text; v_role text; v_search_path text; v_${kinds.join(" text; v_")} text;
BEGIN
  ${LOCK}
${predecessorCheck(index)}
  IF to_regnamespace('cfoclose_ipsas_statement_release') IS NULL THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(${arr(PREREQUISITES.tables.map((t) => "public." + t))}) t WHERE to_regclass(t) IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(${arr(PREREQUISITES.functions.map((f) => "public." + f))}) f WHERE to_regprocedure(f) IS NULL) THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_PREREQUISITE_MISSING: the IPSAS preparation, certification or capability objects this source depends on are absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_ipsas_statement_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_ipsas_statement_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_ipsas_statement_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_ipsas_statement_release.staged_artifacts WHERE batch = c_batch) <> ${kinds.length} THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly ${kinds.length} staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF ${b.installed} THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
${kinds.map((k) => pick(b, k)).join("\n")}
${preserveLocks(index)}
  v_baseline := (${baseline(index)});
  PERFORM set_config('cfoclose_ipsas_statement_release.applying', c_batch, true);
  -- The source has unqualified names (DEFAULT gen_random_uuid()) that bind through the executing session's search_path: with
  -- public ahead of pg_catalog they can bind to a public/pgcrypto function instead of the core one. Pin the path for the source only.
  v_search_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog, public', true);
${kinds.includes("preflight") ? "  EXECUTE v_preflight;\n" : ""}  EXECUTE v_source;
${kinds.includes("postcondition") ? "  EXECUTE v_postcondition;\n" : ""}  PERFORM set_config('search_path', v_search_path, true);
  IF NOT (${b.installed}) THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_POSTCONDITION: % did not install its target', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN CONTINUE; END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid='public.ipsas_presentation_revisions'::regclass)
       OR has_table_privilege(v_role, 'public.ipsas_presentation_revisions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_sequence_privilege(v_role, 'public.ipsas_presentation_revisions_seq_seq', 'USAGE,SELECT,UPDATE')
       OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,7)='_ipsas_' AND has_function_privilege(v_role,p.oid,'EXECUTE'))
       OR (v_role='authenticated') IS DISTINCT FROM (has_function_privilege(v_role,'public.ipsas_statement_review(uuid,integer)','EXECUTE')
             AND has_function_privilege(v_role,'public.ipsas_save_presentation(uuid,integer,jsonb,uuid,text,uuid)','EXECUTE'))
       OR (v_role<>'authenticated' AND (has_function_privilege(v_role,'public.ipsas_statement_review(uuid,integer)','EXECUTE')
             OR has_function_privilege(v_role,'public.ipsas_save_presentation(uuid,integer,jsonb,uuid,text,uuid)','EXECUTE'))) THEN
      RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_PRIVILEGE_POSTCONDITION: % has an unexpected privilege on the installed objects; rolled back', v_role USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF (${baseline(index)}) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'IPSAS_STATEMENT_TRANSPORT_BASELINE_CHANGED: a preserved financial record or runtime setting changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_ipsas_statement_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_ipsas_statement_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', ${q(b.source)}, 'baseline_sha256', v_baseline,
${kinds.map((k) => `      '${k}_sha256', '${b.artifacts[k].sha256}'`).join(",\n")}));
  PERFORM set_config('cfoclose_ipsas_statement_release.applying', '', true);
END
${tag};`;
}

export function renderStage(index, kind, repo = REPO) {
  const b = BATCHES[index]; if (!b?.artifacts[kind]) throw new Error("invalid IPSAS artifact");
  const text = artifactBytes(index, kind, repo).toString("utf8");
  const dq = `$cfoclose_ipsas_statement_stage_${b.artifacts[kind].sha256.slice(0, 16)}$`;
  if (text.includes(dq)) throw new Error(`${b.batch}/${kind} contains its staging quote`);
  return `INSERT INTO cfoclose_ipsas_statement_release.staged_artifacts(batch, kind, body) VALUES (${q(b.batch)}, ${q(kind)}, ${dq}${text}${dq});\n`;
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

/** Reviewed transport forms (pinned renderings). Hosted journal entries are registered only after canonical execution. */
export const REGISTERED_TRANSPORT_FORMS = Object.freeze({
  ipsas_statement_review_staged_transport: "80e13144450e0e08e7cfa0df3f040cf29ea7aa8d4643d85ec80939b82287fbc5",
  ipsas_3_statement_review_staged_apply: "abde2b8d463fd017e733fe36cbfe74e58151eb2d2f95aa69c34b6310bde53fe1",
});

export function checkTransportMirror(tag, text) {
  const f = transportForms().find((x) => tag.endsWith(`_${x.name}`));
  if (!f) return { problems: [`${tag} is not a registered IPSAS transport entry`] };
  const problems = [];
  if (text !== f.text && text !== `${f.text}\n`) problems.push(`${tag} is not exactly the registered ${f.name}`);
  if (f.hashes[0] !== REGISTERED_TRANSPORT_FORMS[f.name]) problems.push(`${tag}: rendering drifted from its pinned registration`);
  return f.role === "apply" ? { covers: f.source, problems } : { problems };
}

/**
 * Hosted journal entry 97 (2026-10-31, drizzle 0096). The installing agent re-typed the apply wrapper instead of submitting
 * the reviewed file unchanged: ONE extra leading space on exactly one line (the second has_function_privilege line of the
 * privilege postcondition), so the installed wrapper is the reviewed text plus that space (14,296 B; the migrator then adds its
 * usual final LF). The staged SOURCE was exact (trigger-pinned) and every postcondition passed.
 *
 * This is registered ONLY as an observed, byte-pinned fact so the migration-authority guard can describe what is installed.
 * It is NOT an acceptance: the strict check above still rejects it, and the reviewer/owner decision is open
 * (docs/release/ipsas-accrual-chain-r1/HOSTED_RECORD.md). Removing the registry entry turns the guard red again.
 */
export const HOSTED_ENTRY_97_VARIANT = Object.freeze({
  tag: "0096_ipsas_3_statement_review_staged_apply",
  sha256: "a7606257683633b6af60563d80a03d9f6f2e89879ec4739fca618b1598cbe59c",
  bytes: 14296,
  journalSha256: "023484a1f9ad9ce298b03ec3f15d76c8df2dec2a9b8675749ef334ab3f8e7c17",
  insertedSpaceBeforeLine: "             AND has_function_privilege(v_role,'public.ipsas_save_presentation(uuid,integer,jsonb,uuid,text,uuid)','EXECUTE'))",
  decision: "PENDING_REVIEWER",
});

export function renderHostedEntry97Variant() {
  const lines = renderApply(0).split("\n");
  const hits = lines.map((l, i) => (l === HOSTED_ENTRY_97_VARIANT.insertedSpaceBeforeLine ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw new Error(`expected exactly one anchor line for the entry 97 variant, found ${hits.length}`);
  lines[hits[0]] = ` ${lines[hits[0]]}`;
  return lines.join("\n");
}

export function checkHostedEntry97Variant(tag, text) {
  if (tag !== HOSTED_ENTRY_97_VARIANT.tag) return { problems: [`${tag} is not the hosted entry 97 variant entry`] };
  const problems = [];
  const v = renderHostedEntry97Variant();
  const bytes = Buffer.from(v, "utf8");
  if (text !== v && text !== `${v}\n`) problems.push(`${tag} is not exactly the observed hosted entry 97 variant (reviewed wrapper plus one space on one line)`);
  if (bytes.length !== HOSTED_ENTRY_97_VARIANT.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== HOSTED_ENTRY_97_VARIANT.sha256) problems.push(`${tag}: the variant drifted from its pinned bytes`);
  if (crypto.createHash("sha256").update(Buffer.concat([bytes, Buffer.from("\n")])).digest("hex") !== HOSTED_ENTRY_97_VARIANT.journalSha256) problems.push(`${tag}: the variant no longer matches the recorded hosted journal hash`);
  return { covers: BATCHES[0].source, problems };
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
  console.log(bad ? `IPSAS_STATEMENT_STAGED_TRANSPORT: DRIFT (${bad})` : `IPSAS_STATEMENT_STAGED_TRANSPORT: OK (${Object.keys(files).length} files)`);
  process.exitCode = bad ? 1 : 0;
}
