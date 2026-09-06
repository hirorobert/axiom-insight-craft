/**
 * _shared/maonoCashflowMath.ts — pure, testable cash-forecast bucketing math
 * extracted from maono-cashflow/index.ts (PPG-1 Finding 4 repair).
 *
 * Ω∞ Iron Dome: SIGN IS EVIDENCE ONLY — classification never comes from
 * debit/credit sign alone; it comes from the certified `subNature`
 * (account_classification) and the professional cash tri-state flag, exactly
 * as the caller already resolves via certifiedTbSource.ts. This module
 * receives already-classified inputs and performs only the AGGREGATION/
 * EXCLUSION arithmetic — it invents no new account-level classification
 * authority.
 *
 * REPOSITORY-EVIDENCE FINDING (PPG-1 forensic trace, not assumed): the
 * live `account_classification` enum
 * (supabase/migrations/20260122083339_...sql) has exactly two current-
 * balance buckets — `current_assets` and `current_liabilities` — with no
 * further split (no `inventory`, `prepayment`, `tax_receivable`,
 * `trade_payable`, or `tax_payable` value has ever existed; grepped the
 * full migration history for `ALTER TYPE public.account_classification`,
 * zero hits). `account_mappings` carries exactly three professional
 * tri-state flags (`is_cash_account`, `is_retained_earnings`,
 * `is_payroll_account`) — none distinguish inventory/prepayments/tax
 * accounts from trade receivables/payables. `account_mappings.line_item`
 * is free text, not a controlled vocabulary — using it as authority would
 * reintroduce exactly the account-name/code heuristic this file's own
 * header (maono-cashflow/index.ts) already documents removing as "not an
 * accounting authority."
 *
 * Given that, the confirmed defect this module repairs is split into what
 * IS and is NOT fixable without inventing a new classification authority
 * (forbidden — MAONO must not create a second accounting classification
 * authority) or guessing (forbidden — UNKNOWN != RECEIVABLE != PAYABLE):
 *
 *   FIXABLE with existing data (fixed here): a PAYE/VAT/SDL/WHT amount
 *   already known precisely via tax_computations was ALSO being swept
 *   into the generic current-liability bucket and spread across the
 *   generic 30/60/90-day payment curve — a genuine, provable double-count.
 *   excludeScheduledTaxFromCurrentLiabilities() removes it.
 *
 *   NOT FIXABLE without new authority (honestly disclosed, not silently
 *   guessed): distinguishing trade receivables from inventory/prepayments/
 *   tax receivables within `current_assets`, and trade payables from any
 *   OTHER (non-statutory-scheduled) tax-like liability within
 *   `current_liabilities`. RECEIVABLE_CLASSIFICATION_LIMITATION and
 *   PAYABLE_CLASSIFICATION_LIMITATION document this precisely in every
 *   response — the aggregate is never relabeled as "verified trade
 *   receivable" when it is not one.
 */

export interface ClassifiableRow {
  accountCode: string | null;
  accountName: string;
  /** The certified account_classification value (e.g. "current_assets"). */
  subNature: string;
  debitBalance: number;
  creditBalance: number;
}

export type CashState = "CASH" | "NOT_CASH" | "UNKNOWN";

// Exactly the two real enum values that exist in the live
// account_classification type today. No "trade_receivables"/"receivables"/
// "trade_payables"/"payables" aliases are included — those values have
// never existed in the persisted enum (verified against every migration
// that touches it) and including them here would falsely imply this system
// can already recognize a finer split than it can.
const CURRENT_ASSET_CLASS = "current_assets";
const CURRENT_LIABILITY_CLASS = "current_liabilities";

export interface BucketResult {
  cashBalance: number;
  /**
   * Every non-cash certified current-asset balance. NOT verified
   * specifically as "trade receivable" — see RECEIVABLE_CLASSIFICATION_
   * LIMITATION. Excludes cash (tri-state CASH) and excludes any row whose
   * cash/non-cash status is UNKNOWN (those are reported separately and
   * must fail the whole forecast closed, per the existing caller logic —
   * this function does not decide that; it only reports which accounts
   * were undecided).
   */
  nonCashCurrentAssetBalance: number;
  /**
   * Every certified current-liability balance, BEFORE excluding amounts
   * already scheduled via tax-specific statutory placement. Callers must
   * run this through excludeScheduledTaxFromCurrentLiabilities() before
   * using it as an outflow projection input.
   */
  currentLiabilityBalanceGross: number;
  /** account codes/names with no professional cash/non-cash decision. */
  undecidedCashAccounts: string[];
}

