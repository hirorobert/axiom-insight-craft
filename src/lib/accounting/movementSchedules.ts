/**
 * movementSchedules.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 11: supporting-schedule contracts / movement engine (Section XIV).
 * Ω∞ Phase 7 extends this file in place (V5: "PPE Movement, Deferred
 * Income, Capital Grants, Provisions") rather than creating a competing
 * schedule engine.
 *
 * Pure, READ ONLY — no I/O. Three parts:
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
 *    not the initial wrong guess. NOT rewritten for Phase 7 — its
 *    cost/accumulated-depreciation/NBV shape and MUSE-specific cumulative
 *    derivation do not generalise honestly to schedules with no
 *    depreciation concept (Deferred Income, Capital Grants, Provisions);
 *    forcing symmetry here would itself be a fabrication.
 *
 * 2. assessScheduleRequirement — pure contracts (Section XIV's named
 *    schedule types) with a materiality-based REQUIRED/RECOMMENDED/
 *    NOT_APPLICABLE/UNASSESSABLE_FROM_TB assessment. Most of Section XIV's
 *    named schedules (borrowings, intangibles, employee benefits,
 *    commitments, related parties, budget-to-actual) have NO real evidence
 *    in the Arusha DC data this session worked from — they stay contracts
 *    only, never given fabricated computation logic (C4/Section XVIII).
 *
 * 3. buildGenericScheduleMovement — Ω∞ Phase 7: the generic, framework- and
 *    source-system-neutral movement engine for DEFERRED_INCOME_MOVEMENT,
 *    CAPITAL_GRANTS_MOVEMENT and PROVISIONS_MOVEMENT. Implements the
 *    generic accounting identity `closing = opening + Σ(signed evidenced
 *    movements)` — never the PPE-shaped 7-term formula, which does not
 *    hold for schedules with no depreciation/disposal concept. Consumes
 *    already-normalized, discrete, SIGNED movement amounts only; resolving
 *    a source system's own reporting convention (e.g. PPE's MUSE
 *    cumulative-to-date figures) into a discrete period movement is a
 *    caller-side adapter concern, deliberately kept out of this contract.
 *
 * "Do not block basic ingestion because schedules are absent" (Section
 * XIV): every function here is advisory/informational only — nothing
 * blocks, throws, or gates on a schedule being required.
 */

