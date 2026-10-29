/**
 * Generated PPE accounting policy and note (charter R7, L8; proposed spec §10). Output for review, never approved text.
 *
 * Every figure, rate and date in the wording is a typed binding to a fact (`ref`), formatted here from the exact minor
 * units, currency and scale — wording never carries a hand-typed amount. A class whose estimates management has not
 * confirmed contributes NO policy sentence: it contributes an explicit unresolved marker. Nothing is invented to fill
 * a gap, and an empty note is not "not applicable".
 */
import { CONVENTION_WORDS, type DepreciationConvention, type DepreciationItem } from "../preparation/depreciation";
import { formatEquipmentAmount } from "../preparation/equipment";
import type { PpeClassInput, PpeInput, PpeResult } from "./ppeWorkpaper";

export const GENERATED_LABEL = "Prepared from confirmed facts — review required";
export const NOTE_REF = "note.ppe";
export const STATEMENT_LINE_REF = "sfp.ppe";

export type Segment = { t: "text"; text: string } | { t: "fact"; ref: string; display: string };
export type PolicyBlock = { id: string; classId: string | null; segments: Segment[]; unresolved: boolean };
export type NoteCell = { ref: string; minor: string; display: string };
export type NoteTable = { id: string; title: string; columns: string[]; rows: { classId: string | null; label: string; cells: (NoteCell | null)[] }[] };
export type PolicyNote = {
  contentVersion: "ipsas-accrual-ppe-note/1";
  label: typeof GENERATED_LABEL;
  semanticRefs: { note: typeof NOTE_REF; statementLine: typeof STATEMENT_LINE_REF };
  policy: PolicyBlock[];
  tables: NoteTable[];
  /** Typed bindings that the wording and cells draw on: the single source of every displayed number. */
  bindings: Record<string, { kind: "amount" | "number" | "text" | "date"; value: string }>;
  unresolved: string[];
};

const text = (t: string): Segment => ({ t: "text", text: t });
const sum = (xs: (string | null)[]): bigint | null => xs.reduce<bigint | null>((n, x) => (n === null || x === null ? null : n + BigInt(x)), 0n);

function describeItem(i: DepreciationItem): string {
  if (i.method === "straight-line") return `straight-line over ${i.lifeYears.trim()} years`;
  if (i.method === "reducing-balance") return `reducing balance at ${i.ratePercent.trim()}% a year`;
  if (i.method === "units-of-production") return `units of production over ${i.totalUnits.trim()} expected units`;
  return "";
}

