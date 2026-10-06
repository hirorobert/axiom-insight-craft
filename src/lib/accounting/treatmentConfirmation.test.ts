/**
 * Treatment confirmation in the review flow (H1b, 20261007100000). "Keep as mapped" is offered only on rows the engine
 * flagged with a treatment request, needs a recorded reason, and becomes CONFIRM_ACCOUNT_TREATMENT; reclassification stays
 * the ordinary review decision. A non-zero balance can never be excluded from the trial balance in the panel.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildBatchDecisions,
  buildTreatmentConfirmation,
  isTreatmentReasonValid,
  KEEP_AS_MAPPED_CHOICE,
} from "./buildReviewDecisions";
import { AccountReviewPanel } from "@/components/AccountReviewPanel";

// The panel never reaches the network in a static render; the client is replaced as in the other rendered-panel tests.
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), functions: { invoke: vi.fn() } } }));

const REQ = "a".repeat(64);
const meta = (cls: string) => ({ statement: ["revenue", "other_income", "cost_of_goods_sold", "operating_expenses", "taxes"].includes(cls) ? "income_statement" : "balance_sheet", normal_balance: "debit" as const });
const stock = { account_code: "1200", account_name: "Closing stock", treatment_request_id: REQ };
const bank = { account_code: "1000", account_name: "Bank" };

describe("buildTreatmentConfirmation", () => {
  it("builds CONFIRM_ACCOUNT_TREATMENT keep_as_mapped with the request id and the trimmed reason; never a classification", () => {
    expect(buildTreatmentConfirmation(stock, REQ, "  Stock count shows a pending credit  ")).toEqual({
      account_code: "1200", account_name: "Closing stock", proposal_type: "NONE", decision_action: "CONFIRM_ACCOUNT_TREATMENT",
      treatment_request_id: REQ, treatment: "keep_as_mapped", reason: "Stock count shows a pending credit",
    });
  });
  it("refuses a malformed request id or a missing/short/over-long reason", () => {
    expect(() => buildTreatmentConfirmation(stock, "abc", "valid reason")).toThrow();
    for (const r of ["", "  ", "ok", "x".repeat(501)]) expect(() => buildTreatmentConfirmation(stock, REQ, r), JSON.stringify(r)).toThrow();
    expect(isTreatmentReasonValid("abc")).toBe(true);
    expect(isTreatmentReasonValid("x".repeat(500))).toBe(true);
  });
});

describe("buildBatchDecisions", () => {
  const rows = [{ key: "1200", account: stock }, { key: "1000", account: bank }];
  it("a flagged row kept as mapped becomes the treatment confirmation; other rows stay ordinary decisions", () => {
    const d = buildBatchDecisions(rows, new Set(), { 1200: KEEP_AS_MAPPED_CHOICE, 1000: "current_assets" }, { 1200: "Explained by the stock count" }, {}, meta);
    expect(d[0].decision_action).toBe("CONFIRM_ACCOUNT_TREATMENT");
    expect(d[0].treatment_request_id).toBe(REQ);
    expect(d[1].decision_action).toBe("USER_MANUAL_CLASSIFICATION");
    expect(d[1].classification).toBe("current_assets");
  });
  it("reclassifying a flagged row is the ordinary review decision (no treatment)", () => {
    const d = buildBatchDecisions(rows, new Set(), { 1200: "cost_of_goods_sold", 1000: "current_assets" }, {}, {}, meta);
    expect(d[0]).toMatchObject({ decision_action: "USER_MANUAL_CLASSIFICATION", classification: "cost_of_goods_sold" });
    expect(d[0]).not.toHaveProperty("treatment_request_id");
  });
  it("keep-as-mapped without a recorded valid reason, or on an unflagged row, is refused (never submitted)", () => {
    expect(() => buildBatchDecisions(rows, new Set(), { 1200: KEEP_AS_MAPPED_CHOICE, 1000: "current_assets" }, {}, {}, meta)).toThrow();
    expect(() => buildBatchDecisions([{ key: "1000", account: bank }], new Set(), { 1000: KEEP_AS_MAPPED_CHOICE }, { 1000: "a reason" }, {}, meta)).toThrow(/only available/);
  });
});

describe("AccountReviewPanel — treatment rows and non-zero exclusion", () => {
  const render = (accounts: object[]) => renderToStaticMarkup(createElement(AccountReviewPanel, {
    uploadId: "u", companyId: "c", userId: "x", needsReviewAccounts: accounts as never, onReprocessed: () => {},
  } as never));
  const row = (over: object) => ({ account_code: "1200", account_name: "Closing stock", debit: 0, credit: 5000, balance: -5000, reason: "Treatment needed", ...over });

  it("only a row carrying a treatment request is marked as a treatment row (the keep-as-mapped option is offered there only)", () => {
    const flagged = render([row({ treatment_request_id: REQ })]);
    const plain = render([row({})]);
    expect(flagged).toContain('data-treatment-row="true"');
    expect(flagged).toContain("Keep as mapped or reclassify");
    expect(plain).not.toContain("data-treatment-row");
    expect(plain).not.toContain("Keep as mapped");
  });
  it("a non-zero balance cannot be excluded (control disabled, reason shown); a zero balance can", () => {
    const nonZero = render([row({})]);
    expect(nonZero).toContain('data-testid="exclude-refused-nonzero"');
    expect(nonZero).toMatch(/data-testid="exclude-from-import"[^>]*disabled|disabled[^>]*data-testid="exclude-from-import"/);
    const zero = render([row({ debit: 100, credit: 100, balance: 0 })]);
    expect(zero).not.toContain('data-testid="exclude-refused-nonzero"');
  });
});
