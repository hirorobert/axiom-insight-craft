/**
 * Multi-class equipment schedule with movement provenance (IFRS for SMEs 2015, 17.31(d)–(e), 17.30; charter L5, R1,
 * R5, G4, G5). Pure and advisory: the server (fs_commit_equipment_preparation_v2 and fs_record_schedule) re-checks
 * every identity before anything is stored. Amounts are exact integer minor units as strings; nothing is rounded,
 * nothing is balanced for the preparer — an unexplained difference stays a difference.
 */
import { MINOR, formatEquipmentAmount, type EquipmentAmountDisplay } from "./equipment";

export const EQUIPMENT_CONTRACT_V2 = "cfoclose-equipment-workpaper/2";
export const EQUIPMENT_CONTENT_VERSION_V2 = "sme-2015-equipment-preparation/2";

/** The pack's movement kinds for the `ppe` schedule, with the fixed direction each has on the carrying amount. */
export const PPE_MOVEMENT_KINDS = [
  "additions",
  "disposals",
  "business_combinations",
  "revaluations_and_oci_impairment",
  "transfers_investment_property",
  "impairment_profit_or_loss",
  "depreciation",
  "other",
] as const;
export type PpeMovementKind = (typeof PPE_MOVEMENT_KINDS)[number];
export const MOVEMENT_SIGN: Readonly<Record<PpeMovementKind, "increase" | "decrease" | "either">> = {
  additions: "increase",
  disposals: "decrease",
  business_combinations: "increase",
  revaluations_and_oci_impairment: "either",
  transfers_investment_property: "either",
  impairment_profit_or_loss: "either",
  depreciation: "decrease",
  other: "either",
};

export const MOVEMENT_SOURCE_TYPES = ["register", "ledger_account", "journal", "workpaper"] as const;
export type MovementSourceType = (typeof MOVEMENT_SOURCE_TYPES)[number];
export type MovementSource = { type: MovementSourceType | ""; reference: string };

/** Gross carrying amount, accumulated depreciation, accumulated impairment and the carrying amount at one date. */
export type BalanceSet = {
  grossMinor: string;
  accumulatedDepreciationMinor: string;
  accumulatedImpairmentMinor: string;
  carryingMinor: string;
};

/**
 * One movement of a class, stated in its three columns. The effect on the carrying amount is DERIVED
 * (gross − accumulated depreciation − accumulated impairment) and never typed, so the carrying-amount schedule and the
 * gross roll-forward cannot disagree with each other.
 */
export type ClassMovement = {
  kind: PpeMovementKind;
  grossMinor: string;
  accumulatedDepreciationMinor: string;
  accumulatedImpairmentMinor: string;
  source: MovementSource;
  note: string;
};

/** An item sold, scrapped, lost or withdrawn (17.27–17.30). Proceeds `null` = unknown, never zero. */
export type DisposalItem = {
  reference: string;
  date: string;
  costMinor: string;
  accumulatedDepreciationMinor: string;
  accumulatedImpairmentMinor: string;
  proceedsMinor: string | null;
  source: MovementSource;
};

export type ClassBalances = { opening: BalanceSet; closing: BalanceSet };

export type RetiredClass = { label: string; reason: string; evidence: string };

export const DESTINATION_TARGETS = [
  "sci.depreciation_and_amortisation",
  "sci.cost_of_sales",
  "sci.operating_expenses_by_function",
  "sci.other_expenses_by_nature",
  "capitalised_inventories",
  "capitalised_assets",
  "other",
] as const;
export type DestinationTarget = (typeof DESTINATION_TARGETS)[number];
/** Where the period's depreciation charge went (17.17): an expense line of the composed statements, or capitalised. */
export type DepreciationDestination = { target: DestinationTarget | ""; amountMinor: string; evidence: string; explanation: string };

