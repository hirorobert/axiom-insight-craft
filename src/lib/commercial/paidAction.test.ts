/**
 * The paid-action gate at the Edge Function boundary (supabase/functions/_shared/paidAction.ts), where each gated
 * function places it, and the comparative-assurance endpoint transition. The database authority itself is proven on
 * real PostgreSQL in scripts/db-proof/entitlements.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  paidActionRefusal,
  requirePaidAction,
  requirePaidActionAsCaller,
  workspaceEntitled,
} from "../../../supabase/functions/_shared/paidAction";

const ROOT = path.join(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const CORS = { "Access-Control-Allow-Origin": "*" };

describe("paidActionRefusal — structured answer in, stable non-sensitive refusal out", () => {
  it("only an explicit ALLOWED passes", () => {
    expect(paidActionRefusal("CLOSE_INSIGHTS", { allowed: true, code: "ALLOWED" })).toBeNull();
    for (const bad of [{ allowed: true }, { code: "ALLOWED" }, { allowed: "true", code: "ALLOWED" }, null, undefined, "ALLOWED", 1]) {
      expect(paidActionRefusal("CLOSE_INSIGHTS", bad)).not.toBeNull();
    }
  });
  it("maps each denial to its HTTP status and a body that names the capability, never another tenant or a price", () => {
    const e = paidActionRefusal("REPORTING_PACK_EXPORT", { allowed: false, code: "ENTITLEMENT_REQUIRED", required_plan: "PRACTICE" })!;
    expect(e.httpStatus).toBe(402);
    expect(e.body).toMatchObject({ status: "entitlement_required", capability: "REPORTING_PACK_EXPORT", required_plan: "PRACTICE" });
    expect(e.body.message).toMatch(/available with Practice\. .*remains available\./);
    expect(JSON.stringify(e.body)).not.toMatch(/\$\d|USD|owner|partner/i);
    expect(paidActionRefusal("CLOSE_INSIGHTS", { allowed: false, code: "WORKSPACE_ACCESS_DENIED" })!.httpStatus).toBe(403);
    expect(paidActionRefusal("CLOSE_INSIGHTS", { allowed: false, code: "UNAUTHENTICATED" })!.httpStatus).toBe(401);
    expect(paidActionRefusal("CLOSE_INSIGHTS", { allowed: false, code: "UNKNOWN_CAPABILITY" })!.httpStatus).toBe(500);
  });
  it("an RPC error fails closed (500, action not started)", async () => {
    const rpc = vi.fn(async () => ({ data: { allowed: true, code: "ALLOWED" }, error: { message: "boom" } }));
    const r = await requirePaidAction(rpc, "u", "c", "CLOSE_INSIGHTS", CORS);
    expect(r?.status).toBe(500);
  });
  it("the service-role variant passes only the JWT-derived user; the caller-bound variant passes no user at all", async () => {
    const rpc = vi.fn(async () => ({ data: { allowed: true, code: "ALLOWED" }, error: null }));
    expect(await requirePaidAction(rpc, "user-from-jwt", "co", "STATEMENT_CERTIFICATION", CORS)).toBeNull();
    expect(rpc).toHaveBeenCalledWith("authorize_paid_action_for_user", { p_user: "user-from-jwt", p_company_id: "co", p_capability: "STATEMENT_CERTIFICATION" });
    const rpc2 = vi.fn(async () => ({ data: { allowed: false, code: "ENTITLEMENT_REQUIRED" }, error: null }));
    const refused = await requirePaidActionAsCaller(rpc2, "co", "CLOSE_INSIGHTS", CORS);
    expect(rpc2).toHaveBeenCalledWith("authorize_paid_action", { p_company_id: "co", p_capability: "CLOSE_INSIGHTS" });
    expect(refused?.status).toBe(402);
    expect(await refused?.json()).toMatchObject({ status: "entitlement_required", capability: "CLOSE_INSIGHTS" });
  });
  it("scheduled work: workspaceEntitled is true only for an explicit true", async () => {
    expect(await workspaceEntitled(vi.fn(async () => ({ data: true, error: null })), "c", "CLOSE_INSIGHTS")).toBe(true);
    for (const r of [{ data: false, error: null }, { data: "true", error: null }, { data: true, error: { m: 1 } }]) {
      expect(await workspaceEntitled(vi.fn(async () => r), "c", "CLOSE_INSIGHTS")).toBe(false);
    }
  });
});

describe("every paid server path asks the authority before doing any work", () => {
  const gated: Array<[string, string, RegExp]> = [
    ["supabase/functions/maono-compute/index.ts", "CLOSE_INSIGHTS", /\.from\("trial_balance_uploads"\)/],
    ["supabase/functions/maono-risk/index.ts", "CLOSE_INSIGHTS", /\.from\("variance_analyses"\)/],
    ["supabase/functions/maono-decide/index.ts", "CLOSE_INSIGHTS", /\.from\("variance_materiality"\)/],
    ["supabase/functions/maono-cashflow/index.ts", "CLOSE_INSIGHTS", /\.from\("variance_materiality"\)/],
    ["supabase/functions/maono-root-cause/index.ts", "CLOSE_INSIGHTS", /\.from\("maono_context"\)/],
    ["supabase/functions/generate-xbrl/index.ts", "REPORTING_PACK_EXPORT", /\.from\("companies"\)/],
    ["supabase/functions/generate-management-letter/index.ts", "REPORTING_PACK_EXPORT", /\.from\("companies"\)/],
  ];
  it.each(gated)("%s gates %s before its first work", (file, capability, firstWork) => {
    const src = read(file).replace(/\r\n/g, "\n");
    const gate = src.search(new RegExp(`requirePaidAction(AsCaller)?\\([^;]*"${capability}"`));
    expect(gate, "gate present").toBeGreaterThan(-1);
    expect(src.slice(gate, gate + 400)).toMatch(/if \(notEntitled\) return notEntitled;/);
    const work = src.slice(gate).search(firstWork);
    expect(work, "work happens after the gate").toBeGreaterThan(0);
    // No user id from the request body is ever used as authority.
    expect(src).not.toMatch(/p_user:\s*(body|payload|req)/);
  });
  it("the scheduled monitor skips (never fails) workspaces without Close Insights", () => {
    const src = read("supabase/functions/maono-monitor/index.ts").replace(/\r\n/g, "\n");
    const skip = src.indexOf('workspaceEntitled((fn, args) => supabase.rpc(fn, args), company.id, "CLOSE_INSIGHTS")');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(src.indexOf("await scanCompany(supabase, company.id)"));
  });
  it("essential validation engines are never gated", () => {
    for (const f of ["supabase/functions/hesabu-validate/index.ts", "supabase/functions/process-trial-balance/index.ts", "supabase/functions/kinga-findings-engine/index.ts", "supabase/functions/_shared/comparativeAssurance.ts"]) {
      expect(read(f)).not.toMatch(/requirePaidAction|authorize_paid_action/);
    }
  });
});

describe("Close Assurance comparative endpoint transition", () => {
  const canonical = read("supabase/functions/comparative-assurance-engine/index.ts");
  const legacy = read("supabase/functions/kinga-comparative-engine/index.ts");
  const shared = read("supabase/functions/_shared/comparativeAssurance.ts");
  it("both endpoints serve the SAME handler: no business logic, no HTTP hop, no recursion", () => {
    for (const src of [canonical, legacy]) {
      expect(src).toMatch(/import \{ handleComparativeAssurance \} from "\.\.\/_shared\/comparativeAssurance\.ts";/);
      expect(src).toMatch(/serve\(handleComparativeAssurance\);/);
      expect(src.replace(/\/\/.*$/gm, "").replace(/import[^\n]*\n/g, "").replace(/serve\(handleComparativeAssurance\);/, "").trim()).toBe("");
    }
    expect(shared.replace(/\/\/.*$/gm, "")).not.toMatch(/functions\/v1\/(kinga-comparative-engine|comparative-assurance-engine)|functions\.invoke/);
  });
  it("the shared handler reads only (no inserts, updates, upserts or deletes), so no duplicate write is possible", () => {
    expect(shared).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
  it("the legacy adapter documents its retirement condition; both run with the same JWT setting", () => {
    expect(legacy).toMatch(/RETIREMENT CONDITION/);
    const cfg = read("supabase/config.toml");
    expect(cfg).toMatch(/\[functions\.comparative-assurance-engine\]\s*\n\s*verify_jwt = false/);
    expect(cfg).toMatch(/\[functions\.kinga-comparative-engine\]\s*\n\s*verify_jwt = false/);
  });
  it("every repository caller uses the neutral endpoint", () => {
    const panel = read("src/jurisdiction-packs/tz/KingaComparativePanel.tsx");
    expect(panel).toMatch(/"comparative-assurance-engine"/);
    expect(panel).not.toMatch(/"kinga-comparative-engine"/);
  });
});
