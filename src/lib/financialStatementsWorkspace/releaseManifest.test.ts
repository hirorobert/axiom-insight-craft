// The release manifest must FAIL whenever any recorded value differs from the repository. These tests build throwaway
// git repositories (a `main` and a feature branch) and prove, mutation by mutation, that omitted, duplicated, reordered
// or unrelated commits, a changed file, migration, document, tree or base — or anything committed after the manifest —
// are detected. They also prove the design: the manifest is a tip commit that cannot name itself yet binds the tree.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// git on a throwaway repository is slow on some hosts (Windows); the limit is per test, not a performance claim.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
// @ts-expect-error — plain ESM library without types
import { buildManifest, MANIFEST_PATH, TIP_SENTINEL, treeWithout, verifyManifest } from "../../../scripts/release/manifestLib.mjs";

const dirs: string[] = [];
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
const write = (repo: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};
const commit = (repo: string, message: string) => {
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", message);
  return sh(repo, "rev-parse", "HEAD");
};

const DOCS = ["docs/release/A.md", "docs/release/B.md"];
const MIG = "supabase/migrations/20990101000000_new.sql";

/** main + a feature branch with three commits, a migration and two release documents; returns the repo. */
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
  dirs.push(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "core.autocrlf", "false");
  write(repo, "README.md", "base\n");
  write(repo, "supabase/migrations/20200101000000_old.sql", "-- old\n");
  commit(repo, "base");
  sh(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  sh(repo, "checkout", "-q", "-b", "feature");
  write(repo, "src/a.ts", "export const a = 1;\n");
  commit(repo, "feat: a");
  write(repo, MIG, "-- new migration\r\nSELECT 1;\r\n");
  write(repo, DOCS[0], "# A\n");
  write(repo, DOCS[1], "# B\n");
  commit(repo, "feat: migration and docs");
  write(repo, "src/b.ts", "export const b = 2;\n");
  commit(repo, "feat: b");
  return repo;
}

/** Builds the manifest for HEAD and commits ONLY it as the tip. */
async function seal(repo: string, mutate?: (m: Record<string, unknown>) => void) {
  const manifest = await buildManifest({ repo, baseRef: "origin/main", sourceRef: "HEAD", branch: "feature", docFiles: DOCS, extra: { applied: { productionMigration: false, productionFunctionsDeployed: false, productionFeatureEnabled: false } } });
  mutate?.(manifest);
  write(repo, MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, tip: commit(repo, "chore(release): manifest") };
}
const verify = (repo: string, manifestOverride?: unknown) => verifyManifest({ repo, baseRef: "origin/main", docFiles: DOCS, manifestOverride }) as Promise<string[]>;
const has = (problems: string[], fragment: string) => problems.some((p) => p.includes(fragment));

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("release manifest — construction", () => {
  let repo: string;
  let manifest: Record<string, any>;
  let tip: string;
  beforeAll(async () => {
    repo = makeRepo();
    ({ manifest, tip } = await seal(repo));
  });

  it("records the base, the source, the source TREE, every commit exactly once plus the tip sentinel, and the counts agree", async () => {
    const actual = sh(repo, "rev-list", "--reverse", "origin/main..HEAD").split("\n");
    expect(actual).toHaveLength(4); // 3 feature commits + the manifest tip
    expect(manifest.commits).toEqual([...actual.slice(0, 3), TIP_SENTINEL]);
    expect(actual[3]).toBe(tip);
    expect(manifest.commitCount).toBe(actual.length);
    expect(manifest.baseCommit).toBe(sh(repo, "rev-parse", "origin/main"));
    expect(manifest.sourceCommit).toBe(sh(repo, "rev-parse", "HEAD^"));
    expect(manifest.sourceTree).toBe(sh(repo, "rev-parse", "HEAD^^{tree}"));
    expect(new Set(manifest.commits).size).toBe(manifest.commits.length);
  });

  it("the tree binding is real: the tip's tree without the manifest IS the source tree (the manifest cannot name itself, yet binds the tree)", async () => {
    expect(await treeWithout(repo, "HEAD", MANIFEST_PATH)).toBe(manifest.sourceTree);
    expect(sh(repo, "diff", "--name-only", "HEAD^", "HEAD")).toBe(MANIFEST_PATH);
  });

  it("records the changed-file inventory and LF-normalised migration and document hashes", async () => {
    expect(manifest.changedFiles).toEqual(["A\tdocs/release/A.md", "A\tdocs/release/B.md", "A\tsrc/a.ts", "A\tsrc/b.ts", `A\t${MIG}`].sort());
    expect(Object.keys(manifest.migrations)).toEqual([MIG]);
    // the migration was committed with CRLF line endings; its recorded hash is of the LF form
    expect(manifest.migrations[MIG]).toBe(require("node:crypto").createHash("sha256").update("-- new migration\nSELECT 1;\n").digest("hex"));
    expect(Object.keys(manifest.documents)).toEqual(DOCS);
  });

  it("verifies clean", async () => {
    expect(await verify(repo)).toEqual([]);
  });
});