import type { IpsasPresentationCode } from "./museIpsasRulePack";
import type { ComparativeAmount } from "./comparativeEvidence";
import type { ClassifiedBalance } from "./statementAggregationEngine";
import type { EvidenceItem } from "./entityContext";
// Ω∞ Phase 7: PreflightVerdict is reused, not re-derived — a pure, zero-
// import leaf type (computePreflight.ts imports nothing itself: no React,
// no Supabase, no workspace state). A type-only import adds no runtime
// coupling; introducing a parallel string union here instead would be the
// actual violation (a second, competing certification vocabulary).
import type { PreflightVerdict } from "../workspace/computePreflight";

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
  | "BUDGET_TO_ACTUAL_SCHEDULE"
  // Ω∞ Phase 7: added per V5's required schedule list. Structurally
  // TB-derivable in principle (a trial balance CAN carry a liability
  // provisions account, IAS 37 / IPSAS 19 sense) — NOT added to
  // NEVER_TB_DERIVABLE. But no such presentationCode exists in
  // TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 today (the only "provision" codes
  // there are RECEIVABLES_ECL_PROVISION_CONTRA / CASH_ECL_PROVISION_CONTRA
  // — contra-asset impairment allowances, NOT liability provisions; never
  // to be conflated with this schedule type). See SCHEDULE_PRESENTATION_CODES.
  | "PROVISIONS_MOVEMENT";

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
  // Ω∞ Phase 7: no liability-Provisions presentationCode exists in the
  // current rule pack (see SupportingScheduleType comment above) — empty
  // list, NOT in NEVER_TB_DERIVABLE (a TB could carry one), resolves
  // honestly to NOT_APPLICABLE via the balance-count path below, same
  // treatment as INTANGIBLES_MOVEMENT / BORROWINGS_MOVEMENT.
  PROVISIONS_MOVEMENT: [],
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
 * BORROWINGS_MOVEMENT, CAPITAL_GRANTS_MOVEMENT, or (Ω∞ Phase 7)
 * PROVISIONS_MOVEMENT — a TB absolutely could carry an intangible-asset,
 * borrowings, or liability-provisions account; the current rule pack
 * simply has none classified. That is NOT_APPLICABLE (nothing to
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

// ── 3. Generic supporting-schedule movement engine (Ω∞ Phase 7) ─────────────
//
// Covers DEFERRED_INCOME_MOVEMENT, CAPITAL_GRANTS_MOVEMENT and
// PROVISIONS_MOVEMENT. PPE keeps buildAssetCategoryMovement above,
// unmodified — see file header.

/** The three Phase 7 schedule types this generic engine actually computes. */
export type GenericScheduleType =
  | "DEFERRED_INCOME_MOVEMENT"
  | "CAPITAL_GRANTS_MOVEMENT"
  | "PROVISIONS_MOVEMENT";

/**
 * Movement categories, typed per schedule accounting semantics — never one
 * generic "movement" bucket. The engine never infers increase/decrease from
 * a category name; direction lives entirely in the caller-supplied signed
 * amount (a RELEASE_TO_INCOME is negative because the evidence says so, not
 * because this engine assumes releases are always decreases).
 *
 * OTHER_EVIDENCED_MOVEMENT exists on each schedule for a genuinely evidenced
 * movement that doesn't fit the two primary categories (e.g. an FX
 * retranslation on a grant). It is NEVER auto-inserted by the engine to
 * force reconciliation — only ever caller-supplied, with its own evidence —
 * so it is not a balancing plug: an un-evidenced gap surfaces as
 * CANNOT_ASSESS / a dataGap, never as a fabricated "other" line.
 */
export type DeferredIncomeMovementCategory =
  | "RECEIPT_INCREASE"
  | "RELEASE_TO_INCOME"
  | "OTHER_EVIDENCED_MOVEMENT";

export type CapitalGrantMovementCategory =
  | "GRANT_RECEIVED"
  | "RECOGNIZED_RELEASED"
  | "OTHER_EVIDENCED_MOVEMENT";

export type ProvisionMovementCategory =
  | "CHARGED_ADDITIONAL"
  | "UTILIZED"
  | "REVERSED_UNUSED"
  | "OTHER_EVIDENCED_MOVEMENT";

export type ScheduleMovementCategory =
  | DeferredIncomeMovementCategory
  | CapitalGrantMovementCategory
  | ProvisionMovementCategory;

export interface ScheduleMovementLine {
  category: ScheduleMovementCategory;
  /**
   * Signed, already-normalized amount for this movement. `null` means this
   * category is relevant for the period but could not be evidenced —
   * distinct from omitting the line entirely (which means the caller has
   * no reason to believe this category occurred at all this period) and
   * distinct from an explicit `0` (a real, evidenced "nothing moved in
   * this category"). A `null` amount blocks closingBalance computation —
   * it is never coalesced to 0. A non-finite amount (NaN/Infinity/
   * -Infinity — malformed evidence, a different failure than "absent")
   * blocks it identically; neither is ever coalesced, dropped, or
   * silently continued past.
   */
  amount: number | null;
  evidence: EvidenceItem[];
}

/**
 * Caller-supplied TB-certification precondition. Reuses computePreflight.ts's
 * PreflightVerdict rather than re-deriving certification status — this
 * engine never queries tb_certifications, computeCertificationReadiness(),
 * Supabase, or React state; the caller resolves the verdict via the
 * existing SAFISHA path and passes only the resulting value in. Only
 * "certified" authorises computation — every other verdict
 * ("review" | "blocked" | "pending" | "stale" | "unknown" | "superseded")
 * fails closed to CANNOT_ASSESS, since none of them prove current,
 * authoritative TB evidence for the account population being scheduled.
 */
export interface ScheduleCertificationPrecondition {
  verdict: PreflightVerdict;
}

export type ScheduleReconciliationStatus =
  | "RECONCILED"
  | "DRIFT_WITHIN_TOLERANCE"
  | "DRIFT_EXCEEDS_TOLERANCE"
  | "CANNOT_ASSESS";

export interface SupportingScheduleResult {
  scheduleType: GenericScheduleType;
  /** Phase 4 authority — never re-derived, never defaulted. */
  openingBalance: ComparativeAmount;
  /** Deterministically ordered — see compareScheduleMovementLines. */
  movements: ScheduleMovementLine[];
  /** opening + Σ(movements). Null when opening is not KNOWN/ZERO, any
   *  movement amount is null, or certification precondition fails. */
  closingBalance: number | null;
  /** This period's TB-derived closing balance for the same account
   *  population, supplied by the caller. Null = not available — never 0. */
  tbClosingBalance: number | null;
  reconciliation: ScheduleReconciliationStatus;
  /** Absolute drift between closingBalance and tbClosingBalance. Null
   *  whenever reconciliation is CANNOT_ASSESS. */
  reconciliationDrift: number | null;
  /** Explicit list of what could not be computed/assessed and why — never
   *  silently omitted (mirrors buildAssetCategoryMovement's dataGaps). */
  dataGaps: string[];
}

export interface BuildGenericScheduleMovementInput {
  scheduleType: GenericScheduleType;
  openingBalance: ComparativeAmount;
  movements: ScheduleMovementLine[];
  tbClosingBalance: number | null;
  /** Reconciliation tolerance, absolute TZS — caller-supplied, mirroring
   *  hesabu-validate's variance_materiality-sourced tolerances. Never
   *  hardcoded inside this engine. */
  toleranceTzs: number;
  certification: ScheduleCertificationPrecondition;
}

/**
 * Ω∞ Phase 7 repair-forward (independent-certification HIGH finding): the
 * only numeric gate this engine trusts. `Number.isFinite` is false for
 * NaN, +Infinity, -Infinity, and non-numbers — exactly the values that
 * must never reach an authoritative closing/drift/tolerance figure.
 */
function isFiniteAmount(x: number): boolean {
  return Number.isFinite(x);
}

/**
 * Evidence canonicalization (independent-certification MEDIUM finding,
 * §8/§9): two movement lines carrying the same evidence SET in a
 * different caller-side array order must compare and serialize
 * identically — evidence order is not itself evidence. Sorted by
 * `source`, then `detail`, then `ref` (plain string comparison, never
 * localeCompare — not guaranteed stable across ICU environments). No
 * random ID, no timestamp, no JSON.stringify-on-insertion-order: only
 * truthful, already-present EvidenceItem fields are used.
 */
function canonicalizeEvidence(evidence: EvidenceItem[]): EvidenceItem[] {
  return [...evidence].sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    if (a.detail !== b.detail) return a.detail < b.detail ? -1 : 1;
    const aRef = a.ref ?? "";
    const bRef = b.ref ?? "";
    if (aRef !== bRef) return aRef < bRef ? -1 : 1;
    return 0;
  });
}

