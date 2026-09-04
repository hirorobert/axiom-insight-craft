/**
 * cashFlowEngines.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 10 (+ Phase 5 Slice 1 hardening): two cash-flow engines (Section XIII).
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
 * equality is asserted by crossCheckOperatingCashFlow(), never assumed --
 * but see that function's own doc comment for exactly what it does and does
 * NOT prove (Phase 5 Design Gate finding: it is not genuine dual-engine
 * independence, because buildPrimaryCashFlowStatement's operating figure is
 * conventionally supplied FROM buildOperatingCashFlowReconciliation's own
 * output, not independently derived).
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
 *
 * Phase 5 Slice 1 additions (cash-perimeter/materiality/reconciliation
 * hardening, verifyCashPositionReconciliation and friends, at the bottom of
 * this file): the cash perimeter (what counts as "cash and cash
 * equivalents") is never inferred here -- no account-name matching, no
 * regex, no sign inference, no presentationCode/accountNature inference.
 * The repository already exposes an authoritative,
 * professionally-maintained account_mappings.is_cash_account flag; this
 * module receives the ALREADY-RESOLVED cash position as caller-supplied
 * facts (CashPositionFacts) and never queries account_mappings itself --
 * this stays a pure function with zero DB access, matching every other
 * certified module in this file cluster. Materiality is caller-supplied
 * too (MaterialityThreshold) -- no hardcoded currency, no hardcoded
 * percentage, no hardcoded absolute floor.
 */

import type { AccountNature, IpsasPresentationCode } from "./museIpsasRulePack";
import { normalBalanceSign, type ClassifiedBalance } from "./statementAggregationEngine";
import type { ComparativeAmount } from "./comparativeEvidence";

/**
 * A rounding epsilon for crossCheckOperatingCashFlow's internal-consistency
 * check ONLY -- NOT a materiality threshold, and deliberately never reused
 * by verifyCashPositionReconciliation (see MaterialityThreshold below,
 * which is caller-supplied and currency-explicit). This constant exists
 * only to absorb floating-point rounding between two numbers that are
 * conventionally the same value passed through two call sites.
 */
const ROUNDING_EPSILON = 1;

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

/**
 * "Operating cash flow in primary statement = Operating cash flow from
 * reconciliation" — enforced, not assumed.
 *
 * LIMITATION (Phase 5 Design Gate finding, not fixed by this function):
 * this is an internal-consistency check, not genuine dual-engine
 * independence. Under the indirect method, this repository has exactly one
 * data-supported derivation of operating cash flow
 * (buildOperatingCashFlowReconciliation) -- buildPrimaryCashFlowStatement's
 * operating figure is conventionally THAT SAME number passed through by the
 * caller, not independently recomputed from a second data source (e.g.
 * actual cash receipts/payments, a genuine direct-method presentation).
 * This function therefore proves "did the caller wire the same number to
 * both call sites" -- a real, worthwhile guard against accidental drift --
 * NOT "do two independently-derived engines agree." No independent
 * operating-CF data source exists in this repository today; fabricating
 * one here would misrepresent what this check actually establishes.
 * Genuine dual-engine independence remains a registered capability gap
 * (Phase 5 Design Gate §7/§N), not solved by this or any function in this
 * file.
 */
export function crossCheckOperatingCashFlow(
  primary: PrimaryCashFlowStatement,
  reconciliation: OperatingCashFlowReconciliation,
): CashFlowCrossCheckResult {
  const variance = primary.operating.total - reconciliation.netCashFromOperatingActivities;
  return {
    matches: Math.abs(variance) <= ROUNDING_EPSILON,
    primaryOperatingCashFlow: primary.operating.total,
    reconciliationOperatingCashFlow: reconciliation.netCashFromOperatingActivities,
    variance,
  };
}

// ── Cash-flow classification completeness (Phase 5 Slice 1) ─────────────────

const ALL_KNOWN_CASHFLOW_PRESENTATION_CODES = new Set<IpsasPresentationCode>([
  ...NON_CASH_ADJUSTMENT_CODES,
  ...WORKING_CAPITAL_ASSET_CODES,
  ...WORKING_CAPITAL_LIABILITY_CODES,
  ...INVESTING_PRESENTATION_CODES,
]);

