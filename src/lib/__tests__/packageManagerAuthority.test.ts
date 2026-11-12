/**
 * Package-manager authority: Bun is the single package manager; bun.lock the single lockfile; CI pins the same Bun
 * version and installs frozen. The guard is exercised against the real repository and against deliberately broken fixtures.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script shared with CI
import { checkRepository } from "../../../scripts/ci/packageManagerAuthority.mjs";

const REPO = path.resolve(__dirname, "../../..");

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-authority-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const GOOD_PKG = JSON.stringify({ packageManager: "bun@1.3.14" });
const GOOD_WF = "jobs:\n  a:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.3.14\n      - run: bun install --frozen-lockfile\n";

describe("package-manager authority", () => {
  it("the repository itself is compliant", () => {
    expect(checkRepository(REPO)).toEqual([]);
  });

  it("package.json declares an exact Bun version and the only JavaScript lockfile is bun.lock", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
    expect(pkg.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
    for (const f of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]) expect(fs.existsSync(path.join(REPO, f)), f).toBe(false);
    expect(fs.existsSync(path.join(REPO, "bun.lock"))).toBe(true);
  });

  it("a compliant fixture passes", () => {
    expect(checkRepository(fixture({ "package.json": GOOD_PKG, "bun.lock": "{}", ".github/workflows/ci.yml": GOOD_WF }))).toEqual([]);
  });

  it.each(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "npm-shrinkwrap.json"])("an introduced %s is rejected", (lock) => {
    const v = checkRepository(fixture({ "package.json": GOOD_PKG, "bun.lock": "{}", [lock]: "{}", ".github/workflows/ci.yml": GOOD_WF }));
    expect(v.join("\n")).toContain(`competing lockfile present: ${lock}`);
  });

  it("a missing or inexact packageManager is rejected", () => {
    for (const pm of [undefined, "bun", "bun@latest", "bun@^1.3.0", "npm@10.0.0", "pnpm@9.0.0"]) {
      const v = checkRepository(fixture({ "package.json": JSON.stringify(pm ? { packageManager: pm } : {}), "bun.lock": "{}", ".github/workflows/ci.yml": GOOD_WF }));
      expect(v.join("\n"), String(pm)).toMatch(/packageManager/);
    }
  });

  it("a workflow with a floating or different Bun version, an unfrozen install or a competing installer is rejected", () => {
    const base = { "package.json": GOOD_PKG, "bun.lock": "{}" };
    expect(checkRepository(fixture({ ...base, ".github/workflows/ci.yml": GOOD_WF.replace("1.3.14", "latest") })).join("\n")).toMatch(/bun-version latest/);
    expect(checkRepository(fixture({ ...base, ".github/workflows/ci.yml": GOOD_WF.replace("1.3.14", "1.2.0") })).join("\n")).toMatch(/bun-version 1\.2\.0/);
    expect(checkRepository(fixture({ ...base, ".github/workflows/ci.yml": GOOD_WF.replace("--frozen-lockfile", "") })).join("\n")).toMatch(/frozen-lockfile/);
    expect(checkRepository(fixture({ ...base, ".github/workflows/ci.yml": `${GOOD_WF}      - run: npm ci\n` })).join("\n")).toMatch(/competing package manager/);
    expect(checkRepository(fixture({ ...base, ".github/workflows/ci.yml": `${GOOD_WF}      - run: npx vitest run\n` })).join("\n")).toMatch(/competing package manager/);
    expect(checkRepository(fixture({ ...base, ".github/workflows/ci.yml": `${GOOD_WF}      - run: pnpm install\n` })).join("\n")).toMatch(/competing package manager/);
  });

  it("a dependency inside the repository (a vendored tarball) is accepted; one outside it is rejected", () => {
    const base = { "bun.lock": "{}", ".github/workflows/ci.yml": GOOD_WF };
    const pkg = (spec: string) => JSON.stringify({ packageManager: "bun@1.3.14", dependencies: { xlsx: spec } });
    for (const ok of ["file:vendor/sheetjs/xlsx-0.20.3.tgz", "file:./vendor/sheetjs/xlsx-0.20.3.tgz", "^1.2.3", "1.2.3", "npm:other@1.0.0", "latest"]) {
      expect(checkRepository(fixture({ ...base, "package.json": pkg(ok) })), ok).toEqual([]);
    }
    for (const bad of ["file:../elsewhere/x.tgz", "file:/tmp/x.tgz", "file:C:/x.tgz", "file:~/x.tgz", "link:../x"]) {
      expect(checkRepository(fixture({ ...base, "package.json": pkg(bad) })).join("\n"), bad).toMatch(/package\.json dependencies\.xlsx .*a local dependency must/);
    }
  });

  it("a dependency fetched from a remote URL, git or GitHub is rejected, in package.json and in bun.lock", () => {
    const base = { "bun.lock": "{}", ".github/workflows/ci.yml": GOOD_WF };
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "overrides"]) {
      for (const bad of ["https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz", "http://example.invalid/x.tgz", "git+https://example.invalid/x.git", "git://example.invalid/x.git", "github:owner/repo", "owner/repo", "owner/repo#v1"]) {
        const v = checkRepository(fixture({ ...base, "package.json": JSON.stringify({ packageManager: "bun@1.3.14", [field]: { xlsx: bad } }) }));
        expect(v.join("\n"), `${field} ${bad}`).toContain(`package.json ${field}.xlsx = ${JSON.stringify(bad)}: a remote URL, git or GitHub dependency is not allowed`);
      }
    }
    const lock = (resolution: string) => `{\n  "packages": {\n    "xlsx": ["xlsx@${resolution}", { "bin": { "xlsx": "./bin/xlsx.njs" } }, "sha512-AA=="],\n    "@scope/pkg": ["@scope/pkg@1.0.0", "", {}, "sha512-AA=="],\n  }\n}\n`;
    expect(checkRepository(fixture({ "package.json": GOOD_PKG, ".github/workflows/ci.yml": GOOD_WF, "bun.lock": lock("vendor/sheetjs/xlsx-0.20.3.tgz") }))).toEqual([]);
    expect(checkRepository(fixture({ "package.json": GOOD_PKG, ".github/workflows/ci.yml": GOOD_WF, "bun.lock": lock("vendor/x.tgz") }))).toEqual([]);
    for (const bad of ["https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz", "github:owner/repo#abc", "git+ssh://git@example.invalid/x.git"]) {
      const v = checkRepository(fixture({ "package.json": GOOD_PKG, ".github/workflows/ci.yml": GOOD_WF, "bun.lock": lock(bad) }));
      expect(v.join("\n"), bad).toContain(`bun.lock resolves xlsx from ${JSON.stringify(bad)}`);
    }
  });

  it("the real repository installs SheetJS from the vendored tarball, not from a URL", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
    expect(pkg.dependencies.xlsx).toBe("file:vendor/sheetjs/xlsx-0.20.3.tgz");
    expect(fs.existsSync(path.join(REPO, "vendor/sheetjs/xlsx-0.20.3.tgz"))).toBe(true);
  });

  it("comments do not trigger the guard", () => {
    expect(checkRepository(fixture({ "package.json": GOOD_PKG, "bun.lock": "{}", ".github/workflows/ci.yml": `${GOOD_WF}      # never npm ci here\n` }))).toEqual([]);
  });

  it("the real workflow pins the same Bun version as packageManager in every job that installs", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
    const version = /^bun@(.+)$/.exec(pkg.packageManager)![1];
    const wf = fs.readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
    const pins = [...wf.matchAll(/bun-version:\s*(\S+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    for (const p of pins) expect(p).toBe(version);
    expect((wf.match(/bun install/g) ?? []).length).toBe((wf.match(/bun install --frozen-lockfile/g) ?? []).length);
  });
});
