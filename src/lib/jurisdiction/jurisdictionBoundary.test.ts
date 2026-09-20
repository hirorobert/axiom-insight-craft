/**
 * Import-boundary + registry behaviour for jurisdiction packs.
 *
 *  - Only `lib/jurisdiction/packLoader.ts` may reference `jurisdiction-packs/*`, and only through a dynamic `import()`.
 *  - Nothing inside a pack may be imported statically by code outside the pack (so a pack cannot enter the entry chunk).
 *  - Jurisdiction-dependent services are unavailable until a filing jurisdiction is explicitly selected — never inferred.
 *  - The loader imports nothing for an unset, unknown or pack-less jurisdiction.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The pack's panels talk to the backend; loading the pack in a node test must not construct a real client.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import { CAPABILITY_OUTCOMES } from "@/lib/workspace/mandate";
import { hasJurisdictionPack, isJurisdictionCode, jurisdictionName, JURISDICTION_DEPENDENT, needsJurisdiction, PACK_CODES, serviceAvailability } from "./registry";
import { LOADABLE_PACK_CODES, loadJurisdictionPack } from "./packLoader";

const SRC = path.resolve(__dirname, "../..");
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
const files = walk(SRC);
const PACK_ALIAS = /["']@\/jurisdiction-packs\/|["'](?:\.\.?\/)+jurisdiction-packs\//;

describe("jurisdiction import boundary", () => {
  it("no file outside the pack references a pack, except the loader (dynamic import only)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (r.startsWith("jurisdiction-packs/") || r === "lib/jurisdiction/packLoader.ts") continue;
      if (/\.test\.tsx?$/.test(r) && r.startsWith("lib/jurisdiction/")) continue; // this boundary test itself
      if (PACK_ALIAS.test(fs.readFileSync(f, "utf8"))) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });

  it("the loader reaches a pack only through dynamic import()", () => {
    const code = fs.readFileSync(path.join(SRC, "lib/jurisdiction/packLoader.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/^\s*import\s[^;]*jurisdiction-packs/m);
    expect(code).toMatch(/import\("@\/jurisdiction-packs\/tz"\)/);
  });

  it("the moved statutory modules are not imported anywhere outside the pack by their old locations", () => {
    const moved = ["KingaTaxPanel", "TaxLossPanel", "TransferPricingPanel", "EvidenceRequestPanel", "ThinCapWorkpaper", "AddBacksWorkpaper", "KingaFindingsPanel", "TRAAuditReadinessPanel", "EFDMSReconciliationPanel", "TRAFilingChecklist", "PaymentLedgerPanel", "generateTaxComputationPDF", "filingTerms"];
    const offenders: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (r.startsWith("jurisdiction-packs/")) continue;
      const code = fs.readFileSync(f, "utf8");
      for (const m of moved) if (new RegExp(`from ["'][^"']*/${m}["']`).test(code)) offenders.push(`${r} → ${m}`);
    }
    expect(offenders).toEqual([]);
  });

  it("no global shell surface (onboarding, layout, Overview, Prepare, Settings) mentions a pack", () => {
    const shell = ["pages/workspace/WorkspaceOverview.tsx", "pages/workspace/WorkspaceLayout.tsx", "pages/workspace/PrepareWorkspace.tsx", "pages/Settings.tsx", "components/workspace/FirstRunEngagement.tsx", "components/workspace/ServiceLaunchpad.tsx", "components/workspace/EngagementScopeDialog.tsx", "components/workspace/DataChoiceCard.tsx", "components/jurisdiction/FilingJurisdictionSetting.tsx"];
    for (const r of shell) {
      const code = fs.readFileSync(path.join(SRC, r), "utf8");
      expect(code, r).not.toMatch(/jurisdiction-packs|packLoader/);
    }
  });
});

describe("filing jurisdiction registry", () => {
  it("every jurisdiction-dependent service is unavailable while no jurisdiction is selected (never inferred)", () => {
    for (const cap of JURISDICTION_DEPENDENT) {
      for (const none of [null, undefined, ""]) {
        const a = serviceAvailability(cap, none);
        expect(a.available, cap).toBe(false);
        expect((a as { reason: string }).reason).toBe("JURISDICTION_REQUIRED");
      }
    }
  });

  it("services that need no jurisdiction are available with none selected", () => {
    for (const o of CAPABILITY_OUTCOMES) if (!needsJurisdiction(o.capability)) expect(serviceAvailability(o.capability, null).available).toBe(true);
    expect(serviceAvailability("FINANCIAL_STATEMENTS", null).available).toBe(true);
  });

  it("a selected jurisdiction without a pack keeps dependent services unavailable (NO_PACK), not silently defaulted", () => {
    const a = serviceAvailability("TAX_COMPUTATION", "KE");
    expect(a.available).toBe(false);
    expect((a as { reason: string }).reason).toBe("NO_PACK");
  });

  it("a selected jurisdiction with a pack makes dependent services available", () => {
    for (const cap of JURISDICTION_DEPENDENT) expect(serviceAvailability(cap, "TZ").available).toBe(true);
  });

  it("the unavailability messages are jurisdiction-neutral", () => {
    for (const j of [null, "KE"]) {
      const a = serviceAvailability("TAX_COMPUTATION", j) as { message: string };
      expect(a.message).not.toMatch(/\b(TRA|TIN|EFDMS|TAA)\b|Tanzania/);
    }
  });

  it("only ISO region codes are accepted; names come from the platform's ISO data, not hard-coded copy", () => {
    expect(isJurisdictionCode("TZ")).toBe(true);
    expect(isJurisdictionCode("KE")).toBe(true);
    expect(isJurisdictionCode("XX")).toBe(false);
    expect(isJurisdictionCode("tz")).toBe(false);
    expect(isJurisdictionCode(null)).toBe(false);
    expect(jurisdictionName("KE")).toMatch(/Kenya/);
  });

  it("the registry's pack list and the loader's list agree", () => {
    expect([...PACK_CODES].sort()).toEqual([...LOADABLE_PACK_CODES].sort());
    expect(hasJurisdictionPack("TZ")).toBe(true);
    expect(hasJurisdictionPack("KE")).toBe(false);
    expect(hasJurisdictionPack(null)).toBe(false);
  });
});

describe("pack loader", () => {
  it("imports nothing for an unset, unknown or pack-less jurisdiction", async () => {
    for (const c of [null, undefined, "", "KE", "XX", "constructor", "__proto__"]) expect(await loadJurisdictionPack(c as string | null)).toBeNull();
  });

  it("loads the pack only when its jurisdiction is explicitly selected", async () => {
    const pack = await loadJurisdictionPack("TZ");
    expect(pack).not.toBeNull();
    expect(pack!.panels).toBeTruthy();
  });
});
