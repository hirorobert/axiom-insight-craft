#!/usr/bin/env node
// Renders the guarded release entries and the read-only inspection into release/candidates/ (scripts/release/guardedEntry.mjs).
//   node scripts/release/renderRelease2026_10.mjs           write the files
//   node scripts/release/renderRelease2026_10.mjs --check   exit 1 when a committed file differs from its rendering
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderRelease } from "./guardedEntry.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
let differ = 0;
for (const [rel, text] of Object.entries(renderRelease(REPO))) {
  const file = path.join(REPO, rel);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current === text) { console.log(`unchanged ${rel}`); continue; }
  if (check) { differ += 1; console.log(`DIFFERS   ${rel}`); continue; }
  fs.writeFileSync(file, text); console.log(`wrote     ${rel}`);
}
process.exit(differ ? 1 : 0);
