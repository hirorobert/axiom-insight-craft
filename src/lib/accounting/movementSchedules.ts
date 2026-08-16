/**
 * movementSchedules.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 11: supporting-schedule contracts / movement engine (Section XIV).
 *
 * Pure, READ ONLY — no I/O. Two parts:
 *
 * 1. assetCategoryMovement — a REAL, fully-computed PPE roll-forward engine.
 *    Built only after verifying (in Python, against the raw Arusha exports,
 *    before writing any TS) that the assumed mechanic actually held: an
 *    initial hypothesis that '61xxxxxx Opening' rolls forward year-over-year
 *    as `Opening(t) = Opening(t-1) + Additions(t-1)` was checked and found
 *    FALSE — the real data shows '61xxxxxx Opening' is a STATIC historical
 *    baseline (identical across FY2025/FY2026), while '31xxxxxx Monetary'
 *    additions are CUMULATIVE-to-date figures (the current period's
 *    addition is the delta between this period's and the prior period's
 *    cumulative figure). The engine below reflects the verified mechanic,
 *    not the initial wrong guess.
 *
 * 2. assessScheduleRequirement — pure contracts (Section XIV's named
 *    schedule types) with a materiality-based REQUIRED/RECOMMENDED/
 *    NOT_APPLICABLE/UNASSESSABLE_FROM_TB assessment. Most of Section XIV's
 *    named schedules (borrowings, intangibles, employee benefits,
 *    commitments, related parties, budget-to-actual) have NO real evidence
 *    in the Arusha DC data this session worked from — they stay contracts
 *    only, never given fabricated computation logic (C4/Section XVIII).
 *
 * "Do not block basic ingestion because schedules are absent" (Section
 * XIV): every function here is advisory/informational only — nothing
 * blocks, throws, or gates on a schedule being required.
 */

import type { IpsasPresentationCode } from "./museIpsasRulePack";
import type { ComparativeAmount } from "./comparativeEvidence";
import type { ClassifiedBalance } from "./statementAggregationEngine";

// ── 1. PPE / asset-category movement (the one real, fully-computed engine) ────

export interface AssetCategoryMovementInput {
  /** A normalized, human asset-category label — the real join key that
   * actually worked against the Arusha data (e.g. "motor vehicles"),
   * NOT a guessed code-arithmetic relationship. */
  categoryLabel: string;
  openingCost: number;
  /** Current-period CUMULATIVE additions-to-date figure, as reported. */
  cumulativeAdditionsCurrentPeriod: number;
  /** Prior-period cumulative additions-to-date — Slice 7's ComparativeAmount, so MISSING/NOT_APPLICABLE is structural, never silently 0. */
  cumulativeAdditionsPriorPeriod: ComparativeAmount;
  openingAccumulatedDepreciation: number;
  /** Current-period depreciation charge — genuinely 0/absent for some real periods (verified: Arusha's FY2026 TB has zero depreciation postings). */
  depreciationChargeForPeriod: number | null;
  /** No disposal evidence exists anywhere in the real Arusha data reviewed this session — always 0 unless a caller supplies real evidence. */
  disposalsAtCost: number;
  disposalsAccumulatedDepreciation: number;
}

export interface AssetCategoryMovementResult {
  categoryLabel: string;
  openingCost: number;
  /** The period's OWN addition (delta vs prior cumulative) — null if the prior comparative is unavailable, never fabricated as the full cumulative figure. */
  additionsForPeriod: number | null;
  disposalsAtCost: number;
  closingCost: number | null;
  openingAccumulatedDepreciation: number;
  depreciationChargeForPeriod: number | null;
  disposalsAccumulatedDepreciation: number;
  closingAccumulatedDepreciation: number | null;
  netBookValueOpening: number;
  netBookValueClosing: number | null;
  /** Explicit list of what could not be computed and why — never silently omitted. */
  dataGaps: string[];
}

