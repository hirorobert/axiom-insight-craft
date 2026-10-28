/**
 * Deterministic depreciation (IFRS for SMEs 2015, 17.16, 17.18–17.23; charter P2, R2, 11.1). Exact integer
 * arithmetic on minor units; the only rounding is the final half-up to a minor unit, named in the result. The
 * calculator takes the entity's own recorded estimates — it never supplies a life, a rate, a residual value or a
 * convention, and it refuses to calculate while an input is missing. A charge supplied by an external register is a
 * different source of the figure and is never relabelled as calculated.
 */
export const DEPRECIATION_CALCULATOR_VERSION = "equipment-depreciation/1";
export const DEPRECIATION_METHODS = ["straight-line", "reducing-balance", "units-of-production"] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];
/** How a part-period is charged: the whole period's charge regardless of dates, or pro rata by days available. */
export const DEPRECIATION_CONVENTIONS = ["full-period", "daily"] as const;
export type DepreciationConvention = (typeof DEPRECIATION_CONVENTIONS)[number];

export type DepreciationItem = {
  label: string;
  costMinor: string;
  residualMinor: string;
  /** Accumulated depreciation on this item at the start of the period (0 for an addition). */
  openingAccumulatedMinor: string;
  method: DepreciationMethod | "";
  /** Straight-line: expected useful life in years (decimal text, e.g. "5" or "2.5"). */
  lifeYears: string;
  /** Reducing balance: annual rate in percent (decimal text). */
  ratePercent: string;
  /** Units of production: total expected output and this period's output. */
  totalUnits: string;
  unitsThisPeriod: string;
  /** Depreciation begins when available for use (17.20); blank = available for the whole period. */
  availableFrom: string;
  /** Depreciation ceases on derecognition (17.20); blank = held at the period end. */
  derecognisedOn: string;
};

export type DepreciationResult =
  | { state: "calculated"; chargeMinor: string; basis: string; daysAvailable: number; daysInPeriod: number; capped: boolean }
  | { state: "insufficient"; missing: string[] };

