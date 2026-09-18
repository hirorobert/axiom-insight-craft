// financialGeneration/equityStatement.ts — the statement of changes in equity
// (net assets/equity), generated from validated equity-movement evidence.
//
// One section per equity component, in the order the components first appear
// in the evidence. Each component shows its opening balance, every movement
// (as supplied, signed), and its closing balance. A closing balance stated in
// the evidence is presented AS STATED and tested against opening + movements by
// the canonical casting rule; only when none is stated is closing computed. The
// totals section carries the anchors the equity tie rules use: closing total
// equity (vs the statement of financial position) and the profit-or-loss
// movement (vs the statement of profit or loss). Nothing is plugged.

import { addMoney, sumMoney, type Money } from "@/lib/canonicalStatement/money";
import { CANONICAL_CONCEPTS } from "@/lib/canonicalStatement/concepts";
import type { MonetaryFact, Statement, StatementLine, StatementSection } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import { EQUITY_MOVEMENT_TYPES } from "@/lib/financialEvidence/schemas";
import { amountOf, columnReader, describeRows, evidenceFact, gap, periodRef, sameDenomination, slug, type EvidenceRowRef, type GenerationDiagnostic, type GenerationResult } from "./common";

export const EQUITY_STATEMENT_ID = "statement:changes-in-equity";

export const MOVEMENT_LABEL: Readonly<Record<string, string>> = {
  OPENING_BALANCE: "Balance at the beginning of the period",
  PROFIT_OR_LOSS: "Result for the period",
  OTHER_COMPREHENSIVE_INCOME: "Other comprehensive income",
  ISSUE_OF_SHARES: "Issue of shares",
  DIVIDENDS_OR_DISTRIBUTIONS: "Dividends or distributions",
  TRANSFER_BETWEEN_COMPONENTS: "Transfer between components",
  PRIOR_PERIOD_ADJUSTMENT: "Prior-period adjustment",
  OTHER_MOVEMENT: "Other movement",
  CLOSING_BALANCE: "Balance at the end of the period",
};

export interface EquityPeriodInput {
  readonly periodId: string;
  readonly isComparative: boolean;
  readonly batch: EvidenceBatch;
}

interface ComponentPeriod {
  opening?: { value: Money; row: number };
  stated?: { value: Money; row: number };
  /** key = type + description */
  movements: Map<string, { type: string; description: string; value: Money; rows: number[] }>;
}