export function buildAssetCategoryMovement(
  input: AssetCategoryMovementInput,
): AssetCategoryMovementResult {
  const dataGaps: string[] = [];

  let additionsForPeriod: number | null = null;
  if (input.cumulativeAdditionsPriorPeriod.state === "KNOWN" || input.cumulativeAdditionsPriorPeriod.state === "ZERO") {
    additionsForPeriod =
      input.cumulativeAdditionsCurrentPeriod - input.cumulativeAdditionsPriorPeriod.value;
  } else {
    dataGaps.push(
      `Prior-period cumulative additions are ${input.cumulativeAdditionsPriorPeriod.state} — ` +
        `this period's own addition cannot be isolated from the cumulative-to-date figure.`,
    );
  }

  const closingCost =
    additionsForPeriod === null
      ? null
      : input.openingCost + additionsForPeriod - input.disposalsAtCost;

  if (input.depreciationChargeForPeriod === null) {
    dataGaps.push("No depreciation charge posted for this period — closing accumulated depreciation cannot be computed.");
  }
  const closingAccumulatedDepreciation =
    input.depreciationChargeForPeriod === null
      ? null
      : input.openingAccumulatedDepreciation +
        input.depreciationChargeForPeriod -
        input.disposalsAccumulatedDepreciation;

  const netBookValueOpening = input.openingCost - input.openingAccumulatedDepreciation;
  const netBookValueClosing =
    closingCost === null || closingAccumulatedDepreciation === null
      ? null
      : closingCost - closingAccumulatedDepreciation;

  return {
    categoryLabel: input.categoryLabel,
    openingCost: input.openingCost,
    additionsForPeriod,
    disposalsAtCost: input.disposalsAtCost,
    closingCost,
    openingAccumulatedDepreciation: input.openingAccumulatedDepreciation,
    depreciationChargeForPeriod: input.depreciationChargeForPeriod,
    disposalsAccumulatedDepreciation: input.disposalsAccumulatedDepreciation,
    closingAccumulatedDepreciation,
    netBookValueOpening,
    netBookValueClosing,
    dataGaps,
  };
}

// ── 2. Supporting-schedule contracts (Section XIV's named schedule types) ────

export type SupportingScheduleType =
  | "PPE_ASSET_MOVEMENT"
  | "INVESTMENT_PROPERTY_MOVEMENT"
  | "INTANGIBLES_MOVEMENT"
  | "WORK_IN_PROGRESS_MOVEMENT"
  | "DEFERRED_INCOME_MOVEMENT"
  | "CAPITAL_GRANTS_MOVEMENT"
  | "RECEIVABLES_ECL_MOVEMENT"
  | "INVENTORIES_MOVEMENT"
  | "BORROWINGS_MOVEMENT"
  | "EMPLOYEE_BENEFITS_SCHEDULE"
  | "COMMITMENTS_SCHEDULE"
  | "RELATED_PARTIES_SCHEDULE"
  | "BUDGET_TO_ACTUAL_SCHEDULE";

export type ScheduleRequirementStatus =
  | "REQUIRED" // material balances exist above threshold
  | "RECOMMENDED" // balances exist, below materiality threshold
  | "NOT_APPLICABLE" // zero balances of the relevant kind — genuinely nothing to disclose
  | "UNASSESSABLE_FROM_TB"; // Section XIV's own opening line: TB alone is insufficient for this schedule type

export interface ScheduleRequirementAssessment {
  scheduleType: SupportingScheduleType;
  status: ScheduleRequirementStatus;
  reason: string;
  relevantPresentationCodes: IpsasPresentationCode[];
  materialBalance: number;
}

/**
 * Data-driven registry (Section IV), not a branching if/else per schedule
 * type. Only schedule types with a REAL presentationCode in
 * TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 get a non-empty code list — the rest
 * are intentionally empty, resolved to UNASSESSABLE_FROM_TB below.
 */
