// financialGeneration/cashFlowDirect.ts — the direct-method statement of cash
// flows, generated from a validated cash transaction ledger.
//
// Each ledger row is one cash receipt or payment carrying an explicit activity
// (operating / investing / financing) and an explicit presentation line label
// supplied by the preparer. The generator only groups and sums: receipts are
// positive, payments negative, and every presented line is the exact sum of the
// evidence rows behind it. Closing cash = opening cash + net movement, and is
// then tested against the statement of financial position by the canonical rule
// pack (Rule 6). There is NO balancing figure: a difference is a finding.
//
// A missing opening cash figure yields a partial statement WITHOUT opening or
// closing lines — never a zero, never an inferred figure.

import { addMoney, subtractMoney, sumMoney, type Money } from "@/lib/canonicalStatement/money";
import { CANONICAL_CONCEPTS } from "@/lib/canonicalStatement/concepts";
import type { MonetaryFact, Statement, StatementLine, StatementSection } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { amountOf, byCodepoint, columnReader, describeRows, evidenceFact, gap, periodRef, sameDenomination, slug, type EvidenceRowRef, type GenerationDiagnostic, type GenerationResult } from "./common";

export const CASH_FLOW_STATEMENT_ID = "statement:cash-flows";
const ACTIVITY_ORDER = ["OPERATING", "INVESTING", "FINANCING"] as const;
const ACTIVITY_TITLE: Readonly<Record<(typeof ACTIVITY_ORDER)[number], string>> = {
  OPERATING: "operating activities",
  INVESTING: "investing activities",
  FINANCING: "financing activities",
};

export interface CashFlowPeriodInput {
  readonly periodId: string;
  readonly isComparative: boolean;
  readonly ledger: EvidenceBatch;
  /** Cash and cash equivalents at the start of this period, from reviewed evidence. null = not available. */
  readonly openingCash: Money | null;
  /** Where the opening figure came from (recorded in the fact's provenance text). */
  readonly openingSource?: string;
}

interface PeriodAggregate {
  readonly input: CashFlowPeriodInput;
  /** activity -> label -> { net, rows } */
  readonly byLine: Map<string, Map<string, { net: Money; rows: number[] }>>;
}

function aggregate(input: CashFlowPeriodInput): PeriodAggregate {
  const read = columnReader(input.ledger);
  const byLine = new Map<string, Map<string, { net: Money; rows: number[] }>>();
  for (let row = 1; row <= input.ledger.document.rows.length; row++) {
    const activity = read(row, "activity");
    const label = read(row, "cash_flow_line");
    const receipt = read(row, "receipt");
    const amount = receipt !== "" ? amountOf(input.ledger, receipt) : subtractMoney(amountOf(input.ledger, "0"), amountOf(input.ledger, read(row, "payment")));
    const lines = byLine.get(activity) ?? new Map();
    const cur = lines.get(label);
    lines.set(label, { net: cur ? addMoney(cur.net, amount) : amount, rows: [...(cur?.rows ?? []), row] });
    byLine.set(activity, lines);
  }
  return { input, byLine };
}

