/**
 * illustrativeReview — the invented trial balance behind the landing page's sample review. Data only: no imports, no logic.
 *
 * Everything here is invented (company, accounts, figures, evidence, reviewer). The decision logic that reads it lives in
 * src/components/landing/illustrativeReviewModel.ts; the words around it live in LANDING_SAMPLE_COPY (landingContent.ts).
 *
 * Two kinds of decision are kept apart on purpose:
 *   - SAMPLE_SUPPLIED_DECISIONS are the decisions that came with the example (shown read-only in the completed example);
 *   - a visitor's own decisions exist only in the page's memory and are never written here or merged with these.
 * `evidenceSupports` is what the INVENTED evidence points to, for this guided example only. CFOClose records decisions; it
 * does not check them against evidence, and the page says so.
 */

export const SAMPLE_COMPANY = { name: "Kilele Supplies Ltd", period: "FY2026", currency: "USD", accountCount: 16 } as const;

/** The statement categories offered in the example, grouped for the statement equation. */
export const SAMPLE_CATEGORY_GROUP = {
  "Current Assets": "assets",
  "Non-Current Assets": "assets",
  "Current Liabilities": "liabilities",
  "Non-Current Liabilities": "liabilities",
  Equity: "equity",
  Revenue: "result",
  "Other Income": "result",
  "Cost of Sales": "result",
  "Operating Expenses": "result",
} as const;

export type SampleCategory = keyof typeof SAMPLE_CATEGORY_GROUP;

/** Balances in minor units (cents). Debit positive, credit negative. Totals: 12,715,000 each side. */
export const SAMPLE_MAPPED_ACCOUNTS: readonly { readonly code: string; readonly name: string; readonly balanceMinor: number; readonly category: SampleCategory }[] = [
  { code: "1000", name: "Cash at bank", balanceMinor: 1840000, category: "Current Assets" },
  { code: "1100", name: "Trade receivables", balanceMinor: 960000, category: "Current Assets" },
  { code: "1200", name: "Inventory", balanceMinor: 725000, category: "Current Assets" },
  { code: "1500", name: "Equipment at cost", balanceMinor: 2400000, category: "Non-Current Assets" },
  { code: "1510", name: "Accumulated depreciation – equipment", balanceMinor: -960000, category: "Non-Current Assets" },
  { code: "2000", name: "Trade payables", balanceMinor: -815000, category: "Current Liabilities" },
  { code: "2200", name: "Accrued expenses", balanceMinor: -190000, category: "Current Liabilities" },
  { code: "3000", name: "Share capital", balanceMinor: -1000000, category: "Equity" },
  { code: "3100", name: "Retained earnings", balanceMinor: -1450000, category: "Equity" },
  { code: "4000", name: "Revenue", balanceMinor: -7900000, category: "Revenue" },
  { code: "5000", name: "Cost of sales", balanceMinor: 4130000, category: "Cost of Sales" },
  { code: "6100", name: "Salaries and wages", balanceMinor: 1580000, category: "Operating Expenses" },
  { code: "6200", name: "Rent", balanceMinor: 600000, category: "Operating Expenses" },
  { code: "6300", name: "Depreciation expense", balanceMinor: 480000, category: "Operating Expenses" },
];

export interface SampleHeldAccount {
  readonly code: string;
  readonly name: string;
  readonly balanceMinor: number;
  /** Why the account is held, in one or two short sentences. */
  readonly why: string;
  readonly evidence: string;
  readonly options: readonly { readonly category: SampleCategory; readonly hint: string }[];
  /** What the invented evidence points to, for this guided example only. */
  readonly evidenceSupports: SampleCategory;
}

export const SAMPLE_HELD_ACCOUNTS: readonly SampleHeldAccount[] = [
  {
    code: "2100",
    name: "Director current account",
    balanceMinor: -300000,
    why: "The credit balance suggests the company owes the director. The supporting terms help determine its classification.",
    evidence: "Loan note: 3,000.00 lent by the director, interest-free, repayable on demand.",
    options: [
      { category: "Current Liabilities", hint: "Repayable on demand" },
      { category: "Non-Current Liabilities", hint: "Due after more than a year" },
      { category: "Equity", hint: "An owner's investment, not a loan" },
    ],
    evidenceSupports: "Current Liabilities",
  },
  {
    code: "4800",
    name: "Sundry balances",
    balanceMinor: -100000,
    why: "The name does not say what the balance is.",
    evidence: "Ledger detail: three customer overpayments (400.00, 350.00, 250.00), not yet refunded.",
    options: [
      { category: "Current Liabilities", hint: "Owed back to customers" },
      { category: "Other Income", hint: "Income outside normal sales" },
      { category: "Revenue", hint: "Income from sales" },
    ],
    evidenceSupports: "Current Liabilities",
  },
];

/** The decisions that came with the example. Read-only: shown in the completed example, never written by the page. */
export const SAMPLE_SUPPLIED_DECISIONS: readonly { readonly code: string; readonly category: SampleCategory; readonly recordedBy: string; readonly recordedAt: string; readonly basis: string }[] = [
  { code: "2100", category: "Current Liabilities", recordedBy: "Example reviewer (invented)", recordedAt: "14 Oct 2026, 10:42", basis: "Loan note: repayable on demand" },
  { code: "4800", category: "Current Liabilities", recordedBy: "Example reviewer (invented)", recordedAt: "14 Oct 2026, 10:47", basis: "Customer overpayments not yet refunded" },
];
