/**
 * No Swahili product name (SAFISHA, HESABU, MAONO, KINGA) may reach a customer. The scanner
 * (scripts/ci/legacyNameSweep.mjs) parses every non-test source file under src/ and supabase/functions/ with the
 * TypeScript compiler and inspects JSX text and user-facing string/template literals — the copy, toasts, errors, PDF and
 * spreadsheet content, export metadata and Edge Function response messages. Identifiers, file and folder names,
 * database object names, function slugs and comments are internal and never counted.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without type declarations
import { LEGACY_FILENAME, LEGACY_NAME, PERSISTED_IDENTIFIER_ALLOWLIST, PUBLIC_SURFACES, scanFile, scanPublicSurfaces, sweep } from "../../../scripts/ci/legacyNameSweep.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Finding = { file: string; line: number; text: string };

describe("customer-visible legacy product names", () => {
  it("none remain in any customer-visible string", () => {
    const findings = sweep() as Finding[];
    expect(findings.map((f) => `${f.file}:${f.line} ${f.text}`)).toEqual([]);
  }, 60_000); // parses every source file with the TypeScript compiler; slow under a loaded parallel run

  it("downloaded file names and public SEO surfaces are swept too", () => {
    expect(LEGACY_FILENAME.test("kinga_uploads_x.csv")).toBe(true);
    expect(LEGACY_FILENAME.test("trial-balance-uploads_x.csv")).toBe(false);
    expect(PUBLIC_SURFACES).toEqual(["index.html", "public/robots.txt", "public/sitemap.xml"]);
    expect(scanPublicSurfaces()).toEqual([]);
  });

  it("the only allowed occurrences are the three legacy redirect route paths, each reviewed", () => {
    expect(PERSISTED_IDENTIFIER_ALLOWLIST).toEqual([
      { file: "src/App.tsx", value: "safisha" },
      { file: "src/App.tsx", value: "hesabu" },
      { file: "src/App.tsx", value: "kinga" },
    ]);
    const app = fs.readFileSync(path.join(__dirname, "../../App.tsx"), "utf8");
    for (const legacy of ["safisha", "hesabu", "kinga"]) {
      expect(app).toMatch(new RegExp(`path="${legacy}"\\s+element=\\{<LegacySubRouteRedirect to="(prepare|statements|tax)" />\\}`));
    }
  });

  it("detects every product spelling and a standalone lower-case word, but not technical slugs", () => {
    for (const hit of ["Run SAFISHA", "Hesabu gate", "Powered by Maono", "Kinga Engine", "run safisha now", "(kinga)"]) expect(LEGACY_NAME.test(hit), hit).toBe(true);
    for (const miss of ["safisha-ingest", "hesabu_validations", "MAONO_DERIVED", "kinga-tax-engine", "Kingston"]) expect(LEGACY_NAME.test(miss), miss).toBe(false);
  });

  it("the scanner itself catches JSX text, string literals, templates and slugs shown on screen; ignores comments, identifiers and imports", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
    const file = path.join(dir, "Probe.tsx");
    fs.writeFileSync(file, [
      'import { x } from "./kinga-helpers";',
      "// Kinga appears in a comment",
      "const SafishaGate = 1; // identifier",
      'const a = "Run HESABU validation";',
      "const b = `Powered by ${a} Maono`;",
      "export const C = () => <p>Kinga Engine</p>;",
      "export const D = () => <p>Run maono-risk to generate.</p>;",
      'console.log("SAFISHA internal log");',
    ].join("\n"));
    const found = (scanFile(file) as Finding[]).map((f) => f.line);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(found).toEqual([4, 5, 6, 7]);
  });
});
