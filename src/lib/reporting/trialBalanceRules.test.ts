/** The sign-off precondition on the current trial-balance rules (20261118100000), as the sign-off page reads it. */
import { describe, expect, it, vi } from "vitest";
import { RULES_UNAVAILABLE, rulesBlockerOf, withTrialBalanceRules } from "./trialBalanceRules";
import { blockerText } from "./blockers";
import { signoffClient } from "./signoff";

describe("trial-balance rules on the sign-off readiness", () => {
  it("adds the server's blocker; none when the period is on the current rules; fails closed when the answer cannot be read", () => {
    const ready = { ready: true, blockers: [] as string[] };
    expect(withTrialBalanceRules(ready, { outcome: "ok", blocker: "TRIAL_BALANCE_RECHECK_REQUIRED:6" })).toEqual({ ready: false, blockers: ["TRIAL_BALANCE_RECHECK_REQUIRED:6"] });
    expect(withTrialBalanceRules(ready, { outcome: "ok", blocker: null })).toBe(ready);
    for (const bad of [null, undefined, { outcome: "not_found" }, "x"]) expect(rulesBlockerOf(bad)).toBe(RULES_UNAVAILABLE);
  });
  it("is said in words, never as a code alone, and says history is unchanged", () => {
    expect(blockerText("TRIAL_BALANCE_RECHECK_REQUIRED:6")).toMatch(/checked before the current checks\. Check it again on the Trial balance page/);
    expect(blockerText("TRIAL_BALANCE_RECHECK_REQUIRED:6")).toMatch(/already signed and packs already issued are unchanged/);
    expect(blockerText(RULES_UNAVAILABLE)).toMatch(/could not be read/);
  });
  it("the sign-off client asks both questions for the exact version and merges the answers", async () => {
    const rpc = vi.fn(async (fn: string) => ({ data: fn === "fs_report_readiness" ? { ready: true, blockers: [] } : { outcome: "ok", blocker: "TRIAL_BALANCE_RECHECK_REQUIRED:6" }, error: null }));
    const c = signoffClient({ rpc, select: vi.fn() } as never);
    const r = await c.readiness("c1", "r1", 3);
    expect(rpc).toHaveBeenCalledWith("tb_signoff_rules_blocker", { p_company_id: "c1", p_report_id: "r1", p_report_version: 3 });
    expect(r).toMatchObject({ ready: false, blockers: ["TRIAL_BALANCE_RECHECK_REQUIRED:6"] });
  });
});