describe("release manifest — every difference between the manifest and the repository is a failure", () => {
  // One sealed repository serves every "recorded value differs" case: the manifest is tampered in memory and verified against it.
  let shared: { repo: string; manifest: Record<string, any> };
  beforeAll(async () => {
    const repo = makeRepo();
    shared = { repo, manifest: (await seal(repo)).manifest };
  });
  const sealed = async () => {
    const repo = makeRepo();
    return { repo, ...(await seal(repo)) };
  };
  const tampered = async (mutate: (m: Record<string, any>) => void) => {
    const copy = JSON.parse(JSON.stringify(shared.manifest));
    mutate(copy);
    return verify(shared.repo, copy);
  };

  it("an OMITTED commit", async () => {
    expect(has(await tampered((m) => m.commits.splice(1, 1)), "omitted")).toBe(true);
  });

  it("a DUPLICATED commit", async () => {
    expect(has(await tampered((m) => m.commits.splice(1, 0, m.commits[0])), "more than once")).toBe(true);
  });

  it("REORDERED commits", async () => {
    expect(has(await tampered((m) => ([m.commits[0], m.commits[1]] = [m.commits[1], m.commits[0]])), "different order")).toBe(true);
  });

  it("an UNRELATED commit in the list", async () => {
    expect(has(await tampered((m) => m.commits.splice(1, 0, "0".repeat(40))), "not in origin/main..HEAD")).toBe(true);
  });

  it("a wrong commit count", async () => {
    expect(has(await tampered((m) => (m.commitCount += 1)), "commitCount")).toBe(true);
  });

  it("a wrong base commit", async () => {
    expect(has(await tampered((m) => (m.baseCommit = "1".repeat(40))), "baseCommit")).toBe(true);
  });

  it("a wrong source commit or source tree", async () => {
    expect(has(await tampered((m) => (m.sourceCommit = "2".repeat(40))), "sourceCommit")).toBe(true);
    expect(has(await tampered((m) => (m.sourceTree = "3".repeat(40))), "sourceTree")).toBe(true);
  });

  it("a changed-file inventory that omits, adds or alters an entry", async () => {
    expect(has(await tampered((m) => m.changedFiles.pop()), "changed-file inventory")).toBe(true);
    expect(has(await tampered((m) => m.changedFiles.push("A\tsrc/ghost.ts")), "changed-file inventory")).toBe(true);
    expect(has(await tampered((m) => (m.changedFiles[0] = "M\tdocs/release/A.md")), "changed-file inventory")).toBe(true);
  });

  it("a migration filename or hash that differs, or a migration that is missing from the manifest", async () => {
    expect(has(await tampered((m) => (m.migrations[MIG] = "0".repeat(64))), "migration")).toBe(true);
    expect(has(await tampered((m) => delete m.migrations[MIG]), "migration")).toBe(true);
    expect(has(await tampered((m) => (m.migrations["supabase/migrations/20990101000001_ghost.sql"] = "0".repeat(64))), "migration")).toBe(true);
  });

  it("a release-document hash that differs, or a document missing from the manifest", async () => {
    expect(has(await tampered((m) => (m.documents[DOCS[0]] = "0".repeat(64))), "release-document")).toBe(true);
    expect(has(await tampered((m) => delete m.documents[DOCS[1]]), "release-document")).toBe(true);
  });

  it("a manifest that claims anything was applied, deployed or enabled in production", async () => {
    expect(has(await tampered((m) => (m.applied.productionMigration = true)), "applied, deployed or enabled")).toBe(true);
    expect(has(await tampered((m) => delete m.applied), "applied, deployed or enabled")).toBe(true);
  });

  it("ANY commit made after the manifest (the candidate is no longer the manifest tip)", async () => {
    const { repo } = await sealed();
    write(repo, "src/late.ts", "export const late = 1;\n");
    commit(repo, "late commit");
    const p = await verify(repo);
    expect(has(p, "not a manifest-only tip")).toBe(true);
    expect(has(p, "sourceCommit")).toBe(true);
  });

  it("a tip commit that changes anything besides the manifest", async () => {
    const repo = makeRepo();
    const manifest = await buildManifest({ repo, baseRef: "origin/main", sourceRef: "HEAD", branch: "feature", docFiles: DOCS, extra: { applied: { productionMigration: false, productionFunctionsDeployed: false, productionFeatureEnabled: false } } });
    write(repo, MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
    write(repo, "src/smuggled.ts", "export const smuggled = 1;\n");
    commit(repo, "manifest plus a smuggled file");
    const p = await verify(repo);
    expect(has(p, "not a manifest-only tip")).toBe(true);
    expect(has(p, "differs from sourceTree")).toBe(true);
  });

  it("a release document or migration edited after the manifest was built (the tree no longer matches)", async () => {
    const repo = makeRepo();
    const manifest = await buildManifest({ repo, baseRef: "origin/main", sourceRef: "HEAD", branch: "feature", docFiles: DOCS, extra: { applied: { productionMigration: false, productionFunctionsDeployed: false, productionFeatureEnabled: false } } });
    write(repo, DOCS[0], "# A — edited after the manifest\n");
    write(repo, MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
    commit(repo, "edit a doc and add the stale manifest in one commit");
    const p = await verify(repo);
    expect(p.length).toBeGreaterThan(0);
  });

  it("a missing manifest is a failure", async () => {
    const repo = makeRepo();
    expect(has(await verify(repo), "missing or unreadable")).toBe(true);
  });
});
