// @vitest-environment jsdom
/**
 * One file, two years (I1-B): the adjacency rule (mirrors register_two_period_uploads), the client's outcome handling,
 * the release gate, and the single uploader's two-year path. The database side — atomicity with a failure injected at
 * every write, idempotency, shared-source cleanup — is proven on real PostgreSQL by scripts/db-proof/sharedSourceAuthority.mjs.
 */
import { act, createElement as h } from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "@/lib/workbench/testkit/dom";
import { TWO_PERIOD_INTAKE_ENABLED, adjacentPriorPeriod, registerTwoPeriodUpload, type PeriodRow, type TwoPeriodRpcClient } from "./twoPeriodIntake";

const P = (id: string, end: string, start: string | null = null, rEnd: string | null = null): PeriodRow =>
  ({ id, period_label: `FY${end.slice(0, 4)}`, fiscal_year_end: end, reporting_start: start, reporting_end: rEnd });

describe("adjacentPriorPeriod — the server's rule", () => {
  it("dated periods meet exactly: the prior ends the day before the current starts", () => {
    const ps = [P("c", "2025-06-30", "2024-07-01", "2025-06-30"), P("p", "2024-06-30", "2023-07-01", "2024-06-30"), P("x", "2023-06-30", "2022-07-01", "2023-06-30")];
    expect(adjacentPriorPeriod(ps, "c")?.id).toBe("p");
  });
  it("a gap between dated periods is not adjacent", () => {
    expect(adjacentPriorPeriod([P("c", "2025-12-31", "2025-01-01", "2025-12-31"), P("p", "2024-11-30", "2023-12-01", "2024-11-30")], "c")).toBeNull();
  });
  it("undated periods: consecutive years", () => {
    expect(adjacentPriorPeriod([P("c", "2025-12-31"), P("p", "2024-12-31"), P("x", "2023-12-31")], "c")?.id).toBe("p");
    expect(adjacentPriorPeriod([P("c", "2025-12-31"), P("x", "2023-12-31")], "c")).toBeNull();
  });
  it("two candidates: none is chosen (never guessed); an unknown current period: none", () => {
    expect(adjacentPriorPeriod([P("c", "2025-12-31"), P("a", "2024-06-30"), P("b", "2024-12-31")], "c")).toBeNull();
    expect(adjacentPriorPeriod([P("p", "2024-12-31")], "missing")).toBeNull();
  });
});

describe("registerTwoPeriodUpload", () => {
  const client = (row: Record<string, unknown> | null, error: { message: string } | null = null) => {
    const rpc = vi.fn(async () => ({ data: row ? [row] : null, error }));
    return { rpc } as unknown as TwoPeriodRpcClient & { rpc: ReturnType<typeof vi.fn> };
  };
  const args = { reservationId: "r", requestId: "q", fileSize: 10, currentPeriodId: "c", priorPeriodId: "p", currentEngagementId: "e" };
  it("sends the reservation, the request id, both periods and the current engagement; returns both uploads", async () => {
    const c = client({ outcome: "registered", current_upload_id: "u1", prior_upload_id: "u0", source_object_id: "o", detail: null });
    await expect(registerTwoPeriodUpload(c, args)).resolves.toEqual({ currentUploadId: "u1", priorUploadId: "u0" });
    expect(c.rpc).toHaveBeenCalledWith("register_two_period_uploads", {
      p_reservation_id: "r", p_request_id: "q", p_file_size: 10, p_current_period_id: "c", p_prior_period_id: "p",
      p_current_engagement_id: "e", p_prior_engagement_id: null,
    });
  });
  it("an already-registered pair is the same pair (retry)", async () => {
    const c = client({ outcome: "already_registered", current_upload_id: "u1", prior_upload_id: "u0", source_object_id: "o", detail: null });
    await expect(registerTwoPeriodUpload(c, args)).resolves.toEqual({ currentUploadId: "u1", priorUploadId: "u0" });
  });
  it("a file already registered for one year only is refused, not silently turned into two years", async () => {
    const c = client({ outcome: "already_registered", current_upload_id: "u1", prior_upload_id: null, source_object_id: null, detail: "x" });
    await expect(registerTwoPeriodUpload(c, args)).rejects.toMatchObject({ code: "already_registered", retryable: false });
  });
  it.each([
    ["periods_not_adjacent", /end immediately before/],
    ["active_upload_exists", /already active for one of these periods/],
    ["forbidden", /permission/],
  ])("%s → a plain refusal", async (outcome, msg) => {
    const c = client({ outcome, current_upload_id: null, prior_upload_id: null, source_object_id: null, detail: null });
    await expect(registerTwoPeriodUpload(c, args)).rejects.toThrow(msg);
  });
  it("no answer → retryable failure", async () => {
    await expect(registerTwoPeriodUpload(client(null, { message: "net" }), args)).rejects.toMatchObject({ code: "register_failed", retryable: true });
  });
});