const SCHEDULE_PRESENTATION_CODES: Record<SupportingScheduleType, IpsasPresentationCode[]> = {
  PPE_ASSET_MOVEMENT: [
    "PROPERTY_PLANT_EQUIPMENT_ADDITIONS",
    "PROPERTY_PLANT_EQUIPMENT_OPENING",
    "PPE_ACCUMULATED_DEPRECIATION_CONTRA",
  ],
  INVESTMENT_PROPERTY_MOVEMENT: ["INVESTMENT_PROPERTY"],
  INTANGIBLES_MOVEMENT: [], // no real evidence — Arusha DC's data has zero intangible-asset codes
  WORK_IN_PROGRESS_MOVEMENT: ["WORK_IN_PROGRESS", "WORK_IN_PROGRESS_TRANSFER_NON_CASH"],
  DEFERRED_INCOME_MOVEMENT: ["DEFERRED_REVENUE_INCOME"],
  // Capital grants specifically (vs deferred income generally) are not
  // distinguishable at today's presentationCode granularity — resolves to
  // NOT_APPLICABLE (empty list, not in NEVER_TB_DERIVABLE), not a guess.
  CAPITAL_GRANTS_MOVEMENT: [],
  RECEIVABLES_ECL_MOVEMENT: ["RECEIVABLES", "RECEIVABLES_ECL_PROVISION_CONTRA", "CASH_ECL_PROVISION_CONTRA"],
  INVENTORIES_MOVEMENT: ["INVENTORIES"],
  // No real evidence — zero borrowings-classified codes in Arusha DC's data
  // (Slice 10 finding). A TB absolutely could carry one; this one doesn't.
  BORROWINGS_MOVEMENT: [],
  EMPLOYEE_BENEFITS_SCHEDULE: [], // not TB-derivable (actuarial/contractual data needed)
  COMMITMENTS_SCHEDULE: [], // not TB-derivable (contracts/purchase orders needed)
  RELATED_PARTIES_SCHEDULE: [], // not TB-derivable (organisational/legal-form data needed)
  BUDGET_TO_ACTUAL_SCHEDULE: [], // not TB-derivable (approved budget document needed, not just actuals)
};

/**
 * Schedule types with NO TB-derivable evidence source at all, REGARDLESS of
 * what balances exist — reserved for things a trial balance structurally
 * cannot represent even in principle (actuarial assumptions, contract
 * terms, related-party status, the APPROVED budget document as opposed to
 * actuals). Deliberately does NOT include INTANGIBLES_MOVEMENT,
 * BORROWINGS_MOVEMENT, or CAPITAL_GRANTS_MOVEMENT — a TB absolutely could
 * carry an intangible-asset or borrowings account; Arusha DC's specific
 * real data simply doesn't have one. That is NOT_APPLICABLE (nothing to
 * disclose), a different and more honest status than "impossible to
 * assess" (Slice 11 gate caught this exact conflation before it shipped).
 */
const NEVER_TB_DERIVABLE = new Set<SupportingScheduleType>([
  "EMPLOYEE_BENEFITS_SCHEDULE",
  "COMMITMENTS_SCHEDULE",
  "RELATED_PARTIES_SCHEDULE",
  "BUDGET_TO_ACTUAL_SCHEDULE",
]);

/**
 * Progressive disclosure (Section XIV: "3 schedules recommended, 1 schedule
 * required"). Advisory only — never blocks ingestion or throws.
 */
export function assessScheduleRequirement(
  scheduleType: SupportingScheduleType,
  balances: ClassifiedBalance[],
  materialityThresholdTzs: number,
): ScheduleRequirementAssessment {
  const relevantPresentationCodes = SCHEDULE_PRESENTATION_CODES[scheduleType];

  if (NEVER_TB_DERIVABLE.has(scheduleType)) {
    return {
      scheduleType,
      status: "UNASSESSABLE_FROM_TB",
      reason:
        "This schedule type requires evidence a trial balance cannot provide on its own " +
        "(Section XIV: 'TB alone is insufficient for all IPSAS/IFRS notes').",
      relevantPresentationCodes,
      materialBalance: 0,
    };
  }

  const relevant = balances.filter((b) => relevantPresentationCodes.includes(b.presentationCode));
  const materialBalance = relevant.reduce((s, b) => s + Math.abs(b.debitAmount - b.creditAmount), 0);

  if (relevant.length === 0) {
    return {
      scheduleType,
      status: "NOT_APPLICABLE",
      reason: "No accounts of this schedule's relevant kind are present in the trial balance.",
      relevantPresentationCodes,
      materialBalance: 0,
    };
  }

  if (materialBalance > materialityThresholdTzs) {
    return {
      scheduleType,
      status: "REQUIRED",
      reason: `${relevant.length} account(s) totalling ${materialBalance.toLocaleString()} TZS exceed the materiality threshold of ${materialityThresholdTzs.toLocaleString()} TZS.`,
      relevantPresentationCodes,
      materialBalance,
    };
  }

  return {
    scheduleType,
    status: "RECOMMENDED",
    reason: `${relevant.length} account(s) totalling ${materialBalance.toLocaleString()} TZS exist but are below the materiality threshold.`,
    relevantPresentationCodes,
    materialBalance,
  };
}