export type CashFlowUnresolvedReason = "NO_PRESENTATION_CODE" | "PRESENTATION_CODE_NOT_CLASSIFIED";

export interface UnresolvedCashFlowLine {
  naturalAccountCode: string;
  amount: number;
  reason: CashFlowUnresolvedReason;
  requiresReview: true;
}

/**
 * Repair (P5S1-HIGH-001): PRESENTATION_CODE_NOT_CLASSIFIED must mean "this
 * item is AUTHORITATIVELY KNOWN to be cash-flow relevant, but its
 * Operating/Investing/Financing classification is unresolved" -- never "not
 * one of our current sets." An equity line like ACCUMULATED_SURPLUS_DEFICIT
 * is not an unresolved cash movement; it simply isn't a cash-flow item at
 * all. This module cannot honestly decide cash-flow relevance itself (that
 * would require inferring from presentationCode absence, which is exactly
 * the fabrication this finding forbids) -- so relevance is a REQUIRED
 * caller-supplied authority, distinct from, and never collapsed into, the
 * cash-perimeter (CashPositionFacts) or materiality (MaterialityThreshold)
 * concepts below. No exclusion list is grown here; the caller decides once,
 * upstream, what is cash-flow relevant at all.
 */
export type CashFlowRelevantPresentationCodes = ReadonlySet<IpsasPresentationCode>;

/**
 * Audits a set of classified balances for cash-flow classification
 * completeness. A balance is surfaced as unresolved only when:
 *   - its presentationCode is missing at runtime (NO_PRESENTATION_CODE --
 *     always surfaced; we have no relevance information to consult at all), or
 *   - the caller's own cashFlowRelevantCodes authority says this code IS
 *     cash-flow relevant, but this module has no section mapping for it yet
 *     (PRESENTATION_CODE_NOT_CLASSIFIED).
 * A presentationCode the caller has NOT declared cash-flow relevant (e.g.
 * ACCUMULATED_SURPLUS_DEFICIT, a revenue/expense P&L line, any other real
 * SFP/statement line) is correctly excluded -- it was never a cash-flow
 * item to begin with, so it is neither "resolved" nor "unresolved" here.
 * Never silently dropped where it WAS declared relevant; never defaulted
 * into OPERATING.
 */
export function findUnresolvedCashFlowLines(
  balances: ClassifiedBalance[],
  cashFlowRelevantCodes: CashFlowRelevantPresentationCodes,
): UnresolvedCashFlowLine[] {
  return balances
    .filter((b) => {
      if (!b.presentationCode) return true; // NO_PRESENTATION_CODE: always surfaced
      if (!cashFlowRelevantCodes.has(b.presentationCode)) return false; // not cash-flow relevant at all -- correctly excluded
      return !ALL_KNOWN_CASHFLOW_PRESENTATION_CODES.has(b.presentationCode); // relevant, but unmapped to a section
    })
    .map((b) => ({
      naturalAccountCode: b.naturalAccountCode,
      amount: normalBalanceSign(b.accountNature) * (b.debitAmount - b.creditAmount),
      reason: (b.presentationCode
        ? "PRESENTATION_CODE_NOT_CLASSIFIED"
        : "NO_PRESENTATION_CODE") as CashFlowUnresolvedReason,
      requiresReview: true,
    }));
}

// ── Cash position reconciliation — Gate C (Phase 5 Slice 1) ─────────────────

/**
 * The already-resolved cash position for a period. The engine NEVER infers
 * cash status from account name, regex, sign, accountNature, or
 * presentationCode -- the caller resolves this from authoritative evidence
 * (e.g. account_mappings.is_cash_account) before calling. openingCash
 * reuses the certified ComparativeAmount contract so a genuinely missing
 * prior-period cash figure stays structurally MISSING/NOT_APPLICABLE, never
 * silently 0. actualClosingCash is the current period's own resolved cash
 * balance -- always a known fact for the period being reported on, so it is
 * a plain number, not a ComparativeAmount.
 */
export interface CashPositionFacts {
  currencyCode: string;
  openingCash: ComparativeAmount;
  actualClosingCash: number;
}

