#!/usr/bin/env bun
// Renders docs/reporting/COVERAGE_IFRS_FOR_SMES.md from src/lib/frameworkPacks/ (the file is pinned to the code by
// src/lib/frameworkPacks/frameworkPacks.test.ts). `--check` exits 1 when the committed file differs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IFRS_FOR_SMES_PACKS } from "../../src/lib/frameworkPacks/ifrsForSmes.ts";
import { IFRS_FOR_SMES_COVERAGE, renderCoverageMatrix } from "../../src/lib/frameworkPacks/coverage.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const file = path.join(REPO, "docs/reporting/COVERAGE_IFRS_FOR_SMES.md");
const text = renderCoverageMatrix(IFRS_FOR_SMES_PACKS, IFRS_FOR_SMES_COVERAGE);
if (process.argv[2] === "--check") {
  const same = fs.existsSync(file) && fs.readFileSync(file, "utf8") === text;
  console.log(same ? "COVERAGE_MATRIX: OK" : "COVERAGE_MATRIX: DRIFT (run bun scripts/release/renderCoverageMatrix.mjs)");
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(file, text);
console.log(`wrote ${path.relative(REPO, file)}`);
