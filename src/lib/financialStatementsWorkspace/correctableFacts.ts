// financialStatementsWorkspace/correctableFacts.ts — which SOURCE figures a
// reviewer may correct in response to a finding. A finding usually points at
// total lines (e.g. "total assets != liabilities + equity"); the figures a
// human can actually correct are the source-account facts underneath. This
// expands the finding's lines through their declared casting children down to
// DETAIL lines, and lists each detail fact with a readable label. Derived
// (subtotal/total) facts are never offered: they are re-derived automatically
// when a source figure is corrected.

import type { CanonicalFinancialStatementReport, RuleEvaluationRecord, StatementLine } from "@/lib/canonicalStatement/types";
import { resolveLatestFact } from "@/lib/canonicalStatement/provenance";
import { formatMoney } from "@/lib/canonicalStatement/money";

export interface CorrectableFact {
  readonly factId: string;
  readonly periodId: string;
  readonly label: string;
  readonly currentAmount: string | null;
}

export function correctableFacts(report: CanonicalFinancialStatementReport, finding: RuleEvaluationRecord): readonly CorrectableFact[] {
  const linesById = new Map<string, StatementLine>();
  for (const st of report.statements) for (const sec of st.sections) for (const l of sec.lines) linesById.set(l.lineId, l);

  const seedIds = new Set<string>();
  if (finding.affected.lineId) seedIds.add(finding.affected.lineId);
  for (const e of finding.evidenceReferences) if (e.lineId) seedIds.add(e.lineId);

  const detailIds = new Set<string>();
  const visit = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    const line = linesById.get(id);
    if (!line) return;
    if (line.role === "DETAIL") detailIds.add(id);
    for (const child of line.castingChildLineIds) visit(child, seen);
  };
  for (const id of [...seedIds].sort()) visit(id, new Set());

  const periodYearById = new Map<string, number>([[report.period.periodId, report.period.periodYear]]);
  for (const p of report.comparativePeriods) periodYearById.set(p.periodId, p.periodYear);

  const out: CorrectableFact[] = [];
  for (const id of [...detailIds].sort()) {
    const line = linesById.get(id)!;
    for (const binding of line.factBindings) {
      const fact = resolveLatestFact(report.facts, binding.factId);
      out.push({
        factId: binding.factId,
        periodId: binding.periodId,
        label: `${line.label} (${periodYearById.get(binding.periodId) ?? binding.periodId})`,
        currentAmount: fact?.value ? formatMoney(fact.value) : null,
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.factId.localeCompare(b.factId));
}
