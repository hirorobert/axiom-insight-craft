// Staged release transport for the financial-statements batches (fs-controls-r1 … fs-memo-r1).
//
// Why it exists: the hosted migrator takes ONE SQL string as a tool argument and cannot read a repository file, so the
// five reviewed wrappers (≈270 KB) cannot be submitted to it byte for byte. They CAN be transferred to PostgreSQL exactly
// (a programmatic connector sends a file's text unchanged). This transport separates the two: the exact committed bytes
// are STAGED as inert data, and a SMALL, deterministic, registered migration per batch — submitted through the canonical
// migrator, which keeps owning its journal row and mirror file — verifies and executes exactly that staged text once.
//
//   bootstrap (1 migration)  private schema cfoclose_release: staged_artifacts (inert text; content-checked on insert
//                            against literal approved identities; no update except the one consumption transition inside an
//                            apply; no delete, no truncate) and transport_events (append-only). RLS on, no policies, every
//                            privilege revoked from PUBLIC / anon / authenticated / service_role. No function is callable
//                            by a client; there is no generic execute function at all.
//   apply (1 per batch)      one DO statement: transport lock → exact journal predecessor (hash literal; any later journal
//                            row must have been written by this same transaction) → prior batch consumed → rows locked and
//                            not consumed → byte count + SHA-256 of preflight, wrapper and postcondition against literals →
//                            sign-off baseline captured → EXECUTE preflight, the ORIGINAL wrapper (comments included),
//                            postcondition → sign-off baseline unchanged → rows consumed + event recorded. One statement:
//                            any failure rolls all of it back, stage state included. Never atomic ACROSS batches.
//
// render*() reads the COMMITTED bytes at APPROVED_COMMIT (git object), never a working-tree copy, and each staged
// identity is a literal pinned below (held equal by src/lib/__tests__/stagedTransport.test.ts).
//
//   node scripts/release/stagedTransport.mjs --write   regenerate release/staged-transport/
//   node scripts/release/stagedTransport.mjs --check   verify release/staged-transport/ (exit 1 on drift)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TRANSPORT_DIR = "release/staged-transport";
/** The approved source commit of every staged artifact. */
export const APPROVED_COMMIT = "daa23e4113dc726fab867480dac6b0b6aba0bbfc";
/** The hosted journal tail the bootstrap must follow: hosted id 64 = 0063_period_currency_correction. */
export const BOOTSTRAP_PREDECESSOR = Object.freeze({ id: 64, hash: "8122917c23abca8726e7ee763796ffae568179233c9537b61a5aff35310f17bc" });
export const BOOTSTRAP_NAME = "fs_release_staged_transport";