const EXACT = /^(0|[1-9][0-9]{0,30})$/;
export const value = (v: string | null | undefined): bigint | null => (typeof v === "string" && MINOR.test(v) ? BigInt(v) : null);
const nonNegative = (v: string): bigint | null => (EXACT.test(v) ? BigInt(v) : null);
const hasText = (v: string | null | undefined) => typeof v === "string" && v.trim().length >= 3;
export const sourcePresent = (s: MovementSource | null | undefined): boolean =>
  !!s && (MOVEMENT_SOURCE_TYPES as readonly string[]).includes(s.type) && hasText(s.reference);

/** The carrying-amount effect of a movement, or null when a component is not an exact amount. */
export function movementCarryingMinor(m: Pick<ClassMovement, "grossMinor" | "accumulatedDepreciationMinor" | "accumulatedImpairmentMinor">): string | null {
  const g = value(m.grossMinor), d = value(m.accumulatedDepreciationMinor), i = value(m.accumulatedImpairmentMinor);
  if (g === null || d === null || i === null) return null;
  return (g - d - i).toString();
}

export type RollForwardResult = {
  state: "incomplete" | "difference" | "agrees";
  problems: string[];
  /** Closing less (opening + movements), per column; null while incomplete. */
  differences: { grossMinor: string; accumulatedDepreciationMinor: string; accumulatedImpairmentMinor: string; carryingMinor: string } | null;
  /** Gross − accumulated depreciation − accumulated impairment − carrying amount, at each date; null while incomplete. */
  netIdentity: { openingMinor: string; closingMinor: string } | null;
  /** The row the server's schedule authority receives, when the class is complete and agrees. */
  scheduleRow: { classLabel: string; openingMinor: string; closingMinor: string; movements: { kind: string; amountMinor: string }[] } | null;
};

/**
 * Both identities of one class: gross − accumulated depreciation − accumulated impairment = carrying amount at each
 * date, and opening + movements = closing in every column. Every movement needs a source (register, ledger account,
 * journal or reviewed workpaper); a blank component is unknown, not zero.
 */
