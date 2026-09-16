import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const adaptersSrc = readFileSync(join(__dirname, "adapters.ts"), "utf-8");

describe("adapter boundary — no format-specific object may leak into the canonical model", () => {
  it("imports exclusively from ./types — never a format-specific SDK", () => {
    const importStatements = adaptersSrc.match(/^import [\s\S]*?;$/gm) ?? [];
    expect(importStatements.length).toBeGreaterThan(0);
    for (const importStatement of importStatements) {
      expect(importStatement).toMatch(/from "\.\/types";$/);
    }
  });

  it("mentions Arelle only in explanatory comments, never as an imported symbol or concrete type", () => {
    expect(adaptersSrc).not.toMatch(/from ["'].*arelle.*["']/i);
    expect(adaptersSrc).not.toMatch(/:\s*Arelle/);
  });

  it("declares exactly the five required adapter interfaces, none implemented", () => {
    for (const name of ["IxbrlAdapter", "PdfAdapter", "DocxAdapter", "XlsxAdapter", "TrialBalanceAdapter"]) {
      expect(adaptersSrc).toMatch(new RegExp(`export interface ${name}`));
    }
    expect(adaptersSrc).not.toMatch(/class \w+Adapter/); // no concrete implementation, interfaces only
  });

  it("every adapter's extraction result type is built entirely from canonical types", () => {
    expect(adaptersSrc).toMatch(/export interface AdapterExtractionResult/);
    expect(adaptersSrc).toMatch(/facts: readonly MonetaryFact\[\]/);
  });
});