const art = (p, bytes, sha256) => Object.freeze({ path: p, bytes, sha256 });
/** The five batches, in the ONLY approved order, with the literal identities of every staged artifact. */
export const BATCHES = Object.freeze([
  Object.freeze({ batch: "fs-controls-r1", name: "fs_controls_r1_staged_apply", source: "20261111100000_fs_publication_controls.sql",
    preflight: art("docs/release/fs-controls-r1/preflight.sql", 1954, "12246fdb909047f44a46fe1366d4b7a966bc6057535d9e8b0616df61dce0caa0"),
    wrapper: art("release/wrappers/20261111100000_fs_publication_controls.wrapper.sql", 94858, "7c3c0b0d9cd456f07a88da1c0930fb5e4a9c4bdeead6ea068008eca939470d56"),
    postcondition: art("docs/release/fs-controls-r1/postcondition.sql", 3574, "d57af109ed12acdefdcf0160422cafd4e63a3cdcd8774fc7826bb096174607f3") }),
  Object.freeze({ batch: "fs-journey-r1", name: "fs_journey_r1_staged_apply", source: "20261112100000_fs_review_workflow_and_rollforward.sql",
    preflight: art("docs/release/fs-journey-r1/preflight.sql", 1916, "cd96b89774b8b6da832a8915f838ef5442f05cc87dca189cc0898dde5fc77d3f"),
    wrapper: art("release/wrappers/20261112100000_fs_review_workflow_and_rollforward.wrapper.sql", 73127, "8f7a1a98a0c34a250dbeb2c94a5c6f4f6d9528a0bf4509e8b1ee89649e135fcd"),
    postcondition: art("docs/release/fs-journey-r1/postcondition.sql", 3510, "2b0b28522203b58ab883814a01119afaacdd5e8ee3f322d7990059cd86fe0415") }),
  Object.freeze({ batch: "fs-bounds-r1", name: "fs_bounds_r1_staged_apply", source: "20261114100000_fs_work_bounds.sql",
    preflight: art("docs/release/fs-bounds-r1/preflight.sql", 2826, "4bbaa482518341d02eff8e20e424d5fafecaf94405e0b1f2437788e1a661b60e"),
    wrapper: art("release/wrappers/20261114100000_fs_work_bounds.wrapper.sql", 15098, "778cfec6f62847def10b7d0938b7aa661ac2c22c2330b40009f3bc0e4682898b"),
    postcondition: art("docs/release/fs-bounds-r1/postcondition.sql", 3044, "2f6e26999122c9cbb9deb52288ccdf41c1527df7e4cd5ec90b680cc93f83bd2f") }),
  Object.freeze({ batch: "fs-capacity-r1", name: "fs_capacity_r1_staged_apply", source: "20261115100000_fs_account_capacity.sql",
    preflight: art("docs/release/fs-capacity-r1/preflight.sql", 2690, "0e86b0fa2b059e964e369e0166b74ea6c53fe8856ea79307f3269f53fdc9b196"),
    wrapper: art("release/wrappers/20261115100000_fs_account_capacity.wrapper.sql", 57041, "d156d1aa434d290932c03f868d0a03779456a90cbdc269d473f8a0ecf9510428"),
    postcondition: art("docs/release/fs-capacity-r1/postcondition.sql", 3590, "6d12b01760bb53029f4a3e9ab2089962d18d1c701c4c5e5b1c4f25229e894822") }),
  Object.freeze({ batch: "fs-memo-r1", name: "fs_memo_r1_staged_apply", source: "20261116100000_fs_transaction_memo.sql",
    preflight: art("docs/release/fs-memo-r1/preflight.sql", 1322, "cfc1f5514e72197d7928173e64e5bd35e1e8e9e600c2fa99793fc404fa0e7d9e"),
    wrapper: art("release/wrappers/20261116100000_fs_transaction_memo.wrapper.sql", 28556, "f332c8b62ba87d99bc149644dd2e43580a6419f9e2d07a4db90666776a5c0321"),
    postcondition: art("docs/release/fs-memo-r1/postcondition.sql", 3091, "68c72b99cf80ca35f09cc8a79d6a4b5152025ecab48ed6d3af244224a426c4c1") }),
]);
export const KINDS = Object.freeze(["preflight", "wrapper", "postcondition"]);

