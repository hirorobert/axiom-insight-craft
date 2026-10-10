// Self-checking release wrappers for the I1-B / I1-C / Close Review / reporting-input / sign-off milestone.
//
// A wrapper is ONE PostgreSQL statement — a DO block — that carries a source migration's committed bytes as a
// dollar-quoted constant. Before any statement of the migration runs, PostgreSQL recomputes the enclosed payload's
// byte count and SHA-256 and RAISEs (SQLSTATE 55000) unless both equal the identity pinned in the wrapper; only then is
// the payload EXECUTEd. Being a single statement it is atomic on its own: a refusal or any failure inside the migration
// rolls the whole statement back, under any executor. The executor's journal row is atomic with it only when the
// executor records it in the same transaction — drizzle-orm migrate() does (verified against its source and on real
// PostgreSQL by scripts/db-proof/selfCheckingWrappers.mjs); the hosted executor's contract is checked at execution time
// (docs/release/MILESTONE_I1B_SIGNOFF_RELEASE.md).
//
// render() is the only way a wrapper is produced, and it reads the COMMITTED bytes (git object), never a working-tree
// copy. A wrapper is accepted only if it is byte-identical to render() of its registered source (or that text with
// exactly its single final LF removed) — see SUBMISSION_FORMS in scripts/ci/releaseJournal.mjs.
//
//   node scripts/release/selfCheckingWrapper.mjs --write   regenerate release/wrappers/ from the committed sources
//   node scripts/release/selfCheckingWrapper.mjs --check   verify the files in release/wrappers/ (exit 1 on drift)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WRAPPER_DIR = "release/wrappers";
/** The commit whose migration bytes the wrappers enclose (main after #76–#85). */
export const SOURCE_COMMIT = "993774cd129a4bfd16946f6be1c339aaf93ac5d4";
export const WRAPPED_SOURCES = Object.freeze([
  "20261011100000_two_period_shared_source.sql",
  "20261012100000_layout_assist_controls.sql",
  "20261013100000_close_review_timeline.sql",
  "20261014100000_close_review_findings.sql",
  "20261015100000_close_review_adjustments.sql",
  "20261016100000_fs_reporting_input.sql",
  "20261017100000_signoff_completion_requirements.sql",
]);
/**
 * The reporting release (PRs #89–#94, IFRS for SMEs reporting): the five sources at the commit holding their final
 * reviewed bytes. Same mechanism, same safety properties; a separate batch so the applied milestone above is untouched.
 */
export const REPORTING_SOURCE_COMMIT = "902a05763be23ef9b3ee762ae92401c0e32ddd84";
export const REPORTING_WRAPPED_SOURCES = Object.freeze([
  "20261018100000_fs_statement_composition.sql",
  "20261019100000_fs_notes_and_schedules.sql",
  "20261020100000_fs_comparatives.sql",
  "20261021100000_fs_signoff_binding.sql",
  "20261022100000_fs_reporting_closure.sql",
]);
/**
 * The readiness correction (DEFECT D-2, hosted acceptance r1 J4): one source at the commit holding its reviewed bytes.
 */
export const READINESS_SOURCE_COMMIT = "2a4d73d38ae1ac76b6983305f37d5d0b30f2b3db";
export const READINESS_WRAPPED_SOURCES = Object.freeze([
  "20261023100000_fs_report_readiness_volatility.sql",
]);
/** The statement sign-off policy (reporting r5): one source at the commit holding its reviewed bytes. */
export const SIGNOFF_POLICY_SOURCE_COMMIT = "5358aefc999bd09f5d306e3e19ba3abbd79da082";
export const SIGNOFF_POLICY_WRAPPED_SOURCES = Object.freeze([
  "20261024100000_fs_signoff_approval_policy.sql",
]);
/** The commercial candidate (commercial-c1): enquiry additions, the retirement of browser adjusting-journal writes, workspace purpose. */
export const COMMERCIAL_SOURCE_COMMIT = "015825859f4bd8641fba013636ae118f3aa5d5e8";
export const COMMERCIAL_WRAPPED_SOURCES = Object.freeze([
  "20261025100000_commercial_enquiries.sql",
  "20261026100000_retire_browser_adjusting_journal_writes.sql",
  "20261027100000_workspace_purpose.sql",
  "20261028100000_period_dates_from_company.sql",
]);
/** Online payment (commercial-p1): the provider routes and the renewal-aware placement of a paid term. */
export const PAYMENTS_SOURCE_COMMIT = "21387d52d432359eb46d34e6160b4876eeb42f63";
export const PAYMENTS_WRAPPED_SOURCES = Object.freeze([
  "20261029100000_payment_provider_routes.sql",
]);
/** Every batch of registered wrappers, in release order. */
export const RELEASE_BATCHES = Object.freeze([
  Object.freeze({ id: "i1b-signoff", commit: SOURCE_COMMIT, sources: WRAPPED_SOURCES, postcondition: "docs/release/milestone-i1b-signoff/postcondition.sql" }),
  Object.freeze({ id: "reporting-r1", commit: REPORTING_SOURCE_COMMIT, sources: REPORTING_WRAPPED_SOURCES, postcondition: "docs/release/reporting-r1/postcondition.sql" }),
  Object.freeze({ id: "reporting-r2", commit: READINESS_SOURCE_COMMIT, sources: READINESS_WRAPPED_SOURCES, postcondition: "docs/release/reporting-r2/postcondition.sql" }),
  Object.freeze({ id: "reporting-r5", commit: SIGNOFF_POLICY_SOURCE_COMMIT, sources: SIGNOFF_POLICY_WRAPPED_SOURCES, postcondition: "docs/release/reporting-r5/postcondition.sql" }),
  Object.freeze({ id: "commercial-c1", commit: COMMERCIAL_SOURCE_COMMIT, sources: COMMERCIAL_WRAPPED_SOURCES, postcondition: "docs/release/commercial-c1/postcondition.sql" }),
  Object.freeze({ id: "commercial-p1", commit: PAYMENTS_SOURCE_COMMIT, sources: PAYMENTS_WRAPPED_SOURCES, postcondition: "docs/release/commercial-p1/postcondition.sql" }),
]);
/** The batch a registered source belongs to. */
export const batchOf = (source) => RELEASE_BATCHES.find((b) => b.sources.includes(source)) ?? null;
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