/**
 * Buckets certified current-asset/current-liability rows into cash,
 * non-cash-current-asset, and current-liability totals. Only `current_
 * assets`/`current_liabilities` rows participate — every other
 * subNature (non_current_assets, equity, revenue, expense categories,
 * etc.) is silently excluded by construction, satisfying "non-current
 * balances excluded" without a separate exclusion list to maintain.
 */
export function bucketCurrentBalances(
  rows: readonly ClassifiableRow[],
  resolveCashState: (key: string) => CashState,
  rowKey: (row: ClassifiableRow) => string,
): BucketResult {
  let cashBalance = 0;
  let nonCashCurrentAssetBalance = 0;
  let currentLiabilityBalanceGross = 0;
  const undecidedCashAccounts: string[] = [];

  for (const row of rows) {
    const net = row.debitBalance - row.creditBalance;

    if (row.subNature === CURRENT_ASSET_CLASS) {
      const key = rowKey(row);
      const cashState = resolveCashState(key);
      if (cashState === "UNKNOWN") {
        undecidedCashAccounts.push(row.accountCode ?? row.accountName);
        continue;
      }
      if (cashState === "CASH") cashBalance += net;
      else nonCashCurrentAssetBalance += Math.abs(net);
    } else if (row.subNature === CURRENT_LIABILITY_CLASS) {
      currentLiabilityBalanceGross += Math.abs(row.creditBalance - row.debitBalance);
    }
    // Every other subNature (non_current_assets, non_current_liabilities,
    // equity, revenue, cost_of_goods_sold, operating_expenses,
    // other_income, taxes (P&L), operating/investing/financing_activities)
    // is intentionally excluded — it is neither a current asset nor a
    // current liability and has no place in this forecast's opening/AR/AP
    // balances.
  }

  return { cashBalance, nonCashCurrentAssetBalance, currentLiabilityBalanceGross, undecidedCashAccounts };
}

export interface ScheduledTaxAmounts {
  paye: number | null;
  sdl: number | null;
  vat: number | null;
  wht: number | null;
}

/**
 * PPG-1 Finding 4 (confirmed defect, now fixed): the generic current-
 * liability sweep and the statutory-due-date tax schedule are
 * independently derived — the former from certified TB balances, the
 * latter from tax_computations — and nothing previously prevented a
 * PAYE/VAT/SDL/WHT amount from being represented in BOTH the generic
 * 30/60/90-day AP curve AND its own precise statutory due date. This
 * function removes the KNOWN scheduled tax total from the generic bucket
 * before it is spread across the generic curve, so each tax obligation is
 * represented EXACTLY ONCE. Floors at zero — the exclusion can never make
 * the generic liability balance negative. `null` (unavailable) amounts
 * contribute 0 to the exclusion — the same "unknown is omitted, never
 * asserted zero" rule already used for the statutory placement itself;
 * an unavailable tax amount cannot be excluded from something it was
 * never proven to be part of, but it is also never asserted to be $0 as a
 * liability (see statutory_this_month in the caller, which preserves null).
 */
export function excludeScheduledTaxFromCurrentLiabilities(
  currentLiabilityBalanceGross: number,
  scheduledTax: ScheduledTaxAmounts,
): { apBalanceExTax: number; scheduledTaxTotal: number } {
  const scheduledTaxTotal =
    (scheduledTax.paye ?? 0) + (scheduledTax.sdl ?? 0) + (scheduledTax.vat ?? 0) + (scheduledTax.wht ?? 0);
  const apBalanceExTax = Math.max(0, currentLiabilityBalanceGross - scheduledTaxTotal);
  return { apBalanceExTax, scheduledTaxTotal };
}

export const RECEIVABLE_CLASSIFICATION_LIMITATION =
  "This forecast's non-cash current-asset figure includes trade receivables, " +
  "inventory, prepayments, and tax receivables together — the certified " +
  "account classification authority in this system does not yet distinguish " +
  "them (account_classification has no sub-split below current_assets, and " +
  "no professional tri-state flag exists for inventory/prepayment/tax-" +
  "receivable identity). Treat this figure as an approximation of eventual " +
  "cash conversion, not a verified trade-receivables collection schedule.";

export const PAYABLE_CLASSIFICATION_LIMITATION =
  "This forecast's current-liability figure includes trade payables and any " +
  "other current liability not already identified as a scheduled statutory " +
  "tax obligation. PAYE/VAT/SDL/WHT amounts scheduled via their own " +
  "statutory due dates are excluded from this generic figure to avoid " +
  "double-counting (see scheduled_tax_excluded_from_generic_ap). Any other " +
  "tax-like liability not covered by that statutory schedule cannot yet be " +
  "distinguished from a trade payable — the certified classification " +
  "authority has no sub-split below current_liabilities.";
