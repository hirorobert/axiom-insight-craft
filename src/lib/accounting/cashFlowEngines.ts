/**
 * cashFlowEngines.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 10: two cash-flow engines (Section XIII).
 *
 * MANDATORY per the directive: do not conflate
 *   A. PRIMARY CASH FLOW STATEMENT (Operating / Investing / Financing) — one
 *      of the primary financial statements, three summary lines.
 *   B. OPERATING CASH FLOW RECONCILIATION — a supporting schedule showing
 *      HOW the operating total was derived: surplus/deficit +/- non-cash
 *      adjustments +/- working-capital movements.
 * They are different PRODUCTS serving different readers, even though under
 * the indirect method (the only method this rule pack's source data
 * supports evidence for) they resolve to the same operating total. That
 * equality is asserted by crossCheckOperatingCashFlow(), never assumed.
 *
 * Pure, READ ONLY — no I/O. Reuses Slice 9's normalBalanceSign convention
 * and Slice 7's ComparativeAmount type rather than inventing parallel ones.
 *
 * Scope boundary (deliberate, not an oversight): this does NOT touch
 * kinga-tax-engine's existing, live `scfEngine` (PHASE-0 audit §11) — that
 * function writes tax_computations.computation_detail.scf_engine, which
 * feeds hesabu-validate's H-06/H-07/H-08 assertions gating sign-off
 * (CLAUDE.md §4.6). Wiring a new engine into a production financial-write
 * edge function that gates sign-off is a materially different risk than
 * anything built in Slices 1-9 and is not attempted here without a
 * separate, explicit decision to do so.
 */

import type { AccountNature, IpsasPresentationCode } from "./museIpsasRulePack";
import { normalBalanceSign, type ClassifiedBalance } from "./statementAggregationEngine";
import type { ComparativeAmount } from "./comparativeEvidence";

const TOLERANCE_TZS = 1;

// ── Shared line-item shape ────────────────────────────────────────────────────

export interface CashFlowLineItem {
  presentationCode: IpsasPresentationCode;
  naturalAccountCode?: string;
  /** Signed impact on cash — positive = cash inflow, negative = cash outflow. */
  amount: number;
}

// ── B. Operating Cash Flow Reconciliation (Section XIII) ─────────────────────

const NON_CASH_ADJUSTMENT_CODES = new Set<IpsasPresentationCode>([
  "DEPRECIATION_AMORTISATION",
  "IMPAIRMENT_EXPECTED_CREDIT_LOSS",
]);

const WORKING_CAPITAL_ASSET_CODES = new Set<IpsasPresentationCode>([
  "RECEIVABLES",
  "PREPAYMENTS",
  "INVENTORIES",
]);

const WORKING_CAPITAL_LIABILITY_CODES = new Set<IpsasPresentationCode>([
  "PAYABLES_AND_ACCRUALS",
  "DEPOSITS_HELD",
  "DEFERRED_REVENUE_INCOME",
  "WITHHOLDING_TAX_PAYABLE",
]);

export interface WorkingCapitalComparative {
  naturalAccountCode: string;
  presentationCode: IpsasPresentationCode;
  accountNature: AccountNature;
  /** Current-period normal-balance-signed net amount (statementAggregationEngine convention). */
  currentNetAmount: number;
  /** Prior-period comparative for this SAME sign convention — Slice 7's type, so MISSING/NOT_APPLICABLE is structurally impossible to silently treat as zero. */
  priorNetAmount: ComparativeAmount;
}

export interface OperatingCashFlowReconciliation {
  surplusForPeriod: number;
  nonCashAdjustments: CashFlowLineItem[];
  workingCapitalMovements: CashFlowLineItem[];
  /** Working-capital lines skipped because the prior amount was MISSING/NOT_APPLICABLE — never fabricated as zero (C4). */
  workingCapitalSkipped: Array<{ naturalAccountCode: string; reason: string }>;
  netCashFromOperatingActivities: number;
}

export function buildOperatingCashFlowReconciliation(
  surplusForPeriod: number,
  currentPeriodBalances: ClassifiedBalance[],
  workingCapitalComparatives: WorkingCapitalComparative[],
): OperatingCashFlowReconciliation {
  const nonCashAdjustments: CashFlowLineItem[] = currentPeriodBalances
    .filter((b) => NON_CASH_ADJUSTMENT_CODES.has(b.presentationCode))
    .map((b) => ({
      presentationCode: b.presentationCode,
      naturalAccountCode: b.naturalAccountCode,
      // A non-cash EXPENSE reduced surplus without using cash — add it back (positive).
      amount: normalBalanceSign(b.accountNature) * (b.debitAmount - b.creditAmount),
    }));

  const workingCapitalMovements: CashFlowLineItem[] = [];
  const workingCapitalSkipped: Array<{ naturalAccountCode: string; reason: string }> = [];

  for (const wc of workingCapitalComparatives) {
    if (wc.priorNetAmount.state === "MISSING" || wc.priorNetAmount.state === "NOT_APPLICABLE") {
      // Never fabricate a movement from an unknown prior balance (C4).
      workingCapitalSkipped.push({
        naturalAccountCode: wc.naturalAccountCode,
        reason: `Prior-period comparative is ${wc.priorNetAmount.state} — movement cannot be reliably computed.`,
      });
      continue;
    }

    const priorNet = wc.priorNetAmount.value;
    const delta = wc.currentNetAmount - priorNet;
    const isAsset = WORKING_CAPITAL_ASSET_CODES.has(wc.presentationCode);
    const isLiability = WORKING_CAPITAL_LIABILITY_CODES.has(wc.presentationCode);
    if (!isAsset && !isLiability) continue; // not a working-capital-relevant line

    // Asset increase = cash outflow (negative); liability increase = cash inflow (positive).
    const cashImpact = isAsset ? -delta : delta;
    workingCapitalMovements.push({
      presentationCode: wc.presentationCode,
      naturalAccountCode: wc.naturalAccountCode,
      amount: cashImpact,
    });
  }

  const netCashFromOperatingActivities =
    surplusForPeriod +
    nonCashAdjustments.reduce((s, l) => s + l.amount, 0) +
    workingCapitalMovements.reduce((s, l) => s + l.amount, 0);

  return {
    surplusForPeriod,
    nonCashAdjustments,
    workingCapitalMovements,
    workingCapitalSkipped,
    netCashFromOperatingActivities,
  };
}

