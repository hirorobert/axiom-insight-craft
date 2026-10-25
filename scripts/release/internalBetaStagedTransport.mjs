// INTERNAL_BETA exact-byte transport. Authored sources are pinned; hosted application remains pending.
// Reuses the immutable Track A contract in its OWN private schema, never alters that journalled module.
// Exact-byte candidate transport: assistant controls followed by internal beta policy.
//
// Same contract as fsIntegrityStagedTransport.mjs (which stays byte-identical because it is journalled): a private schema
// holds the committed bytes as inert, content-checked data; ONE small registered apply migration per source verifies and
// executes exactly that staged text once, through the canonical journalled migrator (which keeps owning its journal row
// and mirror).
//
//   bootstrap  schema cfoclose_beta_release: staged_artifacts (insert checked against literal byte count + SHA-256;
//              consumed only inside its owning apply; no delete / truncate) and append-only transport_events. RLS on,
//              no policies, every privilege revoked from PUBLIC / anon / authenticated / service_role; no generic executor.
//   apply (x2) one DO statement: transport lock -> journal locked and exactly the approved predecessor -> prior batch
//              consumed -> own rows locked, unconsumed, exact identities -> target not already present -> baseline of
//              sign-off bindings, consumed pack issuances, FINAL authority and its history, and every company's framework
//              captured -> EXECUTE exact source (including its preflight/postcondition) ->
//              target present -> baseline unchanged -> consume + event. Any failure rolls the whole statement back,
//              staging included. Never atomic ACROSS the two batches.
//
// ORDER: bootstrap -> stage -> apply 1 -> apply 2 -> disabled-state verification -> frontend -> authorized activation.
//
// Sources are committed authored bytes; the canonical migrator owns every hosted journal row.
//
//   node scripts/release/internalBetaStagedTransport.mjs --write | --check
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TRANSPORT_DIR = "release/staged-transport-beta";
export const SOURCE_COMMIT = "18bd63b621317b8c9a608db27264bed213ceb146";
export const BOOTSTRAP_PREDECESSOR = Object.freeze({ id:83, tag:"0082_tra_2_framework_guard_staged_apply",hash:"7be675f1066aa17090007d039a412b70a2c120fa8fab008d7bfd0ceee1b3523f" });
export const BOOTSTRAP_NAME = "internal_beta_staged_transport";
export const BATCHES = Object.freeze([
  Object.freeze({batch: "beta-1-assistant-controls", name: "beta_1_assistant_controls_staged_apply", source: "20261201100000_assistant_controls.sql", installed: "to_regclass('public.ai_assistant_settings') IS NOT NULL", artifacts: {source: Object.freeze({path:"supabase/migrations/20261201100000_assistant_controls.sql",bytes:38510,sha256:"84695443fc325657b68b159f753a788c16249fac92b0e78176e9876a4994fd3f",commit:SOURCE_COMMIT})}}),  Object.freeze({batch: "beta-2-internal-policy", name: "beta_2_internal_policy_staged_apply", source: "20261202100000_internal_beta_policy.sql", installed: "to_regclass('public.internal_beta_policy') IS NOT NULL", artifacts: {source: Object.freeze({path:"supabase/migrations/20261202100000_internal_beta_policy.sql",bytes:22030,sha256:"a8297d571dccdad22c49a747b9475c50ffa18312d8bcfd69b9c699f87b369268",commit:SOURCE_COMMIT})}})
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
const LOCK = "PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_beta_release_transport', 0));";
export function entryHashes(index) { return index < 0 ? [BOOTSTRAP_PREDECESSOR.hash] : journalHashes(index === 0 ? renderBootstrap() : renderApply(index - 1)); }

const predecessorCheck = () => `  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;`;

const BASELINE = `SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(a)::text, chr(10) ORDER BY a.company_id, a.period_year) FROM public.fs_report_authority a), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(e)::text, chr(10) ORDER BY e.seq) FROM public.fs_report_authority_events e), '') || chr(30) ||
      coalesce((SELECT string_agg(c.id::text || ':' || coalesce(c.reporting_framework::text, ''), chr(10) ORDER BY c.id) FROM public.companies c), ''),
    'UTF8')), 'hex')`;

const approvedRows = () => BATCHES.flatMap((b) => Object.entries(b.artifacts).map(([k, a]) => `        (${q(b.batch)}, ${q(k)}, ${a.bytes}, ${q(a.sha256)})`)).join(",\n");

export function renderBootstrap() {
  return `-- CFOClose internal-beta-r1 staged transport bootstrap. GENERATED by scripts/release/internalBetaStagedTransport.mjs; do not edit.
-- Assistant controls and internal beta source are inert until a registered apply executes them.
DO $cfoclose_beta_transport_bootstrap$
DECLARE
  c_predecessor CONSTANT text[] := ARRAY[${q(BOOTSTRAP_PREDECESSOR.hash)}]::text[];
  v_n bigint;
  v_pred_id bigint;
  v_role name;
BEGIN
  ${LOCK}
${predecessorCheck()}
  IF to_regnamespace('cfoclose_beta_release') IS NOT NULL THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_ALREADY_INSTALLED: the transport schema exists; uncertain state requires review' USING ERRCODE = '55000';
  END IF;
  CREATE SCHEMA cfoclose_beta_release;
  COMMENT ON SCHEMA cfoclose_beta_release IS 'Release-only exact-byte transport for internal-beta-r1; never exposed to clients.';
  CREATE TABLE cfoclose_beta_release.staged_artifacts (
    batch text NOT NULL, kind text NOT NULL CHECK (kind IN ('source','wrapper','preflight','postcondition')), body text NOT NULL,
    body_bytes integer NOT NULL, body_sha256 text NOT NULL, staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    staged_by name NOT NULL DEFAULT session_user, consumed_at timestamptz,
    PRIMARY KEY (batch, kind)
  );
  CREATE TABLE cfoclose_beta_release.transport_events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch text NOT NULL,
    event text NOT NULL CHECK (event IN ('staged','applied')), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT clock_timestamp(), by_role name NOT NULL DEFAULT session_user
  );
  CREATE FUNCTION cfoclose_beta_release.approved_artifact(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT a.bytes, a.sha256 FROM (VALUES
${approvedRows()}
      ) AS a(batch, kind, bytes, sha256) WHERE a.batch = p_batch AND a.kind = p_kind
    $fn$;
  CREATE FUNCTION cfoclose_beta_release.staged_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE v_ok record;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'BETA_TRANSPORT_STAGE_REFUSED: staged rows start unconsumed' USING ERRCODE = '55000'; END IF;
        NEW.body_bytes := octet_length(convert_to(NEW.body, 'UTF8'));
        NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        SELECT * INTO v_ok FROM cfoclose_beta_release.approved_artifact(NEW.batch, NEW.kind);
        IF v_ok.bytes IS NULL OR v_ok.bytes <> NEW.body_bytes OR v_ok.sha256 <> NEW.body_sha256 THEN
          RAISE EXCEPTION 'BETA_TRANSPORT_STAGE_REFUSED: % % is not an approved exact byte identity', NEW.batch, NEW.kind USING ERRCODE = '55000';
        END IF;
        INSERT INTO cfoclose_beta_release.transport_events(batch, event, detail)
          VALUES (NEW.batch, 'staged', jsonb_build_object('kind', NEW.kind, 'bytes', NEW.body_bytes, 'sha256', NEW.body_sha256));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF coalesce(current_setting('cfoclose_beta_release.applying', true), '') <> OLD.batch
           OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
           OR (NEW.batch, NEW.kind, NEW.body, NEW.body_bytes, NEW.body_sha256, NEW.staged_at, NEW.staged_by)
              IS DISTINCT FROM (OLD.batch, OLD.kind, OLD.body, OLD.body_bytes, OLD.body_sha256, OLD.staged_at, OLD.staged_by)
          THEN RAISE EXCEPTION 'BETA_TRANSPORT_STAGE_IMMUTABLE: only the owning apply may consume a row' USING ERRCODE = '55000'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'BETA_TRANSPORT_STAGE_IMMUTABLE: evidence is append-only' USING ERRCODE = '55000';
    END
    $fn$;
  CREATE FUNCTION cfoclose_beta_release.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN RAISE EXCEPTION 'BETA_TRANSPORT_EVIDENCE_IMMUTABLE: % is refused', TG_OP USING ERRCODE = '55000'; END
    $fn$;
  CREATE TRIGGER trg_staged_artifacts_guard BEFORE INSERT OR UPDATE OR DELETE ON cfoclose_beta_release.staged_artifacts
    FOR EACH ROW EXECUTE FUNCTION cfoclose_beta_release.staged_artifacts_guard();
  CREATE TRIGGER trg_staged_artifacts_no_truncate BEFORE TRUNCATE ON cfoclose_beta_release.staged_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_beta_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_append_only BEFORE UPDATE OR DELETE ON cfoclose_beta_release.transport_events
    FOR EACH ROW EXECUTE FUNCTION cfoclose_beta_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_no_truncate BEFORE TRUNCATE ON cfoclose_beta_release.transport_events
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_beta_release.append_only_guard();
  ALTER TABLE cfoclose_beta_release.staged_artifacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cfoclose_beta_release.transport_events ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA cfoclose_beta_release FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_beta_release FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_beta_release.approved_artifact(text, text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_beta_release.staged_artifacts_guard() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION cfoclose_beta_release.append_only_guard() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA cfoclose_beta_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_beta_release FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_beta_release.approved_artifact(text, text) FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_beta_release.staged_artifacts_guard() FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION cfoclose_beta_release.append_only_guard() FROM %I', v_role);
    END IF;
  END LOOP;
END
$cfoclose_beta_transport_bootstrap$;`;
}

const pick = (b, k) => `  SELECT s.body INTO v_${k} FROM cfoclose_beta_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = '${k}' AND s.consumed_at IS NULL
     AND s.body_bytes = ${b.artifacts[k].bytes} AND s.body_sha256 = '${b.artifacts[k].sha256}';
  IF v_${k} IS NULL THEN RAISE EXCEPTION 'BETA_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % ${k} is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;`;

export function renderApply(index) {
  const b = BATCHES[index]; if (!b) throw new Error(`no internal-beta batch ${index}`);
  const prior = index === 0 ? null : BATCHES[index - 1];
  const kinds = Object.keys(b.artifacts);
  const tag = `$cfoclose_beta_transport_${b.batch.replace(/-/g, "_")}$`;
  return `-- CFOClose internal-beta-r1 staged transport: apply ${b.source}. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; sign-off bindings, issued packs, the FINAL authority and its history and every
-- company's framework must be unchanged. One atomic statement.
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
  IF to_regnamespace('cfoclose_beta_release') IS NULL THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_beta_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_beta_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_beta_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_beta_release.staged_artifacts WHERE batch = c_batch) <> ${kinds.length} THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly ${kinds.length} staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF ${b.installed} THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
${kinds.map((k) => pick(b, k)).join("\n")}
  v_baseline := (${BASELINE});
  PERFORM set_config('cfoclose_beta_release.applying', c_batch, true);
${kinds.includes("preflight") ? "  EXECUTE v_preflight;\n" : ""}  EXECUTE v_source;
${kinds.includes("postcondition") ? "  EXECUTE v_postcondition;\n" : ""}  IF NOT (${b.installed}) THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_POSTCONDITION: % did not install its target', ${q(b.source)} USING ERRCODE = '55000';
  END IF;
  IF (${BASELINE}) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_BASELINE_CHANGED: sign-off bindings, issued packs, the FINAL authority or a company framework changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_beta_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_beta_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', ${q(b.source)}, 'baseline_sha256', v_baseline,
${kinds.map((k) => `      '${k}_sha256', '${b.artifacts[k].sha256}'`).join(",\n")}));
  PERFORM set_config('cfoclose_beta_release.applying', '', true);
END
${tag};`;
}

export function renderStage(index, kind, repo = REPO) {
  const b = BATCHES[index]; if (!b?.artifacts[kind]) throw new Error("invalid internal-beta artifact");
  const text = artifactBytes(index, kind, repo).toString("utf8");
  const dq = `$cfoclose_beta_stage_${b.artifacts[kind].sha256.slice(0, 16)}$`;
  if (text.includes(dq)) throw new Error(`${b.batch}/${kind} contains its staging quote`);
  return `INSERT INTO cfoclose_beta_release.staged_artifacts(batch, kind, body) VALUES (${q(b.batch)}, ${q(kind)}, ${dq}${text}${dq});\n`;
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
  internal_beta_staged_transport: "bdbd0020aa9096b38fb553587da68070e9e21ec942e971ea88bd61891fd9b96c",
  beta_1_assistant_controls_staged_apply: "de36c59001a25a73b6bf14f511981c7228f4e2450bb938fa5eb88102a86c4905",
  beta_2_internal_policy_staged_apply: "80b961a8f8015cce6656e7f46cdc212744cf3b267d16ff85e9e775bb8094926f",
});

export function checkTransportMirror(tag, text) {
  const f = transportForms().find((x) => tag.endsWith(`_${x.name}`));
  if (!f) return { problems: [`${tag} is not a registered internal-beta transport entry`] };
  const problems = [];
  if (text !== f.text && text !== `${f.text}\n`) problems.push(`${tag} is not exactly the registered ${f.name}`);
  if (f.hashes[0] !== REGISTERED_TRANSPORT_FORMS[f.name]) problems.push(`${tag}: rendering drifted from its pinned registration`);
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
  console.log(bad ? `BETA_STAGED_TRANSPORT: DRIFT (${bad})` : `BETA_STAGED_TRANSPORT: OK (${Object.keys(files).length} files)`);
  process.exitCode = bad ? 1 : 0;
}
