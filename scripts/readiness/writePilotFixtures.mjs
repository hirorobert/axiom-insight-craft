#!/usr/bin/env bun
/**
 * Regenerates the pilot fixtures from src/lib/readiness/pilot/pilotData.ts, deterministically (LF, fixed order).
 *
 *   bun scripts/readiness/writePilotFixtures.mjs           write the files
 *   bun scripts/readiness/writePilotFixtures.mjs --check   compare the committed files with the regenerated ones (exit 1 on any difference)
 *
 * Needs bun (the generator is TypeScript). The committed files are also compared by a vitest, so a stale fixture fails CI.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PILOT_FILE_NAMES, PILOT_README, pilotFiles } from "../../src/lib/readiness/pilot/pilotData.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(ROOT, "src/lib/readiness/pilot/fixtures");
const files = pilotFiles({});
const out = { ...Object.fromEntries(Object.entries(PILOT_FILE_NAMES).map(([k, name]) => [name, files[k]])), "README.md": PILOT_README };

const check = process.argv.includes("--check");
let bad = 0;
mkdirSync(DIR, { recursive: true });
for (const [name, text] of Object.entries(out)) {
  const path = join(DIR, name);
  if (check) {
    const now = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (now !== text) { console.error(`DIFFERENT: ${name}`); bad++; }
  } else { writeFileSync(path, text, { encoding: "utf8" }); console.log(`wrote ${name}`); }
}
if (check) console.log(bad ? `${bad} file(s) differ` : "pilot fixtures are up to date");
process.exit(bad ? 1 : 0);
