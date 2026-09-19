// The release manifest: build and verify.
//
// DESIGN (the only way a manifest can bind itself to the final repository state):
//
//   A commit cannot contain its own hash, so a manifest committed INSIDE the release cannot name the commit
//   that carries it. This design removes the self-reference without loosening the binding:
//
//     * the release candidate is  HEAD  =  SOURCE + one tip commit;
//     * the tip commit adds/updates ONLY docs/release/release-manifest.json (verified, not assumed);
//     * the manifest records the SOURCE commit and the SOURCE TREE hash (the git tree of the candidate with the manifest
//       file removed — reproducible by anyone with `git write-tree` over a temporary index);
//     * the commit list holds every commit of origin/main..SOURCE in order, each exactly once, followed by the
//       sentinel "MANIFEST_TIP" standing for the tip commit itself. Its position and content are verified
//       structurally (it must be HEAD, its parent must be SOURCE, its diff must be exactly the manifest path),
//       so COMMIT_COUNT_MANIFEST equals the real count of origin/main..HEAD;
//     * everything else (changed-file inventory, migration hashes, release-document hashes) is recomputed from
//       the repository and compared, so ANY difference between the manifest and the repository is a failure.
//
//   Verification therefore proves: the tree being released (minus only the manifest) is byte-identical to the tree the
//   manifest describes, the commit history is exactly the listed one, and nothing was added after the manifest.
//
// Pure library: every git call runs in `repo`, so tests can exercise it on throwaway repositories.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANIFEST_PATH = "docs/release/release-manifest.json";
export const TIP_SENTINEL = "MANIFEST_TIP";
export const SCHEMA = "cfoclose.release-manifest.v2";

const run = promisify(execFile);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const lf = (buf) => Buffer.from(Buffer.from(buf).toString("utf8").replace(/\r\n/g, "\n"), "utf8"); // hash the LF form: identical on every checkout

