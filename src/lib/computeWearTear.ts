/**
 * computeWearTear.ts
 * Phase 1-B — Iron Dome Nuclear Design: Eliminate W&T computation divergence
 *
 * THE canonical wear and tear calculator for ITA Chapter 332 s.34.
 * This is the ONLY place where W&T is computed in the frontend.
 *
 * CapitalAllowancesRegister uses computeWearTear() to show a PREVIEW only.
 * The actual wear_tear_tzs and ita_wdv_closing_tzs in the DB are authoritative
 * only when written by the Kinga Tax Engine Edge Function.
 *
 * ITA s.34 Classes (R.E.2023):
 *   Class 1 — 37.5% Reducing Balance (computers, data-handling equipment)
 *   Class 2 — 25%   Reducing Balance (automobiles, light vehicles, office furniture)
 *   Class 3 — 12.5% Reducing Balance (heavy equipment, agricultural machinery)
 *   Class 5 — 20%   Straight Line    (buildings used for production)
 *   Class 6 — 5%    Straight Line    (commercial buildings)
 *   Class 7 — 1/useful life SL       (intangibles — rate known only at engine run)
 *   Class 8 — 100%  Immediate        (research & development expenditure)
 *
 * Class 7 returns null from this function. The engine must compute it using the
 * asset's useful life as recorded at tax registration.
 */

// ── Class configuration ───────────────────────────────────────────────────────

export type ITAClass = 1 | 2 | 3 | 5 | 6 | 7 | 8;
export type WTMethod = "RB" | "SL" | "IMMEDIATE" | "USEFUL_LIFE";

export interface ITAClassConfig {
  itaClass: ITAClass;
  label: string;
  method: WTMethod;
  /** Rate as a decimal (e.g. 0.375 for 37.5%). Null for Class 7 (useful-life SL). */
  rateNum: number | null;
  description: string;
}

export const ITA_CLASS_CONFIG: ITAClassConfig[] = [
  {
    itaClass: 1,
    label: "Class 1 — 37.5% RB",
    method: "RB",
    rateNum: 0.375,
    description: "Computers and data-handling equipment (ITA s.34, Class 1)",
  },
  {
    itaClass: 2,
    label: "Class 2 — 25% RB",
    method: "RB",
    rateNum: 0.25,
    description: "Automobiles, light vehicles, office furniture (ITA s.34, Class 2)",
  },
  {
    itaClass: 3,
    label: "Class 3 — 12.5% RB",
    method: "RB",
    rateNum: 0.125,
    description: "Heavy equipment, agricultural machinery (ITA s.34, Class 3)",
  },
  {
    itaClass: 5,
    label: "Class 5 — 20% SL",
    method: "SL",
    rateNum: 0.20,
    description: "Buildings used in production (ITA s.34, Class 5)",
  },
  {
    itaClass: 6,
    label: "Class 6 — 5% SL",
    method: "SL",
    rateNum: 0.05,
    description: "Commercial buildings (ITA s.34, Class 6)",
  },
  {
    itaClass: 7,
    label: "Class 7 — Useful life SL",
    method: "USEFUL_LIFE",
    rateNum: null,
    description: "Intangible assets — rate = 1/useful life years (ITA s.34, Class 7)",
  },
  {
    itaClass: 8,
    label: "Class 8 — 100% Immediate",
    method: "IMMEDIATE",
    rateNum: 1.0,
    description: "Research & development expenditure — expensed immediately (ITA s.34, Class 8)",
  },
];

// ── Computation types ─────────────────────────────────────────────────────────

export interface WearTearInput {
  itaClass: ITAClass;
  /** Opening WDV (written-down value) at start of period */
  openingWDV: number;
  /** Capital additions during the period */
  additions: number;
  /** Disposals at tax cost during the period */
  disposals: number;
  /** Original cost of asset (used for SL methods) */
  cost: number;
}

export interface WearTearResult {
  /**
   * Computed W&T deduction for the period.
   * Null for Class 7 (useful life unknown — engine required).
   */
  wearTear: number | null;
  /**
   * Computed closing WDV.
   * Null for Class 7.
   */
  closingWDV: number | null;
  /** Human-readable description of why null is returned (Class 7 only). */
  nullReason?: string;
  /** The config used for this computation. */
  classConfig: ITAClassConfig;
}

// ── Pure computation function ─────────────────────────────────────────────────

/**
 * Compute ITA s.34 W&T deduction and closing WDV.
 *
 * PURE function — no DB calls, no side effects.
 * Returns null for wearTear and closingWDV when itaClass === 7.
 *
 * Iron Dome guarantee: this function NEVER writes to the DB.
 * Only the Kinga Tax Engine writes authoritative W&T figures.
 */
export function computeWearTear(input: WearTearInput): WearTearResult {
  const { itaClass, openingWDV, additions, disposals, cost } = input;

  const classConfig = ITA_CLASS_CONFIG.find(c => c.itaClass === itaClass);
  if (!classConfig) {
    throw new Error(`Unknown ITA class: ${itaClass}. Valid classes: 1, 2, 3, 5, 6, 7, 8.`);
  }

  // Class 7: useful life is asset-specific, stored at the engine level.
  // We cannot compute W&T without the useful life — return null.
  if (itaClass === 7) {
    return {
      wearTear: null,
      closingWDV: null,
      nullReason: "Class 7 W&T requires useful life (years) — run Tax Engine to compute.",
      classConfig,
    };
  }

  // Clamp inputs to non-negative values
  const openWDV = Math.max(0, openingWDV);
  const adds    = Math.max(0, additions);
  const disps   = Math.max(0, disposals);
  const assetCost = Math.max(0, cost);

  let wearTear: number;

  switch (classConfig.method) {
    case "RB": {
      // Reducing balance: rate × (opening WDV + additions − disposals)
      const pool = openWDV + adds - disps;
      wearTear = Math.max(0, pool) * classConfig.rateNum!;
      break;
    }
    case "SL": {
      // Straight line: rate × original cost
      // Disposals reduce the pool but SL W&T is always on original cost
      wearTear = assetCost * classConfig.rateNum!;
      break;
    }
    case "IMMEDIATE": {
      // Class 8: 100% of cost in year of acquisition
      // If no new additions, no W&T (asset is already fully expensed)
      wearTear = adds;
      break;
    }
    default: {
      // Should never reach here given Class 7 guard above
      return {
        wearTear: null,
        closingWDV: null,
        nullReason: `Unhandled W&T method: ${classConfig.method}`,
        classConfig,
      };
    }
  }

  // Closing WDV = opening + additions − disposals − W&T, floored at 0
  const closingWDV = Math.max(0, openWDV + adds - disps - wearTear);

  return {
    wearTear: Math.round(wearTear),
    closingWDV: Math.round(closingWDV),
    classConfig,
  };
}

// ── Convenience helpers ───────────────────────────────────────────────────────

/** Look up config for a class. Returns undefined if not found. */
export function getITAClassConfig(itaClass: number): ITAClassConfig | undefined {
  return ITA_CLASS_CONFIG.find(c => c.itaClass === itaClass);
}

/**
 * Format a W&T preview label suitable for display in CapitalAllowancesRegister.
 * Returns "(preview) TZS X" or "Engine required." for Class 7.
 */
export function formatWearTearPreview(result: WearTearResult): string {
  if (result.wearTear === null) {
    return "Engine required.";
  }
  return `(preview) TZS ${result.wearTear.toLocaleString("en-TZ", { maximumFractionDigits: 0 })}`;
}
