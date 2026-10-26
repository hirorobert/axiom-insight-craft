import { describe, expect, it } from "vitest";
import { CLASSIFICATIONS } from "@/lib/accounting/classificationMeta";
import { CLASS_GUIDANCE, correctionReasonDraft, guidanceReasonComplete } from "./correctionGuidance";

describe("correction guidance", () => {
  it("covers every selectable category without selecting one for the user", () => {
    expect(Object.keys(CLASS_GUIDANCE).sort()).toEqual(CLASSIFICATIONS.map(c => c.value).sort());
    expect(CLASS_GUIDANCE.non_current_assets).toContain("Keep the original debit and credit amounts");
    expect(CLASS_GUIDANCE.current_liabilities).toContain("name alone does not establish");
  });
  it("requires the writer to replace the instruction rather than saving a fabricated justification", () => {
    const draft = correctionReasonDraft("revenue", "cost_of_goods_sold");
    expect(draft).toContain("Revenue");
    expect(guidanceReasonComplete(draft)).toBe(false);
    expect(guidanceReasonComplete("This account records inventory costs recognised on sale; checked against the ledger.")).toBe(true);
  });
  it("does not pretend an unknown previous category is known", () => {
    expect(correctionReasonDraft("invalid", "non_current_assets")).toContain("the previous classification");
  });
});
