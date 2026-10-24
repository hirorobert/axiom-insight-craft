#!/usr/bin/env node
// Structured outcome contract for a disposable-database proof that runs in two modes (the control PRESENT, the control
// ABSENT). A process exit status alone proves nothing: the ABSENT run must fail on EXACTLY the reviewed weakness cases and
// on nothing else, every setup and control case must pass in both modes, and a crash, a missing case, a duplicate, an
// extra case, an incomplete run or an exit status that disagrees with the recorded outcomes is a validation failure.
//
//   node scripts/ci/validateProofResult.mjs <result.json> --manifest <manifest.mjs> --mode present|absent --exit-code <n>
//
// The manifest module exports `PROOF` (the proof's name) and `CASES`: [{ id, kind: 'setup' | 'control' | 'weakness',
// modes?: ['present','absent'] }]. Expected per mode: every case whose modes include the mode, exactly once; outcome
// 'pass', except kind 'weakness' in 'absent' mode, which must be 'fail'. Pure validation is exported for unit tests.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MODES = new Set(["present", "absent"]);
const KINDS = new Set(["setup", "control", "weakness"]);

/** @returns {{ id: string, kind: string, modes: string[] }[]} the manifest's cases, validated. */
export function normaliseManifest(manifest) {
  if (!manifest || typeof manifest.PROOF !== "string" || !Array.isArray(manifest.CASES) || manifest.CASES.length === 0) throw new Error("manifest: PROOF (string) and a non-empty CASES array are required");
  const seen = new Set();
  return manifest.CASES.map((c, i) => {
    if (!c || typeof c.id !== "string" || !/^[a-z0-9][a-z0-9._-]{2,120}$/.test(c.id)) throw new Error(`manifest: case ${i} has no valid id`);
    if (!KINDS.has(c.kind)) throw new Error(`manifest: case ${c.id} has kind ${JSON.stringify(c.kind)}; expected setup | control | weakness`);
    const modes = c.modes ?? ["present", "absent"];
    if (!Array.isArray(modes) || modes.length === 0 || modes.some((m) => !MODES.has(m))) throw new Error(`manifest: case ${c.id} has invalid modes`);
    if (seen.has(c.id)) throw new Error(`manifest: duplicate case id ${c.id}`);
    seen.add(c.id);
    return { id: c.id, kind: c.kind, modes: [...modes] };
  });
}

export function expectedOutcome(kind, mode) {
  return kind === "weakness" && mode === "absent" ? "fail" : "pass";
}

/**
 * @param {unknown} result the parsed result file
 * @param {{ PROOF: string, CASES: unknown[] }} manifest
 * @param {{ mode: string, exitCode: number }} run
 * @returns {{ ok: boolean, errors: string[], summary: { expected: number, reported: number, passed: number, failed: number } }}
 */
