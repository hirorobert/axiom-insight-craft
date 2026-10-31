/** Offline developer runner. Explicit local input/output only; never accesses a backend or provider. */
import fs from "node:fs";
import { prepareNgo } from "./preparation";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("Usage: bun release/candidates/ipsas-accrual-r1/demo.ts <local-input.json> <local-result.json>");
const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const input = raw.fixtureOnly === true && raw.notManagementEvidence === true ? raw.input : raw;
const result = prepareNgo(input);
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ schema: result.schema, label: result.label, publicationAuthorized: result.publicationAuthorized,
  accountingResultSha256: result.accountingResultSha256, sourceSha256: result.sourceSha256,
  currentTotals: result.current.totals, blockers: result.blockers.length }));
