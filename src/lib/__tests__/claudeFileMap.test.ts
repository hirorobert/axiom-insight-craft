/**
 * CLAUDE.md file-map consistency: the "Canonical File Map" (section 7) must describe the repository as it is.
 *  - every path in the map exists;
 *  - every non-test file in the directories the map claims to enumerate is listed;
 *  - files that moved into the Tanzania pack are not documented at their old location.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../../..");
const doc = fs.readFileSync(path.join(REPO, "CLAUDE.md"), "utf8").replace(/\r\n/g, "\n");

/** Parses the indented tree in the fenced block of section 7 into repository-relative paths. */
export function parseFileMap(markdown: string): { dirs: string[]; files: string[] } {
  const start = markdown.indexOf("## 7. Canonical File Map");
  const end = markdown.indexOf("\n---", start);
  const block = /```\n([\s\S]*?)```/.exec(markdown.slice(start, end));
  if (!block) throw new Error("file-map block not found");
  const stack: string[] = [];
  const dirs: string[] = [];
  const files: string[] = [];
  for (const line of block[1].split("\n")) {
    if (!line.trim()) continue;
    const level = Math.floor((line.length - line.trimStart().length) / 2);
    const name = line.trim().split(/\s+/)[0];
    stack.length = level;
    if (name.endsWith("/")) {
      stack.push(name.slice(0, -1));
      dirs.push(stack.join("/"));
    } else {
      files.push([...stack, name].join("/"));
    }
  }
  return { dirs, files };
}

const map = parseFileMap(doc);
const listed = (dir: string) => new Set(map.files.filter((f) => path.posix.dirname(f) === dir).map((f) => path.posix.basename(f)));
const nonTest = (dir: string) => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).filter((e) => e.isFile() && !/\.test\.tsx?$/.test(e.name)).map((e) => e.name);

describe("CLAUDE.md canonical file map", () => {
  it("the parser reads the map", () => {
    expect(map.files.length).toBeGreaterThan(30);
    expect(map.files).toContain("src/lib/workspace/stageMetadata.ts");
    expect(map.files).toContain("src/jurisdiction-packs/tz/computeWearTear.ts");
  });

  it("every documented directory and file exists", () => {
    const missing = [...map.dirs, ...map.files].filter((p) => !fs.existsSync(path.join(REPO, p)));
    expect(missing).toEqual([]);
  });

  it.each(["src/lib/workspace", "src/jurisdiction-packs/tz", "src/lib/jurisdiction", "src/components/jurisdiction"])("every non-test file in %s (a directory the map enumerates in full) is listed", (dir) => {
    const have = listed(dir);
    expect(nonTest(dir).filter((f) => !have.has(f))).toEqual([]);
  });

  it("files moved into the Tanzania pack are documented only at their new location", () => {
    for (const moved of ["computeWearTear.ts", "CapitalAllowancesRegister.tsx", "KingaTaxPanel.tsx", "filingTerms.ts", "generateTaxComputationPDF.ts"]) {
      const at = map.files.filter((f) => f.endsWith(`/${moved}`));
      expect(at, moved).toEqual([`src/jurisdiction-packs/tz/${moved}`]);
      expect(fs.existsSync(path.join(REPO, "src/lib", moved)), `src/lib/${moved} must not exist`).toBe(false);
      expect(fs.existsSync(path.join(REPO, "src/components", moved)), `src/components/${moved} must not exist`).toBe(false);
    }
  });

  it("documents the package-manager authority", () => {
    expect(doc).toMatch(/bun@1\.3\.14/);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
    expect(pkg.packageManager).toBe("bun@1.3.14");
  });
});