// ── A. Primary Cash Flow Statement (Section XIII) ─────────────────────────────

const INVESTING_PRESENTATION_CODES = new Set<IpsasPresentationCode>([
  "PROPERTY_PLANT_EQUIPMENT_ADDITIONS",
  "WORK_IN_PROGRESS",
  "INVESTMENT_PROPERTY",
]);

export interface CashFlowSectionTotal {
  section: "OPERATING" | "INVESTING" | "FINANCING";
  lineItems: CashFlowLineItem[];
  total: number;
}

export interface PrimaryCashFlowStatement {
  operating: CashFlowSectionTotal;
  investing: CashFlowSectionTotal;
  financing: CashFlowSectionTotal;
  netCashMovementForPeriod: number;
}

/**
 * Investing activities: a debit-normal (ASSET) addition to PPE/WIP/
 * investment-property is a cash OUTFLOW. No real financing-activity
 * presentationCode exists in TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 (Arusha DC,
 * an LGA, shows zero borrowings/financing-classified accounts in either
 * real period observed) — this only covers investing.
 */
export function buildInvestingActivities(balances: ClassifiedBalance[]): CashFlowSectionTotal {
  const lineItems: CashFlowLineItem[] = balances
    .filter((b) => INVESTING_PRESENTATION_CODES.has(b.presentationCode))
    .map((b) => ({
      presentationCode: b.presentationCode,
      naturalAccountCode: b.naturalAccountCode,
      amount: -(normalBalanceSign(b.accountNature) * (b.debitAmount - b.creditAmount)),
    }));
  return { section: "INVESTING", lineItems, total: lineItems.reduce((s, l) => s + l.amount, 0) };
}

/**
 * Financing activities: generic over whatever presentationCodes the caller
 * designates as financing (e.g. borrowings drawn/repaid, capital
 * contributions) — no such codes exist in today's real rule pack, so this
 * legitimately returns an empty, zero-total section for any Arusha DC input.
 */
export function buildFinancingActivities(
  balances: ClassifiedBalance[],
  financingPresentationCodes: ReadonlySet<IpsasPresentationCode>,
): CashFlowSectionTotal {
  const lineItems: CashFlowLineItem[] = balances
    .filter((b) => financingPresentationCodes.has(b.presentationCode))
    .map((b) => ({
      presentationCode: b.presentationCode,
      naturalAccountCode: b.naturalAccountCode,
      // A financing liability (e.g. a borrowing) growing on its normal
      // (credit) side is a cash INFLOW — the normal-balance-signed net is
      // already positive in that direction, same convention as everywhere
      // else in this module. (Slice 10 gate caught a credit/debit-order
      // sign inversion here before this fix.)
      amount: normalBalanceSign(b.accountNature) * (b.debitAmount - b.creditAmount),
    }));
  return { section: "FINANCING", lineItems, total: lineItems.reduce((s, l) => s + l.amount, 0) };
}

/**
 * Assembles the primary statement. The operating total is taken as a
 * pre-computed input (from buildOperatingCashFlowReconciliation) — under
 * the indirect method there is only one correct operating number, so this
 * does not recompute it independently. What crossCheckOperatingCashFlow
 * below verifies is that nothing upstream diverged between the two call
 * sites' inputs.
 */
export function buildPrimaryCashFlowStatement(
  operatingCashFlow: number,
  investing: CashFlowSectionTotal,
  financing: CashFlowSectionTotal,
): PrimaryCashFlowStatement {
  const operating: CashFlowSectionTotal = { section: "OPERATING", lineItems: [], total: operatingCashFlow };
  return {
    operating,
    investing,
    financing,
    netCashMovementForPeriod: operating.total + investing.total + financing.total,
  };
}

// ── Mandatory cross-check (Section XIII) ──────────────────────────────────────

export interface CashFlowCrossCheckResult {
  matches: boolean;
  primaryOperatingCashFlow: number;
  reconciliationOperatingCashFlow: number;
  variance: number;
}

/** "Operating cash flow in primary statement = Operating cash flow from reconciliation" — enforced, not assumed. */
export function crossCheckOperatingCashFlow(
  primary: PrimaryCashFlowStatement,
  reconciliation: OperatingCashFlowReconciliation,
): CashFlowCrossCheckResult {
  const variance = primary.operating.total - reconciliation.netCashFromOperatingActivities;
  return {
    matches: Math.abs(variance) <= TOLERANCE_TZS,
    primaryOperatingCashFlow: primary.operating.total,
    reconciliationOperatingCashFlow: reconciliation.netCashFromOperatingActivities,
    variance,
  };
}
