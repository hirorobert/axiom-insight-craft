#!/usr/bin/env node
// Regression tests for the OVERALL pass rule (research/launch-qa/harness/overall.mjs). Proves the fixed rule rejects the
// cases the old `executed>0 && failed===0` wrongly passed. Runs here (pure).
import { evaluateOverall, MANDATORY_SCENARIO_IDS as IDS } from "./overall.mjs";

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d)}` : ""}`); } };
const R = (id, status) => ({ id, status });
const nine = (status) => IDS.map((id) => R(id, status));

// 1) one PASS + eight BLOCKED → NOT overall PASS, non-zero exit (this is exactly what the old rule got wrong).
{
  const results = [R("A", "PASS"), ...IDS.slice(1).map((id) => R(id, "BLOCKED"))];
  const o = evaluateOverall(results);
  check("1 PASS + 8 BLOCKED → overallPass false, exit 4", o.overallPass === false && o.exitCode === 4 && o.blocked.length === 8, o);
}
// 2) eight PASS + one NOT_RUN → NOT overall PASS, non-zero exit.
{
  const results = [...IDS.slice(0, 8).map((id) => R(id, "PASS")), R("I", "NOT_RUN")];
  const o = evaluateOverall(results);
  check("8 PASS + 1 NOT_RUN → overallPass false, exit 4, I in notRun", o.overallPass === false && o.exitCode === 4 && o.notRun.includes("I"), o);
}
// 3) a missing scenario (only eight present, all PASS) → NOT overall PASS.
{
  const results = IDS.slice(0, 8).map((id) => R(id, "PASS")); // I absent entirely
  const o = evaluateOverall(results);
  check("missing scenario (I absent) → overallPass false, exit 4, I in missing", o.overallPass === false && o.exitCode === 4 && o.missing.includes("I") && !o.notRun.includes("I"), o);
}
// 4) a duplicate scenario (A twice, all PASS incl. the dup) → NOT overall PASS.
{
  const results = [...nine("PASS"), R("A", "PASS")]; // A appears twice
  const o = evaluateOverall(results);
  check("duplicate scenario (A twice) → overallPass false, exit 4, A in duplicates", o.overallPass === false && o.exitCode === 4 && o.duplicates.includes("A"), o);
}
// 5) all nine PASS, each exactly once → overall PASS, exit 0.
{
  const o = evaluateOverall(nine("PASS"));
  check("all nine PASS (each once) → overallPass true, exit 0", o.overallPass === true && o.exitCode === 0 && o.reasons.length === 0, o);
}
// Bonus: a real FAIL exits 1 (distinct from not-executed 4); an unexpected extra id is rejected.
{
  const withFail = [...IDS.slice(0, 8).map((id) => R(id, "PASS")), R("I", "FAIL")];
  check("one FAIL → overallPass false, exit 1", (() => { const o = evaluateOverall(withFail); return o.overallPass === false && o.exitCode === 1 && o.failed.includes("I"); })());
  const withExtra = [...nine("PASS"), R("Z", "PASS")];
  check("an unexpected extra scenario id is rejected", (() => { const o = evaluateOverall(withExtra); return o.overallPass === false && o.extra.includes("Z"); })());
}

console.log(`\n${pass}/${pass + fail} overall-rule regression checks passed.`);
process.exit(fail ? 1 : 0);
