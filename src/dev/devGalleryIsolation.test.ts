/**
 * The development gallery is not part of the application: no route, no import from application code, only a dev-server
 * HTML entry that the production build never reads, and neutral synthetic data only. The production-bundle scan
 * (scripts/ci/assertDevGalleryExcluded.mjs, run after `bun run build`) proves the built output carries none of it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../..");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe("development gallery isolation", () => {
  it("no application route and no import of src/dev from application code", () => {
    const app = fs.readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");
    expect(app).not.toMatch(/trial-balance-states|TrialBalanceStates|src\/dev|@\/dev/);
    for (const f of walk(path.join(ROOT, "src")).filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes(`${path.sep}dev${path.sep}`))) {
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/from ["'](@\/dev\/|\.{1,2}\/(\.\.\/)*dev\/)/);
    }
  });
  it("the production build reads only index.html; the gallery's HTML entry lives outside it", () => {
    const vite = fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
    expect(vite).not.toMatch(/rollupOptions|input\s*:/);
    expect(fs.readFileSync(path.join(ROOT, "index.html"), "utf8")).not.toMatch(/src\/dev/);
    expect(fs.readFileSync(path.join(ROOT, "dev/trial-balance-states.html"), "utf8")).toMatch(/src="\/src\/dev\/trialBalanceStatesEntry\.tsx"/);
  });
  it("neutral synthetic data only: no customer names or figures", () => {
    for (const f of walk(path.join(ROOT, "src/dev")).filter((p) => !p.endsWith(".test.ts"))) {
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/arusha|kamanga|174,?776,?903|99,?647,?448/i);
    }
  });
});