/** Stable string key of an already-canonicalized evidence array, used only as a sort tiebreaker. */
function evidenceKey(canonicalEvidence: EvidenceItem[]): string {
  return canonicalEvidence.map((e) => `${e.source} ${e.detail} ${e.ref ?? ""}`).join("");
}

/**
 * Total deterministic ordering for ScheduleMovementLine (independent-
 * certification MEDIUM finding, §7/§8): category, then a fixed amount
 * bucket (null < NaN < -Infinity < finite-ascending < +Infinity — a
 * total order over EVERY possible `number | null`, including the
 * non-finite values §1-6 below reject from authoritative arithmetic but
 * which must still sort deterministically for a reproducible echoed-back
 * array), then the canonicalized-evidence key. Two lines with the same
 * category, the same amount, and an equivalent evidence SET (any array
 * order) are indistinguishable and correctly compare equal — see §9:
 * genuine duplicates are never aggregated or dropped, only ordered.
 */
function compareScheduleMovementLines(a: ScheduleMovementLine, b: ScheduleMovementLine): number {
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;

  const bucketOf = (amount: number | null): 0 | 1 | 2 | 3 | 4 => {
    if (amount === null) return 0;
    if (Number.isNaN(amount)) return 1;
    if (amount === Number.NEGATIVE_INFINITY) return 2;
    if (Number.isFinite(amount)) return 3;
    return 4; // Number.POSITIVE_INFINITY
  };
  const bucketA = bucketOf(a.amount);
  const bucketB = bucketOf(b.amount);
  if (bucketA !== bucketB) return bucketA - bucketB;
  if (bucketA === 3 && a.amount !== b.amount) {
    return (a.amount as number) < (b.amount as number) ? -1 : 1;
  }

  const keyA = evidenceKey(canonicalizeEvidence(a.evidence));
  const keyB = evidenceKey(canonicalizeEvidence(b.evidence));
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  return 0;
}

