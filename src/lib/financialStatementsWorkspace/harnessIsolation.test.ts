/**
 * The browser-acceptance harness (dev-harness/) must never become a
 * publicly reachable production route or leak fixture data into production
 * paths. These are static, non-executing checks over the real repository.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "../../../");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|html|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe("dev-harness isolation", () => {
  it("nothing under src/ imports or names the harness or its fixture data", () => {
    const offenders = walk(path.join(ROOT, "src"))
      .filter((f) => !f.endsWith("harnessIsolation.test.ts"))
      .filter((f) => /dev-harness|Harness Trading Company|buildFixture/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the production entry (index.html) and vite config do not reference the harness", () => {
    expect(fs.readFileSync(path.join(ROOT, "index.html"), "utf8")).not.toMatch(/dev-harness/);
    const vite = fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
    expect(vite).not.toMatch(/dev-harness/);
    expect(vite).not.toMatch(/rollupOptions[\s\S]{0,80}input/); // no multi-page build that could pull the harness in
  });

  it("the harness refuses to run outside the dev server", () => {
    const main = fs.readFileSync(path.join(ROOT, "dev-harness/main.tsx"), "utf8");
    expect(main).toMatch(/if \(!import\.meta\.env\.DEV\)\s*\{\s*throw/);
    expect(fs.readFileSync(path.join(ROOT, "dev-harness/financial-statements.html"), "utf8")).toMatch(/noindex/);
  });

  it("a production build output (when present) contains no harness or fixture", () => {
    const dist = path.join(ROOT, "dist");
    if (!fs.existsSync(dist)) return;
    const offenders = walk(dist).filter((f) => /dev-harness|Harness Trading Company|NON-PRODUCTION HARNESS/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    const js = fs
      .readdirSync(path.join(dist, "assets"), { recursive: true } as never)
      .map(String)
      .filter((f) => f.endsWith(".js"))
      .filter((f) => /Harness Trading Company|NON-PRODUCTION HARNESS/.test(fs.readFileSync(path.join(dist, "assets", f), "utf8")));
    expect(js).toEqual([]);
  });

  it("persistence and document review stay gated off in source", () => {
    expect(fs.readFileSync(path.join(ROOT, "src/lib/product/outcomes.ts"), "utf8")).toMatch(/DOCUMENT_REVIEW_ENABLED = false;/);
    expect(fs.readFileSync(path.join(ROOT, "src/lib/financialStatementsWorkspace/persistenceGate.ts"), "utf8")).toMatch(/FINANCIAL_STATEMENT_PERSISTENCE_ENABLED = false;/);
  });

  it("production default-off: with the gate closed, no workspace UI, hook or copy is present in any built asset (tree-shaken, not merely hidden)", () => {
    const dist = path.join(ROOT, "dist");
    if (!fs.existsSync(dist)) return; // enforced whenever a production build exists; the release gate always builds first
    const needles = ["Internal preview", "unsaved draft", "Session only", "Professional Review", "Print / save as PDF", "fs-print-document", "Correct a figure", "financial_statement_reports", "NON-PRODUCTION HARNESS", "Harness Trading", "dev-harness"];
    const hits: string[] = [];
    const allFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const files = allFiles(dist);
    expect(files.some((f) => f.endsWith(".js"))).toBe(true); // the scan must actually be reading the JS bundles
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const n of needles) if (text.includes(n)) hits.push(`${path.relative(dist, f)} contains "${n}"`);
    }
    expect(hits).toEqual([]);
  });
});