describe("release gate", () => {
  it("is off until the migration is applied to the hosted database, and is a reviewed source constant", () => {
    expect(TWO_PERIOD_INTAKE_ENABLED).toBe(false);
    const src = fs.readFileSync(path.resolve(__dirname, "twoPeriodIntake.ts"), "utf8");
    expect(src).toMatch(/^export const TWO_PERIOD_INTAKE_ENABLED = false;$/m);
    expect(src).not.toMatch(/import\.meta\.env|localStorage|sessionStorage|URLSearchParams|document\.cookie/);
  });
});

// ── The single uploader's two-year path (gate forced on for this test only) ──────────────────────────────────────────
let m: Mounted | null = null;
afterEach(() => {
  m?.unmount(); m = null; document.body.innerHTML = "";
  for (const mod of ["@/contexts/AuthContext", "@/hooks/useAuditLog", "@/integrations/supabase/client", "@/lib/ensureFreshSession", "@/lib/workspace/sourceUpload", "@/lib/workspace/twoPeriodIntake"]) vi.doUnmock(mod);
});
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };

async function mountUploader(gate: boolean) {
  vi.resetModules();
  const rpc = vi.fn(async () => ({ data: [{ outcome: "registered", current_upload_id: "cur-up", prior_upload_id: "pri-up", source_object_id: "o", detail: null }], error: null }));
  const invoke = vi.fn(async () => ({ data: null, error: null }));
  const registerSingle = vi.fn(async () => "single-up");
  const periods = [P("cur", "2025-12-31", "2025-01-01", "2025-12-31"), P("pri", "2024-12-31", "2024-01-01", "2024-12-31")];
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order"]) chain[k] = () => chain;
  chain.limit = async () => ({ data: [] });
  chain.maybeSingle = async () => ({ data: { status: "complete" } });
  const from = vi.fn((t: string) => t === "fiscal_periods"
    ? { select: () => ({ eq: () => Promise.resolve({ data: periods }) }) }
    : chain);
  vi.doMock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
  vi.doMock("@/hooks/useAuditLog", () => ({ useAuditLog: () => ({ logAction: vi.fn() }) }));
  vi.doMock("@/lib/ensureFreshSession", () => ({ ensureFreshSession: async () => undefined }));
  vi.doMock("@/integrations/supabase/client", () => ({ supabase: { rpc, from, functions: { invoke } } }));
  vi.doMock("@/lib/workspace/sourceUpload", async (orig) => ({ ...(await orig<object>()), uploadWorkspaceSource: async () => ({ reservationId: "res-1", objectPath: "p" }), registerWorkspaceUpload: registerSingle }));
  vi.doMock("@/lib/workspace/twoPeriodIntake", async (orig) => ({ ...(await orig<object>()), TWO_PERIOD_INTAKE_ENABLED: gate }));
  const { TrialBalanceUpload } = await import("@/components/TrialBalanceUpload");
  m = mount(h(TrialBalanceUpload, { embedded: true, lockedCompanyId: "c1", periodYear: 2025, periodId: "cur", engagementId: "eng" }));
  await flush();
  const input = document.querySelector("[data-testid=trial-balance-file-input]") as HTMLInputElement;
  const file = new File(["Code,Name,2025,2024\n"], "two-years.csv", { type: "text/csv" });
  Object.defineProperty(input, "files", { value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  return { rpc, invoke, registerSingle };
}

describe("TrialBalanceUpload — one file, two years", () => {
  it("gate off: no two-year option; the single registration path is used, exactly as before", async () => {
    const t = await mountUploader(false);
    expect(document.querySelector("[data-testid=trial-balance-two-period]")).toBeNull();
    (document.querySelector("[data-testid=trial-balance-upload-primary]") as HTMLButtonElement).click();
    await flush();
    expect(t.registerSingle).toHaveBeenCalled();
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it("gate on: the adjacent prior period is offered; when chosen, both years are registered in one call and each is checked on its own", async () => {
    const t = await mountUploader(true);
    const box = document.querySelector("[data-testid=trial-balance-two-period]")!;
    expect(box.textContent).toContain("save it for FY2024 too");
    await act(async () => { (box.querySelector("input[type=checkbox]") as HTMLInputElement).click(); });
    await act(async () => { (document.querySelector("[data-testid=trial-balance-upload-primary]") as HTMLButtonElement).click(); });
    await flush();
    expect(t.registerSingle).not.toHaveBeenCalled();
    expect(t.rpc).toHaveBeenCalledWith("register_two_period_uploads", expect.objectContaining({
      p_reservation_id: "res-1", p_current_period_id: "cur", p_prior_period_id: "pri", p_current_engagement_id: "eng", p_prior_engagement_id: null }));
    const checked = t.invoke.mock.calls.map(([, opts]) => (opts as { body: { uploadId: string } }).body.uploadId);
    expect(checked.sort()).toEqual(["cur-up", "pri-up"]);
    expect(document.querySelector("[data-testid=trial-balance-prior-note]")?.textContent).toContain("FY2024 was saved from the same file");
  });
  it("gate on but not chosen: one year only (the single path)", async () => {
    const t = await mountUploader(true);
    await act(async () => { (document.querySelector("[data-testid=trial-balance-upload-primary]") as HTMLButtonElement).click(); });
    await flush();
    expect(t.registerSingle).toHaveBeenCalled();
    expect(t.rpc).not.toHaveBeenCalled();
  });
});
