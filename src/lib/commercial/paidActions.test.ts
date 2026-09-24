/**
 * Locked-action presentation and the UI call sites of the paid walls. Everything is read from structured fields
 * (commercial state JSON, PT402 + capability code, Edge refusal body, create_entity outcome) — never message text.
 * The walls themselves are enforced and proven in the database (scripts/db-proof/entitlements.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PaidActionNotice } from "@/components/commercial/PaidActionNotice";
import { parseCreateEntityOutcome } from "./entityCreation";
import {
  capacityCopy,
  entitlementRefusal,
  functionEntitlementRefusal,
  lockedCopy,
  paidActionState,
  parseWorkspaceCommercialState,
  PAID_ACTIONS,
} from "./paidActions";

const ROOT = path.join(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const allowed = { allowed: true, code: "ALLOWED" };
const locked = { allowed: false, code: "ENTITLEMENT_REQUIRED" };

describe("parseWorkspaceCommercialState / paidActionState — only an explicit server ALLOWED is allowed", () => {
  it("parses the canonical shape and drops legacy or malformed capability keys", () => {
    const s = parseWorkspaceCommercialState({
      access: true, plan_code: "FREE",
      capabilities: { CLOSE_INSIGHTS: locked, REPORTING_PACK_EXPORT: allowed, MAONO_INTELLIGENCE: allowed, STATEMENT_CERTIFICATION: { allowed: "yes", code: "ALLOWED" } },
    })!;
    expect(s.planCode).toBe("FREE");
    expect(Object.keys(s.capabilities).sort()).toEqual(["CLOSE_INSIGHTS", "REPORTING_PACK_EXPORT"]);
    expect(paidActionState(s, "REPORTING_PACK_EXPORT")).toEqual({ status: "allowed" });
    expect(paidActionState(s, "CLOSE_INSIGHTS")).toEqual({ status: "locked", capability: "CLOSE_INSIGHTS", requiredPlan: "PRACTICE" });
    expect(paidActionState(s, "STATEMENT_CERTIFICATION")).toEqual({ status: "unknown" });
  });
  it("fails closed on anything malformed, loading or without workspace access", () => {
    for (const raw of [null, undefined, "x", { access: "true", capabilities: {} }, { access: true }]) expect(parseWorkspaceCommercialState(raw)).toBeNull();
    expect(paidActionState(null, "CLOSE_INSIGHTS")).toEqual({ status: "unknown" });
    expect(paidActionState(undefined, "CLOSE_INSIGHTS", true)).toEqual({ status: "loading" });
    expect(paidActionState(parseWorkspaceCommercialState({ access: false }), "CLOSE_INSIGHTS")).toEqual({ status: "no_access" });
  });
});

describe("entitlementRefusal — structured codes only", () => {
  it("recognises the database wall (PT402 + details) and the Edge refusal body, including legacy aliases", () => {
    expect(entitlementRefusal({ code: "PT402", details: "STATEMENT_CERTIFICATION", message: "anything" })).toBe("STATEMENT_CERTIFICATION");
    expect(entitlementRefusal({ status: "entitlement_required", capability: "CLOSE_INSIGHTS" })).toBe("CLOSE_INSIGHTS");
    expect(entitlementRefusal({ code: "PT402", details: "HESABU_EXPORT" })).toBe("REPORTING_PACK_EXPORT");
  });
  it("never infers a refusal from message text", () => {
    for (const e of [{ message: "ENTITLEMENT_REQUIRED STATEMENT_CERTIFICATION" }, { code: "42501", details: "CLOSE_INSIGHTS" }, new Error("PT402 CLOSE_INSIGHTS"), "PT402", null]) {
      expect(entitlementRefusal(e)).toBeNull();
    }
  });
  it("reads an Edge Function refusal from the invoke error's response body", async () => {
    const context = new Response(JSON.stringify({ status: "entitlement_required", capability: "REPORTING_PACK_EXPORT" }), { status: 402 });
    expect(await functionEntitlementRefusal({ message: "Edge Function returned a non-2xx status code", context })).toBe("REPORTING_PACK_EXPORT");
    expect(await functionEntitlementRefusal({ context: new Response("not json", { status: 500 }) })).toBeNull();
    expect(await functionEntitlementRefusal({ message: "entitlement_required" })).toBeNull();
  });
});

describe("customer copy", () => {
  it("uses the approved locked wording, names the plan, and says what remains and what is kept", () => {
    expect(lockedCopy("STATEMENT_CERTIFICATION").title).toBe("Upgrade to create a certified close");
    expect(lockedCopy("REPORTING_PACK_EXPORT")).toMatchObject({ title: "Available with Practice", remains: "Preview remains available.", history: "Your existing reports remain accessible." });
    expect(lockedCopy("CLOSE_INSIGHTS").title).toBe("Available with Practice");
    for (const c of PAID_ACTIONS) {
      const text = Object.values(lockedCopy(c)).join(" ");
      expect(text).not.toMatch(/payment required|pay now|must pay|forbidden|denied|owner|partner|manager|SAFISHA|HESABU|MAONO|KINGA/i);
    }
  });
  it("capacity copy states the capacity, never deletes or hides anything, and is honest when capacity is undetermined", () => {
    const c = capacityCopy({ capacity: 5, used: 5, planCode: "PRACTICE", determined: true });
    expect(c.unavailable).toBe("Your Practice plan includes 5 active entities, and 5 are in use.");
    expect(c.history).toMatch(/Nothing is deleted, hidden or moved/);
    expect(capacityCopy({ capacity: 1, used: 1, planCode: "FREE", determined: true }).unavailable).toMatch(/1 active entity, and 1 is in use/);
    expect(capacityCopy({ capacity: null, used: 3, planCode: "ENTERPRISE", determined: false }).title).toBe("Entity capacity needs confirming");
  });
  it("PaidActionNotice is neutral: lock icon, no success glyph or colour, links to plan comparison, no checkout", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PaidActionNotice, { copy: lockedCopy("CLOSE_INSIGHTS") })));
    expect(html).toContain('href="/pricing"');
    expect(html).toContain("Available with Practice");
    expect(html).toContain("Insights you already generated stay accessible.");
    expect(html).toMatch(/lucide-lock/);
    expect(html).not.toMatch(/lucide-(check|circle-check)|✓|✔|green|emerald|success|checkout/i);
  });
});

describe("parseCreateEntityOutcome", () => {
  const id = "0b7e3f0a-7c1e-4a51-9a2e-3f7e1c2d4b5a";
  it("created and idempotent replay both yield the workspace id", () => {
    expect(parseCreateEntityOutcome({ outcome: "created", company_id: id })).toEqual({ kind: "created", companyId: id, replayed: false });
    expect(parseCreateEntityOutcome({ outcome: "already_created", company_id: id })).toEqual({ kind: "created", companyId: id, replayed: true });
  });
  it("capacity outcomes carry structured capacity; everything else fails closed", () => {
    expect(parseCreateEntityOutcome({ outcome: "capacity_reached", capacity: 1, used: 1, plan_code: "FREE" })).toEqual({ kind: "capacity", capacity: { capacity: 1, used: 1, planCode: "FREE", determined: true } });
    expect(parseCreateEntityOutcome({ outcome: "capacity_undetermined", capacity: null, used: 2 })).toMatchObject({ kind: "capacity", capacity: { determined: false, capacity: null } });
    expect(parseCreateEntityOutcome({ outcome: "created", company_id: "not-a-uuid" })).toEqual({ kind: "failed", reason: "malformed" });
    expect(parseCreateEntityOutcome({ outcome: "unauthenticated" })).toEqual({ kind: "failed", reason: "unauthenticated" });
    expect(parseCreateEntityOutcome(null)).toEqual({ kind: "failed", reason: "no_response" });
  });
});

describe("UI call sites defer to the server", () => {
  it("a formal statement export is issued by the server before anything is rendered", () => {
    const src = read("src/components/ExportStatements.tsx").replace(/\r\n/g, "\n");
    const fn = src.slice(src.indexOf("const issueAndExport"), src.indexOf("const isDisabled"));
    expect(fn.indexOf('supabase.rpc("issue_reporting_pack"')).toBeGreaterThan(-1);
    expect(fn.indexOf('supabase.rpc("issue_reporting_pack"')).toBeLessThan(fn.indexOf("render(result.issuance_id)"));
    expect(src).toMatch(/issueAndExport\("financial_statements_pdf", exportToPDF\)/);
    expect(src).toMatch(/issueAndExport\("financial_statements_spreadsheet", exportToExcel\)/);
    expect(src).not.toMatch(/onClick=\{exportTo(PDF|Excel)\}/);
  });
  it("new entities are created only through create_entity (capacity enforced server-side); no direct companies insert", () => {
    for (const f of ["src/components/CompanyManager.tsx", "src/components/workspace/FirstRunEngagement.tsx"]) {
      const src = read(f);
      expect(src).toMatch(/supabase\.rpc\("create_entity"/);
      expect(src).toMatch(/parseCreateEntityOutcome/);
      expect(src).not.toMatch(/\.from\("companies"\)\s*\.(insert|upsert)\(/);
    }
    const all = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) all(p, out); else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
      }
      return out;
    };
    const inserters = all(path.join(ROOT, "src")).filter((f) => /\.from\(["']companies["']\)\s*\.(insert|upsert)\(/.test(fs.readFileSync(f, "utf8")));
    expect(inserters.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
  it("sign-off, publication and management-letter paths recognise the structured refusal", () => {
    expect(read("src/jurisdiction-packs/tz/KingaTaxPanel.tsx")).toMatch(/entitlementRefusal\(\w+\) === "STATEMENT_CERTIFICATION"/);
    expect(read("src/components/PeriodCloseManager.tsx")).toMatch(/entitlementRefusal\(error\) === "STATEMENT_CERTIFICATION"/);
    expect(read("src/lib/financialStatementsWorkspace/rpcTransport.ts")).toMatch(/e\.code === "PT402" \? "ENTITLEMENT_REQUIRED"/);
    expect(read("src/components/MgmtLetterPanel.tsx")).toMatch(/functionEntitlementRefusal\(error\)\)\s*===\s*"REPORTING_PACK_EXPORT"/);
  });
});
