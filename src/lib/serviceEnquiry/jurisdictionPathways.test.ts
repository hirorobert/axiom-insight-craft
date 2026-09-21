// The tax jurisdiction gate: nothing is shown or assumed before a jurisdiction is chosen; the preview jurisdiction is locked and
// request-access only; every other jurisdiction reaches a general expert enquiry (never a dead end); and the registry carries
// presentation and routing only — no tax law.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ISO_REGION_CODES, jurisdictionName } from "@/lib/jurisdiction/registry";
import { PREVIEW_JURISDICTION_CODE } from "./contract";
import { TAX_TILE_COPY } from "./copy";
import { JURISDICTION_PATHWAYS, countryOptions, pathwayPresentation, resolveTaxPathway } from "./jurisdictionPathways";

describe("resolveTaxPathway — nothing is defaulted or inferred", () => {
  it("returns null for no selection and for anything that is not an ISO code", () => {
    for (const v of [null, undefined, "", "XX", "tz", "TZA", "constructor", "__proto__", "toString"]) expect(resolveTaxPathway(v), String(v)).toBeNull();
  });

  it("the private-preview jurisdiction routes to the preview service code", () => {
    expect(resolveTaxPathway(PREVIEW_JURISDICTION_CODE)).toEqual({ kind: "PRIVATE_PREVIEW", serviceCode: "tax_tanzania_preview", code: "TZ" });
  });

  it("EVERY other ISO jurisdiction routes to the general expert enquiry — no country is a dead end", () => {
    for (const code of ISO_REGION_CODES.filter((c) => c !== PREVIEW_JURISDICTION_CODE)) {
      expect(resolveTaxPathway(code), code).toEqual({ kind: "GENERAL_EXPERT", serviceCode: "tax_general", code });
    }
  });

  it("only the preview jurisdiction has a specific pathway", () => {
    expect(Object.keys(JURISDICTION_PATHWAYS)).toEqual([PREVIEW_JURISDICTION_CODE]);
  });
});

describe("pathwayPresentation", () => {
  it("the preview jurisdiction reads '<Country> expert assessment — private preview', locked, with the readiness disclosure and its own action", () => {
    const p = pathwayPresentation(resolveTaxPathway("TZ")!);
    expect(p.heading).toBe("Tanzania expert assessment — private preview");
    expect(p.heading).toBe(`${jurisdictionName("TZ")} expert assessment — private preview`);
    expect(p.locked).toBe(true);
    expect(p.stateLabel).toBe("Locked — request access");
    expect(p.disclosure).toBe("Access is subject to professional assessment and product readiness.");
    expect(p.actionLabel).toBe("Request Tanzania assessment →");
  });

  it("never labels the preview 'available', 'supported', 'production ready' or 'complete'", () => {
    const p = pathwayPresentation(resolveTaxPathway("TZ")!);
    expect(JSON.stringify(p)).not.toMatch(/\b(available|supported|production[- ]ready|complete[d]?|released|live)\b/i);
  });

  it("another jurisdiction gets 'Ask a jurisdiction specialist →', is not locked, and never shows an unsupported error", () => {
    const p = pathwayPresentation(resolveTaxPathway("KE")!);
    expect(p.actionLabel).toBe("Ask a jurisdiction specialist →");
    expect(p.locked).toBe(false);
    expect(p.heading).toBe(jurisdictionName("KE"));
    expect(p.disclosure).toMatch(/assessed jurisdiction by jurisdiction/);
    expect(JSON.stringify(p)).not.toMatch(/not supported|unsupported|unavailable|error|cannot/i);
  });
});

describe("the global tile face is jurisdiction-neutral", () => {
  it("the tile's wording names no country and claims no capability", () => {
    expect(TAX_TILE_COPY.title).toBe("Tax and jurisdictional compliance");
    expect(TAX_TILE_COPY.state).toBe("Jurisdiction required");
    expect(TAX_TILE_COPY.description).toBe("Tax requirements depend on the entity, jurisdiction and reporting period. Select a jurisdiction to see the appropriate pathway.");
    expect(TAX_TILE_COPY.action).toBe("Select jurisdiction →");
    const face = [TAX_TILE_COPY.title, TAX_TILE_COPY.state, TAX_TILE_COPY.description, TAX_TILE_COPY.produces, TAX_TILE_COPY.action].join(" ");
    for (const code of ISO_REGION_CODES) expect(face).not.toContain(jurisdictionName(code));
    expect(face).not.toMatch(/\bavailable\b|workflow available|supported/i);
  });

  it("the country list offers every jurisdiction alphabetically with none pre-selected or emphasised", () => {
    const options = countryOptions();
    expect(options).toHaveLength(ISO_REGION_CODES.length);
    expect(options.map((o) => o.name)).toEqual([...options.map((o) => o.name)].sort((a, b) => a.localeCompare(b, "en")));
  });
});

describe("the registry carries presentation and routing only — no tax law", () => {
  const SRC = path.resolve(__dirname);
  it.each(["jurisdictionPathways.ts", "copy.ts", "entryPoints.ts"])("%s contains no rates, statutes, forms or filing claims", (file) => {
    const code = fs.readFileSync(path.join(SRC, file), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\b\d+(\.\d+)?\s?%|Finance Act|Cap\.\s?\d+|Income Tax|\bVAT\b|\bPAYE\b|withholding tax|capital allowance|tax rate|filing deadline|return due/i);
  });

  it("does not consult the internal statutory-pack manifest (a pack existing internally is not a public release)", () => {
    const code = fs.readFileSync(path.join(SRC, "jurisdictionPathways.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/hasJurisdictionPack|PACK_CODES|packLoader|jurisdiction-packs|serviceAvailability/);
  });
});
