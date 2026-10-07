/**
 * characterizationCorpus.ts is a TEST helper (node:fs, node:path, the xlsx package, __dirname) that lives beside the
 * ingestion tests. Lovable excluded exactly this one file from tsconfig.app.json (the browser application's type
 * check). This pins that the exclusion stays exactly that narrow, that no production module can reach the helper, and
 * that the helper keeps its coverage (ingestCharacterization.test.ts imports and runs it).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? (e.name === "node_modules" ? [] : walk(p)) : /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) ? [p] : [];
});
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const isTest = (p: string) => /\.test\.tsx?$/.test(p) || /(^|\/)__tests__\//.test(p);

describe("the tsconfig.app.json test-helper exclusion", () => {
  it("excludes the three test globs and exactly one named file: the characterization corpus", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.app.json"), "utf8")) as { exclude: string[]; include: string[] };
    expect(cfg.exclude).toEqual(["src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.test.tsx", "src/lib/ingestion/characterizationCorpus.ts"]);
    expect(cfg.include).toEqual(["src"]);
  });
  it("no production module imports it (directly or by any relative or alias path)", () => {
    const importers = walk(path.join(ROOT, "src")).filter((f) => !f.endsWith("characterizationCorpus.ts"))
      .filter((f) => /characterizationCorpus/.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(importers.filter((f) => !isTest(f))).toEqual([]);
    expect(importers).toContain("src/lib/ingestion/ingestCharacterization.test.ts");
  });
  it("its coverage is retained: the characterization test imports it and pins every corpus case", () => {
    const t = fs.readFileSync(path.join(ROOT, "src/lib/ingestion/ingestCharacterization.test.ts"), "utf8");
    expect(t).toMatch(/import \{ characterizationCorpus, resultText \} from "\.\/characterizationCorpus";/);
    const golden = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/ingestion/__fixtures__/ingest-characterization.json"), "utf8")) as { digests: Record<string, string> };
    expect(Object.keys(golden.digests).length).toBeGreaterThanOrEqual(150);
  });
});
