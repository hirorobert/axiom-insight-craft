#!/usr/bin/env node
// Phase 5 — test recorder. Runs every suite, captures full output + exit status, and categorises each as
// PROTOTYPE (pure Node), REAL-CONTRACT (executes the real production contract here), or DEFERRED (needs a runtime this
// host lacks). Prints a categorised log and a roll-up; exits non-zero if any EXECUTED suite fails.
//
// RUN:    node research/phase5/run_all.mjs
// RECORD: node research/phase5/run_all.mjs > research/phase5/TEST-OUTPUT.md   (the committed record)
import { spawnSync } from "node:child_process";

const SUITES = [
  { cat: "PROTOTYPE", file: "research/phase5/tests/phase5.test.mjs", flags: [], note: "Deterministic 5-layer prototype + lifecycle (7 North-Star behaviours)." },
  { cat: "PROTOTYPE", file: "research/phase5/tests/coverage.test.mjs", flags: [], note: "Extended synthetic coverage; detection concepts separated; limits disclosed as LIMIT lines." },
  { cat: "PROTOTYPE", file: "research/phase5/tests/manual.test.mjs", flags: [], note: "Manual multi-account treatment path: no inferred-equivalence grouping, visual-by-issue, atomic submission, cross-tenant/stale/idempotency/concurrent-conflict, reuse-context." },
  { cat: "PROTOTYPE", file: "research/phase5/tests/accounting_boundaries.test.mjs", flags: [], note: "Accounting-boundary refusals: prepayment three-component bridge, two-TB net movement, source imbalance survives balanced adjustment, signed-prior vs comparative, corrected-version immutability, MUSE candidate-rule scope." },
  { cat: "REAL-CONTRACT (executed here)", file: "research/phase5/tests/real_contract_static.mjs", flags: [], note: "Parses the REAL resolve_account_review_batch SQL; asserts field+semantics compatibility. Static — necessary, not sufficient." },
  { cat: "REAL-CONTRACT (executed here)", file: "research/phase5/proof/real_layout_contract.mjs", flags: ["--experimental-strip-types"], note: "Imports & executes the REAL layoutProfile.ts (validateProfile + resolveLayout) to prove the SunSystems manual-layout fallback." },
];

const DEFERRED = [
  {
    cat: "DEFERRED (not executed on this host)", file: "research/phase5/proof/real_contract_proof.mjs",
    reason: "Needs a disposable PostgreSQL 17 (no Docker / local PG / embedded-pg available here; scope confines writes to research/phase5/** so no CI workflow was added). Coordinate the run with NORMAL on the existing branch — DB requirements/migration chain are in HANDOFF.md §Coordination. NEVER run it against hosted customer systems; it refuses the production ref and non-loopback hosts.",
    replay: "DB_PROOF_CONN=postgres://user:pass@127.0.0.1:5432/db node research/phase5/proof/real_contract_proof.mjs",
    proves: "EXECUTION against the real RPC on the replayed authoritative chain: legitimate success + every refusal + the reuse/invalidation lifecycle + the MANUAL path (USER_MANUAL_CLASSIFICATION) + atomic mixed-batch failure + conflicting-decision serialization.",
  },
];

function hr(ch = "─") { return ch.repeat(110); }
const results = [];
console.log(`# Phase 5 — recorded test output\n`);
console.log(`Runtime: Node ${process.version} on ${process.platform}. Recorder: research/phase5/run_all.mjs.`);
console.log(`Legend: PROTOTYPE = pure Node; REAL-CONTRACT = executes the unmodified production contract here; DEFERRED = needs a runtime this host lacks.\n`);

let lastCat = null;
for (const s of SUITES) {
  if (s.cat !== lastCat) { console.log(`\n${hr("═")}\n## ${s.cat}\n${hr("═")}`); lastCat = s.cat; }
  console.log(`\n### ${s.file}\n_${s.note}_\n`);
  const r = spawnSync(process.execPath, [...s.flags, s.file], { encoding: "utf8" });
  const out = (r.stdout || "") + ((r.stderr || "").split("\n").filter((l) => l && !/ExperimentalWarning|--trace-warnings|Type Stripping is an experimental/.test(l)).join("\n"));
  console.log("```");
  process.stdout.write(out.trimEnd() + "\n");
  console.log("```");
  console.log(`**exit status: ${r.status}**`);
  results.push({ file: s.file, cat: s.cat, status: r.status });
}

console.log(`\n${hr("═")}\n## DEFERRED (recorded, NOT executed here)\n${hr("═")}`);
for (const d of DEFERRED) {
  console.log(`\n### ${d.file}\n- **Why deferred:** ${d.reason}\n- **Proves (when run):** ${d.proves}\n- **One-command replay:** \`${d.replay}\``);
  results.push({ file: d.file, cat: d.cat, status: "DEFERRED" });
}

console.log(`\n${hr("═")}\n## Roll-up\n${hr("═")}\n`);
const executed = results.filter((r) => r.status !== "DEFERRED");
const failed = executed.filter((r) => r.status !== 0);
for (const r of results) console.log(`- ${r.status === 0 ? "PASS" : r.status === "DEFERRED" ? "DEFERRED" : "FAIL"}  [${r.cat}]  ${r.file}  (exit ${r.status})`);
console.log(`\nExecuted: ${executed.length}  ·  Passed: ${executed.length - failed.length}  ·  Failed: ${failed.length}  ·  Deferred: ${results.length - executed.length}`);
process.exit(failed.length ? 1 : 0);