export const wrapperFile = (source) => `${WRAPPER_DIR}/${source.replace(/\.sql$/, "")}.wrapper.sql`;

/** The committed bytes of a source migration at SOURCE_COMMIT (a git object: no checkout conversion can touch it). */
export function committedSource(source, commit = batchOf(source)?.commit ?? SOURCE_COMMIT) {
  return execFileSync("git", ["-C", REPO, "cat-file", "blob", `${commit}:supabase/migrations/${source}`], { maxBuffer: 1 << 26 });
}

/** The wrapper for `source` enclosing exactly `payload` (a Buffer). Deterministic; throws if the payload cannot be enclosed safely. */
export function render(source, payload, commit = batchOf(source)?.commit ?? SOURCE_COMMIT) {
  if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(source)) throw new Error(`not a migration name: ${source}`);
  const text = payload.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(payload)) throw new Error(`${source}: payload is not valid UTF-8`);
  if (payload.includes(0x0d) || payload.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error(`${source}: payload has CR or a BOM`);
  const digest = sha256(payload);
  const tag = digest.slice(0, 16);
  const outer = `$cfoclose_release_${tag}$`;
  const inner = `$cfoclose_payload_${tag}$`;
  for (const forbidden of [outer, inner, "$cfoclose_", "--> statement-breakpoint"]) {
    if (text.includes(forbidden)) throw new Error(`${source}: payload contains ${forbidden}`);
  }
  return `-- CFOClose self-checking release wrapper. GENERATED by scripts/release/selfCheckingWrapper.mjs — do not edit.
-- Applies supabase/migrations/${source}
-- exactly as committed at ${commit}: ${payload.length} bytes, SHA-256 ${digest}.
-- ONE statement. Before any statement of the enclosed migration runs, PostgreSQL recomputes the payload's byte count
-- and SHA-256 and refuses (SQLSTATE 55000, nothing changed) unless both equal the identity below. Any failure inside
-- the migration rolls the whole statement back. Submit this file byte for byte.
DO ${outer}
DECLARE
  c_source  CONSTANT text    := '${source}';
  c_bytes   CONSTANT integer := ${payload.length};
  c_sha256  CONSTANT text    := '${digest}';
  c_payload CONSTANT text    := ${inner}${text}${inner};
  v_bytes   integer;
  v_sha256  text;
BEGIN
  v_bytes  := octet_length(convert_to(c_payload, 'UTF8'));
  v_sha256 := encode(sha256(convert_to(c_payload, 'UTF8')), 'hex');
  IF v_bytes IS DISTINCT FROM c_bytes OR v_sha256 IS DISTINCT FROM c_sha256 THEN
    RAISE EXCEPTION 'RELEASE_PAYLOAD_MISMATCH: % encloses % bytes with SHA-256 %, expected % bytes with SHA-256 %; nothing was changed',
      c_source, v_bytes, v_sha256, c_bytes, c_sha256 USING ERRCODE = '55000';
  END IF;
  EXECUTE c_payload;
END
${outer};
`;
}

/** The enclosed payload of a wrapper text (between its payload tags), or null. */
export function enclosedPayload(text) {
  const m = /\$cfoclose_payload_([0-9a-f]{16})\$/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = text.indexOf(m[0], start);
  return end < 0 ? null : Buffer.from(text.slice(start, end), "utf8");
}

/** Identity of the rendered wrapper of `source` from the committed bytes: both registered forms and the enclosed source. */
export function wrapperIdentity(source, commit = batchOf(source)?.commit ?? SOURCE_COMMIT) {
  const payload = committedSource(source, commit);
  const w = Buffer.from(render(source, payload, commit), "utf8");
  return {
    file: wrapperFile(source),
    wrapper: { bytes: w.length, sha256: sha256(w) },
    wrapperFinalLfRemoved: { bytes: w.length - 1, sha256: sha256(w.subarray(0, w.length - 1)) },
    payload: { bytes: payload.length, sha256: sha256(payload) },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") { console.error("usage: selfCheckingWrapper.mjs --write | --check"); process.exit(2); }
  let drift = 0;
  for (const source of RELEASE_BATCHES.flatMap((b) => b.sources)) {
    const text = render(source, committedSource(source));
    const file = path.join(REPO, wrapperFile(source));
    if (mode === "--write") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
    const ok = fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(text, "utf8"));
    if (!ok) drift++;
    const id = wrapperIdentity(source);
    console.log(`${ok ? "OK   " : "DRIFT"} ${wrapperFile(source)}  wrapper ${id.wrapper.bytes} B ${id.wrapper.sha256}  encloses ${id.payload.bytes} B ${id.payload.sha256}`);
  }
  process.exit(drift ? 1 : 0);
}
