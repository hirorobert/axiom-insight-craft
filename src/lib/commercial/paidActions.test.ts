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
import { describe, expect, it, vi } from "vitest";

// DraftPrintMark reaches the Supabase client through its commercial-state hook; nothing here calls it.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import { PaidActionNotice } from "@/components/commercial/PaidActionNotice";
import { DraftPrintMarkView } from "@/components/commercial/DraftPrintMark";
import { DRAFT_PRINT_MARK, REPORTING_PACK_KINDS, parseIssueOutcome } from "./reportingPack";
import { parseCreateEntityOutcome } from "./entityCreation";
import {
  canInviteAnother,
  capacityCopy,
  functionSeatRefusal,
  parseAcceptInvitations,
  parseSeatCapacity,
  seatCopy,
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

describe("named-user seats in the UI (structured state only)", () => {
  const raw = (o: Record<string, unknown>) => ({ access: true, determined: true, plan_code: "PRACTICE", included_seats: 1, additional_seats: 2, allowed_named_users: 3, additional_seats_purchasable: true, active_named_users: 2, reserved_named_users: 2, ...o });
  it("parses the seat state; no access, malformed or undetermined fails closed", () => {
    const s = parseSeatCapacity(raw({}))!;
    expect(s).toMatchObject({ determined: true, allowedNamedUsers: 3, activeNamedUsers: 2, reservedNamedUsers: 2, additionalSeatsPurchasable: true });
    expect(canInviteAnother(s)).toBe(true);
    for (const bad of [null, { access: false }, raw({ active_named_users: -1 }), raw({ determined: "yes" }), raw({ reserved_named_users: 1.5 })]) expect(parseSeatCapacity(bad)).toBeNull();
    const und = parseSeatCapacity(raw({ determined: false, allowed_named_users: null }))!;
    expect(canInviteAnother(und)).toBe(false);
    expect(canInviteAnother(null)).toBe(false);
    expect(seatCopy(und)!.title).toBe("Named-user seats need confirming");
  });
  it("a pending invitation holds a seat: reserved = allowed means no further invitation", () => {
    expect(canInviteAnother(parseSeatCapacity(raw({ active_named_users: 2, reserved_named_users: 3 })))).toBe(false);
    expect(seatCopy(parseSeatCapacity(raw({})))).toBeNull();
  });
  it("Free: one named user, inviting is available with Practice, seat price from the catalogue, nobody removed", () => {
    const c = seatCopy(parseSeatCapacity(raw({ plan_code: "FREE", included_seats: 1, additional_seats: 0, allowed_named_users: 1, additional_seats_purchasable: false, active_named_users: 1, reserved_named_users: 1 })))!;
    expect(c.title).toBe("Available with Practice");
    expect(c.unavailable).toMatch(/one named user: you/);
    expect(c.remains).toContain("$20 / month or $200 / year");
    expect(c.history).toMatch(/nobody is removed/);
  });
  it("Practice at its allowance: states the formula and how to add seats; no checkout, no hostile wording", () => {
    const c = seatCopy(parseSeatCapacity(raw({ active_named_users: 3, reserved_named_users: 3 })))!;
    expect(c.title).toBe("All named-user seats are in use");
    expect(c.unavailable).toBe("Your Practice plan has 3 named users (1 included + 2 additional), and every seat is in use or held by a pending invitation.");
    expect(c.remains).toMatch(/Contact us to add seats/);
    const text = Object.values(c).join(" ");
    expect(text).not.toMatch(/payment required|pay now|checkout|shared (login|account|password)|owner|partner|manager/i);
  });
  it("accept_workspace_invitations and the invitation function's 402 body are read by structured fields", async () => {
    const id = "0b7e3f0a-7c1e-4a51-9a2e-3f7e1c2d4b5a";
    expect(parseAcceptInvitations({ outcome: "ok", accepted: [id], blocked: [{ company_id: id, code: "SEAT_LIMIT_REACHED" }, { company_id: 1, code: "X" }] }))
      .toEqual({ accepted: [id], blocked: [{ companyId: id, code: "SEAT_LIMIT_REACHED" }] });
    expect(parseAcceptInvitations({ outcome: "unauthenticated" })).toBeNull();
    const ctx = new Response(JSON.stringify({ status: "seat_limit_reached", capability: "NAMED_USER_SEATS" }), { status: 402 });
    expect(await functionSeatRefusal({ context: ctx })).toBe("seat_limit_reached");
    expect(await functionSeatRefusal({ context: new Response(JSON.stringify({ status: "seat_limit_reached", capability: "CLOSE_INSIGHTS" })) })).toBeNull();
    expect(await functionSeatRefusal({ message: "seat_limit_reached" })).toBeNull();
  });
  it("acceptance goes through the per-invitation RPC (never a bulk client update); the team panel never offers an invitation the server would refuse", () => {
    const dash = read("src/pages/Dashboard.tsx");
    expect(dash).toMatch(/supabase\.rpc\("accept_workspace_invitations"/);
    expect(dash).not.toMatch(/\.from\("firm_members"\)\s*\.update\(/);
    const panel = read("src/components/FirmManagementPanel.tsx");
    expect(panel).toMatch(/supabase\.rpc\("get_workspace_seat_capacity"/);
    expect(panel).toMatch(/disabled=\{!seatsLoaded \|\| !canInviteAnother\(seats\)\}/);
    expect(panel).toMatch(/functionSeatRefusal\(error\)/);
    expect(panel).toMatch(/Each person signs in with their own account/);
  });
});

describe("Reporting Pack: downloads are issued by the server first; free printing is marked on every page", () => {
  it("parseIssueOutcome: only issued / already_issued with an id allows a download", () => {
    expect(parseIssueOutcome({ outcome: "issued", issuance_id: "abc" })).toEqual({ status: "issued", issuanceId: "abc" });
    expect(parseIssueOutcome({ outcome: "already_issued", issuance_id: "abc" })).toEqual({ status: "issued", issuanceId: "abc" });
    expect(parseIssueOutcome({ outcome: "entitlement_required" })).toEqual({ status: "locked" });
    for (const bad of [null, {}, { outcome: "issued" }, { outcome: "issued", issuance_id: "" }, { outcome: "workspace_access_denied" }]) expect(parseIssueOutcome(bad).status).toBe("failed");
  });
  it("the client kinds are exactly the database's issuance kinds", () => {
    const migration = read("supabase/migrations/20260925100000_global_capabilities_entitlements_pricing.sql");
    const check = /chk_rpi_kind CHECK \(pack_kind IN \(([^)]*)\)\)/.exec(migration)?.[1] ?? "";
    expect([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...REPORTING_PACK_KINDS].sort());
  });
  it.each([
    ["src/pages/workspace/StatementsWorkspace.tsx", /issueReportingPack\([^;]*"financial_statements_data"\)/, /issueDownload=\{issueStatementsDownload\}/],
    ["src/components/financialStatements/OutputsStage.tsx", /const outcome = await issueDownload\(\);/, /if \(outcome\.status === "issued"\) download\(file\)/],
    ["src/components/MgmtLetterPanel.tsx", /requestReportingPack\(companyId, letter\.metadata\.periodYear, "management_letter"\)\) exportToPDF/, null],
    ["src/components/NoteSynth.tsx", /if \(!\(await requestReportingPack\(companyId, periodYear, "disclosure_notes"\)\)\) return;/, null],
    ["src/jurisdiction-packs/tz/CapitalAllowancesRegister.tsx", /if \(!\(await requestReportingPack\(companyId, periodYear, "tax_workpaper"\)\)\) return;/, null],
    ["src/jurisdiction-packs/tz/TRAAuditReadinessPanel.tsx", /if \(!\(await requestReportingPack\(companyId, periodYear, "tax_workpaper"\)\)\) return;/, null],
    ["src/components/maono/BoardPackGenerator.tsx", /requestReportingPack\(companyId, periodYear, "board_pack"\)\)\) return;/, /requestReportingPack\(companyId, periodYear, "board_pack"\)\) exportToExcel\(pack\)/],
  ] as const)("%s issues before it generates", (file, gate, second) => {
    const src = read(file);
    expect(src).toMatch(gate);
    if (second) expect(src).toMatch(second);
  });
  it("the tax computation PDF is issued first at both entry points", () => {
    const src = read("src/jurisdiction-packs/tz/KingaTaxPanel.tsx").replace(/\r\n/g, "\n");
    const gates = [...src.matchAll(/if \(!\(await requestReportingPack\(companyId, periodYear, "tax_computation"\)\)\) return;\n\s*generateTaxComputationPDF\(\{/g)];
    expect(gates.length).toBe(2);
    expect([...src.matchAll(/generateTaxComputationPDF\(\{/g)].length).toBe(2);
  });
  it("the workspace print mark carries the exact required marking on every printed page (the statements print: honestDraft.test.ts)", () => {
    expect(DRAFT_PRINT_MARK).toBe("DRAFT — NOT CERTIFIED — NOT FOR FILING OR CLIENT ISSUE");
    const html = renderToStaticMarkup(createElement(DraftPrintMarkView));
    expect(html.split(DRAFT_PRINT_MARK).length - 1).toBe(2);
    expect(html).toMatch(/@media print[\s\S]*position: fixed/);
    expect(html).toMatch(/\.cfo-draft-print-mark \{ display: none; \}/);
    expect(read("src/pages/workspace/WorkspaceLayout.tsx")).toMatch(/<DraftPrintMark companyId=\{companyId\} \/>/);
    const mark = read("src/components/commercial/DraftPrintMark.tsx");
    expect(mark).toMatch(/paidActionState\(state, "REPORTING_PACK_EXPORT", loading\)\.status === "allowed"\) return null;/);
  });
});
