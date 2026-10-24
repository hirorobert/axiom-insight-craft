// Exact-byte staged transport for fs-integrity-r1: the four reporting migrations 20261123100000 … 20261126100000.
//
// Same contract as tbStagedTransport.mjs (which stays byte-identical because it is journalled): a private schema holds the
// committed bytes as inert, content-checked data; ONE small registered apply migration per source verifies and executes
// exactly that staged text once, through the canonical journalled migrator (which keeps owning its journal row and mirror).
//
//   bootstrap  schema cfoclose_fsi_release: staged_artifacts (insert checked against literal byte count + SHA-256;
//              consumed only inside its owning apply; no delete / truncate) and append-only transport_events. RLS on,
//              no policies, every privilege revoked from PUBLIC / anon / authenticated / service_role; no generic executor.
//   apply (x4) one DO statement: transport lock → journal locked and exactly the approved predecessor → prior batch
//              consumed → own rows locked, unconsumed, exact identities → target not already present → baseline of
//              sign-off bindings and consumed pack issuances captured → [batch 1: EXECUTE preflight] → EXECUTE the
//              wrapper → [batch 4: EXECUTE postcondition] → target present → baseline unchanged → consume + event.
//              Any failure rolls the whole statement back, staging included. Never atomic ACROSS the four batches.
//
// Bytes: sources from SOURCE_COMMIT (merged main); preflight / postcondition from CHECKS_COMMIT (the colon fix). The
// wrapper is rendered by selfCheckingWrapper.render() from those committed source bytes (deterministic, pinned below).
//
//   node scripts/release/fsIntegrityStagedTransport.mjs --write | --check
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { render as renderWrapper } from "./selfCheckingWrapper.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TRANSPORT_DIR = "release/staged-transport-fsi";
export const SOURCE_COMMIT = "27f48f7f4b061ff3ef727aa47ebdf8dac369e543";
export const CHECKS_COMMIT = "56edbf85912b9d347387d15e3d482ff7799dbf5c";
/** Hosted journal tail: id 75 = drizzle 0074_tb_decision_catalogue_read_predicate. */
export const BOOTSTRAP_PREDECESSOR = Object.freeze({ id: 75, tag: "0074_tb_decision_catalogue_read_predicate", hash: "@PRED@" });
export const BOOTSTRAP_NAME = "fs_integrity_staged_transport";

const art = (p, bytes, sha256, commit) => Object.freeze({ path: p, bytes, sha256, commit });
const src = (f, bytes, sha) => art(`supabase/migrations/${f}`, bytes, sha, SOURCE_COMMIT);
export const BATCHES = Object.freeze([
  Object.freeze({ batch: "fsi-1-server-compilation", name: "fsi_1_server_compilation_staged_apply", source: "20261123100000_fs_server_compilation.sql",
    installed: "to_regclass('public.fs_server_compilations') IS NOT NULL",
    artifacts: { source: src("20261123100000_fs_server_compilation.sql", 23305, "7e25c896d34365c7ade29ee095f397a9d85979c74a5d2f5c8a9565ec1501e172"),
      wrapper: "@W0@", preflight: "@PRE@" } }),
  Object.freeze({ batch: "fsi-2-integrity-gate", name: "fsi_2_integrity_gate_staged_apply", source: "20261124100000_fs_publication_integrity_gate.sql",
    installed: "position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0",
    artifacts: { source: src("20261124100000_fs_publication_integrity_gate.sql", 50518, "a71d60eba0dea2347f4c9d519c8e76e2ffa9ec3d986a54281957bb664bf07a03"),
      wrapper: "@W1@" } }),
  Object.freeze({ batch: "fsi-3-final-authority", name: "fsi_3_final_authority_staged_apply", source: "20261125100000_fs_final_authority.sql",
    installed: "to_regclass('public.fs_report_authority') IS NOT NULL",
    artifacts: { source: src("20261125100000_fs_final_authority.sql", 67716, "394d12347da46476df0f551161ca5d6c5a82b781704b4a89c55bac12f258110a"),
      wrapper: "@W2@" } }),
  Object.freeze({ batch: "fsi-4-document-structure", name: "fsi_4_document_structure_staged_apply", source: "20261126100000_fs_document_structure.sql",
    installed: "to_regprocedure('public._fs_document_structure_blockers(uuid, integer, jsonb, text[])') IS NOT NULL",
    artifacts: { source: src("20261126100000_fs_document_structure.sql", 62060, "81ffd8ecdb4ad6ef292a8608dabb9a9cc7f41f4dfa972f66ec5d2cae398dcb39"),
      wrapper: "@W3@", postcondition: "@POST@" } }),
]);

