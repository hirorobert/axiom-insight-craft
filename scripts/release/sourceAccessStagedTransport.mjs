// Exact-byte transport for the source-access repairs (20261211100000): membership removal revokes explicit workspace grants, and the
// atomic issuance decision + durable audit record for original-file download links. New private schema; preceding transports unchanged.
// Protocol follows ipsasStatementReviewStagedTransport.mjs (preservation baseline, pinned search_path, atomic consumption) with three
// differences specific to this source: (1) the predecessor is hosted id 97, accepted in BOTH the reviewed form and the form actually
// installed (the one-space wrapper variant, docs/release/ipsas-accrual-chain-r1/HOSTED_RECORD.md); (2) the source contains a
// session-level SET search_path, which this apply restores at session level so it cannot outlive the transaction on the migrator's
// connection; (3) the pre-installed check refuses if ANY object the source creates already exists, not only when all do.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { entryHashes as predecessorEntryHashes, BATCHES as PREDECESSOR_BATCHES, PRESERVED_TABLES as PREDECESSOR_PRESERVED, renderHostedEntry97Variant } from "./ipsasStatementReviewStagedTransport.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TRANSPORT_DIR = "release/staged-transport-source-access";
/** The commit that carries the migration bytes (the merged #229 head). Identity is the byte count + SHA-256; if the commit is unreachable
 *  the same bytes are read from the working tree and held to the same identity. */
export const SOURCE_COMMIT = "9e5cb9121ec9b713f0206b0dfe6b002c6cfd38aa";
const PREDECESSOR_LAST = PREDECESSOR_BATCHES.length;
const sha256Hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const journalHashes = (text) => [sha256Hex(Buffer.from(text, "utf8")), sha256Hex(Buffer.from(text + "\n", "utf8"))];
/** Hosted id 97 (0096_ipsas_3_statement_review_staged_apply): the reviewed wrapper and the one-space variant that is installed, each with and
 *  without the migrator's final LF. The journal must contain exactly ONE of these (the bootstrap's own count check). */
export const BOOTSTRAP_PREDECESSOR = Object.freeze({
  id: 97, tag: "0096_ipsas_3_statement_review_staged_apply",
  hashes: Object.freeze([...predecessorEntryHashes(PREDECESSOR_LAST + 0), ...journalHashes(renderHostedEntry97Variant())]),
});
export const BOOTSTRAP_NAME = "source_access_staged_transport";
export const PREREQUISITES = Object.freeze({
  tables: ["workspace_capability_grants", "workspace_capability_grant_events", "firm_members", "companies", "trial_balance_uploads"],
  functions: ["tbu_append_only_guard()", "workspace_authority_basis(uuid,uuid,text)", "_plan_write_lock(uuid)"],
});
export const NEW_FUNCTIONS = Object.freeze([
  "decide_trial_balance_source_download_issuance(uuid,uuid,uuid,timestamptz,timestamptz,integer,timestamptz,integer,text)",
  "record_trial_balance_source_download_denial(uuid,uuid,uuid,text)",
  "firm_members_revoke_workspace_grants()",
  "trial_balance_source_download_events_no_truncate()",
]);
const fnPresent = (f) => `to_regprocedure('public.${f}') IS NOT NULL`;
/** Every object is new (two functions are CREATE OR REPLACE'd, so ANY one existing already means an uncertain state). */
export const ANY_PRESENT = "to_regclass('public.trial_balance_source_download_events') IS NOT NULL OR " + NEW_FUNCTIONS.map(fnPresent).join(" OR ");
export const INSTALLED = "to_regclass('public.trial_balance_source_download_events') IS NOT NULL AND " + NEW_FUNCTIONS.map(fnPresent).join(" AND ") +
  " AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.firm_members'::regclass AND tgname = 'trg_firm_members_revoke_workspace_grants' AND NOT tgisinternal)";
export const BATCHES = Object.freeze([
  Object.freeze({ batch: "source-access-1", name: "source_access_1_staged_apply", source: "20261211100000_source_access_authority_repairs.sql", installed: INSTALLED, anyPresent: ANY_PRESENT,
    artifacts: { source: Object.freeze({ path: "supabase/migrations/20261211100000_source_access_authority_repairs.sql", bytes: 25437, sha256: "be582111440335aefc7da9c4cd7454f94e260f79b0e9098233d5e36c1736b344", commit: SOURCE_COMMIT }) } }),
]);

