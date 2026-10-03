/**
 * The database-inertness guard's comparison base is exact and fail-closed (scripts/ci/inertBase.mjs), its review is
 * exact-file, and CI proves the guard executed with zero skipped tests (scripts/ci/assertTestsExecuted.mjs). Exercised
 * against a REAL temporary git repository, so ancestry, staleness and missing commits are git's own answers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveComparisonBase, unreviewedChanges, unreviewedPaths } from "../../../scripts/ci/inertBase.mjs";
import { executionProblems } from "../../../scripts/ci/assertTestsExecuted.mjs";

const ROOT = path.resolve(__dirname, "../../..");
let dir: string;
const sh = (cmd: string) => execSync(cmd, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (args: string): string | null => {
  try { return execSync(`git ${args}`, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
};
const commit = (files: Record<string, string>, msg: string) => {
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  sh(`git add -A && git -c user.email=t@example.test -c user.name=t commit -q -m "${msg}"`);
  return sh("git rev-parse HEAD").trim();
};

const REVIEWED_MIGRATION = "supabase/migrations/20261002100000_refuse_withheld_service_grants.sql";
const REVIEWED_PROOF = "scripts/db-proof/serviceWithholding.mjs";
const added = new Set([REVIEWED_MIGRATION]);
const modified = new Set<string>();
const allowed = new Set([REVIEWED_PROOF, ".github/workflows/ci.yml"]);

let base: string; let head: string; let unrelated: string; let advancedBase: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inert-base-"));
  sh("git init -q -b main");
  base = commit({ "supabase/migrations/0001_init.sql": "select 1;\n", "scripts/ci/x.mjs": "//\n" }, "base");
  sh("git checkout -q -b feature");
  head = commit({ [REVIEWED_MIGRATION]: "select 2;\n", [REVIEWED_PROOF]: "//\n" }, "reviewed additions");
  // main moves on after the branch was cut: the branch is now stale against the new main tip.
  sh("git checkout -q main");
  advancedBase = commit({ "README.md": "main moved\n" }, "main moves");
  sh("git checkout -q --orphan other");
  sh("git rm -rq --cached .");
  unrelated = commit({ "other.txt": "x\n" }, "unrelated root");
  sh("git checkout -q -f feature");
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("exact base → the comparison executes; reviewed exact files pass", () => {
  it("a supplied pull_request base that is an ancestor of HEAD is accepted, with its source recorded", () => {
    const r = resolveComparisonBase({ env: { DB_INERT_BASE_SHA: base, DB_INERT_BASE_SOURCE: "pull_request" }, git });
    expect(r).toEqual({ ok: true, sha: base, source: `pull_request base ${base}` });
  });

  it("the diff against that base contains exactly the reviewed files, and review passes", () => {
    const supabase = git(`diff --name-status ${base}...HEAD -- supabase`)!;
    const automation = git(`diff --name-only ${base}...HEAD -- scripts .github`)!;
    expect(supabase).toBe(`A\t${REVIEWED_MIGRATION}\n`);
    expect(unreviewedChanges(supabase, { added, modified })).toEqual([]);
    expect(unreviewedPaths(automation, allowed)).toEqual([]);
  });

  it("locally, with no CI base for the event, origin/main is the fallback — and still must be an ancestor", () => {
    sh(`git update-ref refs/remotes/origin/main ${base}`);
    expect(resolveComparisonBase({ env: {}, git })).toEqual({ ok: true, sha: base, source: `origin/main ${base}` });
    sh(`git update-ref -d refs/remotes/origin/main`);
  });
});

describe("unregistered files fail", () => {
  it("an unregistered migration fails the supabase review", () => {
    const out = `A\t${REVIEWED_MIGRATION}\nA\tsupabase/migrations/20261003000000_unreviewed.sql\n`;
    expect(unreviewedChanges(out, { added, modified })).toEqual(['"supabase/migrations/20261003000000_unreviewed.sql" is not a reviewed addition']);
  });

  it("an unregistered proof or automation file fails the automation review", () => {
    expect(unreviewedPaths(`${REVIEWED_PROOF}\nscripts/db-proof/unreviewed.mjs\n.github/workflows/deploy.yml\n`, allowed))
      .toEqual(["scripts/db-proof/unreviewed.mjs", ".github/workflows/deploy.yml"]);
  });

  it("a deletion, rename or modification of an unregistered file fails", () => {
    expect(unreviewedChanges("D\tsupabase/migrations/0001_init.sql\n", { added, modified })).toHaveLength(1);
    expect(unreviewedChanges(`R100\tsupabase/migrations/0001_init.sql\t${REVIEWED_MIGRATION}\n`, { added, modified })).toHaveLength(1);
    expect(unreviewedChanges("M\tsupabase/config.toml\n", { added, modified })).toHaveLength(1);
  });
});

describe("missing, malformed, absent, stale or wrong base fails closed (never skips)", () => {
  it("a pull_request or push event that supplies no base SHA fails — it never falls back to an assumed branch", () => {
    sh(`git update-ref refs/remotes/origin/main ${base}`);
    for (const event of ["pull_request", "push"]) {
      const r = resolveComparisonBase({ env: { DB_INERT_BASE_SOURCE: event }, git });
      expect(r.ok, event).toBe(false);
      expect((r as { diagnostic: string }).diagnostic).toMatch(/supplied no base SHA/);
    }
    sh(`git update-ref -d refs/remotes/origin/main`);
  });

  it("no supplied base and no origin/main fails with a controlled diagnostic", () => {
    const r = resolveComparisonBase({ env: {}, git });
    expect(r).toEqual({ ok: false, diagnostic: expect.stringMatching(/origin\/main is not available/) });
  });

  it("a malformed SHA is rejected: short, upper-case, padded, or carrying a revision expression", () => {
    for (const bad of [base.slice(0, 12), base.toUpperCase(), ` ${base}`, `${base}\n`, `${base}^`, "HEAD", "origin/main"]) {
      const r = resolveComparisonBase({ env: { DB_INERT_BASE_SHA: bad, DB_INERT_BASE_SOURCE: "pull_request" }, git });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect((r as { diagnostic: string }).diagnostic).toMatch(/not a full 40-hex commit SHA/);
    }
  });

  it("a well-formed SHA that is not in the repository (a shallow checkout) is rejected", () => {
    const r = resolveComparisonBase({ env: { DB_INERT_BASE_SHA: "0".repeat(40), DB_INERT_BASE_SOURCE: "push" }, git });
    expect(r).toEqual({ ok: false, diagnostic: expect.stringMatching(/is not present in this repository/) });
  });

  it("a stale base (main moved on; the branch was not reconciled), an unrelated commit or HEAD's descendant-free sibling is rejected", () => {
    for (const wrong of [advancedBase, unrelated]) {
      const r = resolveComparisonBase({ env: { DB_INERT_BASE_SHA: wrong, DB_INERT_BASE_SOURCE: "pull_request" }, git });
      expect(r, wrong).toEqual({ ok: false, diagnostic: expect.stringMatching(/is not an ancestor of HEAD — a stale or wrong base/) });
    }
  });
});

describe("exact-file matching cannot be bypassed", () => {
  it("whitespace, ./, .., case, separator and quoting variants of a reviewed path never match", () => {
    const tricks = [
      `${REVIEWED_MIGRATION} `, ` ${REVIEWED_MIGRATION}`, `${REVIEWED_MIGRATION}\r`, `./${REVIEWED_MIGRATION}`,
      `supabase/migrations/../migrations/20261002100000_refuse_withheld_service_grants.sql`, REVIEWED_MIGRATION.toUpperCase(),
      REVIEWED_MIGRATION.replace(/\//g, "\\"), `"${REVIEWED_MIGRATION}"`, `${REVIEWED_MIGRATION}.bak`,
    ];
    for (const t of tricks) {
      expect(unreviewedChanges(`A\t${t}\n`, { added, modified }), JSON.stringify(t)).toHaveLength(1);
      expect(unreviewedPaths(`${t}\n`, new Set([REVIEWED_MIGRATION])), JSON.stringify(t)).toEqual([t]);
    }
  });

  it("an extra tab field or a missing status is unsupported, never accepted", () => {
    expect(unreviewedChanges(`A\t${REVIEWED_MIGRATION}\textra\n`, { added, modified })).toHaveLength(1);
    expect(unreviewedChanges(`${REVIEWED_MIGRATION}\n`, { added, modified })).toHaveLength(1);
  });
});

describe("CI proves the guard executed with zero skipped (assertTestsExecuted.mjs)", () => {
  const FILE = "src/lib/financialStatementsWorkspace/databaseInert.test.ts";
  const report = (statuses: string[]) => ({ testResults: [{ name: `/repo/${FILE}`, assertionResults: statuses.map((status, i) => ({ status, title: `t${i}` })) }] });

  it("all tests passed → proven", () => expect(executionProblems(report(["passed", "passed"]), [FILE])).toEqual([]));
  it("a skipped, todo or failed test → not proven", () => {
    for (const s of ["skipped", "pending", "todo", "failed"]) expect(executionProblems(report(["passed", s]), [FILE]), s).toHaveLength(1);
  });
  it("the file did not run, or ran no tests → not proven", () => {
    expect(executionProblems({ testResults: [] }, [FILE])).toEqual([`${FILE}: not in the report (it did not run)`]);
    expect(executionProblems(report([]), [FILE])).toEqual([`${FILE}: ran no tests`]);
    expect(executionProblems({}, [FILE])).toEqual(["the report is not a Vitest JSON report"]);
  });

  it("both CI test jobs supply GitHub's exact base, fetch full history, and assert zero skipped", () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    /** The text of one job: from "  <id>:" to the next top-level job. */
    const job = (id: string) => {
      const start = ci.indexOf(`\n  ${id}:\n`);
      expect(start, id).toBeGreaterThan(-1);
      const next = ci.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
      return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
    };
    for (const id of ["release-gate", "golden-tests"]) {
      const body = job(id);
      expect(body, id).toContain("DB_INERT_BASE_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event_name == 'push' && github.event.before || '' }}");
      expect(body, id).toContain("DB_INERT_BASE_SOURCE: ${{ github.event_name }}");
      expect(body, id).toMatch(/uses: actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/);
      expect(body, id).toContain("node scripts/ci/assertTestsExecuted.mjs inert-report.json src/lib/financialStatementsWorkspace/databaseInert.test.ts src/lib/__tests__/inertBase.test.ts");
    }
  });

  it("the guard itself no longer skips anything", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/lib/financialStatementsWorkspace/databaseInert.test.ts"), "utf8");
    expect(src).not.toMatch(/skipIf|\.skip\(|hasMain|\?\? ""\)\.trim\(\)\.split/);
    expect(src).toMatch(/resolveComparisonBase\(\{ env: process\.env, git: gitOut \}\)/);
  });
});
