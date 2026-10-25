import { describe, expect, it, vi } from "vitest";
import { handleInternalBeta, remainingBetaMicros, INTERNAL_BETA_LIMITS } from "../../../supabase/functions/_shared/internalBeta";
import { composition } from "@/lib/statements/compositionFixture";

const body = { action: "explain_movement", companyId: "99999999-9999-4999-8999-999999999999", periodYear: 2026,
  lineId: "sfp.cash_and_cash_equivalents", requestId: "44444444-4444-4444-8444-444444444444" };

describe("bounded internal beta", () => {
  it("retains the owner's TOTAL USD 5 ceiling including prior USD 1.3414 exposure", () => {
    expect(INTERNAL_BETA_LIMITS.totalMicros).toBe(5_000_000);
    expect(remainingBetaMicros(0)).toBe(3_658_600);
    expect(remainingBetaMicros(3_658_600)).toBe(0);
    expect(remainingBetaMicros(3_658_601)).toBe(0);
    expect(remainingBetaMicros(NaN)).toBe(0);
  });
  it("uses the same handler but NEVER production approval/reservation RPCs", async () => {
    const rpc = vi.fn(async () => ({ data: { outcome: "refused", code: "FORBIDDEN" }, error: null }));
    const complete = vi.fn();
    const out = await handleInternalBeta("11111111-1111-4111-8111-111111111111", body, {
      provider: { id: "FAKE", complete }, readComposition: async () => composition, rpc, now: () => 0,
    });
    expect(out.body.code).toBe("FORBIDDEN");
    expect(rpc.mock.calls[0]?.[0]).toBe("internal_beta_assistant_reserve");
    expect(complete).not.toHaveBeenCalled();
  });
  it("budget refusal stops before any provider call", async () => {
    const complete = vi.fn();
    const out = await handleInternalBeta("11111111-1111-4111-8111-111111111111", body, {
      provider: { id: "FAKE", complete }, readComposition: async () => composition,
      rpc: async () => ({ data: { outcome: "refused", code: "AI_BUDGET_EXCEEDED" }, error: null }), now: () => 0,
    });
    expect(out.body.code).toBe("AI_BUDGET_EXCEEDED");
    expect(complete).not.toHaveBeenCalled();
  });
});