export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export function committedBytes(rel, commit, repo = REPO) {
  return execFileSync("git", ["show", `${commit}:${rel}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
}
/** The exact bytes of one artifact (wrapper rendered from the committed source), checked against its pinned identity. */
export function artifactBytes(index, kind, repo = REPO) {
  const b = BATCHES[index]; const a = b?.artifacts[kind];
  if (!a) throw new Error(`no artifact ${index}/${kind}`);
  const bytes = kind === "wrapper"
    ? Buffer.from(renderWrapper(b.source, committedBytes(b.artifacts.source.path, SOURCE_COMMIT, repo), SOURCE_COMMIT), "utf8")
    : committedBytes(a.path, a.commit, repo);
  if (bytes.length !== a.bytes || sha256(bytes) !== a.sha256) throw new Error(`${b.batch}/${kind} is not its pinned identity (${bytes.length} ${sha256(bytes)})`);
  return bytes;
}
export const kindsOf = (index) => Object.keys(BATCHES[index].artifacts);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (xs) => `ARRAY[${xs.map(q).join(", ")}]::text[]`;
const journalHashes = (text) => [sha256(Buffer.from(text, "utf8")), sha256(Buffer.from(text + "\n", "utf8"))];
const LOCK = "PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_fsi_release_transport', 0));";
export function entryHashes(index) { return index < 0 ? [BOOTSTRAP_PREDECESSOR.hash] : journalHashes(index === 0 ? renderBootstrap() : renderApply(index - 1)); }

const predecessorCheck = () => `  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;`;

const BASELINE = `SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), ''),
    'UTF8')), 'hex')`;

const approvedRows = () => BATCHES.flatMap((b) => Object.entries(b.artifacts).map(([k, a]) => `        (${q(b.batch)}, ${q(k)}, ${a.bytes}, ${q(a.sha256)})`)).join(",\n");

export function renderBootstrap() {
  return `-- CFOClose fs-integrity-r1 staged transport bootstrap. GENERATED by scripts/release/fsIntegrityStagedTransport.mjs; do not edit.
-- The four reporting migrations and their release checks are inert data until a registered apply migration executes them.
DO $cfoclose_fsi_transport_bootstrap$
DECLARE
  c_predecessor CONSTANT text[] := ARRAY[${q(BOOTSTRAP_PREDECESSOR.hash)}]::text[];
  v_n bigint;
  v_pred_id bigint;
  v_role name;
BEGIN
  ${LOCK}
