#!/usr/bin/env node
// Build-output guard: the development gallery (src/dev/, dev/trial-balance-states.html) and its synthetic fixtures must
// never reach a production build. Scans EVERY file under dist/ (entry and lazy chunks, HTML, maps) for the gallery's
// markers and fixture strings, and requires that no dev/ HTML was emitted. Fails closed on an empty or missing dist.
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve(process.argv[2] ?? "dist");
if (!fs.existsSync(path.join(DIST, "index.html"))) throw new Error(`no build at ${DIST} (run the build first)`);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = walk(DIST);
if (!files.some((f) => f.endsWith(".js"))) throw new Error("no JavaScript in the build — the scan would be vacuous");

const MARKERS = [
  "trial-balance-states", "TrialBalanceStatesGallery", "trialBalanceStatesEntry", "Development gallery",
  "Sample Trading Ltd", "sample_trial_balance_FY2025", "sample_trial_balance_v1", "sample_trial_balance_draft",
  "synthetic-upload", "synthetic-engagement",
];
const found = [];
for (const f of files) {
  const rel = path.relative(DIST, f).split(path.sep).join("/");
  if (rel.startsWith("dev/")) found.push(`${rel}: dev HTML emitted`);
  const text = fs.readFileSync(f, "utf8");
  for (const m of MARKERS) if (text.includes(m)) found.push(`${rel}: "${m}"`);
}
if (found.length) throw new Error(`development gallery content in the production build:\n  ${found.join("\n  ")}`);
console.log(`DEV_GALLERY_EXCLUDED: OK (${files.length} build files scanned; no gallery route, entry or fixture)`);
