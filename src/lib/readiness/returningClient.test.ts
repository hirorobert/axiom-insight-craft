import { describe, expect, it } from "vitest";
import { evaluateReadiness } from "../../../supabase/functions/_shared/readiness/engine";
import type { ReadinessInput } from "../../../supabase/functions/_shared/readiness/types";
import { presentIssues } from "./present";

// A returning client: last year's approved pack carries an audit accrual of 100.00 that the source ledger never posted.
// Minor units, debit positive. Payable 2000 is a credit; opening equity 3100 a credit.
const base = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  period: { start: "2026-01-01", end: "2026-12-31", currency: "TZS", exponent: 2 },
  tb: { validated: true, accounts: { "2000": { closing: "-310000" }, "3100": { closing: "-1100000" }, "1000": { closing: "1410000" } } },
  ledger: { snapshot: "qbo-1", accounts: { "2000": "-310000", "3100": "-1100000", "1000": "1410000" }, entries: [] },
  scope_facts: { opening_lines: ["payables"] },
  evidence: { "EV-AA": { kind: "audit_adjustment_schedule", extraction: "human_confirmed", facts: { amount: "10000", account: "2000", date: "2025-12-31" } } },
  opening_bridge: {
    basis: "prior pack", lines: [{ line: "payables", approved: "-320000", accounts: ["2000"], level: "account", classification: { kind: "unposted_audit_adjustment", evidence: ["EV-AA"] } }],
    proposals: [{ id: "corr:opening:payables", line: "payables", lines: [{ account: "3100", amount: "10000" }, { account: "2000", amount: "-10000" }] }],
  },
  ...over,
});

describe("a returning client's unposted prior-year adjustment", () => {
  it("is ONE confirmed finding that holds the opening scope and offers exactly one correction; independent scopes are unaffected", () => {
    const r = evaluateReadiness(base());
    const bad = r.findings.filter((f) => f.outcome !== "pass");
    expect(bad.map((f) => f.rule)).toEqual(["OPENING_ADJUSTMENT_UNPOSTED"]);
    expect(bad[0]).toMatchObject({ outcome: "confirmed", scope: "opening:payables", resolves: "corr:opening:payables", detail: { difference: "10000" } });
    expect(r.scopes["opening:payables"]).toBe("HELD");
    expect(r.scopes.ledger).toBe("READY");
    expect(r.proposals).toEqual([{ id: "corr:opening:payables", lines: [{ account: "3100", amount: "10000" }, { account: "2000", amount: "-10000" }] }]);
    expect(r.finalization.held).toBe(true);
    expect(r.finalization.reasons).toContain("SCOPE_HELD:opening:payables");
    const issues = presentIssues(r, { currency: "TZS", exponent: 2 });
    expect(issues).toHaveLength(1);
    expect(issues[0].nextAction.kind).toBe("review_correction");
    expect(issues[0].headline).toMatch(/100\.00/);
    // The page can only offer "Propose for review" when the issue carries the correction (found by the browser journey).
    expect(issues[0].correction?.id).toBe("corr:opening:payables");
    expect(issues[0].correction?.lines).toEqual([{ account: "3100", amount: "10000" }, { account: "2000", amount: "-10000" }]);
  });

  it("is resolved only when its correction is effective, and then exactly once", () => {
    const applied = evaluateReadiness(base({ reporting_adjustments: [{ id: "adj-1", correction_id: "corr:opening:payables", approved: true, scope: "opening:payables", lines: [{ account: "3100", amount: "10000" }, { account: "2000", amount: "-10000" }] }] }));
    expect(applied.scopes["opening:payables"]).toBe("READY");
    expect(applied.finalization.held).toBe(false);
    expect(applied.balances).toMatchObject({ "2000": "-320000", "3100": "-1090000" });
    // The same correction delivered twice is one correction (identity, not count).
    const twice = evaluateReadiness(base({ reporting_adjustments: [1, 2].map((n) => ({ id: `adj-${n}`, correction_id: "corr:opening:payables", approved: true, scope: "opening:payables", lines: [{ account: "3100", amount: "10000" }, { account: "2000", amount: "-10000" }] })) }));
    expect(twice.balances["2000"]).toBe("-320000");
  });

  it("an adjustment with no correction to apply still holds (nothing to approve, so nothing to wait for)", () => {
    const r = evaluateReadiness(base({ opening_bridge: { ...base().opening_bridge!, proposals: [] } }));
    expect(r.scopes["opening:payables"]).toBe("HELD");
    expect(r.proposals).toEqual([]);
  });

  it("the same journal booked later as current-year expense: linked + residual = one correction; unlinked stays a candidate for review", () => {
    const corr = { id: "corr:opening:payables", scope: "opening:payables", effect: [{ account: "3100", amount: "10000" }, { account: "2000", amount: "-10000" }], anchor: ["corr:opening:payables"], adjustment_approved: true };
    const posting = (links: string[]) => ({ id: "JE-1", lines: [{ account: "6100", amount: "10000" }, { account: "2000", amount: "-10000" }], links });
    const unlinked = evaluateReadiness(base({ correction_verification: [{ ...corr, snapshot: { id: "qbo-2", postings: [posting([])] } }] }));
    expect(unlinked.corrections[0].state).toBe("candidate_needs_confirmation");
    expect(unlinked.scopes["opening:payables"]).toBe("HELD");
    const linked = evaluateReadiness(base({ correction_verification: [{ ...corr, snapshot: { id: "qbo-2", postings: [posting(["corr:opening:payables"])] } }] }));
    expect(linked.corrections[0]).toMatchObject({ state: "partial_or_different", residual: { "3100": "10000", "6100": "-10000" } });
    const completed = evaluateReadiness(base({ correction_verification: [{ ...corr, completed_by: [{ account: "3100", amount: "10000" }, { account: "6100", amount: "-10000" }], snapshot: { id: "qbo-2", postings: [posting(["corr:opening:payables"])] } }] }));
    expect(completed.corrections[0].state).toBe("completed_by_residual");
  });

  it("a payables-scope refund banked to cash that repeats an amount is not a candidate (the exact-effect rule stands outside opening scopes)", () => {
    const r = evaluateReadiness(base({
      correction_verification: [{ id: "c1", scope: "payables", effect: [{ account: "2000", amount: "-10000" }, { account: "6100", amount: "10000" }], anchor: ["c1"], adjustment_approved: true,
        snapshot: { id: "s", postings: [{ id: "R1", lines: [{ account: "1000", amount: "10000" }, { account: "6100", amount: "-10000" }], links: [] }] } }],
    }));
    expect(r.corrections[0].state).toBe("not_corrected_in_source");
  });
});