export function buildEquityStatement(periods: readonly EquityPeriodInput[]): GenerationResult {
  if (periods.length === 0) return gap(["No equity-movement evidence is available."]);
  if (!sameDenomination(periods.map((p) => p.batch))) return gap(["The equity evidence for the reporting periods uses different currencies or scales."]);
  if (periods.filter((p) => !p.isComparative).length !== 1) return gap(["Exactly one current-period equity-movement batch is required."]);

  const diagnostics: GenerationDiagnostic[] = [];
  const componentOrder: string[] = [];
  const data = new Map<string, Map<string, ComponentPeriod>>(); // component -> periodId -> data

  for (const p of periods) {
    const read = columnReader(p.batch);
    for (let row = 1; row <= p.batch.document.rows.length; row++) {
      const component = read(row, "component");
      const type = read(row, "movement_type");
      const description = read(row, "description");
      const value = amountOf(p.batch, read(row, "amount"));
      if (!componentOrder.includes(component)) componentOrder.push(component);
      const byPeriod = data.get(component) ?? new Map<string, ComponentPeriod>();
      const cp: ComponentPeriod = byPeriod.get(p.periodId) ?? { movements: new Map() };
      if (type === "OPENING_BALANCE") cp.opening = { value, row };
      else if (type === "CLOSING_BALANCE") cp.stated = { value, row };
      else {
        const key = `${type}\u0000${description}`;
        const cur = cp.movements.get(key);
        cp.movements.set(key, { type, description, value: cur ? addMoney(cur.value, value) : value, rows: [...(cur?.rows ?? []), row] });
        if (type === "DIVIDENDS_OR_DISTRIBUTIONS" && value.minorUnits > 0n) {
          diagnostics.push({ code: "DIVIDEND_SIGN_POSITIVE", severity: "WARNING", message: `${component}: a dividend/distribution movement is positive (an increase in equity) on row ${row} of ${p.periodId}. Distributions are entered as negative amounts.` });
        }
      }
      byPeriod.set(p.periodId, cp);
      data.set(component, byPeriod);
    }
  }

  const missingOpening: string[] = [];
  for (const c of componentOrder) for (const p of periods) if (!data.get(c)?.get(p.periodId)?.opening) missingOpening.push(`${c} (${p.periodId})`);
  if (missingOpening.length > 0) return gap([`No opening balance was supplied for: ${missingOpening.join("; ")}. Opening equity cannot be inferred.`], diagnostics);

  const facts: MonetaryFact[] = [];
  const evidenceIndex: Record<string, EvidenceRowRef[]> = {};
  const values = new Map<string, Map<string, Money>>();
  const put = (lineId: string, p: EquityPeriodInput, value: Money, rows: readonly number[], text: string) => {
    const m = values.get(lineId) ?? new Map<string, Money>();
    m.set(p.periodId, value);
    values.set(lineId, m);
    facts.push(evidenceFact(p.batch, `fact:${lineId}:${p.periodId}`, value, periodRef(p.periodId, p.isComparative), rows[0] ?? 0, text));
    if (rows.length > 0) (evidenceIndex[lineId] ??= []).push({ batchId: p.batch.evidenceBatchId, rowNumbers: rows });
  };
  const bind = (lineId: string) => [...(values.get(lineId)?.keys() ?? [])].sort().map((periodId) => ({ periodId, factId: `fact:${lineId}:${periodId}` }));
  const line = (lineId: string, label: string, concept: string, role: StatementLine["role"], children: readonly string[]): StatementLine => ({ lineId, label, concept, role, normalBalance: "CREDIT_NORMAL", isContra: false, factBindings: bind(lineId), castingChildLineIds: children });

  const sections: StatementSection[] = [];
  const closingIds: string[] = [];
  const openingIds: string[] = [];
  const profitLineIds: string[] = [];

  for (const component of componentOrder) {
    const cslug = slug(component);
    const openId = `line:eq:${cslug}:opening`;
    const closeId = `line:eq:${cslug}:closing`;
    const movementKeys = [
      ...new Set(periods.flatMap((p) => [...(data.get(component)?.get(p.periodId)?.movements.entries() ?? [])].map(([k, v]) => `${v.type}\u0000${v.description}`))),
    ].sort((a, b) => {
      const [ta, da] = a.split("\u0000");
      const [tb, db] = b.split("\u0000");
      return EQUITY_MOVEMENT_TYPES.indexOf(ta as (typeof EQUITY_MOVEMENT_TYPES)[number]) - EQUITY_MOVEMENT_TYPES.indexOf(tb as (typeof EQUITY_MOVEMENT_TYPES)[number]) || (da < db ? -1 : da > db ? 1 : 0);
    });

    for (const p of periods) {
      const cp = data.get(component)!.get(p.periodId)!;
      put(openId, p, cp.opening!.value, [cp.opening!.row], describeRows([cp.opening!.row]));
    }
    const moveLines: StatementLine[] = [];
    for (const key of movementKeys) {
      const [type, description] = key.split("\u0000");
      const lineId = `line:eq:${cslug}:${type.toLowerCase()}:${slug(description)}`;
      for (const p of periods) {
        const m = data.get(component)?.get(p.periodId)?.movements.get(key);
        if (m) put(lineId, p, m.value, m.rows, describeRows(m.rows));
      }
      moveLines.push(line(lineId, description ? `${MOVEMENT_LABEL[type]} — ${description}` : MOVEMENT_LABEL[type], `equity_movement:${cslug}:${type.toLowerCase()}:${slug(description)}`, "DETAIL", []));
      if (type === "PROFIT_OR_LOSS") profitLineIds.push(lineId);
    }
    const childIds = [openId, ...moveLines.map((m) => m.lineId)];
    for (const p of periods) {
      const cp = data.get(component)!.get(p.periodId)!;
      const vals = childIds.map((id) => values.get(id)?.get(p.periodId));
      if (cp.stated) put(closeId, p, cp.stated.value, [cp.stated.row], `${describeRows([cp.stated.row])} (closing balance as stated in the evidence)`);
      else if (vals.every((v): v is Money => v !== undefined)) put(closeId, p, sumMoney(vals)!, [], "computed: opening balance plus movements (no closing balance was stated)");
      else diagnostics.push({ code: "CLOSING_NOT_PRESENTED", severity: "WARNING", message: `${component}: closing equity is not presented for ${p.periodId} because a movement line has no figure for that period and no closing balance was stated.` });
    }
    sections.push({ sectionId: `section:eq:${cslug}`, label: component, lines: [line(openId, MOVEMENT_LABEL.OPENING_BALANCE, `equity_opening:${cslug}`, "DETAIL", []), ...moveLines, line(closeId, MOVEMENT_LABEL.CLOSING_BALANCE, `equity_closing:${cslug}`, "TOTAL", childIds)] });
    closingIds.push(closeId);
    openingIds.push(openId);
  }

  // Totals section: anchors for the canonical tie rules.
  const totalLines: StatementLine[] = [];
  const total = (lineId: string, label: string, concept: string, children: readonly string[], text: string) => {
    for (const p of periods) {
      const vals = children.map((id) => values.get(id)?.get(p.periodId));
      if (vals.length > 0 && vals.every((v): v is Money => v !== undefined)) put(lineId, p, sumMoney(vals)!, [], text);
    }
    totalLines.push(line(lineId, label, concept, "TOTAL", children));
  };
  total("line:eq:total-opening", "Total equity at the beginning of the period", "socie_opening_total", openingIds, "computed: sum of component opening balances");
  if (profitLineIds.length > 0) total("line:eq:total-profit", "Result for the period recognised in equity", CANONICAL_CONCEPTS.SOCIE_PROFIT_OR_LOSS_TOTAL, profitLineIds, "computed: sum of component result movements");
  else diagnostics.push({ code: "NO_PROFIT_OR_LOSS_MOVEMENT", severity: "WARNING", message: "No PROFIT_OR_LOSS movement was supplied for any component; the result-for-the-period tie to the statement of profit or loss cannot be tested." });
  total("line:eq:total-closing", "Total equity at the end of the period", CANONICAL_CONCEPTS.SOCIE_CLOSING_TOTAL, closingIds, "computed: sum of component closing balances");
  sections.push({ sectionId: "section:eq:total", label: "Total equity", lines: totalLines });

  const statement: Statement = { statementId: EQUITY_STATEMENT_ID, type: "STATEMENT_OF_CHANGES_IN_EQUITY", title: "Statement of changes in equity", sections };
  return { status: "GENERATED", statement, facts, evidenceIndex, diagnostics };
}