export function generatePpePolicyNote(input: PpeInput, result: PpeResult, display: { currency: string; exponent: number }, entityName: string): PolicyNote {
  const bindings: PolicyNote["bindings"] = {};
  const unresolved: string[] = [];
  const money = (ref: string, minor: string): Segment => {
    bindings[ref] = { kind: "amount", value: minor };
    return { t: "fact", ref, display: formatEquipmentAmount(minor, display) };
  };
  const policy: PolicyBlock[] = [];
  const allCost = input.classes.length > 0 && input.classes.every((c) => c.measurementModel === "cost" && c.estimate.basis === "cost");
  if (allCost) policy.push({ id: "policy.ppe.measurement", classId: null, unresolved: false, segments: [text(`${entityName.trim()} measures property, plant and equipment at cost less accumulated depreciation and accumulated impairment losses.`)] });
  else { unresolved.push("Measurement model not confirmed as the cost model for every class."); policy.push({ id: "policy.ppe.measurement", classId: null, unresolved: true, segments: [text("The measurement model for property, plant and equipment has not been confirmed.")] }); }

  const classRes = new Map(result.classes.map((r) => [r.classId, r]));
  for (const c of input.classes) {
    const r = classRes.get(c.classId);
    if (!r?.estimateReady || c.estimate.items.length === 0) {
      unresolved.push(`Estimates for "${c.label}" are not confirmed; no policy wording is generated for it.`);
      policy.push({ id: `policy.ppe.${c.classId}`, classId: c.classId, unresolved: true, segments: [text(`${c.label}: useful lives, methods and residual values await management's confirmation.`)] });
      continue;
    }
    const descriptors = [...new Set(c.estimate.items.map(describeItem).filter(Boolean))];
    const residual = sum(c.estimate.items.map((i) => i.residualMinor));
    const segs: Segment[] = [text(`${c.label} is depreciated ${descriptors.join("; ")}`)];
    if (residual !== null) { segs.push(text(", with a total residual value of ")); segs.push(money(`fact.ppe.${c.classId}.residual`, residual.toString())); }
    const conv = input.convention as DepreciationConvention;
    if (c.estimate.chargeSource === "calculated" && CONVENTION_WORDS[conv]) segs.push(text(`; for part periods, ${CONVENTION_WORDS[conv]}`));
    segs.push(text(". Depreciation begins when an asset is available for use and ceases on derecognition."));
    policy.push({ id: `policy.ppe.${c.classId}`, classId: c.classId, unresolved: false, segments: segs });
  }

  const cell = (classId: string, col: string, minor: string | null): NoteCell | null => {
    if (minor === null) return null;
    const ref = `fact.ppe.${classId}.${col}`;
    bindings[ref] = { kind: "amount", value: minor };
    return { ref, minor, display: formatEquipmentAmount(minor, display) };
  };
  const mv = (c: PpeClassInput, kind: string, col: "grossMinor" | "accumulatedDepreciationMinor" | "accumulatedImpairmentMinor") => {
    const m = c.movements.filter((x) => x.kind === kind);
    return m.length ? m.reduce<bigint>((n, x) => n + BigInt(x[col]), 0n).toString() : "0";
  };
  const exactOrNull = (v: string) => (/^(0|-?[1-9][0-9]{0,30})$/.test(v) ? v : null);
  const total = (label: string, rows: NoteTable["rows"], key: string): NoteTable["rows"][number] => {
    const cells = rows[0].cells.map((_, i) => {
      const col = rows.map((r) => r.cells[i]?.minor ?? null);
      const s = sum(col);
      if (s === null) return null;
      const ref = `fact.ppe.total.${key}.${i}`;
      bindings[ref] = { kind: "amount", value: s.toString() };
      return { ref, minor: s.toString(), display: formatEquipmentAmount(s.toString(), display) };
    });
    return { classId: null, label, cells };
  };
  const tables: NoteTable[] = [];
  if (input.classes.length) {
    const grossRows = input.classes.map((c) => ({ classId: c.classId, label: c.label, cells: [cell(c.classId, "gross.opening", exactOrNull(c.opening.grossMinor)), cell(c.classId, "gross.additions", mv(c, "additions", "grossMinor")), cell(c.classId, "gross.disposals", mv(c, "disposals", "grossMinor")), cell(c.classId, "gross.closing", exactOrNull(c.closing.grossMinor))] }));
    tables.push({ id: "table.ppe.gross", title: "Gross carrying amount", columns: ["Opening", "Additions", "Disposals", "Closing"], rows: [...grossRows, total("Total", grossRows, "gross")] });
    const accRows = input.classes.map((c) => ({ classId: c.classId, label: c.label, cells: [
      cell(c.classId, "acc.opening", sum([exactOrNull(c.opening.accumulatedDepreciationMinor), exactOrNull(c.opening.accumulatedImpairmentMinor)])?.toString() ?? null),
      cell(c.classId, "acc.depreciation", mv(c, "depreciation", "accumulatedDepreciationMinor")),
      cell(c.classId, "acc.impairment", mv(c, "impairment_profit_or_loss", "accumulatedImpairmentMinor")),
      cell(c.classId, "acc.disposals", sum([mv(c, "disposals", "accumulatedDepreciationMinor"), mv(c, "disposals", "accumulatedImpairmentMinor")])?.toString() ?? null),
      cell(c.classId, "acc.closing", sum([exactOrNull(c.closing.accumulatedDepreciationMinor), exactOrNull(c.closing.accumulatedImpairmentMinor)])?.toString() ?? null)] }));
    tables.push({ id: "table.ppe.accumulated", title: "Accumulated depreciation and impairment", columns: ["Opening", "Depreciation", "Impairment", "Disposals", "Closing"], rows: [...accRows, total("Total", accRows, "acc")] });
    const carryRows = input.classes.map((c) => ({ classId: c.classId, label: c.label, cells: [cell(c.classId, "carrying.opening", exactOrNull(c.opening.carryingMinor)), cell(c.classId, "carrying.closing", exactOrNull(c.closing.carryingMinor))] }));
    tables.push({ id: "table.ppe.carrying", title: "Carrying amount", columns: ["Opening", "Closing"], rows: [...carryRows, total("Total", carryRows, "carrying")] });
  }
  if (result.issues.length) unresolved.push(`${result.issues.length} preparation matter(s) are still open; the figures above are not final.`);
  return { contentVersion: "ipsas-accrual-ppe-note/1", label: GENERATED_LABEL, semanticRefs: { note: NOTE_REF, statementLine: STATEMENT_LINE_REF }, policy, tables, bindings, unresolved };
}
