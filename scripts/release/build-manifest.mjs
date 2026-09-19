// Builds and verifies docs/release/release-manifest.json.
//
//   node scripts/release/build-manifest.mjs           write the manifest for HEAD (then commit ONLY that file as the tip commit)
//   node scripts/release/build-manifest.mjs --check   verify that HEAD is that tip commit and the manifest describes the repository exactly
//
// The design (why a manifest can bind the final tree without naming its own commit) is documented in manifestLib.mjs
// and in docs/release/FINANCIAL_STATEMENTS_RELEASE_PACKAGE.md. Nothing here reads the clock; the same repository state
// always yields the same manifest.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, git, MANIFEST_PATH, verifyManifest } from "./manifestLib.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE_REF = process.env.RELEASE_BASE_REF ?? "origin/main";
const BRANCH = process.env.RELEASE_BRANCH ?? "codex/financial-statements-production-readiness"; // fixed: a detached checkout would otherwise record "HEAD"

const docFilesAt = async (ref) => (await git(REPO, ["ls-tree", "-r", "--name-only", ref, "docs/release"])).split("\n").filter((f) => f && f !== MANIFEST_PATH);

const dist = path.join(REPO, "dist");
const filesUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);

if (process.argv.includes("--check")) {
  const parent = await git(REPO, ["rev-parse", "HEAD^"]);
  const problems = await verifyManifest({ repo: REPO, baseRef: BASE_REF, docFiles: await docFilesAt(parent) });
  if (problems.length > 0) {
    console.error(["release-manifest.json does not match the repository:", ...problems.map((p) => ` - ${p}`)].join("\n"));
    process.exit(1);
  }
  const m = JSON.parse(fs.readFileSync(path.join(REPO, MANIFEST_PATH), "utf8"));
  console.log(`release-manifest.json matches the repository exactly (source ${m.sourceCommit.slice(0, 12)}, tree ${m.sourceTree.slice(0, 12)}, ${m.commitCount} commits incl. the manifest tip, ${Object.keys(m.migrations).length} migrations, ${m.changedFiles.length} changed files)`);
} else {
  const head = await git(REPO, ["rev-parse", "HEAD"]);
  const touched = (await git(REPO, ["diff", "--name-only", "HEAD^", "HEAD"])).split("\n").filter(Boolean);
  if (touched.length === 1 && touched[0] === MANIFEST_PATH) {
    console.error("HEAD is already a manifest-only tip commit. To rebuild the manifest, reset to its parent first (git reset --hard HEAD^), then run this again.");
    process.exit(1);
  }
  if ((await git(REPO, ["status", "--porcelain", "--untracked-files=no"])) !== "") {
    console.error("The working tree has uncommitted changes to tracked files: the manifest describes committed state only. Commit or stash them first.");
    process.exit(1);
  }
  const artifacts = filesUnder(dist).map((f) => path.relative(REPO, f).split(path.sep).join("/")).sort();
  const manifest = await buildManifest({
    repo: REPO,
    baseRef: BASE_REF,
    sourceRef: "HEAD",
    branch: BRANCH,
    docFiles: await docFilesAt("HEAD"),
    extra: {
      productionProjectRef: { value: "bvyivmmfjejbmqoydezk", use: "identity protection only — no command in this release contacts it" },
      secretNames: {
        note: "Names only. Values are never stored in this repository.",
        browser: ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY (public anon key; already deployed)"],
        operatorOnly: ["service-role key of the target project (used solely to run docs/release/sql/03-05 as a named operator; never shipped to a browser)"],
        ciStaging: ["STAGING_SUPABASE_URL", "STAGING_SUPABASE_ANON_KEY", "STAGING_SUPABASE_SERVICE_ROLE_KEY", "STAGING_SUPABASE_PROJECT_REF (a variable, not a secret)"],
      },
      requiredGateState: {
        FINANCIAL_STATEMENTS_WORKSPACE_ENABLED: false,
        FINANCIAL_STATEMENT_PERSISTENCE_ENABLED: false,
        DOCUMENT_REVIEW_ENABLED: false,
        serverRollout: "default denied: zero companies enabled, kill switch not engaged",
      },
      applied: { productionMigration: false, productionFunctionsDeployed: false, productionFeatureEnabled: false },
      hostedStaging: { result: "BLOCKED_MISSING_STAGING_PROJECT", note: "No hosted staging project is configured. Local disposable-database proof is separate and is not hosted acceptance." },
      buildArtifacts: { note: artifacts.length === 0 ? "dist/ was not present" : "the vite build embeds the build time and the commit id, so artifact bytes are not reproducible; only their names are listed", files: artifacts },
    },
  });
  fs.mkdirSync(path.dirname(path.join(REPO, MANIFEST_PATH)), { recursive: true });
  fs.writeFileSync(path.join(REPO, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${MANIFEST_PATH} for source ${head.slice(0, 12)} (${manifest.commitCount} commits incl. the manifest tip, ${Object.keys(manifest.migrations).length} migrations). Commit ONLY this file as the tip commit.`);
}
