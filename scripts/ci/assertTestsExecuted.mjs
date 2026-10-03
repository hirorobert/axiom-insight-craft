#!/usr/bin/env node
// assertTestsExecuted — fail unless every named test file ran, and every test in it PASSED: none skipped, none todo,
// none failed. Reads a Vitest JSON report.
//
//   node scripts/ci/assertTestsExecuted.mjs <report.json> <test-file> [<test-file> ...]
//
// Used by CI for the database-inertness guard, whose authoritative base comparison must never pass by being skipped.
import fs from "node:fs";
import path from "node:path";

/** Pure: the reasons the report does not prove full execution of `files` (empty = proven). */
export function executionProblems(report, files) {
  const problems = [];
  if (!report || !Array.isArray(report.testResults)) return ["the report is not a Vitest JSON report"];
  const norm = (p) => p.split(path.sep).join("/");
  for (const file of files) {
    const result = report.testResults.find((r) => norm(r.name ?? "").endsWith(`/${file}`));
    if (!result) { problems.push(`${file}: not in the report (it did not run)`); continue; }
    const assertions = result.assertionResults ?? [];
    if (assertions.length === 0) problems.push(`${file}: ran no tests`);
    for (const a of assertions) {
      if (a.status !== "passed") problems.push(`${file}: "${a.title}" is ${a.status}`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("assertTestsExecuted.mjs")) {
  const [reportPath, ...files] = process.argv.slice(2);
  if (!reportPath || files.length === 0) {
    console.error("usage: assertTestsExecuted.mjs <report.json> <test-file> [...]");
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const problems = executionProblems(report, files);
  for (const file of files) {
    const r = report.testResults?.find((x) => (x.name ?? "").split(path.sep).join("/").endsWith(`/${file}`));
    const n = r?.assertionResults?.length ?? 0;
    const passed = r?.assertionResults?.filter((a) => a.status === "passed").length ?? 0;
    console.log(`${file}: ${n} tests, ${passed} passed, ${n - passed} not passed (skipped/todo/failed)`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`TESTS_EXECUTED: FAIL ${p}`);
    process.exit(1);
  }
  console.log("TESTS_EXECUTED: OK (every named test file ran; zero skipped, zero todo, zero failed)");
}