export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
/** The committed bytes of `rel` at APPROVED_COMMIT (never the working tree). */
export function committedBytes(rel, repo = REPO) {
  return execFileSync("git", ["show", `${APPROVED_COMMIT}:${rel}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (xs) => `ARRAY[${xs.map(q).join(", ")}]::text[]`;
/** Both forms a submission can be journalled under: as rendered (no final LF), and with one LF appended. */
const journalHashes = (text) => [sha256(Buffer.from(text, "utf8")), sha256(Buffer.from(text + "\n", "utf8"))];

const LOCK = "PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_release_transport', 0));";
// The journal predecessor rule, shared by every entry: exactly one row carries a predecessor hash, and every row after it
// was written by THIS transaction (an executor that records its row before running the statement) — nothing else.
const predecessorCheck = (label) => `  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1 OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                           AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'TRANSPORT_WRONG_PREDECESSOR: ${label} must directly follow its approved journal predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;`;

/** The bootstrap migration (one DO statement, no final LF). */
export function renderBootstrap() {
  const rows = BATCHES.flatMap((b) => KINDS.map((k) => `(${q(b.batch)}, ${q(k)}, ${b[k].bytes}, ${q(b[k].sha256)})`));
  return `-- CFOClose staged release transport: bootstrap. GENERATED by scripts/release/stagedTransport.mjs — do not edit.
-- Creates the private schema cfoclose_release. Staged artifacts are inert text: each insert is refused unless its exact
-- UTF-8 byte count and SHA-256 equal one approved artifact of commit ${APPROVED_COMMIT}; rows are never updated except by
-- the consumption transition inside a batch apply, never deleted, never truncated. No client role can reach anything here.
DO $cfoclose_transport_bootstrap$
DECLARE
  c_predecessor CONSTANT text[] := ${arr([BOOTSTRAP_PREDECESSOR.hash])};
  v_n bigint;
  v_pred_id bigint;
  v_role text;
BEGIN
  ${LOCK}
${predecessorCheck("the transport bootstrap")}
  IF v_pred_id <> ${BOOTSTRAP_PREDECESSOR.id} THEN
    RAISE EXCEPTION 'TRANSPORT_WRONG_PREDECESSOR: the transport bootstrap must follow hosted journal id ${BOOTSTRAP_PREDECESSOR.id}; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF to_regnamespace('cfoclose_release') IS NOT NULL THEN
    RAISE EXCEPTION 'TRANSPORT_ALREADY_INSTALLED: schema cfoclose_release exists; nothing was changed' USING ERRCODE = '55000';
  END IF;

  CREATE SCHEMA cfoclose_release;
  COMMENT ON SCHEMA cfoclose_release IS 'Release-only staged transport for the financial-statements batches. Not application data; never exposed.';

  CREATE TABLE cfoclose_release.staged_artifacts (
    batch        text        NOT NULL,
    kind         text        NOT NULL CHECK (kind IN ('preflight', 'wrapper', 'postcondition')),
    body         text        NOT NULL,
    body_bytes   integer     NOT NULL,
    body_sha256  text        NOT NULL,
    staged_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
    staged_by    name        NOT NULL DEFAULT session_user,
    consumed_at  timestamptz,
    PRIMARY KEY (batch, kind)
  );
  CREATE TABLE cfoclose_release.transport_events (
    seq     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch   text        NOT NULL,
    event   text        NOT NULL CHECK (event IN ('staged', 'applied')),
    detail  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    by_role name        NOT NULL DEFAULT session_user
  );

  CREATE FUNCTION cfoclose_release.approved_artifact(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT a.bytes, a.sha256 FROM (VALUES
        ${rows.join(",\n        ")}
      ) AS a(batch, kind, bytes, sha256) WHERE a.batch = p_batch AND a.kind = p_kind
    $fn$;

  CREATE FUNCTION cfoclose_release.staged_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE v_ok record;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN
          RAISE EXCEPTION 'TRANSPORT_STAGE_REFUSED: an artifact is staged unconsumed' USING ERRCODE = '55000';
        END IF;
        NEW.body_bytes  := octet_length(convert_to(NEW.body, 'UTF8'));
        NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        SELECT * INTO v_ok FROM cfoclose_release.approved_artifact(NEW.batch, NEW.kind);
        IF v_ok.bytes IS NULL OR v_ok.bytes <> NEW.body_bytes OR v_ok.sha256 <> NEW.body_sha256 THEN
          RAISE EXCEPTION 'TRANSPORT_STAGE_REFUSED: % % has % bytes, SHA-256 %, which is not its approved identity; nothing was staged',
            NEW.batch, NEW.kind, NEW.body_bytes, NEW.body_sha256 USING ERRCODE = '55000';
        END IF;
        NEW.staged_at := clock_timestamp();
        NEW.staged_by := session_user;
        INSERT INTO cfoclose_release.transport_events (batch, event, detail)
          VALUES (NEW.batch, 'staged', jsonb_build_object('kind', NEW.kind, 'bytes', NEW.body_bytes, 'sha256', NEW.body_sha256));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF coalesce(current_setting('cfoclose_release.applying', true), '') <> OLD.batch
           OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
           OR (NEW.batch, NEW.kind, NEW.body, NEW.body_bytes, NEW.body_sha256, NEW.staged_at, NEW.staged_by)
              IS DISTINCT FROM (OLD.batch, OLD.kind, OLD.body, OLD.body_bytes, OLD.body_sha256, OLD.staged_at, OLD.staged_by) THEN
          RAISE EXCEPTION 'TRANSPORT_STAGE_IMMUTABLE: a staged artifact changes only by being consumed inside its batch apply' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'TRANSPORT_STAGE_IMMUTABLE: staged artifacts are release evidence and are never deleted' USING ERRCODE = '55000';
    END
    $fn$;
  CREATE FUNCTION cfoclose_release.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN
      RAISE EXCEPTION 'TRANSPORT_EVIDENCE_IMMUTABLE: % on %.% is refused', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '55000';
    END
    $fn$;

  CREATE TRIGGER trg_staged_artifacts_guard BEFORE INSERT OR UPDATE OR DELETE ON cfoclose_release.staged_artifacts
    FOR EACH ROW EXECUTE FUNCTION cfoclose_release.staged_artifacts_guard();
  CREATE TRIGGER trg_staged_artifacts_no_truncate BEFORE TRUNCATE ON cfoclose_release.staged_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_append_only BEFORE UPDATE OR DELETE ON cfoclose_release.transport_events
    FOR EACH ROW EXECUTE FUNCTION cfoclose_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_no_truncate BEFORE TRUNCATE ON cfoclose_release.transport_events
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_release.append_only_guard();

  ALTER TABLE cfoclose_release.staged_artifacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cfoclose_release.transport_events ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA cfoclose_release FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_release FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cfoclose_release FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA cfoclose_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cfoclose_release FROM %I', v_role);
    END IF;
  END LOOP;
END
$cfoclose_transport_bootstrap$;`;
}

/** The journal hash(es) the entry at `index` (-1 = bootstrap) may be recorded under. */
export function entryHashes(index) {
  return journalHashes(index < 0 ? renderBootstrap() : renderApply(index));
}

/** The apply migration of batch `index` (one DO statement, no final LF). */
export function renderApply(index) {
  const b = BATCHES[index];
  if (!b) throw new Error(`no batch ${index}`);
  const prior = index === 0 ? null : BATCHES[index - 1].batch;
  const tag = `$cfoclose_transport_${b.batch.replace(/-/g, "_")}$`;
  // Complete-row fingerprint: count + SHA-256 of every whole row as jsonb text, one per line in seq order (no column
  // selection, no delimiter or NULL ambiguity; the same expression as the primary live baseline).
  const bind = `(SELECT count(*) AS n, encode(sha256(convert_to(coalesce(string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq), ''), 'UTF8')), 'hex') AS digest
     FROM public.fs_publication_bindings f)`;
  const pick = (k) => `  SELECT s.body INTO v_${k} FROM cfoclose_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = '${k}'
     AND octet_length(convert_to(s.body, 'UTF8')) = ${b[k].bytes}
     AND encode(sha256(convert_to(s.body, 'UTF8')), 'hex') = '${b[k].sha256}';
  IF v_${k} IS NULL THEN
    RAISE EXCEPTION 'TRANSPORT_STAGE_MISSING_OR_MODIFIED: % ${k} is not staged with ${b[k].bytes} bytes and SHA-256 ${b[k].sha256}; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;`;
  return `-- CFOClose staged release transport: apply ${b.batch}. GENERATED by scripts/release/stagedTransport.mjs — do not edit.
-- Executes, once, the staged committed bytes (commit ${APPROVED_COMMIT}) of
--   ${b.preflight.path} (${b.preflight.bytes} B), then
--   ${b.wrapper.path} (${b.wrapper.bytes} B, the original wrapper of ${b.source}), then
--   ${b.postcondition.path} (${b.postcondition.bytes} B).
-- One statement: any refusal or failure rolls back everything, the stage state included.
DO ${tag}
DECLARE
  c_batch       CONSTANT text   := ${q(b.batch)};
  c_prior       CONSTANT text   := ${prior ? q(prior) : "NULL"};
  c_predecessor CONSTANT text[] := ${arr(entryHashes(index - 1))};
  v_n bigint;
  v_pred_id bigint;
  v_preflight text;
  v_wrapper text;
  v_postcondition text;
  v_before record;
  v_after record;
BEGIN
  ${LOCK}
${predecessorCheck(`apply ${b.batch}`)}
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_release.staged_artifacts s WHERE s.batch = c_prior AND s.consumed_at IS NOT NULL) <> 3 THEN
    RAISE EXCEPTION 'TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_release.staged_artifacts s WHERE s.batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_release.staged_artifacts s WHERE s.batch = c_batch AND s.consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
${pick("preflight")}
${pick("wrapper")}
${pick("postcondition")}
  SELECT * INTO v_before FROM ${bind} x;

  PERFORM set_config('cfoclose_release.applying', c_batch, true);
  EXECUTE v_preflight;
  EXECUTE v_wrapper;
  EXECUTE v_postcondition;

  SELECT * INTO v_after FROM ${bind} x;
  IF v_after.n IS DISTINCT FROM v_before.n OR v_after.digest IS DISTINCT FROM v_before.digest THEN
    RAISE EXCEPTION 'TRANSPORT_SIGNOFF_BASELINE_CHANGED: % changed the recorded sign-offs; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_release.staged_artifacts s SET consumed_at = clock_timestamp() WHERE s.batch = c_batch;
  INSERT INTO cfoclose_release.transport_events (batch, event, detail) VALUES (c_batch, 'applied', jsonb_build_object(
    'predecessor_journal_id', v_pred_id, 'wrapper_sha256', '${b.wrapper.sha256}', 'signoffs', v_after.n, 'signoff_digest', v_after.digest));
  PERFORM set_config('cfoclose_release.applying', '', true);
END
${tag};`;
}

/** The staging statement of one artifact: an INSERT whose dollar-quoted literal IS the committed bytes. */
export function renderStage(index, kind, repo = REPO) {
  const b = BATCHES[index];
  const bytes = committedBytes(b[kind].path, repo);
  if (bytes.length !== b[kind].bytes || sha256(bytes) !== b[kind].sha256) throw new Error(`${b[kind].path} at ${APPROVED_COMMIT} is not its pinned identity`);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${b[kind].path} is not valid UTF-8`);
  const dq = `$cfoclose_stage_${b[kind].sha256.slice(0, 16)}$`;
  if (text.includes(dq)) throw new Error(`${b[kind].path} contains its staging quote`);
  return `INSERT INTO cfoclose_release.staged_artifacts (batch, kind, body) VALUES (${q(b.batch)}, ${q(kind)}, ${dq}${text}${dq});\n`;
}

/** Every generated file: relative path → text. */
export function renderAll(repo = REPO) {
  const out = { [`${TRANSPORT_DIR}/00_${BOOTSTRAP_NAME}.sql`]: renderBootstrap() };
  BATCHES.forEach((b, i) => {
    out[`${TRANSPORT_DIR}/${i + 1}0_${b.name}.sql`] = renderApply(i);
    for (const k of KINDS) out[`${TRANSPORT_DIR}/stage/${i + 1}_${b.batch}.${k}.sql`] = renderStage(i, k, repo);
  });
  return out;
}

/**
 * The registered submission forms of the transport entries: tag suffix (the migrator's migration name) → the exact text
 * and its journal hash (as submitted, no final LF; or with one LF appended). Registered BEFORE application.
 */
export function transportForms() {
  const f = [{ name: BOOTSTRAP_NAME, role: "bootstrap", text: renderBootstrap() }, ...BATCHES.map((b, i) => ({ name: b.name, role: "apply", batch: b.batch, source: b.source, text: renderApply(i) }))];
  return f.map((x) => ({ ...x, bytes: Buffer.byteLength(x.text), hashes: journalHashes(x.text) }));
}

/**
 * The REGISTERED submission forms of the six transport entries (migration name → exact rendered identity), recorded
 * BEFORE any hosted application. A journal mirror is accepted only as exactly the rendered text (no final LF) or that
 * text plus one LF; renderBootstrap()/renderApply() must keep reproducing these literals.
 */
export const REGISTERED_TRANSPORT_FORMS = Object.freeze({
  fs_release_staged_transport: Object.freeze({ role: "bootstrap", bytes: 8922, sha256: "ead3ca14299acdde48b07eae48f57cb08f94d9fd8674f59cc8d8d4136c22daab", withFinalLf: "7cc407593a96bc36acfd54c38046636df4f9d949cf6c38a905927803c407584a" }),
  fs_controls_r1_staged_apply: Object.freeze({ role: "apply", bytes: 5625, sha256: "b0c9e768e9776c25bfa8324e2baf802fddd7b1059054f399958c8fa06ce46d2a", withFinalLf: "43082b222ae9ac0fdb66edbe9c414770ce0d5a9dfa7a2b54a4f765511d4ea6a6" }),
  fs_journey_r1_staged_apply: Object.freeze({ role: "apply", bytes: 5652, sha256: "ef7468d912838fd94b810330a851d3beccd85f6f5a889e443ca9b7b6ea552c47", withFinalLf: "f0c8db453db6d1ed2622ea734291e65f4a7eb3bdf52460ea7e47024bb2c4a4f8" }),
  fs_bounds_r1_staged_apply: Object.freeze({ role: "apply", bytes: 5604, sha256: "2d2245dd74d20da8b0569a1cd89304061f715c27b8550b902730fe7d5528e893", withFinalLf: "b7838927a2f7bbe03b760b410de590adf7d972d661f2d3732ce0addb3c4be905" }),
  fs_capacity_r1_staged_apply: Object.freeze({ role: "apply", bytes: 5627, sha256: "f09a8bfa676396220deefd0a0c58f45a747d6cfeeca6aebe8cce9e8d1106e5b2", withFinalLf: "54128fa9b74a7a8cccf8068d68a73c3752a02c842bf601bd304755819e9ebd3a" }),
  fs_memo_r1_staged_apply: Object.freeze({ role: "apply", bytes: 5601, sha256: "ab9f67ebc6ac60e6d23b8a4da6f8dde24ab23441c73eaf446bdf5965c5bcb93c", withFinalLf: "614d87902f14f033cb52542c862da39ddc7e669abbe121ebe2dbd05acf43beba" }),
});

/** Checks a journal mirror `text` of tag `tag` as a transport entry. Returns { covers?, problems }. */
export function checkTransportMirror(tag, text) {
  const f = transportForms().find((x) => tag.endsWith(`_${x.name}`));
  if (!f) return { problems: [`${tag} is not a registered transport entry`] };
  const reg = REGISTERED_TRANSPORT_FORMS[f.name];
  const problems = [];
  if (!reg || reg.bytes !== f.bytes || reg.sha256 !== f.hashes[0] || reg.withFinalLf !== f.hashes[1]) problems.push(`${f.name}: the rendering no longer equals its registered form`);
  const h = sha256(Buffer.from(text, "utf8"));
  if (text !== f.text && text !== f.text + "\n") problems.push(`${tag} is not exactly the registered ${f.name}`);
  if (reg && h !== reg.sha256 && h !== reg.withFinalLf) problems.push(`${tag}: SHA-256 ${h} is not a registered form of ${f.name}`);
  return f.role === "apply" ? { covers: f.source, problems } : { problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = renderAll();
  if (process.argv.includes("--write")) {
    fs.rmSync(path.join(REPO, TRANSPORT_DIR), { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true }); fs.writeFileSync(path.join(REPO, rel), text); }
    for (const f of transportForms()) console.log(`${f.name}: ${f.bytes} B, journal hash ${f.hashes[0]}`);
  } else {
    let bad = 0;
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(REPO, rel);
      if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== text) { console.error(`DRIFT: ${rel}`); bad++; }
    }
    console.log(bad ? `STAGED_TRANSPORT: DRIFT (${bad})` : `STAGED_TRANSPORT: OK (${Object.keys(files).length} files)`);
    process.exitCode = bad ? 1 : 0;
  }
}
