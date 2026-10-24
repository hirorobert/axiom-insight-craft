import { describe, expect, it } from "vitest";
import { changeReportingFramework, frameworkChangeMessage, frameworkChangeReason, parseFrameworkChange, type FrameworkChangeClient } from "./companyFramework";

const client = (data: unknown, error: { code?: string } | null = null): FrameworkChangeClient & { calls: Array<[string, Record<string, unknown>]> } => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return { calls, rpc: async (fn, args) => { calls.push([fn, args]); return { data, error }; } };
};

describe("changeReportingFramework — the one browser path", () => {
  it("calls set_company_reporting_framework with the expected current value, the target, a reason and the request id", async () => {
    const c = client({ outcome: "changed", from: null, to: "ipsas_accrual", eventId: "e1" });
    const r = await changeReportingFramework(c, { companyId: "c1", from: null, to: "ipsas_accrual", requestId: "r1" });
    expect(r).toEqual({ kind: "changed", from: null, to: "ipsas_accrual", eventId: "e1" });
    expect(c.calls).toHaveLength(1);
    const [fn, args] = c.calls[0];
    expect(fn).toBe("set_company_reporting_framework");
    expect(args).toMatchObject({ p_company_id: "c1", p_framework: "ipsas_accrual", p_expected_framework: null, p_request_id: "r1" });
    expect(String(args.p_reason).length).toBeGreaterThanOrEqual(8);
  });
  it("a thrown transport error is an error, never a success", async () => {
    const r = await changeReportingFramework({ rpc: () => { throw new Error("network"); } }, { companyId: "c1", from: null, to: "full_ifrs", requestId: "r" });
    expect(r).toEqual({ kind: "error" });
  });
});

describe("parseFrameworkChange — strict reading of structured fields", () => {
  it("maps each server refusal code", () => {
    expect(parseFrameworkChange({ outcome: "refused", code: "FRAMEWORK_LOCKED", current: "ifrs_for_smes" }, null)).toEqual({ kind: "locked", current: "ifrs_for_smes" });
    expect(parseFrameworkChange({ outcome: "refused", code: "STALE_FRAMEWORK", current: null }, null)).toEqual({ kind: "stale", current: null });
    expect(parseFrameworkChange({ outcome: "refused", code: "PROCESSING_IN_PROGRESS", current: "full_ifrs" }, null)).toEqual({ kind: "processing", current: "full_ifrs" });
  });
  it("maps SQLSTATEs, not message text", () => {
    expect(parseFrameworkChange(null, { code: "42501" })).toEqual({ kind: "forbidden" });
    expect(parseFrameworkChange(null, { code: "22023" })).toEqual({ kind: "invalid" });
    expect(parseFrameworkChange(null, { code: "PT409" })).toEqual({ kind: "error" });
  });
  it("replayed and unchanged are successes; anything outside the contract is an error", () => {
    expect(parseFrameworkChange({ outcome: "replayed", from: "full_ifrs", to: "ifrs_for_smes", eventId: "e" }, null).kind).toBe("replayed");
    expect(parseFrameworkChange({ outcome: "unchanged", from: "full_ifrs", to: "full_ifrs" }, null)).toEqual({ kind: "unchanged", framework: "full_ifrs" });
    expect(parseFrameworkChange({ outcome: "changed", from: null, to: "nonsense", eventId: "e" }, null).kind).toBe("error");
    expect(parseFrameworkChange({ outcome: "changed", from: null, to: "full_ifrs" }, null).kind).toBe("error");
    expect(parseFrameworkChange({ outcome: "refused", code: "SOMETHING_NEW", current: null }, null).kind).toBe("error");
    expect(parseFrameworkChange({ outcome: "ok" }, null).kind).toBe("error");
    expect(parseFrameworkChange("changed", null).kind).toBe("error");
  });
});

describe("words", () => {
  it("successes have no refusal message; every refusal has one", () => {
    expect(frameworkChangeMessage({ kind: "changed", from: null, to: "full_ifrs", eventId: "e" })).toBeNull();
    for (const kind of ["locked", "stale", "processing"] as const) expect(frameworkChangeMessage({ kind, current: null })).toBeTruthy();
    for (const kind of ["forbidden", "invalid", "error"] as const) expect(frameworkChangeMessage({ kind })).toBeTruthy();
  });
  it("the recorded reason names both frameworks and fits the server's 8-500 bound", () => {
    const r = frameworkChangeReason(null, "ipsas_accrual");
    expect(r).toMatch(/not selected/);
    expect(r).toMatch(/IPSAS/);
    expect(r.length).toBeGreaterThanOrEqual(8);
    expect(r.length).toBeLessThanOrEqual(500);
  });
});