/**
 * Caller-supplied materiality. No defaults, no hardcoded currency. The
 * caller is responsible for sourcing this from wherever the firm's
 * materiality policy actually lives (company/period/engagement
 * configuration) -- no such configuration table exists in this repository
 * today, so none is invented or assumed here.
 */
export interface MaterialityThreshold {
  currencyCode: string;
  percentageThreshold: number;
  absoluteThreshold: number;
}

export type CashPositionReconciliationStatus = "RECONCILED" | "UNRECONCILED" | "CANNOT_ASSESS";

export interface CashPositionReconciliationResult {
  status: CashPositionReconciliationStatus;
  openingCashState: ComparativeAmount["state"];
  netCashMovement: number;
  /** null only when status is CANNOT_ASSESS (opening cash missing/not applicable). */
  derivedClosingCash: number | null;
  actualClosingCash: number;
  /** null only when status is CANNOT_ASSESS. */
  difference: number | null;
  /** null only when status is CANNOT_ASSESS -- the actual max(pct, absolute) value applied. */
  thresholdApplied: number | null;
  currencyCode: string;
}

/**
 * A non-empty string once whitespace is trimmed -- rejects "", "   ", and
 * non-string runtime bypasses. Exported so other pure HESABU cash-flow
 * modules (e.g. primaryCashFlowEngine.ts) reuse this exact validation
 * rather than duplicating it.
 */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Repair (P5S1-HIGH-003): Gate C must not trust TypeScript alone for
 * ComparativeAmount. This is an exhaustive RUNTIME discriminant -- a
 * `never`-typed default branch enforces compile-time exhaustiveness too,
 * but the throw is what actually protects a runtime-bypassed or malformed
 * value. Does NOT mutate or redefine the certified comparativeEvidence.ts
 * contract -- purely a defensive reader of it.
 *
 * KNOWN: value must be finite -- throws otherwise.
 * ZERO: value must be exactly 0, matching the certified contract's own
 *   shape (`{ state: "ZERO"; value: 0; ... }`) -- a ZERO with any other
 *   value is malformed and throws, never silently substituted.
 * MISSING / NOT_APPLICABLE: not assessable -- callers return CANNOT_ASSESS.
 * Anything else (an unrecognized state string): throws -- fails closed
 * rather than silently treating unknown data as either a value or an
 * absence.
 *
 * Exported (generalized from Gate C's own original private helper) so the
 * Primary Cash-Flow Engine (primaryCashFlowEngine.ts) reuses this exact
 * runtime-exhaustive logic for its own ComparativeAmount facts, rather than
 * duplicating it.
 */
export function resolveAssessableComparativeAmount(
  amount: ComparativeAmount,
): { assessable: true; value: number } | { assessable: false; state: "MISSING" | "NOT_APPLICABLE" } {
  switch (amount.state) {
    case "KNOWN": {
      if (!Number.isFinite(amount.value)) {
        throw new Error(
          `resolveAssessableComparativeAmount: ComparativeAmount state KNOWN has a non-finite value (received: ${String(amount.value)}).`,
        );
      }
      return { assessable: true, value: amount.value };
    }
    case "ZERO": {
      if ((amount.value as unknown) !== 0) {
        throw new Error(
          `resolveAssessableComparativeAmount: ComparativeAmount state ZERO must have value exactly 0 (received: ${String(amount.value)}) -- malformed against the certified contract.`,
        );
      }
      return { assessable: true, value: 0 };
    }
    case "MISSING":
      return { assessable: false, state: "MISSING" };
    case "NOT_APPLICABLE":
      return { assessable: false, state: "NOT_APPLICABLE" };
    default: {
      const exhaustive: never = amount;
      throw new Error(
        `resolveAssessableComparativeAmount: unrecognized ComparativeAmount state (received: ${String((exhaustive as ComparativeAmount).state)}).`,
      );
    }
  }
}

/**
 * Gate C: opening cash + net cash movement = derived closing cash, compared
 * against the actual (independently resolved) closing cash. This is a
 * DIFFERENT control from crossCheckOperatingCashFlow -- it never claims to
 * prove dual-engine operating-CF independence (see that function's own doc
 * comment). It proves cash MOVEMENT arithmetic ties to an independently
 * known cash POSITION, which is exactly what IFRS for SMEs s.7 /
 * IAS 7 / IPSAS 2 require and exactly what this repository's evidence can
 * honestly support today.
 *
 * Fails to CANNOT_ASSESS (never a plug, never a guessed zero) when opening
 * cash is MISSING or NOT_APPLICABLE. Fails closed (throws) on: any
 * non-finite numeric input; a negative percentageThreshold/absoluteThreshold
 * (Repair P5S1-HIGH-002 -- zero is a valid, explicit "no tolerance" choice
 * and is accepted); an empty/whitespace-only currencyCode on either input;
 * a mismatched currencyCode between cashPosition and materiality (compared
 * trimmed, case-sensitive -- matching this repository's own observed
 * convention of upper-case codes like 'TZS', with no currency library and
 * no case-folding invented); or a malformed ComparativeAmount (see
 * resolveAssessableComparativeAmount).
 */
export function verifyCashPositionReconciliation(
  cashPosition: CashPositionFacts,
  netCashMovement: number,
  materiality: MaterialityThreshold,
): CashPositionReconciliationResult {
  if (!isNonBlankString(cashPosition.currencyCode)) {
    throw new Error(
      `verifyCashPositionReconciliation: cashPosition.currencyCode must be a non-empty, non-whitespace string (received: ${JSON.stringify(cashPosition.currencyCode)}).`,
    );
  }
  if (!isNonBlankString(materiality.currencyCode)) {
    throw new Error(
      `verifyCashPositionReconciliation: materiality.currencyCode must be a non-empty, non-whitespace string (received: ${JSON.stringify(materiality.currencyCode)}).`,
    );
  }
  if (!Number.isFinite(netCashMovement)) {
    throw new Error(
      `verifyCashPositionReconciliation: netCashMovement is not a finite number (received: ${String(netCashMovement)}).`,
    );
  }
  if (!Number.isFinite(cashPosition.actualClosingCash)) {
    throw new Error(
      `verifyCashPositionReconciliation: cashPosition.actualClosingCash is not a finite number (received: ${String(cashPosition.actualClosingCash)}).`,
    );
  }
  if (!Number.isFinite(materiality.percentageThreshold) || materiality.percentageThreshold < 0) {
    throw new Error(
      `verifyCashPositionReconciliation: materiality.percentageThreshold must be a finite number >= 0 (received: ${String(materiality.percentageThreshold)}).`,
    );
  }
  if (!Number.isFinite(materiality.absoluteThreshold) || materiality.absoluteThreshold < 0) {
    throw new Error(
      `verifyCashPositionReconciliation: materiality.absoluteThreshold must be a finite number >= 0 (received: ${String(materiality.absoluteThreshold)}).`,
    );
  }
  if (cashPosition.currencyCode.trim() !== materiality.currencyCode.trim()) {
    throw new Error(
      `verifyCashPositionReconciliation: currency mismatch between cashPosition ('${cashPosition.currencyCode}') and materiality ('${materiality.currencyCode}') -- refusing to compare across currencies.`,
    );
  }

  const opening = resolveAssessableComparativeAmount(cashPosition.openingCash);

  if (!opening.assessable) {
    return {
      status: "CANNOT_ASSESS",
      openingCashState: cashPosition.openingCash.state,
      netCashMovement,
      derivedClosingCash: null,
      actualClosingCash: cashPosition.actualClosingCash,
      difference: null,
      thresholdApplied: null,
      currencyCode: cashPosition.currencyCode,
    };
  }

  const derivedClosingCash = opening.value + netCashMovement;
  const difference = derivedClosingCash - cashPosition.actualClosingCash;
  const thresholdApplied = Math.max(
    Math.abs(cashPosition.actualClosingCash) * materiality.percentageThreshold,
    materiality.absoluteThreshold,
  );
  const status: CashPositionReconciliationStatus =
    Math.abs(difference) <= thresholdApplied ? "RECONCILED" : "UNRECONCILED";

  return {
    status,
    openingCashState: cashPosition.openingCash.state,
    netCashMovement,
    derivedClosingCash,
    actualClosingCash: cashPosition.actualClosingCash,
    difference,
    thresholdApplied,
    currencyCode: cashPosition.currencyCode,
  };
}
