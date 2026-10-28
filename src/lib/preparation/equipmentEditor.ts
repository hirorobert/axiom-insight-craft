/**
 * The browser editor of the multi-class preparation: what the preparer typed (decimal text, one entry convention) and
 * its derivation into the exact model the checks and the server read. Pure; no React.
 */
import { formatMinor, parseSourceAmount } from "./equipment";
import { MOVEMENT_SIGN, PPE_MOVEMENT_KINDS, type ClassMovement, type DisposalItem, type PpeMovementKind } from "./equipmentSchedule";
import { emptyAnswer, emptyBalances, emptyEstimate, type Answer, type EquipmentClass } from "./equipmentModel";
import type { EquipmentEditorV2 } from "./editorSchema";

export type EditorClass = EquipmentEditorV2["classes"][number];
export type EditorMovement = EditorClass["movements"][number];
export type EditorDisposal = EditorClass["disposals"][number];

/** Decimal text → exact minor units (signed), or the text itself when it is not an exact amount (so checks say so). */
export const minorOrText = (text: string, exponent: number): string => {
  const t = text.trim();
  if (t === "") return "";
  return parseSourceAmount(t, exponent, 0) ?? t;
};
/** A positive magnitude entered for a column with a fixed direction. */
const signed = (text: string, exponent: number, direction: 1 | -1): string => {
  const m = minorOrText(text, exponent);
  if (!/^(0|[1-9][0-9]{0,30})$/.test(m)) return m;
  return m === "0" || direction === 1 ? m : `-${m}`;
};

/**
 * One entry convention per movement kind. Fixed-direction kinds take positive amounts: additions and business
 * combinations add to cost; disposals remove cost and eliminate accumulated depreciation and impairment; depreciation
 * adds to accumulated depreciation. The 'either' kinds (revaluation/OCI, transfers, impairment in profit or loss, other)
 * take signed amounts per column: positive increases that column, a minus sign reduces it.
 */
export function movementColumns(kind: PpeMovementKind): { gross: "fixed+" | "fixed-" | "signed" | "none"; depreciation: "fixed+" | "fixed-" | "signed" | "none"; impairment: "fixed+" | "fixed-" | "signed" | "none" } {
  switch (kind) {
    case "additions": case "business_combinations": return { gross: "fixed+", depreciation: "none", impairment: "none" };
    case "disposals": return { gross: "fixed-", depreciation: "fixed-", impairment: "fixed-" };
    case "depreciation": return { gross: "none", depreciation: "fixed+", impairment: "none" };
    default: return { gross: "signed", depreciation: "signed", impairment: "signed" };
  }
}
const column = (text: string, mode: "fixed+" | "fixed-" | "signed" | "none", exponent: number): string =>
  mode === "none" ? "0" : mode === "signed" ? minorOrText(text, exponent) : signed(text, exponent, mode === "fixed+" ? 1 : -1);

export function deriveMovement(m: EditorMovement, exponent: number): ClassMovement {
  const cols = movementColumns(m.kind);
  return { kind: m.kind, grossMinor: column(m.grossMinor, cols.gross, exponent), accumulatedDepreciationMinor: column(m.accumulatedDepreciationMinor, cols.depreciation, exponent), accumulatedImpairmentMinor: column(m.accumulatedImpairmentMinor, cols.impairment, exponent), source: m.source, note: m.note };
}
export function deriveDisposal(d: EditorDisposal, exponent: number): DisposalItem {
  return { ...d, costMinor: minorOrText(d.costMinor, exponent), accumulatedDepreciationMinor: minorOrText(d.accumulatedDepreciationMinor, exponent), accumulatedImpairmentMinor: minorOrText(d.accumulatedImpairmentMinor, exponent),
    proceedsMinor: d.proceedsMinor === null ? null : minorOrText(d.proceedsMinor, exponent) };
}
const balances = (b: EditorClass["opening"], exponent: number) => ({ grossMinor: minorOrText(b.grossMinor, exponent), accumulatedDepreciationMinor: minorOrText(b.accumulatedDepreciationMinor, exponent), accumulatedImpairmentMinor: minorOrText(b.accumulatedImpairmentMinor, exponent), carryingMinor: minorOrText(b.carryingMinor, exponent) });

/** The exact model of a class from what was typed. */
export function deriveClass(c: EditorClass, exponent: number): EquipmentClass {
  const e = c.estimate;
  return {
    classId: c.classId, label: c.label, origin: c.origin, accounts: c.accounts,
    opening: balances(c.opening, exponent), closing: balances(c.closing, exponent),
    movements: c.movements.map((m) => deriveMovement(m, exponent)),
    disposals: c.disposals.map((d) => deriveDisposal(d, exponent)),
    estimate: { ...e, residualMinor: minorOrText(e.residualMinor, exponent), registerChargeMinor: minorOrText(e.registerChargeMinor, exponent), changeEffectMinor: minorOrText(e.changeEffectMinor, exponent),
      calculatedChargeMinor: "", chargeDifference: { ...e.chargeDifference, amountMinor: minorOrText(e.chargeDifference.amountMinor, exponent) },
      items: e.items.map((i) => ({ ...i, costMinor: minorOrText(i.costMinor, exponent), residualMinor: minorOrText(i.residualMinor, exponent), openingAccumulatedMinor: minorOrText(i.openingAccumulatedMinor, exponent) })) },
    answers: c.answers as Record<string, Answer>,
  };
}

