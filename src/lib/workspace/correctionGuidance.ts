import { isClassification, type ClassificationValue } from "@/lib/accounting/classificationMeta";
import { classificationWords } from "./reviewConfirmation";

/** Educational guidance only. Never classifies an account or changes a server decision. */
export const CLASS_GUIDANCE: Record<ClassificationValue, string> = {
  current_assets: "Resources expected to be realised or used in the operating cycle or near term. Check the underlying facts before choosing.",
  non_current_assets: "Longer-term resources, including equipment. Accumulated depreciation reduces the related asset; it is different from this year's depreciation expense. Keep the original debit and credit amounts.",
  current_liabilities: "Obligations classified as current under the applicable framework. A loan's name alone does not establish its maturity; check the agreement and reporting-date facts.",
  non_current_liabilities: "Obligations meeting the applicable framework's non-current criteria. Check the agreement and reporting-date rights; do not infer maturity from the account name.",
  equity: "Owners' interests, such as share capital and retained earnings. Check the nature of the transaction.",
  revenue: "Income from ordinary activities. Costs of goods sold belong in an expense category, even when the name contains sales.",
  cost_of_goods_sold: "Costs associated with the goods sold during the period. These are expenses, rather than sales revenue.",
  operating_expenses: "Costs of running the business, such as rent and this year's depreciation expense. Accumulated depreciation is a separate asset deduction.",
  other_income: "Income presented separately from ordinary revenue, according to the applicable framework and the entity's activities.",
  taxes: "Tax expense classification. A tax payable balance is a liability, rather than the period's tax expense.",
};

export function correctionReasonDraft(previous: string | null, next: ClassificationValue): string {
  const from = previous && isClassification(previous) ? classificationWords(previous) : "the previous classification";
  return `Changing from ${from} to ${classificationWords(next)} because [describe what this account records and the evidence you checked].`;
}

/** A draft is a writing aid, never evidence of a completed accounting review. */
export function guidanceReasonComplete(reason: string): boolean {
  return !/\[describe what this account records and the evidence you checked\]/i.test(reason);
}
