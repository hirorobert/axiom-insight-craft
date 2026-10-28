// EQUIPMENT exact-byte transport. Authored sources are pinned; hosted application remains pending.
// Reuses the immutable Track A contract in its OWN private schema, never alters that journalled module.
// Exact-byte candidate transport: equipment preparation followed by multi-class equipment preparation.
//
// Same contract as fsIntegrityStagedTransport.mjs (which stays byte-identical because it is journalled): a private schema
// holds the committed bytes as inert, content-checked data; ONE small registered apply migration per source verifies and
// executes exactly that staged text once, through the canonical journalled migrator (which keeps owning its journal row
// and mirror).
//
//   bootstrap  schema cfoclose_eqp_release: staged_artifacts (insert checked against literal byte count + SHA-256;
//              consumed only inside its owning apply; no delete / truncate) and append-only transport_events. RLS on,
//              no policies, every privilege revoked from PUBLIC / anon / authenticated / service_role; no generic executor.
//   apply (x2) one DO statement: transport lock -> journal locked and exactly the approved predecessor -> prior batch
//              consumed -> own rows locked, unconsumed, exact identities -> target not already present -> baseline of
//              all explicitly preserved records and runtime settings
//              captured -> EXECUTE exact approved source ->
//              target present -> baseline unchanged -> consume + event. Any failure rolls the whole statement back,
//              consumption included; prior committed staging is retained. Never atomic ACROSS the two batches.
//
// ORDER: bootstrap -> stage -> apply 1 -> apply 2 -> preservation verification -> frontend publication (separately authorized).
//
// Sources are committed authored bytes; the canonical migrator owns every hosted journal row.
//
//   node scripts/release/equipmentStagedTransport.mjs --write | --check
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TRANSPORT_DIR = "release/staged-transport-equipment";
export const SOURCE_COMMIT = "b7ac24017b0b99a8ba2a125066d67e8f44d8284a";
export const BOOTSTRAP_PREDECESSOR = Object.freeze({ id:88, tag:"0087_internal_beta_team_bootstrap",hash:"238d8b0664b253cd665c8e9b9532326486e86ad087f1a76dda56846cc0a0edb8" });
export const BOOTSTRAP_NAME = "equipment_staged_transport";
export const BATCHES = Object.freeze([
  Object.freeze({batch: "eqp-1-preparation", name: "eqp_1_preparation_staged_apply", source: "20261205100000_fs_equipment_preparation.sql", installed: "to_regclass('public.fs_equipment_workpapers') IS NOT NULL AND to_regclass('public.fs_equipment_policy_insertions') IS NOT NULL AND to_regprocedure('public.fs_create_equipment_schedule(uuid,integer,jsonb,text,uuid)') IS NOT NULL", artifacts: {source: Object.freeze({path:"supabase/migrations/20261205100000_fs_equipment_preparation.sql",bytes:18476,sha256:"6a2a33c7d6c35d917172a1df42561e7d6a4ce2838a96e27764889bc75e61b9f7",commit:SOURCE_COMMIT})}}),
  Object.freeze({batch: "eqp-2-multiclass", name: "eqp_2_multiclass_staged_apply", source: "20261206100000_fs_equipment_multiclass.sql", installed: "to_regclass('public.fs_equipment_answers') IS NOT NULL AND to_regprocedure('public.fs_equipment_context_v2(uuid,integer)') IS NOT NULL", artifacts: {source: Object.freeze({path:"supabase/migrations/20261206100000_fs_equipment_multiclass.sql",bytes:54129,sha256:"c73085b386cb461977b9072b4ec753ea23c0bf8f8474e1693a86fad3f97e585e",commit:SOURCE_COMMIT})}})
]);