export const newClassId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "00000000-0000-4000-8000-000000000000");
export const emptyEditorClass = (label = "", origin: "existing" | "new" = "new"): EditorClass => ({
  classId: newClassId(), label, origin, accounts: "", opening: emptyBalances(), closing: emptyBalances(), movements: [], disposals: [], estimate: emptyEstimate(), answers: {},
});
export const emptyMovement = (kind: PpeMovementKind): EditorMovement => ({ kind, grossMinor: "", accumulatedDepreciationMinor: "", accumulatedImpairmentMinor: "", source: { type: "", reference: "" }, note: "" });
export const emptyDisposal = (): EditorDisposal => ({ reference: "", date: "", costMinor: "", accumulatedDepreciationMinor: "", accumulatedImpairmentMinor: "", proceedsMinor: null, source: { type: "", reference: "" } });
export const emptyItem = (): EditorClass["estimate"]["items"][number] => ({ label: "", costMinor: "", residualMinor: "", openingAccumulatedMinor: "", method: "", lifeYears: "", ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "" });
export const ensureAnswer = (a: Answer | undefined): Answer => a ?? emptyAnswer();

/**
 * A class loaded from the recorded schedule (the server's rows carry the carrying-amount effect per movement, not the
 * columns): the carrying amounts are filled; depreciation, additions, business combinations and impairment in profit
 * or loss map to their single column; a disposal or an 'either' movement keeps its recorded effect in the note so the
 * preparer splits it into cost and accumulated deductions with evidence. Nothing else is assumed.
 */
export function classFromScheduleRow(row: { classLabel: string; openingMinor: string; closingMinor: string; movements: readonly { kind: string; amountMinor: string }[] }, exponent: number): EditorClass {
  const c = emptyEditorClass(row.classLabel, "existing");
  c.opening.carryingMinor = formatMinor(row.openingMinor, exponent);
  c.closing.carryingMinor = formatMinor(row.closingMinor, exponent);
  for (const m of row.movements) {
    if (!(PPE_MOVEMENT_KINDS as readonly string[]).includes(m.kind)) continue;
    const kind = m.kind as PpeMovementKind;
    const em = emptyMovement(kind);
    const abs = formatMinor(m.amountMinor.startsWith("-") ? m.amountMinor.slice(1) : m.amountMinor, exponent);
    if (kind === "depreciation") em.accumulatedDepreciationMinor = abs;
    else if (kind === "additions" || kind === "business_combinations") em.grossMinor = abs;
    else if (kind === "impairment_profit_or_loss") em.accumulatedImpairmentMinor = formatMinor((-BigInt(m.amountMinor)).toString(), exponent);
    else em.note = `Recorded carrying-amount effect ${formatMinor(m.amountMinor, exponent)}: enter its cost and accumulated deductions.`;
    if (BigInt(m.amountMinor) === 0n) em.note = RECORDED_ZERO_NOTE;
    c.movements.push(em);
  }
  return c;
}

/** Positive display of a stored amount for fixed-direction columns, signed for the others. */
export const movementSign = (kind: PpeMovementKind) => MOVEMENT_SIGN[kind];


export const RECORDED_ZERO_NOTE = "Recorded net effect is zero. This does not prove that no underlying movement occurred.";
/** Never classify cancelling nonzero columns, invalid text or a new unsourced row as a removable recorded zero. */
export function isRecordedZeroMovement(m: EditorMovement, exponent: number): boolean {
  return m.note === RECORDED_ZERO_NOTE && [m.grossMinor, m.accumulatedDepreciationMinor, m.accumulatedImpairmentMinor]
    .every(v => v.trim() === "" || parseSourceAmount(v, exponent, 0) === "0");
}
/** Explicit preparer action only. Retain who, which entries and evidence as an answer in the existing atomic save. */
export function excludeReviewedZeroMovements(cls: EditorClass, exponent: number, checkedBy: string, evidence: string): EditorClass {
  if (checkedBy.trim().length < 3 || evidence.trim().length < 3) throw new Error("Name who checked and the underlying evidence.");
  const removed = cls.movements.filter(m => isRecordedZeroMovement(m, exponent));
  if (!removed.length) return cls;
  const kinds = removed.map(m => m.kind);
  return { ...cls, movements: cls.movements.filter(m => !isRecordedZeroMovement(m, exponent)), answers: {
    ...cls.answers,
    zero_effect_row_review: { status: "answered", checkedBy: checkedBy.trim(), evidence: evidence.trim(),
      text: `During preparation, the reviewer checked the underlying records and excluded recorded zero-net rows for: ${kinds.join(", ")}. This records the removal decision; movements subsequently added remain separately evidenced and reconciled.`,
      flags: Object.fromEntries(kinds.map(kind => [kind, true])),
    },
  } };
}