export function classRollForward(label: string, balances: ClassBalances, movements: readonly ClassMovement[], disposals: readonly DisposalItem[], display?: EquipmentAmountDisplay): RollForwardResult {
  const money = (v: string | bigint) => formatEquipmentAmount(v, display);
  const problems: string[] = [];
  const cols = ["grossMinor", "accumulatedDepreciationMinor", "accumulatedImpairmentMinor"] as const;
  const bal = (b: BalanceSet) => ({ g: nonNegative(b.grossMinor), d: nonNegative(b.accumulatedDepreciationMinor), i: nonNegative(b.accumulatedImpairmentMinor), c: value(b.carryingMinor) });
  const o = bal(balances.opening), c = bal(balances.closing);
  if (!hasText(label)) problems.push("Name the asset class.");
  if ([o.g, o.d, o.i, o.c, c.g, c.d, c.i, c.c].some((x) => x === null)) problems.push("Enter the gross amount, accumulated depreciation, accumulated impairment and carrying amount at both dates (type 0 only for a verified zero).");
  const kinds = new Set<string>();
  const sums = { g: 0n, d: 0n, i: 0n };
  let complete = true;
  for (const m of movements) {
    if (!(PPE_MOVEMENT_KINDS as readonly string[]).includes(m.kind)) { problems.push(`Unknown movement kind ${m.kind}.`); complete = false; continue; }
    if (kinds.has(m.kind)) problems.push(`Movement ${m.kind} is entered more than once.`);
    kinds.add(m.kind);
    const g = value(m.grossMinor), d = value(m.accumulatedDepreciationMinor), i = value(m.accumulatedImpairmentMinor);
    if (g === null || d === null || i === null) { problems.push(`Enter exact amounts for every column of ${m.kind} (0 for a column it does not touch).`); complete = false; continue; }
    const effect = g - d - i;
    const sign = MOVEMENT_SIGN[m.kind as PpeMovementKind];
    if (sign === "increase" && effect < 0n) problems.push(`${m.kind} cannot reduce the carrying amount.`);
    if (sign === "decrease" && effect > 0n) problems.push(`${m.kind} cannot increase the carrying amount.`);
    if (!sourcePresent(m.source)) problems.push(`Name the register, ledger account, journal or reviewed workpaper that supports ${m.kind}.`);
    sums.g += g; sums.d += d; sums.i += i;
  }
  const disposal = movements.find((m) => m.kind === "disposals");
  if (disposal) {
    const dg = value(disposal.grossMinor), dd = value(disposal.accumulatedDepreciationMinor), di = value(disposal.accumulatedImpairmentMinor);
    if (dg !== null && dd !== null && di !== null && (dg !== 0n || dd !== 0n || di !== 0n)) {
      if (disposals.length === 0) problems.push("List each item disposed of (cost, accumulated depreciation, proceeds) so the gross roll-forward can be checked.");
      let sc = 0n, sd = 0n, si = 0n, ok = true;
      for (const d of disposals) {
        const cost = nonNegative(d.costMinor), ad = nonNegative(d.accumulatedDepreciationMinor), ai = nonNegative(d.accumulatedImpairmentMinor);
        if (cost === null || ad === null || ai === null) { ok = false; problems.push(`Enter the cost, accumulated depreciation and accumulated impairment removed for disposal ${d.reference || "(unnamed)"}.`); continue; }
        if (!hasText(d.reference)) problems.push("Identify each disposed item.");
        if (!sourcePresent(d.source)) problems.push(`Name the record supporting disposal ${d.reference || "(unnamed)"}.`);
        if (d.proceedsMinor !== null && value(d.proceedsMinor) === null) problems.push(`Proceeds for ${d.reference || "(unnamed)"} must be an exact amount, or left unknown.`);
        sc += cost; sd += ad; si += ai;
      }
      if (ok && disposals.length) {
        if (sc !== -dg) problems.push(`Disposed cost ${money(sc)} does not equal the cost removed in the disposals movement ${money(-dg)}.`);
        if (sd !== -dd) problems.push(`Accumulated depreciation eliminated ${money(sd)} does not equal the disposals movement ${money(-dd)}.`);
        if (si !== -di) problems.push(`Accumulated impairment eliminated ${money(si)} does not equal the disposals movement ${money(-di)}.`);
      }
    }
  }
  if (problems.length || !complete) return { state: "incomplete", problems, differences: null, netIdentity: null, scheduleRow: null };
  const openingNet = o.g! - o.d! - o.i! - o.c!, closingNet = c.g! - c.d! - c.i! - c.c!;
  const diff = { grossMinor: (c.g! - o.g! - sums.g).toString(), accumulatedDepreciationMinor: (c.d! - o.d! - sums.d).toString(), accumulatedImpairmentMinor: (c.i! - o.i! - sums.i).toString(), carryingMinor: (c.c! - o.c! - (sums.g - sums.d - sums.i)).toString() };
  const out: string[] = [];
  if (openingNet !== 0n) out.push("Opening gross less accumulated depreciation and impairment does not equal the opening carrying amount.");
  if (closingNet !== 0n) out.push("Closing gross less accumulated depreciation and impairment does not equal the closing carrying amount.");
  for (const col of cols) if (diff[col] !== "0") out.push(`${col === "grossMinor" ? "Gross cost" : col === "accumulatedDepreciationMinor" ? "Accumulated depreciation" : "Accumulated impairment"}: opening plus movements does not equal closing (difference ${money(diff[col])}). Find the missing movement; nothing is inferred.`);
  if (diff.carryingMinor !== "0" && !out.length) out.push("The carrying-amount schedule does not add up.");
  const agrees = out.length === 0;
  return {
    state: agrees ? "agrees" : "difference",
    problems: out,
    differences: diff,
    netIdentity: { openingMinor: openingNet.toString(), closingMinor: closingNet.toString() },
    scheduleRow: agrees
      ? { classLabel: label.trim(), openingMinor: o.c!.toString(), closingMinor: c.c!.toString(), movements: movements.map((m) => ({ kind: m.kind, amountMinor: movementCarryingMinor(m)! })) }
      : null,
  };
}