${predecessorCheck()}
  IF to_regnamespace('cfoclose_fsi_release') IS NOT NULL THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_ALREADY_INSTALLED: the transport schema exists; uncertain state requires review' USING ERRCODE = '55000';
  END IF;
  CREATE SCHEMA cfoclose_fsi_release;
  COMMENT ON SCHEMA cfoclose_fsi_release IS 'Release-only exact-byte transport for fs-integrity-r1; never exposed to clients.';
  CREATE TABLE cfoclose_fsi_release.staged_artifacts (
    batch text NOT NULL, kind text NOT NULL CHECK (kind IN ('source','wrapper','preflight','postcondition')), body text NOT NULL,
    body_bytes integer NOT NULL, body_sha256 text NOT NULL, staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    staged_by name NOT NULL DEFAULT session_user, consumed_at timestamptz,
    PRIMARY KEY (batch, kind)
  );
  CREATE TABLE cfoclose_fsi_release.transport_events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch text NOT NULL,
    event text NOT NULL CHECK (event IN ('staged','applied')), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT clock_timestamp(), by_role name NOT NULL DEFAULT session_user
  );
  CREATE FUNCTION cfoclose_fsi_release.approved_artifact(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT a.bytes, a.sha256 FROM (VALUES
${approvedRows()}
      ) AS a(batch, kind, bytes, sha256) WHERE a.batch = p_batch AND a.kind = p_kind
    $fn$;
  CREATE FUNCTION cfoclose_fsi_release.staged_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE v_ok record;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_REFUSED: staged rows start unconsumed' USING ERRCODE = '55000'; END IF;
        NEW.body_bytes := octet_length(convert_to(NEW.body, 'UTF8'));
        NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        SELECT * INTO v_ok FROM cfoclose_fsi_release.approved_artifact(NEW.batch, NEW.kind);
        IF v_ok.bytes IS NULL OR v_ok.bytes <> NEW.body_bytes OR v_ok.sha256 <> NEW.body_sha256 THEN
          RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_REFUSED: % % is not an approved exact byte identity', NEW.batch, NEW.kind USING ERRCODE = '55000';
        END IF;
        INSERT INTO cfoclose_fsi_release.transport_events(batch, event, detail)
          VALUES (NEW.batch, 'staged', jsonb_build_object('kind', NEW.kind, 'bytes', NEW.body_bytes, 'sha256', NEW.body_sha256));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF coalesce(current_setting('cfoclose_fsi_release.applying', true), '') <> OLD.batch
           OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
           OR (NEW.batch, NEW.kind, NEW.body, NEW.body_bytes, NEW.body_sha256, NEW.staged_at, NEW.staged_by)
              IS DISTINCT FROM (OLD.batch, OLD.kind, OLD.body, OLD.body_bytes, OLD.body_sha256, OLD.staged_at, OLD.staged_by)
          THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_IMMUTABLE: only the owning apply may consume a row' USING ERRCODE = '55000'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_IMMUTABLE: evidence is append-only' USING ERRCODE = '55000';
    END
    $fn$;
  CREATE FUNCTION cfoclose_fsi_release.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN RAISE EXCEPTION 'FSI_TRANSPORT_EVIDENCE_IMMUTABLE: % is refused', TG_OP USING ERRCODE = '55000'; END
    $fn$;
  CREATE TRIGGER trg_staged_artifacts_guard BEFORE INSERT OR UPDATE OR DELETE ON cfoclose_fsi_release.staged_artifacts
    FOR EACH ROW EXECUTE FUNCTION cfoclose_fsi_release.staged_artifacts_guard();
  CREATE TRIGGER trg_staged_artifacts_no_truncate BEFORE TRUNCATE ON cfoclose_fsi_release.staged_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_fsi_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_append_only BEFORE UPDATE OR DELETE ON cfoclose_fsi_release.transport_events
    FOR EACH ROW EXECUTE FUNCTION cfoclose_fsi_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_no_truncate BEFORE TRUNCATE ON cfoclose_fsi_release.transport_events
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_fsi_release.append_only_guard();
  ALTER TABLE cfoclose_fsi_release.staged_artifacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cfoclose_fsi_release.transport_events ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA cfoclose_fsi_release FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_fsi_release FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_fsi_release.approved_artifact(text, text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_fsi_release.staged_artifacts_guard() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_fsi_release.append_only_guard() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA cfoclose_fsi_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_fsi_release FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_fsi_release.approved_artifact(text, text) FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_fsi_release.staged_artifacts_guard() FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_fsi_release.append_only_guard() FROM %I', v_role);
    END IF;
  END LOOP;
END
$cfoclose_fsi_transport_bootstrap$;`;
}

const pick = (b, k) => `  SELECT s.body INTO v_${k} FROM cfoclose_fsi_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = '${k}' AND s.consumed_at IS NULL
     AND s.body_bytes = ${b.artifacts[k].bytes} AND s.body_sha256 = '${b.artifacts[k].sha256}';
  IF v_${k} IS NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % ${k} is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;`;

export function renderApply(index) {
  const b = BATCHES[index]; if (!b) throw new Error(`no fs-integrity batch ${index}`);
  const prior = index === 0 ? null : BATCHES[index - 1];
  const kinds = Object.keys(b.artifacts);
  const tag = `$cfoclose_fsi_transport_${b.batch.replace(/-/g, "_")}$`;
  return `-- CFOClose fs-integrity-r1 staged transport: apply ${b.source}. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing sign-off bindings and issued packs must be unchanged. One atomic statement.
DO ${tag}
DECLARE
  c_batch CONSTANT text := ${q(b.batch)};
  c_prior CONSTANT text := ${prior ? q(prior.batch) : "NULL"};
  c_prior_kinds CONSTANT integer := ${prior ? Object.keys(prior.artifacts).length : 0};
  c_predecessor CONSTANT text[] := ${arr(entryHashes(index))};
  v_n bigint; v_pred_id bigint; v_baseline text; v_${kinds.join(" text; v_")} text;
BEGIN
  ${LOCK}
${predecessorCheck()}
  IF to_regnamespace('cfoclose_fsi_release') IS NULL THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_fsi_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_fsi_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_fsi_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_fsi_release.staged_artifacts WHERE batch = c_batch) <> ${kinds.length} THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly ${kinds.length} staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF ${b.installed} THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
${kinds.map((k) => pick(b, k)).join("\n")}
  ${BASELINE.replace(/^SELECT /, "SELECT ").replace(/\)$/, ") INTO v_baseline;").replace(/'hex'\)\) INTO/, "'hex')) INTO")}
  PERFORM set_config('cfoclose_fsi_release.applying', c_batch, true);
