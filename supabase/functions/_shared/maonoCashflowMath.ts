/**
 * _shared/maonoCashflowMath.ts — pure, testable cash-forecast bucketing math
 * extracted from maono-cashflow/index.ts (PPG-1 Finding 4 / PPG-1R HIGH-2
 * repair).
 *
 * Ω∞ Iron Dome: SIGN IS EVIDENCE ONLY — classification never comes from
 * debit/credit sign alone, account name, or Tanzania-specific labels. It
 * comes ONLY from the certified `subNature` (account_classification) and
 * the professional cash tri-state flag, exactly as the caller already
 * resolves via certifiedTbSource.ts. This module receives already-
 * classified inputs and performs only AGGREGATION/EXCLUSION arithmetic —
 * it invents no new account-level classification authority.
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
 * ── PPG-1R HIGH-2 (Codex REJECT of PPG-1's CLASS_LEVEL_APPROXIMATION) ──────
 * PPG-1 fixed the one part of this defect fixable with EXISTING data (the
 * PAYE/VAT/SDL/WHT double-count — excludeScheduledTaxFromCurrentLiabilities,
 * unchanged and still in force below) but otherwise still mapped every
 * non-cash current_assets balance into "AR" and every current_liabilities
 * balance into "AP", merely disclosing the approximation in prose
 * (RECEIVABLE_CLASSIFICATION_LIMITATION / PAYABLE_CLASSIFICATION_
 * LIMITATION). Codex correctly rejected that: a disclosure string does not
 * make arithmetic that treats UNKNOWN evidence as TRADE_RECEIVABLE/
 * TRADE_PAYABLE safe.
 *
 * This module now classifies every current-balance row through an
 * explicit, narrow CashBehavior seam (see below) and the caller (maono-
 * cashflow/index.ts) uses ONLY rows classified as TRADE_RECEIVABLE/
 * TRADE_PAYABLE to populate a forecast figure. Because — per the
 * repository-evidence finding above — NO row can be classified as
 * anything but UNKNOWN today (besides CASH), the honest, non-guessing
 * result is: AR/AP forecasting is CANNOT_ASSESS for any company that has
 * one or more non-cash current-asset / current-liability rows (assessNon
 * CashCurrentAssetForecast / assessCurrentLiabilityForecast below) — a
 * company with literally ZERO such rows gets a genuine KNOWN zero (an
 * empty set is a definite fact, not an evidentiary gap). This seam exists
 * so that WHEN a future professional classification authority (a new
 * tri-state flag mirroring is_payroll_account's precedent, or a genuine
 * account_classification enum extension) supplies real per-row evidence,
 * classifyCashBehavior is the ONE place that changes — the aggregation,
 * exclusion, and assessability logic around it does not need another
 * redesign.
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

/**
 * PPG-1R §4 — the narrow semantic seam future authoritative account
 * cash-behavior classification plugs into. Only ever populated from
 * evidence that CURRENTLY exists authoritatively — never a machine guess
 * persisted as professional truth, never inferred from account name,
 * sign, or a generic current_assets/current_liabilities bucket alone.
 */
export type CashBehavior =
  | "TRADE_RECEIVABLE"
  | "TRADE_PAYABLE"
  | "STATUTORY_RECEIVABLE"
  | "STATUTORY_PAYABLE"
  | "NON_CASH_CURRENT_ASSET"
  | "NON_TRADE_CURRENT_LIABILITY"
  | "CASH"
  | "UNKNOWN";

/**
 * Classifies one certified current-balance row's cash behavior using ONLY
 * evidence that exists today: the certified subNature and the professional
 * cash tri-state flag. Every branch below is a direct consequence of the
 * repository-evidence finding in this file's header — there is currently
 * no authoritative way to populate TRADE_RECEIVABLE, STATUTORY_RECEIVABLE,
 * NON_CASH_CURRENT_ASSET, TRADE_PAYABLE, STATUTORY_PAYABLE, or
 * NON_TRADE_CURRENT_LIABILITY at the individual-row level, so every
 * non-cash row fails closed to UNKNOWN. This function is the SOLE place
 * that changes when real classification evidence becomes available.
 */
