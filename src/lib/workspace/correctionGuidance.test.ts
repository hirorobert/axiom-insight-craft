import { describe, expect, it } from "vitest";
import { CLASSIFICATIONS } from "@/lib/accounting/classificationMeta";
import type { FindingRow } from "@/lib/closeReview/findings";
import { AMOUNT_GUIDANCE, authoredReason, balanceSides, CLASS_GUIDANCE, correctionReasonDraft, findingGuidance, guidanceReasonComplete, REASON_AUTHORED_MIN } from "./correctionGuidance";

const finding = (o: Partial<FindingRow> = {}): FindingRow => ({
  id: "f1", run_id: "r1", rule_id: "A01", finding_key: "A01:1510", severity: "warning", kind: "risk_indicator", mandatory: false,
  required_resolution: "explanation", account_key: "1510", account_code: "1510", account_name: "Accumulated depreciation — plant",
  classification: "operating_expenses", debit_minor: "0", credit_minor: "2500000", class_side_minor: "-2500000", detail: {}, ...o,
});

describe("category guidance", () => {
  it("covers every selectable category and never tells the person to keep an amount as if it were verified", () => {
    expect(Object.keys(CLASS_GUIDANCE).sort()).toEqual(CLASSIFICATIONS.map((c) => c.value).sort());
    for (const words of Object.values(CLASS_GUIDANCE)) expect(words).not.toMatch(/keep the original/i);
    expect(AMOUNT_GUIDANCE).toMatch(/does not change the uploaded amount/);
    expect(AMOUNT_GUIDANCE).toMatch(/adjustment workflow/);
    expect(CLASS_GUIDANCE.non_current_assets).toMatch(/Accumulated depreciation is a credit against the related asset/);
    expect(CLASS_GUIDANCE.operating_expenses).toMatch(/this year's depreciation expense/);
    expect(CLASS_GUIDANCE.current_liabilities).toMatch(/name alone does not establish/);
  });
});

describe("finding guidance keeps facts, possibilities and judgement apart", () => {
  it("states the recorded facts of an A01 and never says the classification is wrong", () => {
    const g = findingGuidance(finding(), null);
    expect(g.found).toBe("The check used Operating Expenses, which expects a debit balance; the trial balance carries a credit balance on this account.");
    expect(JSON.stringify(g)).not.toMatch(/\bwrong\b/i);
    expect(g.decides).toMatch(/A name alone does not establish the treatment/);
    expect(g.explanationRemains).toBe(true);
  });
  it("after a correction to an asset category, says the warning is raised again and is closed by an explanation — not by repeating the correction", () => {
    const g = findingGuidance(finding({ classification: "non_current_assets" }), "non_current_assets");
    expect(g.legitimateIf).toMatch(/accumulated depreciation/);
    expect(g.correctionEffect).toMatch(/raised again after the check/);
    expect(g.correctionEffect).toMatch(/does not yet record contra-account treatment|records a confirmed treatment only for a current-asset closing-stock credit/);
    expect(g.correctionEffect).toMatch(/recording your explanation/);
  });
  it("while a saved classification has not been rechecked, says so instead of asking for a correction", () => {
    const g = findingGuidance(finding(), "non_current_assets");
    expect(g.correctionEffect).toMatch(/^The saved classification \(Non-Current Assets\) has not been used by a check yet/);
  });
  it("A10 names the structured evidence tier the check recorded, not a keyword guess of its own", () => {
    const g = findingGuidance(finding({ rule_id: "A10", finding_key: "A10:1510", detail: { evidenceTier: 4 } }), null);
    expect(g.found).toMatch(/keyword match \(evidence tier 4\)/);
    expect(findingGuidance(finding({ rule_id: "A10", detail: {} }), null).found).toMatch(/an automatic suggestion/);
  });
  it("A03 says what resolves a mandatory finding (adjustment or overdraft presentation), never an explanation", () => {
    const g = findingGuidance(finding({ rule_id: "A03", classification: "current_assets", severity: "blocking", mandatory: true, required_resolution: "review" }), null);
    expect(g.correctionEffect).toMatch(/approved adjustment/);
    expect(g.explanationRemains).toBe(false);
  });
  it("reads the balance side from the amounts, not from the name", () => {
    expect(balanceSides(finding())).toEqual({ expected: "debit", actual: "credit" });
    expect(balanceSides(finding({ debit_minor: null }))).toEqual({ expected: "debit", actual: null });
    expect(balanceSides(finding({ classification: "nonsense" }))).toEqual({ expected: null, actual: "credit" });
  });
});

describe("the reason writing aid", () => {
  it("writes only the selected categories and an instruction; the draft is never complete", () => {
    const draft = correctionReasonDraft("revenue", "cost_of_goods_sold");
    expect(draft).toBe("Changing from Revenue to Cost of Goods Sold because [describe what this account records and the evidence you checked]");
    expect(draft).not.toMatch(/was checked|verified|reviewed by|has been reviewed|confirmed/i);
    expect(guidanceReasonComplete(draft)).toBe(false);
  });
  it("a template with the instruction deleted and nothing of the person's own is still not a reason", () => {
    expect(guidanceReasonComplete("Changing from Revenue to Cost of goods sold because ")).toBe(false);
    expect(guidanceReasonComplete("Changing from Revenue to Cost of goods sold because ok.")).toBe(false);
    expect(authoredReason("Changing from Revenue to Cost of goods sold because ok.")).toBe("ok.");
    const own = "x".repeat(REASON_AUTHORED_MIN);
    expect(guidanceReasonComplete(`Changing from Revenue to Cost of goods sold because ${own}`)).toBe(true);
    expect(guidanceReasonComplete("This account records inventory costs recognised on sale; checked against the ledger.")).toBe(true);
  });
  it("does not pretend an unknown previous category is known", () => {
    expect(correctionReasonDraft("invalid", "non_current_assets")).toContain("the previous classification");
    expect(correctionReasonDraft(null, "non_current_assets")).toContain("the previous classification");
  });
});
