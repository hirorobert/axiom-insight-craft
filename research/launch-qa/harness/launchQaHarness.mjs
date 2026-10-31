#!/usr/bin/env node
// Launch-acceptance QA harness (REPLAYABLE scaffold). It drives the 9 launch scenarios against a LIVE, NON-PRODUCTION
// preview using a pluggable `driver` (CDP/Playwright), and scores each step with the pure checks in ../checks.mjs.
//
// RUN (once NORMAL provides a candidate + isolated preview):
//   LAUNCH_QA_BASE_URL=https://<preview-host> node research/launch-qa/harness/launchQaHarness.mjs
//
// SAFETY: refuses the production project ref; makes NO hosted writes, NO purchases (payment scenarios use the existing
// sandbox/mock-provider path only), uses synthetic users/files. Without a BASE_URL or a wired driver it prints the plan and
// exits with "CANDIDATE EXECUTION PENDING" — it NEVER reports a scenario as passed from a mockup, a prototype, or no run.
import { productionTargetProblem } from "../checks.mjs";

export const SCENARIOS = [
  { id: 1, name: "First visit: supported file → context confirmation → processing → truthful result" },
  { id: 2, name: "Existing entity: correct sourced context; no unintended entity creation" },
  { id: 3, name: "Refresh / back / sign-out+in / retry: safe draft recovery, no cross-user leakage, no duplicate submit/consume" },
  { id: 4, name: "Purchase-required path: clear explanation, retained draft, supported return; no entitlement bypass" },
  { id: 5, name: "Replacement: explicit choice, preserved history, safe stale-version refusal" },
  { id: 6, name: "Invalid / unsupported / over-limit files: actionable refusal, no false success" },
  { id: 7, name: "Review: distinct identities, uncertainty visible, blockers explained; no premature Phase-6 claims" },
  { id: 8, name: "Keyboard, focus, loading/error states, mobile reflow at 320/390px" },
  { id: 9, name: "Customer wording: one clear next action; no internal codenames or unsupported certification/compliance claims" },
];

/**
 * Run the suite. `driver` is an injected adapter (e.g. CDP/Playwright) exposing the navigation/observation primitives each
 * scenario needs; when null, the harness cannot execute and returns every scenario as PENDING. This function NEVER fabricates
 * a pass: a scenario is "passed" only if the driver actually performed it and the checks found no problems.
 */
export async function runLaunchQa({ baseUrl, driver } = {}) {
  if (!baseUrl) return { ok: false, pending: true, results: SCENARIOS.map((s) => ({ ...s, status: "PENDING", detail: "awaiting candidate + isolated preview from NORMAL" })) };
  const guard = productionTargetProblem(baseUrl); // only a PRESENT url can be a safety block (production ref / invalid)
  if (guard) return { ok: false, blocked: guard, results: SCENARIOS.map((s) => ({ ...s, status: "BLOCKED", detail: guard })) };
  if (!driver) return { ok: false, pending: true, results: SCENARIOS.map((s) => ({ ...s, status: "PENDING", detail: "preview set but no driver wired" })) };
  const results = [];
  for (const s of SCENARIOS) {
    const step = driver.scenarios?.[s.id];
    if (typeof step !== "function") { results.push({ ...s, status: "PENDING", detail: "driver does not implement this scenario yet" }); continue; }
    try { const problems = await step(driver); results.push({ ...s, status: problems.length ? "FAIL" : "PASS", problems }); }
    catch (e) { results.push({ ...s, status: "ERROR", detail: String(e && e.message || e) }); }
  }
  return { ok: results.every((r) => r.status === "PASS"), results };
}

// CLI entry: no driver is wired in this research lane (a browser driver + a live preview belong to the execution step with
// NORMAL). So invoking it today prints the plan and the PENDING status honestly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("launchQaHarness.mjs")) {
  const baseUrl = process.env.LAUNCH_QA_BASE_URL || "";
  const out = await runLaunchQa({ baseUrl, driver: null });
  console.log("Launch-acceptance QA — scenario status\n");
  for (const r of out.results) console.log(`  [${r.status}] #${r.id} ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
  if (out.blocked) { console.log(`\nBLOCKED: ${out.blocked}`); process.exit(2); }
  console.log(`\nCANDIDATE EXECUTION PENDING — supply LAUNCH_QA_BASE_URL (a non-production preview) and a wired driver.`);
  console.log(`No scenario is reported as passed without a real run against a candidate. See research/launch-qa/REPORT.md.`);
  process.exit(0);
}