${kinds.includes("preflight") ? "  EXECUTE v_preflight;\n" : ""}  EXECUTE v_wrapper;
${kinds.includes("postcondition") ? "  EXECUTE v_postcondition;\n" : ""}  IF NOT (${b.installed}) THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_POSTCONDITION: % did not install its target', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
  IF (${BASELINE}) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_BASELINE_CHANGED: existing sign-off bindings or issued packs changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_fsi_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_fsi_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', ${q(b.source)}, 'baseline_sha256', v_baseline,
${kinds.map((k) => `      '${k}_sha256', '${b.artifacts[k].sha256}'`).join(",\n")}));
  PERFORM set_config('cfoclose_fsi_release.applying', '', true);
END
${tag};`;
}

export function renderStage(index, kind, repo = REPO) {
  const b = BATCHES[index]; if (!b?.artifacts[kind]) throw new Error("invalid fs-integrity artifact");
  const text = artifactBytes(index, kind, repo).toString("utf8");
  const dq = `$cfoclose_fsi_stage_${b.artifacts[kind].sha256.slice(0, 16)}$`;
  if (text.includes(dq)) throw new Error(`${b.batch}/${kind} contains its staging quote`);
  return `INSERT INTO cfoclose_fsi_release.staged_artifacts(batch, kind, body) VALUES (${q(b.batch)}, ${q(kind)}, ${dq}${text}${dq});\n`;
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

export function checkTransportMirror(tag, text) {
  const f = transportForms().find((x) => tag.endsWith(`_${x.name}`));
  if (!f) return { problems: [`${tag} is not a registered fs-integrity transport entry`] };
  const problems = [];
  if (text !== f.text && text !== `${f.text}\n`) problems.push(`${tag} is not exactly the registered ${f.name}`);
  return f.role === "apply" ? { covers: f.source, problems } : { problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const files = renderAll();
  if (process.argv.includes("--write")) {
    fs.rmSync(path.join(REPO, TRANSPORT_DIR), { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true }); fs.writeFileSync(path.join(REPO, rel), text); }
  }
  let bad = 0;
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(REPO, rel); if (!(fs.existsSync(p) && fs.readFileSync(p, "utf8") === text)) { console.error(`DRIFT: ${rel}`); bad++; }
  }
  for (const f of transportForms()) console.log(`${f.role.padEnd(9)} ${f.name}  ${f.bytes} B  sha256 ${f.hashes[0]}`);
  console.log(bad ? `FSI_STAGED_TRANSPORT: DRIFT (${bad})` : `FSI_STAGED_TRANSPORT: OK (${Object.keys(files).length} files)`);
  process.exitCode = bad ? 1 : 0;
}
