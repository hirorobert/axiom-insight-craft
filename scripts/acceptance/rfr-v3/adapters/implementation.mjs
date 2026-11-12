/**
 * Acceptance adapter: drives the REAL readiness engine (supabase/functions/_shared/readiness) with each case's inputs.
 *
 *   bun scripts/acceptance/rfr-v3/run.mjs --implementation scripts/acceptance/rfr-v3/adapters/implementation.mjs
 *
 * It does not import the reference model (the runner refuses an adapter that does). It needs bun because the engine is
 * TypeScript. Contracts C1-C4 and C7 are proven on PostgreSQL by scripts/db-proof/readinessFinalization.mjs, which writes
 * a structured result; runContract reads that result and reports NOT_RUN when it is missing, stale or from another commit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReadiness } from "../../../../supabase/functions/_shared/readiness/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const head = () => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "unknown"; } };

export const meta = { kind: "implementation", name: "cfoclose-readiness-engine", target_commit: head(), target: "local-engine" };

export async function evaluate(inputs) {
  return evaluateReadiness(inputs);
}
/** Synchronous entry for callers that cannot await (auditRegression.mjs). */
export const evaluateSync = evaluateReadiness;

/** Map of database contracts to the PostgreSQL proof case that exercises each. */
const CONTRACT_CASES = {
  C1: "c1.change-commits-before-finalize",
  C2: "c2.finalize-commits-before-change",
  C3: "c3.non-read-committed-refused",
  C4: "c4.every-writer-takes-the-scope-lock",
  C7: "c7.bound-evidence-retained",
};

export async function runContract(id) {
  const file = join(ROOT, "proof-results", "readinessFinalization.present.json");
  if (!existsSync(file)) return { pass: false, detail: "NOT_RUN: proof-results/readinessFinalization.present.json is missing (run scripts/db-proof/readinessFinalization.mjs)" };
  const r = JSON.parse(readFileSync(file, "utf8"));
  const want = CONTRACT_CASES[id];
  if (!want) return { pass: false, detail: `NOT_RUN: no PostgreSQL case is mapped to ${id}` };
  if (!r.completed || r.crashed) return { pass: false, detail: "NOT_RUN: the PostgreSQL proof did not complete" };
  if (r.commit && r.commit !== head()) return { pass: false, detail: `NOT_RUN: the PostgreSQL proof was made at ${r.commit}, not ${head()}` };
  const c = r.cases.find((x) => x.id === want);
  return c ? { pass: c.outcome === "pass", detail: c.detail ?? c.outcome } : { pass: false, detail: `NOT_RUN: case ${want} absent from the proof result` };
}