export function buildDirectCashFlow(periods: readonly CashFlowPeriodInput[]): GenerationResult {
  const diagnostics: GenerationDiagnostic[] = [];
  if (periods.length === 0) return gap(["No cash transaction ledger is available."]);
  if (!sameDenomination(periods.map((p) => p.ledger))) return gap(["The cash ledgers for the reporting periods use different currencies or scales."]);
  const current = periods.filter((p) => !p.isComparative);
  if (current.length !== 1) return gap(["Exactly one current-period cash ledger is required."]);

  const aggs = periods.map(aggregate);
  const denomination = periods[0].ledger;
  const facts: MonetaryFact[] = [];
  const evidenceIndex: Record<string, EvidenceRowRef[]> = {};
  const lineValues = new Map<string, Map<string, Money>>(); // lineId -> periodId -> value
  const setValue = (lineId: string, periodId: string, v: Money) => {
    const m = lineValues.get(lineId) ?? new Map<string, Money>();
    m.set(periodId, v);
    lineValues.set(lineId, m);
  };
  const bindings = (lineId: string) => [...(lineValues.get(lineId)?.keys() ?? [])].sort(byCodepoint).map((periodId) => ({ periodId, factId: `fact:${lineId}:${periodId}` }));
  const addFact = (lineId: string, agg: PeriodAggregate, value: Money, rows: readonly number[], text: string) => {
    const p = agg.input;
    setValue(lineId, p.periodId, value);
    facts.push(evidenceFact(p.ledger, `fact:${lineId}:${p.periodId}`, value, periodRef(p.periodId, p.isComparative), rows[0] ?? 0, text));
    if (rows.length > 0) (evidenceIndex[lineId] ??= []).push({ batchId: p.ledger.evidenceBatchId, rowNumbers: rows });
  };

  const sections: StatementSection[] = [];
  const subtotalIds: string[] = [];

  for (const activity of ACTIVITY_ORDER) {
    const labels = [...new Set(aggs.flatMap((a) => [...(a.byLine.get(activity)?.keys() ?? [])]))].sort(byCodepoint);
    if (labels.length === 0) continue;
    const detail: StatementLine[] = [];
    for (const label of labels) {
      const lineId = `line:cf:${activity.toLowerCase()}:${slug(label)}`;
      for (const agg of aggs) {
        const cell = agg.byLine.get(activity)?.get(label);
        if (cell) addFact(lineId, agg, cell.net, cell.rows, describeRows(cell.rows));
      }
      detail.push({ lineId, label, concept: `cash_flow_line:${activity.toLowerCase()}:${slug(label)}`, role: "DETAIL", normalBalance: "DEBIT_NORMAL", isContra: false, factBindings: bindings(lineId), castingChildLineIds: [] });
    }
    const subId = `line:cf:${activity.toLowerCase()}:net`;
    for (const agg of aggs) {
      const vals = detail.map((d) => lineValues.get(d.lineId)?.get(agg.input.periodId));
      if (vals.every((v): v is Money => v !== undefined)) {
        const total = sumMoney(vals)!;
        addFact(subId, agg, total, [], `computed: sum of ${detail.length} presented line${detail.length === 1 ? "" : "s"}`);
      } else {
        diagnostics.push({ code: "SUBTOTAL_OMITTED_MISSING_LINE", severity: "WARNING", message: `Net cash from ${ACTIVITY_TITLE[activity]} is not presented for ${agg.input.periodId} because a presented line has no figure for that period.` });
      }
    }
    subtotalIds.push(subId);
    sections.push({
      sectionId: `section:cf:${activity.toLowerCase()}`,
      label: `Cash flows from ${ACTIVITY_TITLE[activity]}`,
      lines: [...detail, { lineId: subId, label: `Net cash from ${ACTIVITY_TITLE[activity]}`, concept: `cash_flow_net:${activity.toLowerCase()}`, role: "SUBTOTAL", normalBalance: "DEBIT_NORMAL", isContra: false, factBindings: bindings(subId), castingChildLineIds: detail.map((d) => d.lineId) }],
    });
  }

  if (sections.length === 0) return gap(["The cash ledger contains no usable rows."]);

  const netId = "line:cf:net-increase";
  const openingId = "line:cf:opening";
  const closingId = "line:cf:closing";
  const cashLines: StatementLine[] = [];
  for (const agg of aggs) {
    const subs = subtotalIds.map((id) => lineValues.get(id)?.get(agg.input.periodId));
    if (subs.every((v): v is Money => v !== undefined)) addFact(netId, agg, sumMoney(subs)!, [], "computed: sum of the activity subtotals");
  }
  cashLines.push({ lineId: netId, label: "Net increase (decrease) in cash and cash equivalents", concept: "cash_flow_net_increase", role: "TOTAL", normalBalance: "DEBIT_NORMAL", isContra: false, factBindings: bindings(netId), castingChildLineIds: subtotalIds });

  const haveOpening = aggs.filter((a) => a.input.openingCash !== null);
  for (const agg of haveOpening) addFact(openingId, agg, agg.input.openingCash!, [], `opening cash and cash equivalents taken from ${agg.input.openingSource ?? "reviewed evidence"}`);
  const missingOpening = aggs.filter((a) => a.input.openingCash === null).map((a) => a.input.periodId);
  if (missingOpening.length > 0) {
    diagnostics.push({ code: "OPENING_CASH_MISSING", severity: "WARNING", message: `Opening cash and cash equivalents is not available for ${missingOpening.join(", ")}; opening and closing cash are not presented for that period and nothing is assumed.` });
  }
  if (haveOpening.length > 0) {
    cashLines.push({ lineId: openingId, label: "Cash and cash equivalents at the beginning of the period", concept: "cash_flow_opening", role: "DETAIL", normalBalance: "DEBIT_NORMAL", isContra: false, factBindings: bindings(openingId), castingChildLineIds: [] });
    for (const agg of haveOpening) {
      const net = lineValues.get(netId)?.get(agg.input.periodId);
      if (net) addFact(closingId, agg, addMoney(agg.input.openingCash!, net), [], "computed: opening cash plus net movement — compared with the statement of financial position by the rule pack, never adjusted");
    }
    cashLines.push({ lineId: closingId, label: "Cash and cash equivalents at the end of the period", concept: CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF, role: "TOTAL", normalBalance: "DEBIT_NORMAL", isContra: false, factBindings: bindings(closingId), castingChildLineIds: [openingId, netId] });
  }
  sections.push({ sectionId: "section:cf:cash", label: "Cash and cash equivalents", lines: cashLines });

  const statement: Statement = { statementId: CASH_FLOW_STATEMENT_ID, type: "STATEMENT_OF_CASH_FLOWS", title: "Statement of cash flows (direct method)", sections };
  void denomination;
  return { status: "GENERATED", statement, facts, evidenceIndex, diagnostics };
}
