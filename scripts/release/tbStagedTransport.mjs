// Exact-byte staged transport for the two Trial Balance release batches.
//
// This is intentionally a separate transport from stagedTransport.mjs. The existing FS transport is already
// journalled in production; changing its bootstrap would change its registered bytes. TB transport therefore gets
// its own private schema while using the same canonical Drizzle journal, predecessor and atomic-DO contract.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TRANSPORT_DIR = "release/staged-transport-tb";
export const APPROVED_COMMIT = "5c69b1795be3020dbcd145dcab9f3828b3993814";
export const BOOTSTRAP_PREDECESSOR = Object.freeze({
  id: 71,
  hash: "0eb1405df641e956ca43b4ad652f9ca263029352637e98d1ce482d5c2bb19910",
});
export const BOOTSTRAP_NAME = "tb_release_staged_transport";
export const KINDS = Object.freeze(["source", "wrapper", "postcondition"]);

const art = (pathName, bytes, sha256) => Object.freeze({ path: pathName, bytes, sha256 });
export const BATCHES = Object.freeze([
  Object.freeze({
    batch: "tb-portfolio-a1",
    name: "tb_portfolio_a1_staged_apply",
    source: "20261117100000_engagement_portfolio.sql",
    object: "public.portfolio_revisions",
    sourceArtifact: art("supabase/migrations/20261117100000_engagement_portfolio.sql", 26579, "a9eb6ca77c26a29e7c6f4230e0466fa4320e07d5537ec1f2a6baafaf989873f7"),
    wrapper: art("release/wrappers/20261117100000_engagement_portfolio.wrapper.sql", 28141, "c07611e571c7c65bf986a47ea6105b9c99e7c898d65c18f53c9afc652d34e08d"),
    postcondition: art("docs/release/tb-portfolio-a1/postcondition.sql", 4473, "80c6181a3f03261aa1e90fe404c97720cb9e8263ba5bde51c55c93d6553dc36e"),
  }),
  Object.freeze({
    batch: "tb-decisions-b1",
    name: "tb_decisions_b1_staged_apply",
    source: "20261118100000_tb_finding_decisions.sql",
    object: "public.tb_decision_actions",
    sourceArtifact: art("supabase/migrations/20261118100000_tb_finding_decisions.sql", 99185, "223d15e3e7ee2d941af1c4152f7c206b6aceabee96624ae990b8ddf4282db216"),
    wrapper: art("release/wrappers/20261118100000_tb_finding_decisions.wrapper.sql", 100714, "dab3fa1720468119b5f24f97ed045c2116f7a086c75125e1db9f45f9b5b8e4d8"),
    postcondition: art("docs/release/tb-decisions-b1/postcondition.sql", 11218, "1cd683a26f3c22c22c2e8f9e9a9508b52087d4c678891c5f4aee92088937a98f"),
  }),
]);

