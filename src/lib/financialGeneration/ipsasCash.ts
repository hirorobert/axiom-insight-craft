// financialGeneration/ipsasCash.ts — the IPSAS cash-basis statement of cash
// receipts and payments, generated from validated evidence.
//
// Receipts are shown positive and payments negative so the canonical casting
// rule can sum a section directly. A closing cash balance stated in the
// evidence is presented as stated and tested against opening + net; otherwise
// closing is computed. Payments made by third parties on the entity's behalf are
// a separate memorandum section and are NEVER part of the net movement.

import { addMoney, subtractMoney, sumMoney, type Money } from "@/lib/canonicalStatement/money";
import { CANONICAL_CONCEPTS } from "@/lib/canonicalStatement/concepts";
import type { MonetaryFact, Statement, StatementLine, StatementSection } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { amountOf, byCodepoint, columnReader, describeRows, evidenceFact, gap, periodRef, sameDenomination, slug, type EvidenceRowRef, type GenerationDiagnostic, type GenerationResult } from "./common";

export const IPSAS_CASH_STATEMENT_ID = "statement:cash-receipts-and-payments";

export interface IpsasCashPeriodInput {
  readonly periodId: string;
  readonly isComparative: boolean;
  readonly batch: EvidenceBatch;
}

export function buildIpsasCashStatement(periods: readonly IpsasCashPeriodInput[]): GenerationResult {
  if (periods.length === 0) return gap(["No cash receipts and payments evidence is available."]);
  if (!sameDenomination(periods.map((p) => p.batch))) return gap(["The evidence for the reporting periods uses different currencies or scales."]);
  if (periods.filter((p) => !p.isComparative).length !== 1) return gap(["Exactly one current-period receipts and payments batch is required."]);

  const diagnostics: GenerationDiagnostic[] = [];
  type Cell = { value: Money; row: number; label: string };
  const perPeriod = new Map<string, { opening?: Cell; closing?: Cell; lines: Map<string, Map<string, Cell>> }>();

  for (const p of periods) {
    const read = columnReader(p.batch);
    const cur: { opening?: Cell; closing?: Cell; lines: Map<string, Map<string, Cell>> } = { lines: new Map() };
    for (let row = 1; row <= p.batch.document.rows.length; row++) {
      const section = read(row, "section");
      const value = amountOf(p.batch, read(row, "amount"));
      const cell = { value, row, label: read(row, "line_label") };
      if (section === "OPENING_CASH") cur.opening = cell;
      else if (section === "CLOSING_CASH") cur.closing = cell;
      else {
        const m = cur.lines.get(section) ?? new Map<string, Cell>();
        m.set(read(row, "line_key"), cell);
        cur.lines.set(section, m);
      }
    }
    perPeriod.set(p.periodId, cur);
  }

  const noOpening = periods.filter((p) => !perPeriod.get(p.periodId)!.opening).map((p) => p.periodId);
  if (noOpening.length > 0) return gap([`No opening cash balance was supplied for ${noOpening.join(", ")}; it cannot be inferred.`]);

  const facts: MonetaryFact[] = [];
  const evidenceIndex: Record<string, EvidenceRowRef[]> = {};
  const values = new Map<string, Map<string, Money>>();
  const put = (lineId: string, p: IpsasCashPeriodInput, value: Money, rows: readonly number[], text: string) => {
    const m = values.get(lineId) ?? new Map<string, Money>();
    m.set(p.periodId, value);
    values.set(lineId, m);
    facts.push(evidenceFact(p.batch, `fact:${lineId}:${p.periodId}`, value, periodRef(p.periodId, p.isComparative), rows[0] ?? 0, text));
    if (rows.length > 0) (evidenceIndex[lineId] ??= []).push({ batchId: p.batch.evidenceBatchId, rowNumbers: rows });
  };
  const bind = (lineId: string) => [...(values.get(lineId)?.keys() ?? [])].sort().map((periodId) => ({ periodId, factId: `fact:${lineId}:${periodId}` }));
  const mk = (lineId: string, label: string, concept: string, role: StatementLine["role"], children: readonly string[]): StatementLine => ({ lineId, label, concept, role, normalBalance: "DEBIT_NORMAL", isContra: false, factBindings: bind(lineId), castingChildLineIds: children });

  const sections: StatementSection[] = [];
  const sectionTotals: string[] = []; // RECEIPTS and PAYMENTS totals
  const zero = (p: IpsasCashPeriodInput) => subtractMoney(amountOf(p.batch, "0"), amountOf(p.batch, "0"));
  void zero;

  const build = (section: "RECEIPTS" | "PAYMENTS" | "THIRD_PARTY_PAYMENTS", title: string, totalLabel: string, negative: boolean, includeInNet: boolean) => {
    const keys = [...new Set(periods.flatMap((p) => [...(perPeriod.get(p.periodId)!.lines.get(section)?.keys() ?? [])]))].sort(byCodepoint);
    if (keys.length === 0) return;
    const detail: StatementLine[] = [];
    for (const key of keys) {
      const lineId = `line:ipsas:${section.toLowerCase()}:${slug(key)}`;
      let label = key;
      for (const p of periods) {
        const cell = perPeriod.get(p.periodId)!.lines.get(section)?.get(key);
        if (cell) {
          label = cell.label;
          put(lineId, p, negative ? subtractMoney(amountOf(p.batch, "0"), cell.value) : cell.value, [cell.row], describeRows([cell.row]));
        }
      }
      detail.push(mk(lineId, label, `ipsas_cash_line:${section.toLowerCase()}:${slug(key)}`, "DETAIL", []));
    }
    const totalId = `line:ipsas:${section.toLowerCase()}:total`;
    for (const p of periods) {
      const vals = detail.map((d) => values.get(d.lineId)?.get(p.periodId));
      if (vals.every((v): v is Money => v !== undefined)) put(totalId, p, sumMoney(vals)!, [], `computed: sum of ${detail.length} line${detail.length === 1 ? "" : "s"}`);
      else diagnostics.push({ code: "TOTAL_OMITTED_MISSING_LINE", severity: "WARNING", message: `${totalLabel} is not presented for ${p.periodId} because a line has no figure for that period.` });
    }
    sections.push({ sectionId: `section:ipsas:${section.toLowerCase()}`, label: title, lines: [...detail, mk(totalId, totalLabel, `ipsas_cash_total:${section.toLowerCase()}`, "TOTAL", detail.map((d) => d.lineId))] });
    if (includeInNet) sectionTotals.push(totalId);
  };

  build("RECEIPTS", "Cash receipts", "Total cash receipts", false, true);
  build("PAYMENTS", "Cash payments", "Total cash payments", true, true);

  const netId = "line:ipsas:net-movement";
  for (const p of periods) {
    const vals = sectionTotals.map((id) => values.get(id)?.get(p.periodId));
    if (vals.length > 0 && vals.every((v): v is Money => v !== undefined)) put(netId, p, sumMoney(vals)!, [], "computed: total receipts plus total payments");
  }
  const openId = "line:ipsas:opening";
  const closeId = "line:ipsas:closing";
  const cash: StatementLine[] = [];
  if (sectionTotals.length > 0) cash.push(mk(netId, "Net increase (decrease) in cash", "ipsas_cash_net_movement", "TOTAL", sectionTotals));
  for (const p of periods) {
    const o = perPeriod.get(p.periodId)!.opening!;
    put(openId, p, o.value, [o.row], describeRows([o.row]));
  }
  cash.push(mk(openId, "Cash and cash equivalents at the beginning of the period", "ipsas_cash_opening", "DETAIL", []));
  for (const p of periods) {
    const c = perPeriod.get(p.periodId)!;
    const net = values.get(netId)?.get(p.periodId);
    if (c.closing) put(closeId, p, c.closing.value, [c.closing.row], `${describeRows([c.closing.row])} (closing balance as stated in the evidence)`);
    else if (net) put(closeId, p, addMoney(c.opening!.value, net), [], "computed: opening cash plus net movement (no closing balance was stated)");
    else diagnostics.push({ code: "CLOSING_NOT_PRESENTED", severity: "WARNING", message: `Closing cash is not presented for ${p.periodId}: no closing balance was stated and the net movement is incomplete.` });
  }
  cash.push(mk(closeId, "Cash and cash equivalents at the end of the period", CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, "TOTAL", sectionTotals.length > 0 ? [openId, netId] : []));
  sections.push({ sectionId: "section:ipsas:cash", label: "Cash and cash equivalents", lines: cash });

  build("THIRD_PARTY_PAYMENTS", "Payments made by third parties on the entity's behalf (memorandum)", "Total third-party payments", false, false);

  const statement: Statement = { statementId: IPSAS_CASH_STATEMENT_ID, type: "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS", title: "Statement of cash receipts and payments", sections };
  return { status: "GENERATED", statement, facts, evidenceIndex, diagnostics };
}
