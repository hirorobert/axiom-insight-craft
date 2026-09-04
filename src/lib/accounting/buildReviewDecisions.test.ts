import { describe, expect, it } from "vitest";
import { buildReviewDecision } from "./buildReviewDecisions";

const META = (cls: string) =>
  cls === "current_liabilities"
    ? { statement: "balance_sheet", normal_balance: "credit" as const }
    : { statement: "balance_sheet", normal_balance: "debit" as const };

describe("buildReviewDecision", () => {
  it("A. manual classification with no machine suggestion", () => {
    const d = buildReviewDecision(
      { account_code: "6171", account_name: "Office Supplies" },
      false,
      "operating_expenses",
      META,
    );
    expect(d.proposal_type).toBe("NONE");
    expect(d.decision_action).toBe("USER_MANUAL_CLASSIFICATION");
    expect(d.classification).toBe("operating_expenses");
  });

  it("B. accepted machine suggestion — decision_action reflects acceptance, not manual entry", () => {
    const d = buildReviewDecision(
      { account_code: "6171", account_name: "Office Supplies", suggested_classification: "operating_expenses" },
      false,
      "operating_expenses",
      META,
    );
    expect(d.proposal_type).toBe("MACHINE_SUGGESTION");
    expect(d.decision_action).toBe("USER_ACCEPTED_SUGGESTION");
  });

  it("C. overridden machine suggestion is still a manual classification, but proposal_type records the suggestion existed", () => {
    const d = buildReviewDecision(
      { account_code: "6171", account_name: "Office Supplies", suggested_classification: "operating_expenses" },
      false,
      "cost_of_goods_sold",
      META,
    );
    expect(d.proposal_type).toBe("MACHINE_SUGGESTION");
    expect(d.decision_action).toBe("USER_MANUAL_CLASSIFICATION");
    expect(d.classification).toBe("cost_of_goods_sold");
  });

  it("D. excluded account becomes MARK_NON_REPORTING_ACCOUNT, not a silently-dropped row", () => {
    const d = buildReviewDecision(
      { account_code: "9999", account_name: "Suspense" },
      true,
      "operating_expenses", // ignored — exclusion wins
      META,
    );
    expect(d.decision_action).toBe("MARK_NON_REPORTING_ACCOUNT");
    expect(d.proposal_type).toBe("NONE");
    expect(d.classification).toBeUndefined();
    expect(d.statement).toBeUndefined();
    expect(d.reason).toBe("Excluded from import");
  });

  it("E. never emits AUTO_MAPPED_RULE — that value is reserved for a future, unactivated phase", () => {
    const outcomes = [
      buildReviewDecision({ account_code: "1", account_name: "A" }, false, "current_assets", META),
      buildReviewDecision({ account_code: "2", account_name: "B", suggested_classification: "current_liabilities" }, false, "current_liabilities", META),
      buildReviewDecision({ account_code: "3", account_name: "C" }, true, undefined, META),
    ];
    for (const d of outcomes) {
      expect(d.proposal_type).not.toBe("AUTO_MAPPED_RULE");
    }
  });

  it("F. code-less account carries account_code:null through to the payload, never a fabricated code", () => {
    const d = buildReviewDecision(
      { account_code: null, account_name: "Sundry Debtors" },
      false,
      "current_assets",
      META,
    );
    expect(d.account_code).toBeNull();
    expect(d.account_name).toBe("Sundry Debtors");
  });

  it("G. exclusion payload never carries classification fields, even if a stale choice exists in state", () => {
    const d = buildReviewDecision(
      { account_code: "5", account_name: "Old Suggestion" },
      true,
      "revenue",
      META,
    );
    expect(d.classification).toBeUndefined();
    expect(d.normal_balance).toBeUndefined();
    expect(d.is_cash_account).toBeUndefined();
  });

  // ── Ω∞ Phase 6 — DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001 repair ──────
  // buildReviewDecision must never manufacture false for is_cash_account /
  // is_retained_earnings / is_payroll_account. A flag the professional did
  // not review must be OMITTED from the payload (undefined key), never sent
  // as false — resolve_account_review_batch reads absence as "preserve the
  // current account_mappings value," not "clear it."

  it("H. no flagDecisions argument at all — all three flags omitted, not false", () => {
    const d = buildReviewDecision(
      { account_code: "1010", account_name: "CRDB Bank Account" },
      false,
      "current_assets",
      META,
    );
    expect(d.is_cash_account).toBeUndefined();
    expect(d.is_retained_earnings).toBeUndefined();
    expect(d.is_payroll_account).toBeUndefined();
    expect("is_cash_account" in d).toBe(false);
    expect("is_retained_earnings" in d).toBe(false);
    expect("is_payroll_account" in d).toBe(false);
  });

  it("I. empty flagDecisions object — still omitted, not defaulted to false", () => {
    const d = buildReviewDecision(
      { account_code: "1010", account_name: "CRDB Bank Account" },
      false,
      "current_assets",
      META,
      {},
    );
    expect("is_cash_account" in d).toBe(false);
    expect("is_retained_earnings" in d).toBe(false);
    expect("is_payroll_account" in d).toBe(false);
  });

  it("J. explicit professional true for one flag is sent verbatim; the other two remain omitted", () => {
    const d = buildReviewDecision(
      { account_code: "1010", account_name: "CRDB Bank Account" },
      false,
      "current_assets",
      META,
      { is_cash_account: true },
    );
    expect(d.is_cash_account).toBe(true);
    expect("is_retained_earnings" in d).toBe(false);
    expect("is_payroll_account" in d).toBe(false);
  });

  it("K. explicit professional false is sent verbatim — distinct from omission, still a real decision", () => {
    const d = buildReviewDecision(
      { account_code: "3200", account_name: "Share Capital" },
      false,
      "equity",
      META,
      { is_retained_earnings: false },
    );
    expect(d.is_retained_earnings).toBe(false);
    expect("is_retained_earnings" in d).toBe(true); // present, not omitted — a real "set false" decision
  });

  it("L. all three flags can be explicitly set together", () => {
    const d = buildReviewDecision(
      { account_code: "6010", account_name: "Salaries and Wages" },
      false,
      "operating_expenses",
      META,
      { is_cash_account: false, is_retained_earnings: false, is_payroll_account: true },
    );
    expect(d.is_cash_account).toBe(false);
    expect(d.is_retained_earnings).toBe(false);
    expect(d.is_payroll_account).toBe(true);
  });

  it("M. flag overrides never leak into an excluded (MARK_NON_REPORTING_ACCOUNT) decision", () => {
    const d = buildReviewDecision(
      { account_code: "9999", account_name: "Suspense" },
      true,
      "operating_expenses",
      META,
      { is_cash_account: true, is_payroll_account: true },
    );
    expect(d.decision_action).toBe("MARK_NON_REPORTING_ACCOUNT");
    expect("is_cash_account" in d).toBe(false);
    expect("is_retained_earnings" in d).toBe(false);
    expect("is_payroll_account" in d).toBe(false);
  });

  it("N. flag overrides compose independently of proposal_type/decision_action (accepted-suggestion path)", () => {
    const d = buildReviewDecision(
      { account_code: "6171", account_name: "Office Supplies", suggested_classification: "operating_expenses" },
      false,
      "operating_expenses",
      META,
      { is_payroll_account: false },
    );
    expect(d.decision_action).toBe("USER_ACCEPTED_SUGGESTION");
    expect(d.is_payroll_account).toBe(false);
    expect("is_cash_account" in d).toBe(false);
  });
});