export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export function committedBytes(rel, repo = REPO) {
  return execFileSync("git", ["show", `${APPROVED_COMMIT}:${rel}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (xs) => `ARRAY[${xs.map(q).join(", ")}]::text[]`;
const journalHashes = (text) => [sha256(Buffer.from(text, "utf8")), sha256(Buffer.from(text + "\n", "utf8"))];
const LOCK = "PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_tb_release_transport', 0));";

export function entryHashes(index) { return journalHashes(index < 0 ? renderBootstrap() : renderApply(index)); }

const predecessorCheck = () => `  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  -- Serialize the predecessor check and journal append against every writer, including other migration tools.
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'TB_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;`;

const approvedRows = () => BATCHES.flatMap((b) => [
  [b.batch, "source", b.sourceArtifact], [b.batch, "wrapper", b.wrapper], [b.batch, "postcondition", b.postcondition],
]).map(([batch, kind, a]) => `        (${q(batch)}, ${q(kind)}, ${a.bytes}, ${q(a.sha256)})`).join(",\n");

export function renderBootstrap() {
  return `-- CFOClose Trial Balance staged transport bootstrap. GENERATED; do not edit.
-- The two TB wrappers and their source/postcondition evidence are inert until a registered apply migration executes them.
DO $cfoclose_tb_transport_bootstrap$
DECLARE
  c_predecessor CONSTANT text[] := ARRAY[${q(BOOTSTRAP_PREDECESSOR.hash)}]::text[];
  v_n bigint;
  v_pred_id bigint;
  v_role name;
BEGIN
  ${LOCK}
${predecessorCheck()}
  IF to_regnamespace('cfoclose_tb_release') IS NOT NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_ALREADY_INSTALLED: the TB transport schema exists; uncertain state requires review' USING ERRCODE = '55000';
  END IF;
  CREATE SCHEMA cfoclose_tb_release;
  COMMENT ON SCHEMA cfoclose_tb_release IS 'Release-only exact-byte transport for the Trial Balance batches; never exposed to clients.';
  CREATE TABLE cfoclose_tb_release.staged_artifacts (
    batch text NOT NULL, kind text NOT NULL CHECK (kind IN ('source','wrapper','postcondition')), body text NOT NULL,
    body_bytes integer NOT NULL, body_sha256 text NOT NULL, staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    staged_by name NOT NULL DEFAULT session_user, consumed_at timestamptz,
    PRIMARY KEY (batch, kind)
  );
  CREATE TABLE cfoclose_tb_release.transport_events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch text NOT NULL,
    event text NOT NULL CHECK (event IN ('staged','applied')), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT clock_timestamp(), by_role name NOT NULL DEFAULT session_user
  );
  CREATE FUNCTION cfoclose_tb_release.approved_artifact(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT a.bytes, a.sha256 FROM (VALUES
${approvedRows()}
      ) AS a(batch, kind, bytes, sha256) WHERE a.batch = p_batch AND a.kind = p_kind
    $fn$;
  CREATE FUNCTION cfoclose_tb_release.staged_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE v_ok record;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_REFUSED: staged rows start unconsumed' USING ERRCODE = '55000'; END IF;
        NEW.body_bytes := octet_length(convert_to(NEW.body, 'UTF8'));
        NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        SELECT * INTO v_ok FROM cfoclose_tb_release.approved_artifact(NEW.batch, NEW.kind);
        IF v_ok.bytes IS NULL OR v_ok.bytes <> NEW.body_bytes OR v_ok.sha256 <> NEW.body_sha256 THEN
          RAISE EXCEPTION 'TB_TRANSPORT_STAGE_REFUSED: % % is not an approved exact byte identity', NEW.batch, NEW.kind USING ERRCODE = '55000';
        END IF;
        INSERT INTO cfoclose_tb_release.transport_events(batch, event, detail)
          VALUES (NEW.batch, 'staged', jsonb_build_object('kind', NEW.kind, 'bytes', NEW.body_bytes, 'sha256', NEW.body_sha256));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF coalesce(current_setting('cfoclose_tb_release.applying', true), '') <> OLD.batch
           OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
           OR (NEW.batch, NEW.kind, NEW.body, NEW.body_bytes, NEW.body_sha256, NEW.staged_at, NEW.staged_by)
              IS DISTINCT FROM (OLD.batch, OLD.kind, OLD.body, OLD.body_bytes, OLD.body_sha256, OLD.staged_at, OLD.staged_by)
          THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_IMMUTABLE: only the owning apply may consume a row' USING ERRCODE = '55000'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'TB_TRANSPORT_STAGE_IMMUTABLE: evidence is append-only' USING ERRCODE = '55000';
    END
    $fn$;
  CREATE FUNCTION cfoclose_tb_release.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN RAISE EXCEPTION 'TB_TRANSPORT_EVIDENCE_IMMUTABLE: % is refused', TG_OP USING ERRCODE = '55000'; END
    $fn$;
  CREATE TRIGGER trg_staged_artifacts_guard BEFORE INSERT OR UPDATE OR DELETE ON cfoclose_tb_release.staged_artifacts
    FOR EACH ROW EXECUTE FUNCTION cfoclose_tb_release.staged_artifacts_guard();
  CREATE TRIGGER trg_staged_artifacts_no_truncate BEFORE TRUNCATE ON cfoclose_tb_release.staged_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_tb_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_append_only BEFORE UPDATE OR DELETE ON cfoclose_tb_release.transport_events
    FOR EACH ROW EXECUTE FUNCTION cfoclose_tb_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_no_truncate BEFORE TRUNCATE ON cfoclose_tb_release.transport_events
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_tb_release.append_only_guard();
  ALTER TABLE cfoclose_tb_release.staged_artifacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cfoclose_tb_release.transport_events ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA cfoclose_tb_release FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_tb_release FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_tb_release.approved_artifact(text, text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_tb_release.staged_artifacts_guard() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_tb_release.append_only_guard() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA cfoclose_tb_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_tb_release FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_tb_release.approved_artifact(text, text) FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_tb_release.staged_artifacts_guard() FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_tb_release.append_only_guard() FROM %I', v_role);
    END IF;
  END LOOP;
END
$cfoclose_tb_transport_bootstrap$;`;
}

const pick = (b, k) => `  SELECT s.body INTO v_${k} FROM cfoclose_tb_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = '${k}' AND s.consumed_at IS NULL
     AND s.body_bytes = ${b[k === "source" ? "sourceArtifact" : k].bytes} AND s.body_sha256 = '${b[k === "source" ? "sourceArtifact" : k].sha256}';
  IF v_${k} IS NULL THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % ${k} is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;`;

export function renderApply(index) {
  const b = BATCHES[index]; if (!b) throw new Error(`no TB batch ${index}`);
  const prior = index === 0 ? null : BATCHES[index - 1].batch;
  const tag = `$cfoclose_tb_transport_${b.batch.replace(/-/g, "_")}$`;
  return `-- CFOClose Trial Balance staged transport: apply ${b.batch}. GENERATED; do not edit.
-- Exact source, wrapper and postcondition bytes are checked before execution; this is one atomic statement.
DO ${tag}
DECLARE
  c_batch CONSTANT text := ${q(b.batch)};
  c_prior CONSTANT text := ${prior ? q(prior) : "NULL"};
  c_predecessor CONSTANT text[] := ${arr(entryHashes(index - 1))};
  v_n bigint; v_pred_id bigint; v_source text; v_wrapper text; v_postcondition text;
BEGIN
  ${LOCK}
${predecessorCheck()}
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_tb_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> 3 THEN
    RAISE EXCEPTION 'TB_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_tb_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF (SELECT count(*) FROM cfoclose_tb_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) = 3 THEN
    RAISE EXCEPTION 'TB_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_tb_release.staged_artifacts WHERE batch = c_batch) <> 3 THEN
    RAISE EXCEPTION 'TB_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly three immutable artifacts', c_batch USING ERRCODE = '55000';
  END IF;
  IF to_regclass(${q(b.object)}) IS NOT NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_UNCERTAIN_STATE: % already exists without a consumed transport record', ${q(b.object)} USING ERRCODE = '55000';
  END IF;
${pick(b, "source")}
${pick(b, "wrapper")}
${pick(b, "postcondition")}
  PERFORM set_config('cfoclose_tb_release.applying', c_batch, true);
  EXECUTE v_wrapper;
  EXECUTE v_postcondition;
  IF to_regclass(${q(b.object)}) IS NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_POSTCONDITION: % was not created', ${q(b.object)} USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_tb_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_tb_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id,
      'source_sha256', '${b.sourceArtifact.sha256}', 'wrapper_sha256', '${b.wrapper.sha256}', 'postcondition_sha256', '${b.postcondition.sha256}'));
  PERFORM set_config('cfoclose_tb_release.applying', '', true);
END
${tag};`;
}

export function renderStage(index, kind, repo = REPO) {
  const b = BATCHES[index]; if (!b || !KINDS.includes(kind)) throw new Error("invalid TB artifact");
  const a = kind === "source" ? b.sourceArtifact : b[kind];
  const bytes = committedBytes(a.path, repo);
  if (bytes.length !== a.bytes || sha256(bytes) !== a.sha256) throw new Error(`${a.path} is not its pinned identity`);
  const text = bytes.toString("utf8"); const dq = `$cfoclose_tb_stage_${a.sha256.slice(0, 16)}$`;
  if (text.includes(dq)) throw new Error(`${a.path} contains its staging quote`);
  return `INSERT INTO cfoclose_tb_release.staged_artifacts(batch, kind, body) VALUES (${q(b.batch)}, ${q(kind)}, ${dq}${text}${dq});\n`;
}

export function renderAll(repo = REPO) {
  const out = { [`${TRANSPORT_DIR}/00_${BOOTSTRAP_NAME}.sql`]: renderBootstrap() };
  BATCHES.forEach((b, i) => {
    out[`${TRANSPORT_DIR}/${i + 1}0_${b.name}.sql`] = renderApply(i);
    for (const k of KINDS) out[`${TRANSPORT_DIR}/stage/${i + 1}_${b.batch}.${k}.sql`] = renderStage(i, k, repo);
  });
  return out;
}

export function transportForms() {
  return [{ name: BOOTSTRAP_NAME, role: "bootstrap", text: renderBootstrap() }, ...BATCHES.map((b, i) => ({ name: b.name, role: "apply", batch: b.batch, source: b.source, text: renderApply(i) }))]
    .map((x) => ({ ...x, bytes: Buffer.byteLength(x.text), hashes: journalHashes(x.text) }));
}

export const REGISTERED_TRANSPORT_FORMS = Object.freeze(Object.fromEntries(transportForms().map((f) => [f.name,
  Object.freeze({ role: f.role, bytes: f.bytes, sha256: f.hashes[0], withFinalLf: f.hashes[1] })])));

export function checkTransportMirror(tag, text) {
  const f = transportForms().find((x) => tag.endsWith(`_${x.name}`));
  if (!f) return { problems: [`${tag} is not a registered TB transport entry`] };
  const reg = REGISTERED_TRANSPORT_FORMS[f.name]; const h = sha256(Buffer.from(text, "utf8"));
  const problems = [];
  if (text !== f.text && text !== `${f.text}\n`) problems.push(`${tag} is not exactly the registered ${f.name}`);
  if (h !== reg.sha256 && h !== reg.withFinalLf) problems.push(`${tag}: unregistered SHA-256 ${h}`);
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
    const p = path.join(REPO, rel); const ok = fs.existsSync(p) && fs.readFileSync(p, "utf8") === text;
    if (!ok) { console.error(`DRIFT: ${rel}`); bad++; }
  }
  console.log(bad ? `TB_STAGED_TRANSPORT: DRIFT (${bad})` : `TB_STAGED_TRANSPORT: OK (${Object.keys(files).length} files)`);
  process.exitCode = bad ? 1 : 0;
}