export const sha256 = sha256Hex;
export function committedBytes(rel, commit, repo = REPO) {
  try { return execFileSync("git", ["show", `${commit}:${rel}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return fs.readFileSync(path.join(repo, rel)); } // unreachable commit: the identity check in artifactBytes still applies
}
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
const LOCK = "PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_source_access_release_transport', 0));";
export function entryHashes(index) { return index < 0 ? [...BOOTSTRAP_PREDECESSOR.hashes] : journalHashes(index === 0 ? renderBootstrap() : renderApply(index - 1)); }

const predecessorCheck = (index = -1) => `  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1 OR v_pred_id <> ${BOOTSTRAP_PREDECESSOR.id + index + 1}
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;`;

// Fixed, reviewed relation names only; no caller-supplied identifier or executable body. The three grant/membership tables are preserved
// because this source adds a trigger to firm_members and acts on workspace grants: installing it must not change one existing row.
export const PRESERVED_TABLES = Object.freeze([...new Set([...PREDECESSOR_PRESERVED, "ipsas_presentation_revisions", "workspace_capability_grants", "workspace_capability_grant_events", "firm_members"])]);
const preservedTables = () => [...PRESERVED_TABLES];
const preserveLocks = (index) => `  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE ${preservedTables(index).sort().map(t => `public.${t}`).join(", ")} IN SHARE MODE;`;
const baseline = (index) => `SELECT encode(sha256(convert_to(jsonb_build_array(
${preservedTables(index).map(t => `    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.${t} t), '[]'::jsonb)`).join(",\n")}
  )::text, 'UTF8')), 'hex')`;

const approvedRows = () => BATCHES.flatMap((b) => Object.entries(b.artifacts).map(([k, a]) => `        (${q(b.batch)}, ${q(k)}, ${a.bytes}, ${q(a.sha256)})`)).join(",\n");

export function renderBootstrap() {
  return `-- CFOClose source-access-r1 staged transport bootstrap. GENERATED by scripts/release/sourceAccessStagedTransport.mjs; do not edit.
-- The source-access source is inert until a registered apply executes it.
DO $cfoclose_source_access_transport_bootstrap$
DECLARE
  c_predecessor CONSTANT text[] := ${arr(BOOTSTRAP_PREDECESSOR.hashes)};
  v_n bigint;
  v_pred_id bigint;
  v_role name;
BEGIN
  ${LOCK}
${predecessorCheck()}
  IF to_regnamespace('cfoclose_source_access_release') IS NOT NULL THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_ALREADY_INSTALLED: the transport schema exists; uncertain state requires review' USING ERRCODE = '55000';
  END IF;
  CREATE SCHEMA cfoclose_source_access_release;
  COMMENT ON SCHEMA cfoclose_source_access_release IS 'Release-only exact-byte transport for source-access-r1; never exposed to clients.';
  CREATE TABLE cfoclose_source_access_release.staged_artifacts (
    batch text NOT NULL, kind text NOT NULL CHECK (kind IN ('source','wrapper','preflight','postcondition')), body text NOT NULL CHECK (octet_length(convert_to(body, 'UTF8')) <= 54129),
    body_bytes integer NOT NULL, body_sha256 text NOT NULL, staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    staged_by name NOT NULL DEFAULT session_user, consumed_at timestamptz,
    PRIMARY KEY (batch, kind)
  );
  CREATE TABLE cfoclose_source_access_release.transport_events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch text NOT NULL,
    event text NOT NULL CHECK (event IN ('staged','applied')), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT clock_timestamp(), by_role name NOT NULL DEFAULT session_user
  );
  CREATE FUNCTION cfoclose_source_access_release.approved_artifact(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT a.bytes, a.sha256 FROM (VALUES
${approvedRows()}
      ) AS a(batch, kind, bytes, sha256) WHERE a.batch = p_batch AND a.kind = p_kind
    $fn$;
  CREATE FUNCTION cfoclose_source_access_release.staged_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE v_ok record;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_STAGE_REFUSED: staged rows start unconsumed' USING ERRCODE = '55000'; END IF;
        NEW.body_bytes := octet_length(convert_to(NEW.body, 'UTF8'));
        NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        SELECT * INTO v_ok FROM cfoclose_source_access_release.approved_artifact(NEW.batch, NEW.kind);
        IF v_ok.bytes IS NULL OR v_ok.bytes <> NEW.body_bytes OR v_ok.sha256 <> NEW.body_sha256 THEN
          RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_STAGE_REFUSED: % % is not an approved exact byte identity', NEW.batch, NEW.kind USING ERRCODE = '55000';
        END IF;
        INSERT INTO cfoclose_source_access_release.transport_events(batch, event, detail)
          VALUES (NEW.batch, 'staged', jsonb_build_object('kind', NEW.kind, 'bytes', NEW.body_bytes, 'sha256', NEW.body_sha256));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF coalesce(current_setting('cfoclose_source_access_release.applying', true), '') <> OLD.batch
           OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
           OR (NEW.batch, NEW.kind, NEW.body, NEW.body_bytes, NEW.body_sha256, NEW.staged_at, NEW.staged_by)
              IS DISTINCT FROM (OLD.batch, OLD.kind, OLD.body, OLD.body_bytes, OLD.body_sha256, OLD.staged_at, OLD.staged_by)
          THEN RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_STAGE_IMMUTABLE: only the owning apply may consume a row' USING ERRCODE = '55000'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_STAGE_IMMUTABLE: evidence is append-only' USING ERRCODE = '55000';
    END
    $fn$;
  CREATE FUNCTION cfoclose_source_access_release.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_EVIDENCE_IMMUTABLE: % is refused', TG_OP USING ERRCODE = '55000'; END
    $fn$;
  CREATE TRIGGER trg_staged_artifacts_guard BEFORE INSERT OR UPDATE OR DELETE ON cfoclose_source_access_release.staged_artifacts
    FOR EACH ROW EXECUTE FUNCTION cfoclose_source_access_release.staged_artifacts_guard();
  CREATE TRIGGER trg_staged_artifacts_no_truncate BEFORE TRUNCATE ON cfoclose_source_access_release.staged_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_source_access_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_append_only BEFORE UPDATE OR DELETE ON cfoclose_source_access_release.transport_events
    FOR EACH ROW EXECUTE FUNCTION cfoclose_source_access_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_no_truncate BEFORE TRUNCATE ON cfoclose_source_access_release.transport_events
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_source_access_release.append_only_guard();
  ALTER TABLE cfoclose_source_access_release.staged_artifacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cfoclose_source_access_release.transport_events ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA cfoclose_source_access_release FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_source_access_release FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA cfoclose_source_access_release FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_source_access_release.approved_artifact(text, text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_source_access_release.staged_artifacts_guard() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_source_access_release.append_only_guard() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA cfoclose_source_access_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_source_access_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA cfoclose_source_access_release FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_source_access_release.approved_artifact(text, text) FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_source_access_release.staged_artifacts_guard() FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_source_access_release.append_only_guard() FROM %I', v_role);
    END IF;
  END LOOP;
END
$cfoclose_source_access_transport_bootstrap$;`;
}

const pick = (b, k) => `  SELECT s.body INTO v_${k} FROM cfoclose_source_access_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = '${k}' AND s.consumed_at IS NULL
     AND s.body_bytes = ${b.artifacts[k].bytes} AND s.body_sha256 = '${b.artifacts[k].sha256}'
     AND octet_length(convert_to(s.body, 'UTF8')) = ${b.artifacts[k].bytes}
     AND encode(sha256(convert_to(s.body, 'UTF8')), 'hex') = '${b.artifacts[k].sha256}';
  IF v_${k} IS NULL THEN RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % ${k} is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;`;

// What the source must leave behind, role by role: the events table is read-only to authenticated and service_role (and invisible to
// anon), the two decision functions are executable by service_role only, and the two trigger functions by nobody.
const privilegePostcondition = `  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN CONTINUE; END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.trial_balance_source_download_events'::regclass)
       OR has_table_privilege(v_role, 'public.trial_balance_source_download_events', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR (v_role = 'anon' AND has_table_privilege(v_role, 'public.trial_balance_source_download_events', 'SELECT'))
       OR (v_role <> 'anon' AND NOT has_table_privilege(v_role, 'public.trial_balance_source_download_events', 'SELECT'))
       OR (v_role = 'service_role') IS DISTINCT FROM (has_function_privilege(v_role, 'public.decide_trial_balance_source_download_issuance(uuid,uuid,uuid,timestamptz,timestamptz,integer,timestamptz,integer,text)', 'EXECUTE')
             AND has_function_privilege(v_role, 'public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text)', 'EXECUTE'))
       OR (v_role <> 'service_role' AND (has_function_privilege(v_role, 'public.decide_trial_balance_source_download_issuance(uuid,uuid,uuid,timestamptz,timestamptz,integer,timestamptz,integer,text)', 'EXECUTE')
             OR has_function_privilege(v_role, 'public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text)', 'EXECUTE')))
       OR has_function_privilege(v_role, 'public.firm_members_revoke_workspace_grants()', 'EXECUTE')
       OR has_function_privilege(v_role, 'public.trial_balance_source_download_events_no_truncate()', 'EXECUTE') THEN
      RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_PRIVILEGE_POSTCONDITION: % has an unexpected privilege on the installed objects; rolled back', v_role USING ERRCODE = '55000';
    END IF;
  END LOOP;`;

export function renderApply(index) {
  const b = BATCHES[index]; if (!b) throw new Error(`no source-access batch ${index}`);
  const prior = index === 0 ? null : BATCHES[index - 1];
  const kinds = Object.keys(b.artifacts);
  const tag = `$cfoclose_source_access_transport_${b.batch.replace(/-/g, "_")}$`;
  return `-- CFOClose source-access-r1 staged transport: apply ${b.source}. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing schedules, disclosures, sign-offs, grants, memberships, authority, issuances and runtime settings must be unchanged. One atomic statement.
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
  IF to_regnamespace('cfoclose_source_access_release') IS NULL THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(${arr(PREREQUISITES.tables.map((t) => "public." + t))}) t WHERE to_regclass(t) IS NULL)
     OR EXISTS (SELECT 1 FROM unnest(${arr(PREREQUISITES.functions.map((f) => "public." + f))}) f WHERE to_regprocedure(f) IS NULL) THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_PREREQUISITE_MISSING: the workspace grant tables, the authority predicate, the plan lock and the append-only guard this source depends on are absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_source_access_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_source_access_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_source_access_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_source_access_release.staged_artifacts WHERE batch = c_batch) <> ${kinds.length} THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly ${kinds.length} staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF ${b.anyPresent} THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_UNCERTAIN_STATE: % has objects present without a consumed transport record', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
${kinds.map((k) => pick(b, k)).join("\n")}
${preserveLocks(index)}
  v_baseline := (${baseline(index)});
  PERFORM set_config('cfoclose_source_access_release.applying', c_batch, true);
  -- The source binds unqualified names through the executing session's search_path and itself contains a session-level SET search_path.
  -- Pin the path for the source, then restore the ORIGINAL path at SESSION level so the source's SET cannot outlive this transaction.
  v_search_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog, public', true);
${kinds.includes("preflight") ? "  EXECUTE v_preflight;\n" : ""}  EXECUTE v_source;
${kinds.includes("postcondition") ? "  EXECUTE v_postcondition;\n" : ""}  PERFORM set_config('search_path', v_search_path, false);
  IF NOT (${b.installed}) THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_POSTCONDITION: % did not install its target', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
${privilegePostcondition}
  IF (${baseline(index)}) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_TRANSPORT_BASELINE_CHANGED: a preserved financial record, grant, membership or runtime setting changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_source_access_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_source_access_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', ${q(b.source)}, 'baseline_sha256', v_baseline,
${kinds.map((k) => `      '${k}_sha256', '${b.artifacts[k].sha256}'`).join(",\n")}));
  PERFORM set_config('cfoclose_source_access_release.applying', '', true);
END
${tag};`;
}

export function renderStage(index, kind, repo = REPO) {
  const b = BATCHES[index]; if (!b?.artifacts[kind]) throw new Error("invalid source-access artifact");
  const text = artifactBytes(index, kind, repo).toString("utf8");
  const dq = `$cfoclose_source_access_stage_${b.artifacts[kind].sha256.slice(0, 16)}$`;
  if (text.includes(dq)) throw new Error(`${b.batch}/${kind} contains its staging quote`);
  return `INSERT INTO cfoclose_source_access_release.staged_artifacts(batch, kind, body) VALUES (${q(b.batch)}, ${q(kind)}, ${dq}${text}${dq});\n`;
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
  source_access_staged_transport: "9d95500fbcf35c6dc7c1c15238afc06e81ec847816b7ede703e3f40c54f6e415",
  source_access_1_staged_apply: "d31be75cbcd95962dda56aaea235521668780a8b7cd5a24643bf640c21f4f287",
});

export function checkTransportMirror(tag, text) {
  const f = transportForms().find((x) => tag.endsWith(`_${x.name}`));
  if (!f) return { problems: [`${tag} is not a registered source-access transport entry`] };
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
  console.log(bad ? `SOURCE_ACCESS_STAGED_TRANSPORT: DRIFT (${bad})` : `SOURCE_ACCESS_STAGED_TRANSPORT: OK (${Object.keys(files).length} files)`);
  process.exitCode = bad ? 1 : 0;
}
