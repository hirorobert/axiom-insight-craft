/**
 * The classifications a reviewer can choose, and each one's statement and normal side — the one table Account review
 * and the account correction from a Close Review finding both use (moved from AccountReviewPanel, unchanged).
 * The statement / normal side is metadata the review decision records; the class-side arithmetic is by class, on the
 * server, and never reads it.
 */
export const CLASSIFICATIONS = [
  { value: "current_assets",          label: "Current Assets" },
  { value: "non_current_assets",      label: "Non-Current Assets" },
  { value: "current_liabilities",     label: "Current Liabilities" },
  { value: "non_current_liabilities", label: "Non-Current Liabilities" },
  { value: "equity",                  label: "Equity" },
  { value: "revenue",                 label: "Revenue" },
  { value: "cost_of_goods_sold",      label: "Cost of Goods Sold" },
  { value: "operating_expenses",      label: "Operating Expenses" },
  { value: "other_income",            label: "Other Income" },
  { value: "taxes",                   label: "Taxes" },
] as const;

export type ClassificationValue = (typeof CLASSIFICATIONS)[number]["value"];

export interface ClassMeta {
  statement: string;
  normal_balance: "debit" | "credit";
}

const META: Readonly<Record<ClassificationValue, ClassMeta>> = Object.freeze({
  current_assets:          { statement: "balance_sheet",    normal_balance: "debit"  },
  non_current_assets:      { statement: "balance_sheet",    normal_balance: "debit"  },
  current_liabilities:     { statement: "balance_sheet",    normal_balance: "credit" },
  non_current_liabilities: { statement: "balance_sheet",    normal_balance: "credit" },
  equity:                  { statement: "balance_sheet",    normal_balance: "credit" },
  revenue:                 { statement: "income_statement", normal_balance: "credit" },
  cost_of_goods_sold:      { statement: "income_statement", normal_balance: "debit"  },
  operating_expenses:      { statement: "income_statement", normal_balance: "debit"  },
  other_income:            { statement: "income_statement", normal_balance: "credit" },
  taxes:                   { statement: "income_statement", normal_balance: "debit"  },
});

export const isClassification = (v: unknown): v is ClassificationValue =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(META, v);

/** Unknown values keep Account review's long-standing fallback (the server refuses an unknown classification anyway). */
export function classificationMeta(cls: string): ClassMeta {
  return isClassification(cls) ? META[cls] : { statement: "income_statement", normal_balance: "debit" };
}