/**
 * The generic Phase 7 movement engine: `closing = opening + Σ(signed
 * evidenced movements)`. Pure, deterministic, fails closed at every
 * boundary — never a `|| 0` / `?? 0` default, never a synthetic movement,
 * never a balancing plug, and (repair-forward) never a non-finite number
 * escaping as an authoritative closing/drift/tolerance figure.
 */
export function buildGenericScheduleMovement(
  input: BuildGenericScheduleMovementInput,
): SupportingScheduleResult {
  const dataGaps: string[] = [];
  // Evidence is canonicalized into the ECHOED array too, not just used
  // internally for sorting — so the same semantic input, evidence-array
  // order included, always produces byte-identical output (§8).
  const normalizedMovements = input.movements.map((m) => ({ ...m, evidence: canonicalizeEvidence(m.evidence) }));
  const orderedMovements = normalizedMovements.sort(compareScheduleMovementLines);

  if (input.certification.verdict !== "certified") {
    dataGaps.push(
      `Trial balance certification verdict is "${input.certification.verdict}", not "certified" — ` +
        `schedule computation requires certified/current TB authority and cannot proceed.`,
    );
    return {
      scheduleType: input.scheduleType,
      openingBalance: input.openingBalance,
      movements: orderedMovements,
      closingBalance: null,
      tbClosingBalance: input.tbClosingBalance,
      reconciliation: "CANNOT_ASSESS",
      reconciliationDrift: null,
      dataGaps,
    };
  }

  // ── Opening (Phase 4 ComparativeAmount authority — never re-derived) ──────
  // A malformed KNOWN/ZERO numeric payload fails closed; it is never
  // reinterpreted as ZERO, and Phase 4's ComparativeAmount value itself is
  // never mutated — only THIS engine's use of it is blocked.
  let openingValue: number | null = null;
  if (input.openingBalance.state === "KNOWN") {
    if (isFiniteAmount(input.openingBalance.value)) {
      openingValue = input.openingBalance.value;
    } else {
      dataGaps.push(
        "Opening balance is KNOWN but its numeric value is not finite (NaN/Infinity) — " +
          "treated as unavailable, never as ZERO or a mutated Phase 4 value.",
      );
    }
  } else if (input.openingBalance.state === "ZERO") {
    openingValue = 0;
  } else {
    dataGaps.push(
      `Opening balance is ${input.openingBalance.state} — closing balance cannot be computed from an unavailable opening.`,
    );
  }

  // ── Movements ──────────────────────────────────────────────────────────
  // null continues to mean "relevant but unevidenced" (unchanged design).
  // NaN/±Infinity are a DIFFERENT failure — malformed evidence, not absent
  // evidence — but both fail closed identically: block the sum, never
  // coalesce, never silently drop the line and continue.
  let movementSum: number | null = 0;
  for (const m of orderedMovements) {
    if (m.amount === null) {
      dataGaps.push(
        `Movement category "${m.category}" has no evidenced amount for this period — closing balance cannot be computed from an incomplete movement set.`,
      );
      movementSum = null;
    } else if (!isFiniteAmount(m.amount)) {
      dataGaps.push(
        `Movement category "${m.category}" has a non-finite amount (NaN/Infinity) — closing balance cannot be computed from malformed evidence.`,
      );
      movementSum = null;
    } else if (movementSum !== null) {
      movementSum += m.amount;
    }
  }

  // Overflow guard: two individually finite numbers can sum to Infinity
  // (e.g. two Number.MAX_VALUE-scale movements). Never let that escape as
  // an authoritative closing balance.
  let closingBalance: number | null =
    (openingValue !== null && movementSum !== null) ? openingValue + movementSum : null;
  if (closingBalance !== null && !isFiniteAmount(closingBalance)) {
    dataGaps.push(
      "Computed closing balance is not finite (numeric overflow from otherwise-finite inputs) — " +
        "never returned as an authoritative figure.",
    );
    closingBalance = null;
  }

  // ── TB closing balance — finite or treated as unavailable, never fabricated ──
  const tbClosingValid = input.tbClosingBalance !== null && isFiniteAmount(input.tbClosingBalance);
  if (input.tbClosingBalance !== null && !tbClosingValid) {
    dataGaps.push(
      "TB closing balance supplied is not finite (NaN/Infinity) — treated as unavailable, reconciliation cannot be assessed.",
    );
  }

  // ── Tolerance — caller-supplied, must be finite and >= 0. Never Math.abs()
  // (that would silently convert invalid negative authority into valid
  // positive authority) and never defaulted to 0. ──────────────────────────
  const toleranceValid = isFiniteAmount(input.toleranceTzs) && input.toleranceTzs >= 0;
  if (!toleranceValid) {
    dataGaps.push(
      `Tolerance ${String(input.toleranceTzs)} is invalid (must be finite and >= 0) — reconciliation cannot be assessed.`,
    );
  }

  let reconciliation: ScheduleReconciliationStatus;
  let reconciliationDrift: number | null = null;

  if (closingBalance === null) {
    reconciliation = "CANNOT_ASSESS";
  } else if (input.tbClosingBalance === null) {
    reconciliation = "CANNOT_ASSESS";
    dataGaps.push(
      "No TB closing balance supplied for this account population — reconciliation cannot be assessed.",
    );
  } else if (!tbClosingValid || !toleranceValid) {
    reconciliation = "CANNOT_ASSESS";
  } else {
    const drift = Math.abs(closingBalance - input.tbClosingBalance);
    if (!isFiniteAmount(drift)) {
      dataGaps.push(
        "Computed reconciliation drift is not finite (numeric overflow from otherwise-finite inputs) — " +
          "never returned as an authoritative figure.",
      );
      reconciliation = "CANNOT_ASSESS";
    } else {
      reconciliationDrift = drift;
      reconciliation =
        drift === 0 ? "RECONCILED" :
        drift <= input.toleranceTzs ? "DRIFT_WITHIN_TOLERANCE" :
        "DRIFT_EXCEEDS_TOLERANCE";
    }
  }

  return {
    scheduleType: input.scheduleType,
    openingBalance: input.openingBalance,
    movements: orderedMovements,
    closingBalance,
    tbClosingBalance: input.tbClosingBalance,
    reconciliation,
    reconciliationDrift,
    dataGaps,
  };
}