export function classifyCashBehavior(row: ClassifiableRow, cashState: CashState): CashBehavior {
  if (row.subNature === CURRENT_ASSET_CLASS) {
    if (cashState === "CASH") return "CASH";
    // NOT_CASH or UNKNOWN cash-state: no authority exists today to tell a
    // trade receivable apart from inventory, a prepayment, or a tax
    // receivable. Fails closed rather than assuming TRADE_RECEIVABLE.
    return "UNKNOWN";
  }
  if (row.subNature === CURRENT_LIABILITY_CLASS) {
    // No authority exists today to tell a trade payable apart from a
    // statutory/tax-like liability or another non-trade current liability
    // at the row level (the statutory TOTAL is separately known via
    // tax_computations, but never attributable to a specific TB row).
    // Fails closed rather than assuming TRADE_PAYABLE.
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

export interface BucketResult {
  cashBalance: number;
  /** Sum of rows classified TRADE_RECEIVABLE. Always 0 today — see classifyCashBehavior. */
  tradeReceivableBalance: number;
  /** Count of non-cash current_assets rows whose CashBehavior resolved to UNKNOWN. */
  unknownCurrentAssetCount: number;
  /** Sum of unknown-classification non-cash current-asset balances — diagnostic only, NEVER used as a forecast input (that would be exactly the rejected guess). */
  unknownCurrentAssetBalance: number;
  /** Sum of rows classified TRADE_PAYABLE. Always 0 today — see classifyCashBehavior. */
  tradePayableBalance: number;
  /** Count of current_liabilities rows whose CashBehavior resolved to UNKNOWN. */
  unknownCurrentLiabilityCount: number;
  /** Sum of unknown-classification current-liability balances — diagnostic only, NEVER used as a forecast input. */
  unknownCurrentLiabilityBalance: number;
  /** account codes/names with no professional cash/non-cash decision at all (a stronger UNKNOWN than "classified UNKNOWN" — the whole forecast must fail closed on this, unchanged from PPG-1). */
  undecidedCashAccounts: string[];
}

/**
 * Buckets certified current-asset/current-liability rows by CashBehavior.
 * Only `current_assets`/`current_liabilities` rows participate — every
 * other subNature (non_current_assets, equity, revenue, expense
 * categories, etc.) is silently excluded by construction, satisfying
 * "non-current balances excluded" without a separate exclusion list.
 */
export function bucketCurrentBalances(
  rows: readonly ClassifiableRow[],
  resolveCashState: (key: string) => CashState,
  rowKey: (row: ClassifiableRow) => string,
): BucketResult {
  let cashBalance = 0;
  let tradeReceivableBalance = 0;
  let unknownCurrentAssetCount = 0;
  let unknownCurrentAssetBalance = 0;
  let tradePayableBalance = 0;
  let unknownCurrentLiabilityCount = 0;
  let unknownCurrentLiabilityBalance = 0;
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
      const behavior = classifyCashBehavior(row, cashState);
      if (behavior === "CASH") {
        cashBalance += net;
      } else if (behavior === "TRADE_RECEIVABLE") {
        tradeReceivableBalance += Math.abs(net);
      } else {
        // UNKNOWN / NON_CASH_CURRENT_ASSET / STATUTORY_RECEIVABLE — none
        // of these are currently reachable besides UNKNOWN, but all are
        // handled identically here: never swept into a forecast figure.
        unknownCurrentAssetCount += 1;
        unknownCurrentAssetBalance += Math.abs(net);
      }
    } else if (row.subNature === CURRENT_LIABILITY_CLASS) {
      const behavior = classifyCashBehavior(row, "NOT_CASH");
      const magnitude = Math.abs(row.creditBalance - row.debitBalance);
      if (behavior === "TRADE_PAYABLE") {
        tradePayableBalance += magnitude;
      } else {
        unknownCurrentLiabilityCount += 1;
        unknownCurrentLiabilityBalance += magnitude;
      }
    }
    // Every other subNature (non_current_assets, non_current_liabilities,
    // equity, revenue, cost_of_goods_sold, operating_expenses,
    // other_income, taxes (P&L), operating/investing/financing_activities)
    // is intentionally excluded — it is neither a current asset nor a
    // current liability and has no place in this forecast's opening/AR/AP
    // balances.
  }

  return {
    cashBalance,
    tradeReceivableBalance,
    unknownCurrentAssetCount,
    unknownCurrentAssetBalance,
    tradePayableBalance,
    unknownCurrentLiabilityCount,
    unknownCurrentLiabilityBalance,
    undecidedCashAccounts,
  };
}

