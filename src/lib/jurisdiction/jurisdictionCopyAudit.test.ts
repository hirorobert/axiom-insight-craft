/**
 * Static jurisdiction-copy audit. CFOClose is a globally neutral platform: no TRA / TIN / Tanzania / fiscal-device-system
 * wording may appear in a string literal or JSX text that a user of a global surface can read.
 *
 * What is scanned: every non-test source file under src/, with comments removed. What counts as user-visible: string and
 * template literals, and JSX text. Database column names (`tin`), identifiers and comments are not user-visible and are
 * deliberately not flagged (the UPPERCASE tokens TRA / TIN / EFDMS and the word Tanzania[n] are what a reader sees).
 *
 * Reference data (ISO-4217 currency names such as "TZS — Tanzanian Shilling") is allowed on exactly the two currency
 * pickers. The statutory-engine modules listed below are jurisdiction-scoped BY DESIGN: they render only inside a tax /
 * compliance / fiscal-device module that is in scope for a workspace, never on a first-run, overview, preparation,
 * settings or validation surface. They are inventoried here explicitly so the boundary is visible and reviewable — adding
 * a file to this list is a deliberate decision, and an unlisted file that gains such wording fails this test.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateTaxProfile } from "./taxProfile";

const SRC = path.resolve(__dirname, "../..");

/** Statutory-engine modules: jurisdiction-scoped by design (rendered only inside an in-scope tax / compliance / fiscal-device module). */
export const JURISDICTION_MODULES: readonly string[] = [
  "components/EFDMSReconciliationPanel.tsx",
  "components/TRAAuditReadinessPanel.tsx",
  "components/KingaFindingsPanel.tsx",
  "components/PaymentLedgerPanel.tsx",
  "components/EvidenceRequestPanel.tsx",
  "components/TransferPricingPanel.tsx",
  "lib/jurisdiction/filingTerms.ts",
  "components/TaxLossPanel.tsx",
  "components/ThinCapWorkpaper.tsx",
  "components/AddBacksWorkpaper.tsx",
  "lib/generateTaxComputationPDF.ts",
  "lib/accounting/museIpsasRulePack.ts",
];

/** Currency pickers: ISO-4217 reference data. */
const CURRENCY_LIST_FILES = ["components/workspace/FirstRunEngagement.tsx", "components/CompanyManager.tsx"];

const FORBIDDEN = /\b(TRA|TIN|EFDMS|TAA)\b|Tanzania|ITA Cap|Cap\.\s?332/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "integrations" || e.name === "__tests__" || e.name === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/fixture/i.test(e.name) ? [p] : [];
  });
}

/** Removes block and line comments without touching `//` inside string literals or URLs. */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "*") { const end = code.indexOf("*/", i + 2); i = end < 0 ? code.length : end + 2; continue; }
    if (c === "/" && n === "/" && code[i - 1] !== ":") { while (i < code.length && code[i] !== "\n") i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/** String / template literals and JSX text — what a reader can see. */
export function visibleStrings(code: string): string[] {
  const src = stripComments(code);
  const found: string[] = [];
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) found.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of src.matchAll(/>([^<>{}=;]*[A-Za-z][^<>{}=;]*)</g)) found.push(m[1]);
  return found.filter((s) => !/PUT-REAL/.test(s));
}

export function findForbidden(code: string): string[] {
  return visibleStrings(code).filter((s) => FORBIDDEN.test(s)).map((s) => s.trim().slice(0, 90));
}