const INT = /^(0|[1-9][0-9]{0,30})$/;
const DEC = /^(\d{1,15})(?:\.(\d{1,6}))?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Rational = { num: bigint; den: bigint };
const rational = (text: string): Rational | null => {
  const m = DEC.exec(text.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  return { num: BigInt(m[1] + frac), den: 10n ** BigInt(frac.length) };
};
const validDate = (v: string) => DATE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00.000Z`)) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;
const dayNumber = (v: string) => Math.round(Date.parse(`${v}T00:00:00.000Z`) / 86_400_000);
/** Half-up rounding of num/den to an integer (num ≥ 0, den > 0). */
const roundHalfUp = (num: bigint, den: bigint): bigint => (num * 2n + den) / (2n * den);

/**
 * The charge for one item (an asset, or a component depreciated separately under 17.16) for the period
 * [period.start, period.end]. Under the daily convention the available days run from the later of the period start
 * and the available-for-use date to the earlier of the period end and the day before derecognition, inclusive.
 */
export function depreciationCharge(item: DepreciationItem, period: { start: string; end: string }, convention: DepreciationConvention | ""): DepreciationResult {
  const missing: string[] = [];
  const cost = INT.test(item.costMinor) ? BigInt(item.costMinor) : null;
  const residual = INT.test(item.residualMinor) ? BigInt(item.residualMinor) : null;
  const opening = INT.test(item.openingAccumulatedMinor) ? BigInt(item.openingAccumulatedMinor) : null;
  if (cost === null) missing.push("cost");
  if (residual === null) missing.push("residual value (0 only if the entity genuinely expects nothing)");
  if (opening === null) missing.push("accumulated depreciation at the start of the period");
  if (!(DEPRECIATION_METHODS as readonly string[]).includes(item.method)) missing.push("depreciation method");
  if (!(DEPRECIATION_CONVENTIONS as readonly string[]).includes(convention)) missing.push("part-period convention (the entity's policy)");
  if (!validDate(period.start) || !validDate(period.end) || dayNumber(period.end) < dayNumber(period.start)) missing.push("reporting period dates");
  if (item.availableFrom && !validDate(item.availableFrom)) missing.push("available-for-use date");
  if (item.derecognisedOn && !validDate(item.derecognisedOn)) missing.push("derecognition date");
  let life: Rational | null = null, rate: Rational | null = null, total: Rational | null = null, units: Rational | null = null;
  if (item.method === "straight-line") { life = rational(item.lifeYears); if (!life || life.num === 0n) missing.push("useful life in years"); }
  if (item.method === "reducing-balance") { rate = rational(item.ratePercent); if (!rate || rate.num === 0n) missing.push("annual rate (percent)"); }
  if (item.method === "units-of-production") {
    total = rational(item.totalUnits); units = rational(item.unitsThisPeriod);
    if (!total || total.num === 0n) missing.push("total expected output");
    if (!units) missing.push("output this period");
  }
  if (missing.length) return { state: "insufficient", missing };
  const daysInPeriod = dayNumber(period.end) - dayNumber(period.start) + 1;
  const from = Math.max(dayNumber(period.start), item.availableFrom ? dayNumber(item.availableFrom) : -Infinity);
  const to = Math.min(dayNumber(period.end), item.derecognisedOn ? dayNumber(item.derecognisedOn) - 1 : Infinity);
  const daysAvailable = Math.max(0, to - from + 1);
  const fraction: Rational = convention === "daily" ? { num: BigInt(daysAvailable), den: BigInt(daysInPeriod) } : daysAvailable === 0 ? { num: 0n, den: 1n } : { num: 1n, den: 1n };
  const carrying = cost! - opening!;
  // The depreciable amount still to be charged: never below zero (a residual value above the carrying amount gives 0).
  const remaining = carrying - residual! > 0n ? carrying - residual! : 0n;
  let num: bigint, den: bigint, basis: string;
  if (item.method === "straight-line") {
    // (cost − residual) / life × fraction
    const depreciable = cost! - residual! > 0n ? cost! - residual! : 0n;
    num = depreciable * life!.den * fraction.num; den = life!.num * fraction.den;
    basis = `straight-line: (cost − residual) ÷ ${item.lifeYears.trim()} years${convention === "daily" ? ` × ${daysAvailable}/${daysInPeriod} days` : ""}`;
  } else if (item.method === "reducing-balance") {
    // carrying × rate% × fraction
    num = carrying * rate!.num * fraction.num; den = 100n * rate!.den * fraction.den;
    basis = `reducing balance: carrying amount × ${item.ratePercent.trim()}%${convention === "daily" ? ` × ${daysAvailable}/${daysInPeriod} days` : ""}`;
  } else {
    // (cost − residual) × units / total (usage methods are not pro-rated by days: 17.20 allows zero while idle)
    const depreciable = cost! - residual! > 0n ? cost! - residual! : 0n;
    num = depreciable * units!.num * total!.den; den = total!.num * units!.den;
    basis = `units of production: (cost − residual) × ${item.unitsThisPeriod.trim()} ÷ ${item.totalUnits.trim()} units`;
  }
  if (num < 0n) num = 0n;
  let charge = roundHalfUp(num, den);
  const capped = charge > remaining;
  if (capped) charge = remaining;
  return { state: "calculated", chargeMinor: charge.toString(), basis: `${basis}; rounded half-up to the minor unit${capped ? "; capped at the remaining depreciable amount" : ""}`, daysAvailable, daysInPeriod, capped };
}

/** The class charge from its items (components or assets): the sum, or the first insufficiency. */
export function classCharge(items: readonly DepreciationItem[], period: { start: string; end: string }, convention: DepreciationConvention | ""): { state: "calculated"; chargeMinor: string; items: { label: string; result: DepreciationResult }[] } | { state: "insufficient"; items: { label: string; result: DepreciationResult }[] } {
  if (!items.length) return { state: "insufficient", items: [] };
  const out = items.map((i) => ({ label: i.label, result: depreciationCharge(i, period, convention) }));
  if (out.some((x) => x.result.state !== "calculated")) return { state: "insufficient", items: out };
  return { state: "calculated", chargeMinor: out.reduce((n, x) => n + BigInt((x.result as { chargeMinor: string }).chargeMinor), 0n).toString(), items: out };
}

/**
 * A change in estimate (17.19, 17.23; 10.16–10.18): the remaining carrying amount less the revised residual value is
 * spread prospectively over the revised remaining life. The effect disclosed is the revised charge less the charge the
 * previous estimate would have given; prior periods are never restated.
 */
export function revisedStraightLineCharge(carryingAtChangeMinor: string, revisedResidualMinor: string, revisedRemainingLifeYears: string, previousChargeMinor: string): { state: "calculated"; chargeMinor: string; effectMinor: string } | { state: "insufficient"; missing: string[] } {
  const missing: string[] = [];
  const carrying = INT.test(carryingAtChangeMinor) ? BigInt(carryingAtChangeMinor) : null;
  const residual = INT.test(revisedResidualMinor) ? BigInt(revisedResidualMinor) : null;
  const life = rational(revisedRemainingLifeYears);
  const previous = INT.test(previousChargeMinor) ? BigInt(previousChargeMinor) : null;
  if (carrying === null) missing.push("carrying amount at the date of the change");
  if (residual === null) missing.push("revised residual value");
  if (!life || life.num === 0n) missing.push("revised remaining life in years");
  if (previous === null) missing.push("charge under the previous estimate");
  if (missing.length) return { state: "insufficient", missing };
  const depreciable = carrying! - residual! > 0n ? carrying! - residual! : 0n;
  const charge = roundHalfUp(depreciable * life!.den, life!.num);
  return { state: "calculated", chargeMinor: charge.toString(), effectMinor: (charge - previous!).toString() };
}