export type ArApAssessmentState = "KNOWN" | "CANNOT_ASSESS";

export interface ArApAssessment {
  /**
   * KNOWN only when every non-cash current-asset row was classified with
   * positive evidence (today: only possible when there are ZERO such
   * rows — an empty set is a definite fact, not an evidentiary gap).
   * CANNOT_ASSESS whenever one or more rows exist but could not be
   * classified as TRADE_RECEIVABLE.
   */
  arState: ArApAssessmentState;
  /** Meaningful only when arState === "KNOWN". Always 0 today (see arState doc). */
  arKnownAmount: number;
  apState: ArApAssessmentState;
  /** Meaningful only when apState === "KNOWN". Always 0 today (see arState doc), and already tax-exclusion-safe by construction (tradePayableBalance never includes a statutory-scheduled amount, since no row is ever classified TRADE_PAYABLE today). */
  apKnownAmount: number;
}

/**
 * PPG-1R §3 fail-closed forecast contract: "if current authoritative data
 * cannot distinguish trade receivable from inventory/prepayment/tax
 * receivable, then generic current_assets MUST NOT contribute to
 * expected_ar_inflows" (and the current_liabilities/AP mirror). This
 * function is the single decision point the caller uses to decide whether
 * an assessable number exists at all — it never itself fabricates a
 * number for the CANNOT_ASSESS case.
 */
export function assessArAp(bucketed: BucketResult): ArApAssessment {
  const arState: ArApAssessmentState = bucketed.unknownCurrentAssetCount === 0 ? "KNOWN" : "CANNOT_ASSESS";
  const apState: ArApAssessmentState = bucketed.unknownCurrentLiabilityCount === 0 ? "KNOWN" : "CANNOT_ASSESS";
  return {
    arState,
    arKnownAmount: arState === "KNOWN" ? bucketed.tradeReceivableBalance : 0,
    apState,
    apKnownAmount: apState === "KNOWN" ? bucketed.tradePayableBalance : 0,
  };
}

export interface ScheduledTaxAmounts {
  paye: number | null;
  sdl: number | null;
  vat: number | null;
  wht: number | null;
}

/**
 * PPG-1 Finding 4 / PPG-1R §5 (double-count fix, preserved unchanged): a
 * PAYE/VAT/SDL/WHT amount known precisely via tax_computations must never
 * ALSO be represented via a generic current-liability sweep. This function
 * still exists and is still exercised (see tests) so the protection is
 * regression-guarded even though, today, `assessArAp` already ensures the
 * generic current-liability figure never reaches a forecast at all (no row
 * is ever classified TRADE_PAYABLE) — once a future classification
 * authority DOES populate TRADE_PAYABLE rows, this exclusion becomes load-
 * bearing again immediately, with no further change required here.
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
  "This system cannot yet distinguish trade receivables from inventory, " +
  "prepayments, or tax receivables at the account level (account_" +
  "classification has no sub-split below current_assets, and no " +
  "professional tri-state flag exists for that distinction). A forward " +
  "AR-collection forecast is CANNOT_ASSESS whenever any such account " +
  "exists — never approximated as if it were a verified trade-receivables " +
  "collection schedule.";

export const PAYABLE_CLASSIFICATION_LIMITATION =
  "This system cannot yet distinguish trade payables from statutory/tax-" +
  "like liabilities or other non-trade current liabilities at the account " +
  "level (account_classification has no sub-split below current_" +
  "liabilities). A forward AP-payment forecast is CANNOT_ASSESS whenever " +
  "any such account exists — the separately-known PAYE/VAT/SDL/WHT " +
  "statutory schedule remains usable on its own exact due dates " +
  "regardless (see excludeScheduledTaxFromCurrentLiabilities), but it is " +
  "never presented as if it were the whole AP picture.";