export type DisposalResult = {
  reference: string;
  carryingMinor: string | null;
  proceedsMinor: string | null;
  /** Proceeds less carrying amount (17.30); null until the proceeds are known. Positive = gain. */
  gainMinor: string | null;
};
/** Gain or loss per disposed item from confirmed inputs only; a missing proceeds figure stays unresolved. */
export function disposalResults(items: readonly DisposalItem[]): { items: DisposalResult[]; totalGainMinor: string | null; unresolved: number } {
  const out: DisposalResult[] = [];
  let total = 0n, unresolved = 0, allKnown = true;
  for (const d of items) {
    const cost = nonNegative(d.costMinor), ad = nonNegative(d.accumulatedDepreciationMinor), ai = nonNegative(d.accumulatedImpairmentMinor);
    const carrying = cost === null || ad === null || ai === null ? null : cost - ad - ai;
    const proceeds = d.proceedsMinor === null ? null : value(d.proceedsMinor);
    const gain = carrying === null || proceeds === null ? null : proceeds - carrying;
    if (gain === null) { unresolved += 1; allKnown = false; } else total += gain;
    out.push({ reference: d.reference, carryingMinor: carrying === null ? null : carrying.toString(), proceedsMinor: proceeds === null ? null : proceeds.toString(), gainMinor: gain === null ? null : gain.toString() });
  }
  return { items: out, totalGainMinor: allKnown && items.length ? total.toString() : null, unresolved };
}

export type TieOutResult = {
  state: "incomplete" | "difference" | "agrees";
  problems: string[];
  scheduleDepreciationMinor: string | null;
  destinationsMinor: string | null;
  differenceMinor: string | null;
  lines: { target: string; amountMinor: string; composedMinor: string | null; exceeds: boolean }[];
};
/**
 * The period's depreciation per the schedule must be accounted for by its destinations (17.17): expense lines of the
 * composed statement of comprehensive income and amounts capitalised. A destination on a composed line may not exceed
 * that line; a composed by-nature depreciation line that differs from the schedule needs an explanation, never a
 * journal posted from here.
 */
export function depreciationTieOut(
  classes: readonly { movements: readonly ClassMovement[] }[],
  destinations: readonly DepreciationDestination[],
  composedLines: readonly { lineId: string; amountMinor: string }[],
  display?: EquipmentAmountDisplay,
): TieOutResult {
  const money = (v: string | bigint) => formatEquipmentAmount(v, display);
  const problems: string[] = [];
  let schedule = 0n, complete = true;
  for (const c of classes) for (const m of c.movements) if (m.kind === "depreciation") { const d = value(m.accumulatedDepreciationMinor); if (d === null) complete = false; else schedule += d; }
  let total = 0n;
  const lines: TieOutResult["lines"] = [];
  for (const d of destinations) {
    const a = nonNegative(d.amountMinor);
    if (!(DESTINATION_TARGETS as readonly string[]).includes(d.target) || a === null) { problems.push("Each destination needs a target and an exact amount."); complete = false; continue; }
    if (!hasText(d.evidence)) problems.push(`Name the record supporting the amount sent to ${d.target}.`);
    total += a;
    const composed = d.target.startsWith("sci.") ? composedLines.find((l) => l.lineId === d.target) : undefined;
    const composedMinor = composed ? composed.amountMinor : null;
    const exceeds = composed ? a > BigInt(composed.amountMinor) : false;
    if (d.target.startsWith("sci.") && !composed) problems.push(`The statements have no composed line ${d.target}; choose the line the depreciation was presented in.`);
    if (exceeds) problems.push(`The amount sent to ${d.target} exceeds that composed line.`);
    if (d.target === "other" && !hasText(d.explanation)) problems.push("Explain any other destination of the depreciation charge.");
    lines.push({ target: d.target, amountMinor: a.toString(), composedMinor, exceeds });
  }
  if (!complete) return { state: "incomplete", problems, scheduleDepreciationMinor: null, destinationsMinor: null, differenceMinor: null, lines };
  const diff = schedule - total;
  if (diff !== 0n) problems.push(`Depreciation per the schedule (${money(schedule)}) and its destinations (${money(total)}) differ by ${money(diff)}. Explain where the rest went; no journal is posted here.`);
  const byNature = composedLines.find((l) => l.lineId === "sci.depreciation_and_amortisation");
  const sentByNature = lines.filter((l) => l.target === "sci.depreciation_and_amortisation").reduce((n, l) => n + BigInt(l.amountMinor), 0n);
  if (byNature && sentByNature !== BigInt(byNature.amountMinor) && destinations.some((d) => d.target === "sci.depreciation_and_amortisation") && !destinations.some((d) => hasText(d.explanation)))
    problems.push(`The composed depreciation and amortisation line (${money(byNature.amountMinor)}) differs from the depreciation sent to it (${money(sentByNature)}); explain the difference (for example amortisation on that line).`);
  return { state: problems.length ? "difference" : "agrees", problems, scheduleDepreciationMinor: schedule.toString(), destinationsMinor: total.toString(), differenceMinor: diff.toString(), lines };
}

