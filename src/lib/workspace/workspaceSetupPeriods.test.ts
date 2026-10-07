import { describe, expect, it, vi } from "vitest";
import { completeLegacyPeriodDates, confirmPeriodDates, openEngagementWithPeriod, PERIOD_REFUSAL_COPY, SetupFeatureUnavailable, WorkspaceSetupError, type RpcClient } from "./workspaceSetupClient";

const client = (answer: { data: unknown; error: { code?: string; message?: string } | null }) => {
  const rpc = vi.fn(async () => answer);
  return { c: { rpc } as unknown as RpcClient, rpc };
};
const input = { companyId: "c", periodStart: "2024-07-01", periodEnd: "2025-06-30", reportingCurrency: "BHD", capabilities: ["FINANCIAL_STATEMENTS"] as const };

describe("openEngagementWithPeriod", () => {
  it("sends exactly what the person chose (no defaulted currency or dates)", async () => {
    const { c, rpc } = client({ data: { outcome: "opened", engagementId: "e", periodId: "p", priorPeriodId: null, periodYear: 2025, created: true, granted: ["FINANCIAL_STATEMENTS"] }, error: null });
    const r = await openEngagementWithPeriod(c, { ...input });
    expect(rpc).toHaveBeenCalledWith("open_engagement_with_period", expect.objectContaining({ p_period_start: "2024-07-01", p_period_end: "2025-06-30", p_reporting_currency: "BHD", p_prior_start: null, p_prior_currency: null }));
    expect(r).toMatchObject({ outcome: "opened", periodYear: 2025, created: true });
  });
  it("maps every server refusal to plain copy", async () => {
    for (const code of Object.keys(PERIOD_REFUSAL_COPY)) {
      const { c } = client({ data: { outcome: "refused", code, periodId: "p" }, error: null });
      const r = await openEngagementWithPeriod(c, { ...input });
      expect(r).toEqual({ outcome: "refused", code, message: PERIOD_REFUSAL_COPY[code as keyof typeof PERIOD_REFUSAL_COPY], periodId: "p" });
    }
  });
  it("an unknown refusal is never shown as success", async () => {
    const { c } = client({ data: { outcome: "refused", code: "SOMETHING_NEW" }, error: null });
    await expect(openEngagementWithPeriod(c, { ...input })).rejects.toBeInstanceOf(WorkspaceSetupError);
  });
  it("a backend without the function means unavailable, not failed", async () => {
    for (const code of ["PGRST202", "42883"]) {
      const { c } = client({ data: null, error: { code, message: "function not found" } });
      await expect(openEngagementWithPeriod(c, { ...input })).rejects.toBeInstanceOf(SetupFeatureUnavailable);
    }
  });
  it("server input refusals keep their meaning", async () => {
    const { c } = client({ data: null, error: { code: "22023", message: "INVALID: CURRENCY_UNSUPPORTED — XAU is not a supported monetary currency" } });
    await expect(openEngagementWithPeriod(c, { ...input, reportingCurrency: "XAU" })).rejects.toMatchObject({ kind: "INVALID" });
    const f = client({ data: null, error: { code: "42501", message: "FORBIDDEN" } });
    await expect(openEngagementWithPeriod(f.c, { ...input })).rejects.toMatchObject({ kind: "NOT_AUTHORISED" });
  });
  it("refuses malformed dates before any request", async () => {
    const { c, rpc } = client({ data: null, error: null });
    await expect(openEngagementWithPeriod(c, { ...input, periodStart: "1/7/2024" })).rejects.toMatchObject({ kind: "INVALID" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("confirmPeriodDates", () => {
  it("confirms, and maps a refusal", async () => {
    const ok = client({ data: { outcome: "confirmed", periodId: "p", changed: true }, error: null });
    expect(await confirmPeriodDates(ok.c, "p", "2019-01-01", "2019-12-31")).toEqual({ outcome: "confirmed", periodId: "p", changed: true });
    const no = client({ data: { outcome: "refused", code: "PERIOD_OVERLAP" }, error: null });
    expect(await confirmPeriodDates(no.c, "p", "2019-01-01", "2019-12-31")).toEqual({ outcome: "refused", code: "PERIOD_OVERLAP", message: PERIOD_REFUSAL_COPY.PERIOD_OVERLAP });
  });
});

describe("completeLegacyPeriodDates", () => {
  it("sends the reason; reports the invalidated results; maps refusals; refuses a missing reason before any request", async () => {
    const ok = client({ data: { outcome: "completed", periodId: "p", changed: true, invalidated: ["c1"] }, error: null });
    expect(await completeLegacyPeriodDates(ok.c, "p", "2019-01-01", "2019-12-31", "Per the signed 2019 accounts")).toEqual({ outcome: "completed", periodId: "p", changed: true, invalidated: ["c1"] });
    expect(ok.rpc).toHaveBeenCalledWith("complete_legacy_period_dates", { p_period_id: "p", p_start: "2019-01-01", p_end: "2019-12-31", p_reason: "Per the signed 2019 accounts" });
    const no = client({ data: { outcome: "refused", code: "NOT_A_LEGACY_PERIOD" }, error: null });
    expect(await completeLegacyPeriodDates(no.c, "p", "2019-01-01", "2019-12-31", "Per the signed accounts")).toEqual({ outcome: "refused", code: "NOT_A_LEGACY_PERIOD", message: PERIOD_REFUSAL_COPY.NOT_A_LEGACY_PERIOD });
    const none = client({ data: null, error: null });
    await expect(completeLegacyPeriodDates(none.c, "p", "2019-01-01", "2019-12-31", "short")).rejects.toMatchObject({ kind: "INVALID" });
    expect(none.rpc).not.toHaveBeenCalled();
  });
});