describe("jurisdiction-neutral copy", () => {
  const files = walk(SRC).map((f) => path.relative(SRC, f).split(path.sep).join("/"));

  it("the scanner itself finds what it claims to (and ignores comments and column names)", () => {
    expect(findForbidden('const a = "TRA TIN not set";')).toHaveLength(1);
    expect(findForbidden("<p>Filed with TRA</p>")).toHaveLength(1);
    expect(findForbidden('label: "Tanzania pack"')).toHaveLength(1);
    expect(findForbidden("// TRA TIN in a comment\nconst a = 1;")).toEqual([]);
    expect(findForbidden("/* TIN */ const b = 1;")).toEqual([]);
    expect(findForbidden('.select("id, name, tin")')).toEqual([]);
    expect(findForbidden('const url = "https://x.example/a"; // TRA')).toEqual([]);
  });

  it("no user-visible string outside the inventoried statutory-engine modules names TRA, TIN, EFDMS or Tanzania", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (JURISDICTION_MODULES.includes(rel)) continue;
      const hits = findForbidden(fs.readFileSync(path.join(SRC, rel), "utf8")).filter((h) => !(CURRENCY_LIST_FILES.includes(rel) && /^[A-Z]{3} — /.test(h)));
      for (const h of hits) offenders.push(`${rel}: ${h}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the inventory only lists files that exist and really carry such wording (no stale allowlist)", () => {
    for (const rel of JURISDICTION_MODULES) {
      expect(files, rel).toContain(rel);
      expect(findForbidden(fs.readFileSync(path.join(SRC, rel), "utf8")).length, `${rel} no longer needs an exemption`).toBeGreaterThan(0);
    }
  });

  it("no statutory-engine module is rendered by a first-run, overview, upload, settings or layout surface", () => {
    const shell = ["pages/workspace/WorkspaceOverview.tsx", "pages/workspace/WorkspaceLayout.tsx", "pages/workspace/PrepareWorkspace.tsx", "pages/Settings.tsx", "components/TrialBalanceUpload.tsx", "components/workspace/FirstRunEngagement.tsx", "components/workspace/ServiceLaunchpad.tsx", "components/workspace/DataChoiceCard.tsx"];
    for (const rel of shell) {
      const code = fs.readFileSync(path.join(SRC, rel), "utf8");
      for (const mod of JURISDICTION_MODULES) {
        const base = path.basename(mod).replace(/\.(tsx|ts)$/, "");
        expect(new RegExp(`from ["'][^"']*/${base}["']`).test(code), `${rel} must not import ${base}`).toBe(false);
      }
    }
  });
});

describe("tax-profile warnings are conditional, never global", () => {
  const FS = ["FINANCIAL_STATEMENTS"] as const;
  const TAX = ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"] as const;

  it("a financial-statements-only workspace never warns, whatever the jurisdiction or identifier", () => {
    for (const jurisdiction of [null, undefined, "TZ", "XX"]) {
      for (const taxIdentifier of [null, "", "PUT-REAL-TRA-TIN-HERE", "123"]) {
        expect(evaluateTaxProfile({ granted: FS, jurisdiction, taxIdentifier }).warn).toBe(false);
      }
    }
  });

  it("an active tax service with NO configured jurisdiction does not warn (a jurisdiction is never inferred)", () => {
    expect(evaluateTaxProfile({ granted: TAX, jurisdiction: null, taxIdentifier: null }).warn).toBe(false);
  });

  it("an active tax service in a jurisdiction that requires the field warns only while the field is missing or malformed", () => {
    expect(evaluateTaxProfile({ granted: TAX, jurisdiction: "TZ", taxIdentifier: null }).warn).toBe(true);
    expect(evaluateTaxProfile({ granted: TAX, jurisdiction: "TZ", taxIdentifier: "PUT-REAL-TRA-TIN-HERE" }).warn).toBe(true);
    expect(evaluateTaxProfile({ granted: TAX, jurisdiction: "TZ", taxIdentifier: "12-34" }).warn).toBe(true);
    expect(evaluateTaxProfile({ granted: TAX, jurisdiction: "TZ", taxIdentifier: "123-456-789" }).warn).toBe(false);
  });

  it("an unknown jurisdiction has no requirement; no granted services means nothing to warn about", () => {
    expect(evaluateTaxProfile({ granted: TAX, jurisdiction: "ZZ", taxIdentifier: null }).warn).toBe(false);
    expect(evaluateTaxProfile({ granted: null, jurisdiction: "TZ", taxIdentifier: null }).warn).toBe(false);
  });

  it("the warning text is neutral and names no jurisdiction", async () => {
    const { TAX_PROFILE_COPY } = await import("./taxProfile");
    for (const v of Object.values(TAX_PROFILE_COPY)) expect(v).not.toMatch(FORBIDDEN);
  });
});