// Asynchronous on purpose: many small git processes must not block the event loop of a test worker or a CI step.
export async function git(repo, args, { env } = {}) {
  const { stdout } = await run("git", args, { cwd: repo, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  return stdout.replace(/\n$/, "");
}
const lines = (text) => text.split("\n").filter(Boolean);
const showBlob = async (repo, ref, file) => (await run("git", ["show", `${ref}:${file}`], { cwd: repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })).stdout;
const tryGit = async (repo, args) => {
  try {
    return await git(repo, args);
  } catch {
    return null;
  }
};

/** The git tree of `ref` with one path removed, computed through a temporary index (the working tree and index are untouched). */
export async function treeWithout(repo, ref, removePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-index-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    await git(repo, ["read-tree", ref], { env });
    if (await tryGit(repo, ["ls-tree", ref, "--", removePath])) await git(repo, ["update-index", "--force-remove", removePath], { env });
    return await git(repo, ["write-tree"], { env });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Everything the manifest records about SOURCE, computed from the repository. */
export async function describeSource({ repo, baseRef, sourceRef, migrationsDir, docFiles }) {
  const baseCommit = await git(repo, ["rev-parse", baseRef]);
  const sourceCommit = await git(repo, ["rev-parse", sourceRef]);
  const commits = lines(await git(repo, ["rev-list", "--reverse", `${baseCommit}..${sourceCommit}`]));
  const changed = lines(await git(repo, ["diff", "--name-status", "--no-renames", baseCommit, sourceCommit])).filter((l) => l.split("\t")[1] !== MANIFEST_PATH).sort();
  const migrations = lines(await git(repo, ["diff", "--name-only", "--diff-filter=A", baseCommit, sourceCommit, "--", migrationsDir])).sort();
  const migrationHashes = {};
  for (const f of migrations) migrationHashes[f] = sha(lf(await showBlob(repo, sourceCommit, f)));
  const documents = {};
  for (const f of [...docFiles].sort()) if (await tryGit(repo, ["ls-tree", sourceCommit, "--", f])) documents[f] = sha(lf(await showBlob(repo, sourceCommit, f)));
  return { baseCommit, sourceCommit, sourceTree: await treeWithout(repo, sourceCommit, MANIFEST_PATH), commits, changedFiles: changed, migrations: migrationHashes, documents };
}

export async function buildManifest({ repo, baseRef, sourceRef = "HEAD", branch, migrationsDir = "supabase/migrations", docFiles, extra = {} }) {
  const d = await describeSource({ repo, baseRef, sourceRef, migrationsDir, docFiles });
  const commits = [...d.commits, TIP_SENTINEL];
  return {
    schema: SCHEMA,
    release: "financial-statements-production-readiness",
    branch,
    design: "Candidate = sourceCommit + one manifest-only tip commit. sourceTree is the git tree of the candidate without docs/release/release-manifest.json. commits lists origin/main..sourceCommit followed by MANIFEST_TIP (the tip itself). Verification recomputes every field.",
    baseCommit: d.baseCommit,
    sourceCommit: d.sourceCommit,
    sourceTree: d.sourceTree,
    commitCount: commits.length,
    commits,
    changedFiles: d.changedFiles,
    migrations: d.migrations,
    documents: d.documents,
    ...extra,
  };
}

/** Returns a list of problems; empty means the manifest describes exactly this repository state. */
export async function verifyManifest({ repo, baseRef, headRef = "HEAD", migrationsDir = "supabase/migrations", docFiles, manifestOverride }) {
  const problems = [];
  const head = await git(repo, ["rev-parse", headRef]);
  const parent = await tryGit(repo, ["rev-parse", `${head}^`]);
  let manifest;
  try {
    manifest = manifestOverride ?? JSON.parse((await showBlob(repo, head, MANIFEST_PATH)).toString("utf8"));
  } catch {
    return [`the manifest ${MANIFEST_PATH} is missing or unreadable at ${head}`];
  }
  if (manifest.schema !== SCHEMA) problems.push(`unexpected manifest schema ${manifest.schema}`);
  if (!parent) return [...problems, "HEAD has no parent, so it cannot be a manifest tip"];

  // 1. HEAD is the manifest-only tip, on top of exactly the recorded source.
  const tipFiles = lines(await git(repo, ["diff", "--name-only", parent, head]));
  if (tipFiles.length !== 1 || tipFiles[0] !== MANIFEST_PATH) problems.push(`HEAD is not a manifest-only tip commit (it changes: ${tipFiles.slice(0, 5).join(", ") || "nothing"})`);
  if (manifest.sourceCommit !== parent) problems.push(`sourceCommit ${String(manifest.sourceCommit).slice(0, 12)} is not the parent of HEAD (${parent.slice(0, 12)}): something was committed after the manifest, or the manifest is stale`);

  // 2. The tree being released, minus only the manifest, is the tree the manifest describes.
  const treeNow = await treeWithout(repo, head, MANIFEST_PATH);
  if (manifest.sourceTree !== treeNow) problems.push("the repository tree (without the manifest) differs from sourceTree");
  if (manifest.sourceTree !== (await git(repo, ["rev-parse", `${parent}^{tree}`])) && tipFiles.length === 1) problems.push("sourceTree is not the tree of the source commit");

  // 3. Base.
  const base = await git(repo, ["rev-parse", baseRef]);
  if (manifest.baseCommit !== base) problems.push(`baseCommit differs from ${baseRef}`);

  // 4. Every commit of base..HEAD, each exactly once, in order, the tip standing as the sentinel.
  const actual = lines(await git(repo, ["rev-list", "--reverse", `${base}..${head}`]));
  const expected = [...actual.slice(0, -1), TIP_SENTINEL];
  const listed = Array.isArray(manifest.commits) ? manifest.commits : [];
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    const dup = listed.filter((c, i) => listed.indexOf(c) !== i);
    const omitted = expected.filter((c) => !listed.includes(c));
    const unrelated = listed.filter((c) => !expected.includes(c));
    if (dup.length) problems.push(`commits listed more than once: ${[...new Set(dup)].map((c) => c.slice(0, 12)).join(", ")}`);
    if (omitted.length) problems.push(`commits omitted from the manifest: ${omitted.map((c) => c.slice(0, 12)).join(", ")}`);
    if (unrelated.length) problems.push(`commits in the manifest that are not in ${baseRef}..HEAD: ${unrelated.map((c) => c.slice(0, 12)).join(", ")}`);
    if (!dup.length && !omitted.length && !unrelated.length) problems.push("the commit list is in a different order than the repository history");
  }
  if (manifest.commitCount !== actual.length || manifest.commitCount !== listed.length) problems.push(`commitCount ${manifest.commitCount} does not equal the ${actual.length} commits of ${baseRef}..HEAD (list has ${listed.length})`);

  // 5. Everything else is recomputed and compared.
  const d = await describeSource({ repo, baseRef, sourceRef: parent, migrationsDir, docFiles });
  if (JSON.stringify(manifest.changedFiles) !== JSON.stringify(d.changedFiles)) problems.push("the changed-file inventory differs from the repository");
  if (JSON.stringify(manifest.migrations) !== JSON.stringify(d.migrations)) problems.push("migration filenames or LF-normalised hashes differ from the repository");
  if (JSON.stringify(manifest.documents) !== JSON.stringify(d.documents)) problems.push("release-document hashes (or the document set) differ from the repository");

  // 6. Nothing production-side has happened.
  if (JSON.stringify(manifest.applied) !== JSON.stringify({ productionMigration: false, productionFunctionsDeployed: false, productionFeatureEnabled: false })) problems.push("the manifest does not declare that nothing was applied, deployed or enabled in production");
  return problems;
}
