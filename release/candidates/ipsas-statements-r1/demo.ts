/** Explicit local fixture CLI; never imports secrets or contacts an external service. */
import fs from "node:fs";
import { composeIpsasStatements } from "./compose";
import { renderIpsasStatementReview } from "./render";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("Usage: bun run release/candidates/ipsas-statements-r1/demo.ts INPUT.json OUTPUT.html");
const report = composeIpsasStatements(JSON.parse(fs.readFileSync(inputPath, "utf8")));
fs.writeFileSync(outputPath, renderIpsasStatementReview(report), { flag: "wx" });
console.log(JSON.stringify({ outputPath, statementCount: report.statements.length, reconciliations: report.checks,
  inputSha256: report.inputSha256, accountingResultSha256: report.accountingResultSha256, publicationAuthorized: false }, null, 2));
