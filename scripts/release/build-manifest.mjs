// Builds docs/release/release-manifest.json — the immutable description of what is
// being released: base/source commits, the SHA-256 of every new migration, the SHA-256
// of the built artifacts (dist/), the names (never values) of secrets any step needs,
// and the state every gate must be in.
//
// Reproducible: no clock is written, so the same commit + the same dist/ give the same
// file. `sourceCommit` is the commit the manifest was built FROM (its own commit is the
// one that adds this file, so it cannot name itself).
//
// Usage: node scripts/release/build-manifest.mjs [--check]
//   --check   fail if the committed manifest is not what would be built now

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(REPO, "docs/release/release-manifest.json");
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const norm = (buf) => Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8"); // hash the LF form so the value is identical on every checkout

const BASE_REF = process.env.RELEASE_BASE_REF ?? "origin/main";
const baseCommit = git("rev-parse", BASE_REF);
const sourceCommit = git("rev-parse", "HEAD");
const branch = process.env.RELEASE_BRANCH ?? "codex/financial-statements-production-readiness"; // fixed: a detached verification checkout would otherwise record "HEAD"

const migrations = git("diff", "--name-only", "--diff-filter=A", `${baseCommit}...HEAD`, "--", "supabase/migrations").split("\n").filter(Boolean).sort();
const migrationHashes = Object.fromEntries(migrations.map((f) => [f, sha(norm(fs.readFileSync(path.join(REPO, f))))]));

const filesUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const dist = path.join(REPO, "dist");
const artifacts = Object.fromEntries(filesUnder(dist).map((f) => [path.relative(REPO, f).split(path.sep).join("/"), sha(fs.readFileSync(f))]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

const docFiles = ["docs/release/FINANCIAL_STATEMENTS_ACTIVATION.md", "docs/release/FINANCIAL_STATEMENTS_RELEASE_PACKAGE.md", ...filesUnder(path.join(REPO, "docs/release/sql")).map((f) => path.relative(REPO, f).split(path.sep).join("/"))].sort();
const documents = Object.fromEntries(docFiles.filter((f) => fs.existsSync(path.join(REPO, f))).map((f) => [f, sha(norm(fs.readFileSync(path.join(REPO, f))))]));

const manifest = {
  schema: "cfoclose.release-manifest.v1",
  release: "financial-statements-production-readiness",
  branch,
  baseCommit,
  sourceCommit,
  migrations: migrationHashes,
  documents,
  artifacts: { note: Object.keys(artifacts).length === 0 ? "dist/ was not present when this manifest was built; run `npm run build` and rebuild the manifest" : "sha256 of every file in dist/", files: artifacts },
  productionProjectRef: { value: "bvyivmmfjejbmqoydezk", use: "identity protection only — no command in this release contacts it" },
  secretNames: {
    note: "Names only. Values are never stored in this repository.",
    browser: ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY (public anon key; already deployed)"],
    operatorOnly: ["service-role key of the target project (used solely to run docs/release/sql/03-05 as a named operator; never shipped to a browser)"],
    ciStaging: ["STAGING_SUPABASE_URL", "STAGING_SUPABASE_SERVICE_ROLE_KEY", "STAGING_SUPABASE_PROJECT_REF"],
  },
  requiredGateState: {
    FINANCIAL_STATEMENTS_WORKSPACE_ENABLED: false,
    FINANCIAL_STATEMENT_PERSISTENCE_ENABLED: false,
    DOCUMENT_REVIEW_ENABLED: false,
    serverRollout: "default denied: zero companies enabled, kill switch not engaged",
  },
  applied: { productionMigration: false, productionFunctionsDeployed: false, productionFeatureEnabled: false },
};

const text = JSON.stringify(manifest, null, 2) + "\n";
if (process.argv.includes("--check")) {
  // The manifest's own commit cannot be its sourceCommit, so --check verifies content, not the commit id:
  // sourceCommit must be an ancestor of HEAD, and the migration and document hashes must match the files now on disk.
  if (!fs.existsSync(OUT)) {
    console.error("release-manifest.json is missing; run: node scripts/release/build-manifest.mjs");
    process.exit(1);
  }
  const existing = JSON.parse(fs.readFileSync(OUT, "utf8"));
  let ancestor = true;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", existing.sourceCommit, "HEAD"], { cwd: REPO });
  } catch {
    ancestor = false;
  }
  const problems = [];
  if (!ancestor) problems.push(`sourceCommit ${existing.sourceCommit} is not an ancestor of HEAD`);
  if (existing.baseCommit !== baseCommit) problems.push("baseCommit differs");
  if (JSON.stringify(existing.migrations) !== JSON.stringify(migrationHashes)) problems.push("migration hashes differ");
  const docsNow = Object.fromEntries(Object.entries(documents));
  for (const [f, h] of Object.entries(existing.documents)) if (docsNow[f] !== h) problems.push(`document changed since the manifest: ${f}`);
  const built = Object.keys(artifacts).length > 0;
  if (built && JSON.stringify(existing.artifacts.files) !== JSON.stringify(artifacts)) problems.push("artifact hashes differ from the current dist/");
  if (problems.length > 0) {
    console.error(["release-manifest.json is stale:", ...problems.map((p) => ` - ${p}`)].join("\n"));
    process.exit(1);
  }
  console.log(`release-manifest.json is current (source ${existing.sourceCommit.slice(0, 8)}, ${Object.keys(existing.migrations).length} migrations${built ? ", artifacts verified" : ", artifacts not re-checked: no dist/"})`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(REPO, OUT)} (source ${sourceCommit.slice(0, 8)}, ${Object.keys(migrationHashes).length} migrations, ${Object.keys(artifacts).length} artifacts)`);
}