export function validateProofResult(result, manifest, run) {
  const errors = [];
  const cases = normaliseManifest(manifest);
  if (!MODES.has(run.mode)) errors.push(`mode ${JSON.stringify(run.mode)} is not present | absent`);
  if (!Number.isInteger(run.exitCode)) errors.push(`exit code ${JSON.stringify(run.exitCode)} is not an integer (the command's exit status must be captured)`);
  const r = result && typeof result === "object" && !Array.isArray(result) ? /** @type {Record<string, unknown>} */ (result) : null;
  if (!r) { errors.push("result: not a JSON object"); return { ok: false, errors, summary: { expected: 0, reported: 0, passed: 0, failed: 0 } }; }
  if (r.proof !== manifest.PROOF) errors.push(`result.proof ${JSON.stringify(r.proof)} is not ${JSON.stringify(manifest.PROOF)}`);
  if (r.mode !== run.mode) errors.push(`result.mode ${JSON.stringify(r.mode)} is not the run's mode ${JSON.stringify(run.mode)}`);
  if (r.completed !== true) errors.push("result.completed is not true (the run did not reach its end: a setup error, a crash or a timeout)");
  if (r.crashed !== false) errors.push("result.crashed is not false (an exception escaped the proof)");
  if (typeof r.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.manifestSha256)) errors.push("result.manifestSha256 missing: the proof did not pin the manifest it ran");
  const reported = Array.isArray(r.cases) ? /** @type {Record<string, unknown>[]} */ (r.cases) : null;
  if (!reported) { errors.push("result.cases is not an array"); return { ok: false, errors, summary: { expected: 0, reported: 0, passed: 0, failed: 0 } }; }
  const expected = cases.filter((c) => c.modes.includes(run.mode));
  const byId = new Map();
  for (const c of reported) {
    if (!c || typeof c.id !== "string" || (c.outcome !== "pass" && c.outcome !== "fail")) { errors.push(`result: malformed case ${JSON.stringify(c).slice(0, 120)}`); continue; }
    if (byId.has(c.id)) errors.push(`result: case ${c.id} reported more than once`);
    byId.set(c.id, c);
  }
  const expectedIds = new Set(expected.map((c) => c.id));
  for (const id of byId.keys()) if (!expectedIds.has(id)) errors.push(`result: case ${id} is not in the manifest for mode ${run.mode} (extra or wrong-mode case)`);
  let passed = 0, failed = 0;
  for (const c of expected) {
    const got = byId.get(c.id);
    if (!got) { errors.push(`result: case ${c.id} (${c.kind}) is missing - skipped or never reached`); continue; }
    if (got.outcome === "pass") passed += 1; else failed += 1;
    const want = expectedOutcome(c.kind, run.mode);
    if (got.outcome !== want) errors.push(`case ${c.id} (${c.kind}) is ${got.outcome}; expected ${want} in mode ${run.mode}${got.detail ? ` - ${String(got.detail).slice(0, 300)}` : ""}`);
  }
  const anyFail = reported.some((c) => c && c.outcome === "fail");
  if (Number.isInteger(run.exitCode)) {
    if (anyFail && run.exitCode === 0) errors.push("the command exited 0 although a case failed");
    if (!anyFail && run.exitCode !== 0 && r.completed === true && r.crashed === false) errors.push(`the command exited ${run.exitCode} although every case passed and the run completed`);
    if (run.mode === "present" && run.exitCode !== 0) errors.push(`present mode must exit 0 (exited ${run.exitCode})`);
    if (run.mode === "absent" && expected.some((c) => c.kind === "weakness") && run.exitCode === 0) errors.push("absent mode must exit non-zero: the weakness cases must fail");
  }
  return { ok: errors.length === 0, errors, summary: { expected: expected.length, reported: reported.length, passed, failed } };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const manifestPath = opt("--manifest"), mode = opt("--mode"), exitRaw = opt("--exit-code");
  if (!file || !manifestPath || !mode || exitRaw === undefined) { console.error("usage: validateProofResult.mjs <result.json> --manifest <manifest.mjs> --mode present|absent --exit-code <n>"); process.exit(2); }
  const manifest = await import(pathToFileURL(path.resolve(manifestPath)).href);
  let result = null;
  try { result = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); } catch (e) { console.error(`PROOF RESULT INVALID: ${file}: ${e.message}`); process.exit(1); }
  const exitCode = /^-?\d+$/.test(exitRaw) ? Number(exitRaw) : NaN;
  const v = validateProofResult(result, manifest, { mode, exitCode });
  console.log(`${manifest.PROOF} [${mode}] expected ${v.summary.expected} cases, reported ${v.summary.reported}: ${v.summary.passed} passed, ${v.summary.failed} failed; command exit ${exitRaw}`);
  for (const e of v.errors) console.log(`  CONTRACT VIOLATION: ${e}`);
  console.log(v.ok ? `PROOF RESULT VALID (${mode})` : `PROOF RESULT INVALID (${mode})`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
