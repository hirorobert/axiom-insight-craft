#!/usr/bin/env node
// Regressions for the FALSE POSITIVES NORMAL found on run 38919978092 (B passed without uploading; F/G read A's latest
// upload; D compared the whole snapshot). Pure, runs here.
import { accessOf, accessUnchanged, hasSandboxRecord, boundUploadId, requireCreatedUpload } from "./evidenceRules.mjs";

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d)}` : ""}`); } };
const group = (n) => console.log(`\n== ${n}`);

group("D false positive: effective access, not whole snapshot");
const before = { licenceStatus: null, plan: null, licences: [] };
const afterSandbox = { licenceStatus: null, plan: null, licences: ["POLAR_VERIFIED_PAYMENT:SANDBOX"] }; // recorded, grants nothing
const afterGrant = { licenceStatus: "ACTIVE", plan: "SOLO", licences: ["POLAR_VERIFIED_PAYMENT:SANDBOX", "AGREEMENT"] };
check("a SANDBOX order record does NOT count as an access change (kills the whole-snapshot false FAIL)", accessUnchanged(before, afterSandbox) === true);
check("the SANDBOX payment IS detectable as recorded (separate assertion)", hasSandboxRecord(afterSandbox) === true);
check("an authorised activation DOES change effective access", accessUnchanged(before, afterGrant) === false);
check("accessOf projects only licenceStatus + plan", JSON.stringify(accessOf(afterGrant)) === JSON.stringify({ licenceStatus: "ACTIVE", plan: "SOLO" }));

group("B/F/G false positive: bind to the scenario's OWN upload by source_file_hash, never 'latest'");
const rows = [
  { id: "A-upl", source_file_hash: "hashA", period_year: 2026 },   // A's (newest/"latest")
  { id: "B-upl", source_file_hash: "hashB", period_year: 2027 },   // B's own file
];
check("binding returns the scenario's OWN upload (hashB), not the latest (A)", boundUploadId(rows, "hashB") === "B-upl");
check("binding returns null when the scenario's own file is absent (no vacuous reuse of A)", boundUploadId(rows, "hashMISSING") === null);
check("binding refuses an ambiguous >1 match (never guesses)", boundUploadId([{ id: "x", source_file_hash: "h" }, { id: "y", source_file_hash: "h" }], "h") === null);

group("B false positive: no upload created where required ⇒ FAIL, never a vacuous pass");
check("a null uploadId yields a FAIL reason", typeof requireCreatedUpload(null, "B's file") === "string");
check("a real uploadId yields no problem", requireCreatedUpload("B-upl", "B's file") === null);

console.log(`\n${pass}/${pass + fail} evidence-rule regression checks passed.`);
process.exit(fail ? 1 : 0);
