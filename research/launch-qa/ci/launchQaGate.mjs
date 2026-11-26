// Launch-acceptance QA gate (NORMAL, evidence branch #144 only). The STRICT overall condition, independent of the runner's
// own exit code (whose overallPass admits BLOCKED/NOT_RUN scenarios when none FAILED):
//   success ⇔ the report exists; exactly the nine mandatory scenarios A–I are present; every one is PASS; no PASS carries a
//   problem other than a "NOTE:" (a PASS that records a blocked sub-check is not a pass); and the application identity was
//   verified against the built tree (identity.json from the CI step). Anything else — FAIL, BLOCKED, NOT_RUN, ERROR, a
//   missing scenario, a missing report — is NOT PASS. Writes <dir>/gate.json.
//   node research/launch-qa/ci/launchQaGate.mjs <evidence-dir>
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "real-app-evidence/launch-qa");
const MANDATORY = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
const report = read("launch-acceptance.json");
const identity = read("identity.json");
const scenarios = MANDATORY.map((id) => {
  const r = report?.results?.find((x) => String(x.id) === id);
  if (!r) return { id, verdict: "NOT_RUN", why: "absent from the report" };
  const blocking = (r.problems ?? []).filter((p) => !String(p).startsWith("NOTE"));
  if (r.status === "PASS" && blocking.length === 0) return { id, verdict: "PASS" };
  if (r.status === "PASS") return { id, verdict: "NOT_PASS", why: `reported PASS but records: ${blocking.join(" | ").slice(0, 300)}` };
  return { id, verdict: r.status ?? "UNKNOWN", why: blocking.join(" | ").slice(0, 300) };
});
const identityOk = !!identity?.verified && report?.applicationSha === identity?.applicationSha;
const pass = !!report && identityOk && scenarios.every((s) => s.verdict === "PASS");
const out = { pass, identityOk, applicationSha: identity?.applicationSha ?? null, applicationTree: identity?.applicationTree ?? null,
  prHeadSha: identity?.prHeadSha ?? null, baseSha: identity?.baseSha ?? null, checkoutSha: identity?.checkoutSha ?? null,
  checkoutParents: identity?.checkoutParents ?? null, checkoutKind: identity?.checkoutKind ?? null, harnessTree: identity?.harnessTree ?? null,
  provenanceProblems: identity?.problems ?? null, scenarios };
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify(out, null, 2));
console.log(`Launch-acceptance gate — application ${out.applicationSha} (tree ${out.applicationTree}), identity ${identityOk ? "verified" : "NOT verified"}`);
console.log(`  PR head ${out.prHeadSha} · base ${out.baseSha} · checkout ${out.checkoutSha} (${out.checkoutKind}; parents ${(out.checkoutParents ?? []).join(", ")}) · harness tree ${out.harnessTree}`);
for (const s of scenarios) console.log(`  [${s.verdict}] ${s.id}${s.why ? `  — ${s.why}` : ""}`);
console.log(pass ? "GATE: PASS (all nine mandatory scenarios executed and passed)" : "GATE: NOT PASS");
process.exit(pass ? 0 : 1);