/** Existing classes on the recorded schedule must be kept or explicitly retired with a reason; never silently dropped. */
export function classPreservation(existingRows: readonly { classLabel: string }[], classes: readonly { label: string }[], retired: readonly RetiredClass[]): { missing: string[]; problems: string[] } {
  const present = new Set(classes.map((c) => c.label.trim()));
  const retiredLabels = new Set(retired.map((r) => r.label.trim()));
  const missing = existingRows.map((r) => r.classLabel.trim()).filter((l) => !present.has(l) && !retiredLabels.has(l));
  const problems = missing.map((l) => `The recorded schedule has a class "${l}" that this preparation does not include. Keep it, or retire it with a reason and evidence; it is never dropped silently.`);
  for (const r of retired) if (!hasText(r.reason) || !hasText(r.evidence)) problems.push(`Retiring class "${r.label}" needs a reason and supporting evidence.`);
  return { missing, problems };
}

/**
 * The opening gross amount and accumulated deductions must agree to the prior report's printed figures when the
 * preparer confirmed them (17.31(d), 3.14; acceptance case AC-23). The net bridge alone can pass while the gross is
 * wrong, so this is checked separately and reported as a difference, never balanced.
 */
export function openingGrossBridge(
  prior: { grossMinor: string | null; accumulatedMinor: string | null },
  classes: readonly { opening: BalanceSet }[],
): { state: "not_provided" | "incomplete" | "difference" | "agrees"; grossDifferenceMinor: string | null; accumulatedDifferenceMinor: string | null } {
  if (prior.grossMinor === null && prior.accumulatedMinor === null) return { state: "not_provided", grossDifferenceMinor: null, accumulatedDifferenceMinor: null };
  let g = 0n, a = 0n;
  for (const c of classes) {
    const cg = nonNegative(c.opening.grossMinor), cd = nonNegative(c.opening.accumulatedDepreciationMinor), ci = nonNegative(c.opening.accumulatedImpairmentMinor);
    if (cg === null || cd === null || ci === null) return { state: "incomplete", grossDifferenceMinor: null, accumulatedDifferenceMinor: null };
    g += cg; a += cd + ci;
  }
  const pg = prior.grossMinor === null ? null : value(prior.grossMinor), pa = prior.accumulatedMinor === null ? null : value(prior.accumulatedMinor);
  if ((prior.grossMinor !== null && pg === null) || (prior.accumulatedMinor !== null && pa === null)) return { state: "incomplete", grossDifferenceMinor: null, accumulatedDifferenceMinor: null };
  const gd = pg === null ? null : g - pg, ad = pa === null ? null : a - pa;
  return { state: (gd ?? 0n) === 0n && (ad ?? 0n) === 0n ? "agrees" : "difference", grossDifferenceMinor: gd === null ? null : gd.toString(), accumulatedDifferenceMinor: ad === null ? null : ad.toString() };
}

/** Sum of the classes' carrying amounts at a date (null while any class is not exact). */
export function totalCarrying(classes: readonly { opening: BalanceSet; closing: BalanceSet }[], at: "opening" | "closing"): string | null {
  let t = 0n;
  for (const c of classes) { const v = value(c[at].carryingMinor); if (v === null) return null; t += v; }
  return t.toString();
}