export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export function committedBytes(rel, commit, repo = REPO) {
  return execFileSync("git", ["show", `${commit}:${rel}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
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
const LOCK = "PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_eqp_release_transport', 0));";
export function entryHashes(index) { return index < 0 ? [BOOTSTRAP_PREDECESSOR.hash] : journalHashes(index === 0 ? renderBootstrap() : renderApply(index - 1)); }

const predecessorCheck = (index = -1) => `  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1 OR v_pred_id <> ${BOOTSTRAP_PREDECESSOR.id + index + 1}
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;`;

// Fixed, reviewed relation names only; no caller-supplied identifier or executable body.
export const PRESERVED_TABLES = Object.freeze([
  "companies", "fs_publication_bindings", "reporting_pack_issuances", "fs_report_authority", "fs_report_authority_events",
  "fs_schedule_definitions", "fs_schedule_submissions", "fs_disclosure_texts",
  "financial_statements_rollout_state", "financial_statements_rollout_companies", "financial_statements_rollout_audit",
  "ai_assistant_settings", "internal_beta_policy", "commercial_platform_state",
]);
// No financial/settings writes can race between the before/after snapshots. These short SHARE locks also protect an
// installation from misattributing a concurrent user's change. A lock timeout rolls back this migrator transaction.
const preservedTables = (index) => [...PRESERVED_TABLES, ...(index === 1 ? ["fs_equipment_workpapers", "fs_equipment_policy_insertions"] : [])];
const preserveLocks = (index) => `  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE ${preservedTables(index).sort().map(t => `public.${t}`).join(", ")} IN SHARE MODE;`;
const baseline = (index) => `SELECT encode(sha256(convert_to(jsonb_build_array(
${preservedTables(index).map(t => `    coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.${t} t), '[]'::jsonb)`).join(",\n")}
  )::text, 'UTF8')), 'hex')`;

const approvedRows = () => BATCHES.flatMap((b) => Object.entries(b.artifacts).map(([k, a]) => `        (${q(b.batch)}, ${q(k)}, ${a.bytes}, ${q(a.sha256)})`)).join(",\n");

export function renderBootstrap() {
  return `-- CFOClose equipment-r1 staged transport bootstrap. GENERATED by scripts/release/equipmentStagedTransport.mjs; do not edit.
-- Equipment preparation and multiclass sources are inert until a registered apply executes them.
DO $cfoclose_eqp_transport_bootstrap$
DECLARE
  c_predecessor CONSTANT text[] := ARRAY[${q(BOOTSTRAP_PREDECESSOR.hash)}]::text[];
  v_n bigint;
  v_pred_id bigint;
  v_role name;
BEGIN
  ${LOCK}
${predecessorCheck()}
  IF to_regnamespace('cfoclose_eqp_release') IS NOT NULL THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_ALREADY_INSTALLED: the transport schema exists; uncertain state requires review' USING ERRCODE = '55000';
  END IF;
  CREATE SCHEMA cfoclose_eqp_release;
  COMMENT ON SCHEMA cfoclose_eqp_release IS 'Release-only exact-byte transport for equipment-r1; never exposed to clients.';
  CREATE TABLE cfoclose_eqp_release.staged_artifacts (
    batch text NOT NULL, kind text NOT NULL CHECK (kind IN ('source','wrapper','preflight','postcondition')), body text NOT NULL CHECK (octet_length(convert_to(body, 'UTF8')) <= 54129),
    body_bytes integer NOT NULL, body_sha256 text NOT NULL, staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    staged_by name NOT NULL DEFAULT session_user, consumed_at timestamptz,
    PRIMARY KEY (batch, kind)
  );
  CREATE TABLE cfoclose_eqp_release.transport_events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch text NOT NULL,
    event text NOT NULL CHECK (event IN ('staged','applied')), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT clock_timestamp(), by_role name NOT NULL DEFAULT session_user
  );
  CREATE FUNCTION cfoclose_eqp_release.approved_artifact(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT a.bytes, a.sha256 FROM (VALUES
${approvedRows()}
      ) AS a(batch, kind, bytes, sha256) WHERE a.batch = p_batch AND a.kind = p_kind
    $fn$;
  CREATE FUNCTION cfoclose_eqp_release.staged_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE v_ok record;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_STAGE_REFUSED: staged rows start unconsumed' USING ERRCODE = '55000'; END IF;
        NEW.body_bytes := octet_length(convert_to(NEW.body, 'UTF8'));
        NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        SELECT * INTO v_ok FROM cfoclose_eqp_release.approved_artifact(NEW.batch, NEW.kind);
        IF v_ok.bytes IS NULL OR v_ok.bytes <> NEW.body_bytes OR v_ok.sha256 <> NEW.body_sha256 THEN
          RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_STAGE_REFUSED: % % is not an approved exact byte identity', NEW.batch, NEW.kind USING ERRCODE = '55000';
        END IF;
        INSERT INTO cfoclose_eqp_release.transport_events(batch, event, detail)
          VALUES (NEW.batch, 'staged', jsonb_build_object('kind', NEW.kind, 'bytes', NEW.body_bytes, 'sha256', NEW.body_sha256));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF coalesce(current_setting('cfoclose_eqp_release.applying', true), '') <> OLD.batch
           OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
           OR (NEW.batch, NEW.kind, NEW.body, NEW.body_bytes, NEW.body_sha256, NEW.staged_at, NEW.staged_by)
              IS DISTINCT FROM (OLD.batch, OLD.kind, OLD.body, OLD.body_bytes, OLD.body_sha256, OLD.staged_at, OLD.staged_by)
          THEN RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_STAGE_IMMUTABLE: only the owning apply may consume a row' USING ERRCODE = '55000'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_STAGE_IMMUTABLE: evidence is append-only' USING ERRCODE = '55000';
    END
    $fn$;
  CREATE FUNCTION cfoclose_eqp_release.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_EVIDENCE_IMMUTABLE: % is refused', TG_OP USING ERRCODE = '55000'; END
    $fn$;
  CREATE TRIGGER trg_staged_artifacts_guard BEFORE INSERT OR UPDATE OR DELETE ON cfoclose_eqp_release.staged_artifacts
    FOR EACH ROW EXECUTE FUNCTION cfoclose_eqp_release.staged_artifacts_guard();
  CREATE TRIGGER trg_staged_artifacts_no_truncate BEFORE TRUNCATE ON cfoclose_eqp_release.staged_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_eqp_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_append_only BEFORE UPDATE OR DELETE ON cfoclose_eqp_release.transport_events
    FOR EACH ROW EXECUTE FUNCTION cfoclose_eqp_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_no_truncate BEFORE TRUNCATE ON cfoclose_eqp_release.transport_events
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_eqp_release.append_only_guard();
  ALTER TABLE cfoclose_eqp_release.staged_artifacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cfoclose_eqp_release.transport_events ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA cfoclose_eqp_release FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_eqp_release FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA cfoclose_eqp_release FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_eqp_release.approved_artifact(text, text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_eqp_release.staged_artifacts_guard() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_eqp_release.append_only_guard() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA cfoclose_eqp_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_eqp_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA cfoclose_eqp_release FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_eqp_release.approved_artifact(text, text) FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_eqp_release.staged_artifacts_guard() FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_eqp_release.append_only_guard() FROM %I', v_role);
    END IF;
  END LOOP;
END
$cfoclose_eqp_transport_bootstrap$;`;
}

const pick = (b, k) => `  SELECT s.body INTO v_${k} FROM cfoclose_eqp_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = '${k}' AND s.consumed_at IS NULL
     AND s.body_bytes = ${b.artifacts[k].bytes} AND s.body_sha256 = '${b.artifacts[k].sha256}'
     AND octet_length(convert_to(s.body, 'UTF8')) = ${b.artifacts[k].bytes}
     AND encode(sha256(convert_to(s.body, 'UTF8')), 'hex') = '${b.artifacts[k].sha256}';
  IF v_${k} IS NULL THEN RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % ${k} is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;`;

export function renderApply(index) {
  const b = BATCHES[index]; if (!b) throw new Error(`no equipment batch ${index}`);
  const prior = index === 0 ? null : BATCHES[index - 1];
  const kinds = Object.keys(b.artifacts);
  const tag = `$cfoclose_eqp_transport_${b.batch.replace(/-/g, "_")}$`;
  return `-- CFOClose equipment-r1 staged transport: apply ${b.source}. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing schedules, disclosures, sign-offs, authority, issuances and runtime settings must be unchanged. One atomic statement.
DO ${tag}
DECLARE
  c_batch CONSTANT text := ${q(b.batch)};
  c_prior CONSTANT text := ${prior ? q(prior.batch) : "NULL"};
  c_prior_kinds CONSTANT integer := ${prior ? Object.keys(prior.artifacts).length : 0};
  c_predecessor CONSTANT text[] := ${arr(entryHashes(index))};
  v_n bigint; v_pred_id bigint; v_baseline text; v_${kinds.join(" text; v_")} text;
BEGIN
  ${LOCK}
${predecessorCheck(index)}
  IF to_regnamespace('cfoclose_eqp_release') IS NULL THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_eqp_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_eqp_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_eqp_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_eqp_release.staged_artifacts WHERE batch = c_batch) <> ${kinds.length} THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly ${kinds.length} staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF ${b.installed} THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
${kinds.map((k) => pick(b, k)).join("\n")}
${preserveLocks(index)}
  v_baseline := (${baseline(index)});
  PERFORM set_config('cfoclose_eqp_release.applying', c_batch, true);
${kinds.includes("preflight") ? "  EXECUTE v_preflight;\n" : ""}  EXECUTE v_source;
${kinds.includes("postcondition") ? "  EXECUTE v_postcondition;\n" : ""}  IF NOT (${b.installed}) THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_POSTCONDITION: % did not install its target', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
  IF (${baseline(index)}) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'EQUIPMENT_TRANSPORT_BASELINE_CHANGED: a preserved financial record or runtime setting changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_eqp_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_eqp_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', ${q(b.source)}, 'baseline_sha256', v_baseline,
${kinds.map((k) => `      '${k}_sha256', '${b.artifacts[k].sha256}'`).join(",\n")}));
  PERFORM set_config('cfoclose_eqp_release.applying', '', true);
END
${tag};`;
}

export function renderStage(index, kind, repo = REPO) {
  const b = BATCHES[index]; if (!b?.artifacts[kind]) throw new Error("invalid equipment artifact");
  const text = artifactBytes(index, kind, repo).toString("utf8");
  const dq = `$cfoclose_eqp_stage_${b.artifacts[kind].sha256.slice(0, 16)}$`;
  if (text.includes(dq)) throw new Error(`${b.batch}/${kind} contains its staging quote`);
  return `INSERT INTO cfoclose_eqp_release.staged_artifacts(batch, kind, body) VALUES (${q(b.batch)}, ${q(kind)}, ${dq}${text}${dq});\n`;
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

/** Reviewed transport forms. Register actual hosted entries only after canonical execution. */
export const REGISTERED_TRANSPORT_FORMS = Object.freeze({
  equipment_staged_transport: "bdc337e3030a44df205f80dbdc5b3ce50c3eadb0d3599cc57207ccef96a811fc",
  eqp_1_preparation_staged_apply: "92ea5a25c14dc6b31b8cbcf6160982eedb239df99004215d1cf702ced469c47b",
  eqp_2_multiclass_staged_apply: "ed1ceb09ff9d1bd85a022e38cff680ed725855df4898061cc97d6830763a3644",
});

export function checkTransportMirror(tag, text) {
  const f = transportForms().find((x) => tag.endsWith(`_${x.name}`));
  if (!f) return { problems: [`${tag} is not a registered equipment transport entry`] };
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
  console.log(bad ? `EQUIPMENT_STAGED_TRANSPORT: DRIFT (${bad})` : `EQUIPMENT_STAGED_TRANSPORT: OK (${Object.keys(files).length} files)`);
  process.exitCode = bad ? 1 : 0;
}
