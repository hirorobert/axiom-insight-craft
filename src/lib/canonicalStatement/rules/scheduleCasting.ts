// Rule 13 (rule pack v2) — a supporting breakdown must add up to its own total.
//
// For a note that declares a total fact and lists its component facts (and is
// not a movement schedule — Rule 7 owns those), the declared total must equal
// the sum of the other listed facts. A mismatch is reported with both figures;
// it is never adjusted. Notes that list no components, or whose total is the only
// fact, are NOT_APPLICABLE: a narrative note has nothing to cast.

import { equalsWithinTolerance, formatMoney, sumMoney, type Money } from "../money";
import { resolveFact } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const scheduleCastingRule: RuleDefinition = {
  ruleId: "schedule-casting",
  ruleVersion: "1.0.0",
  title: "Supporting schedule casting",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    for (const note of ctx.report.notes) {
      if (note.movementSchedule || !note.totalFactId) continue;
      const componentIds = note.monetaryFactIds.filter((id) => id !== note.totalFactId);
      if (componentIds.length === 0) continue;
      const discriminator = `${note.noteId}:casting`;
      const affected = { noteId: note.noteId };
      const total = resolveFact(ctx, note.totalFactId);
      const parts = componentIds.map((id) => resolveFact(ctx, id));
      if (total.status !== "PRESENT" || parts.some((p) => p.status !== "PRESENT")) {
        results.push({
          outcome: "INSUFFICIENT_EVIDENCE",
          failureSeverity: "MEDIUM",
          observedValues: { missingComponentCount: { kind: "COUNT", value: parts.filter((p) => p.status !== "PRESENT").length } },
          expectedRelationship: "declared total = sum of listed components",
          deterministicCalculation: "the total or one or more components have no value",
          evidenceReferences: [],
          affected,
          remediationGuidance: "Provide a value for every component and the total of this schedule.",
          discriminator,
        });
        continue;
      }
      const moneys = parts.map((p) => (p as { money: Money }).money);
      let sum: Money | null = null;
      try {
        sum = sumMoney(moneys);
      } catch {
        sum = null;
      }
      const ownMoney = (total as { money: Money }).money;
      const same = sum !== null && sum.currency === ownMoney.currency && sum.scale === ownMoney.scale;
      const pass = same && equalsWithinTolerance(ownMoney, sum as Money, ctx.tolerance);
      results.push({
        outcome: same ? (pass ? "PASS" : "FAIL") : "INSUFFICIENT_EVIDENCE",
        failureSeverity: "HIGH",
        observedValues: { declaredTotal: { kind: "MONEY", value: ownMoney }, sumOfComponents: { kind: "MONEY", value: sum } },
        expectedRelationship: "declared total = sum of listed components",
        deterministicCalculation: same ? `${formatMoney(ownMoney)} vs sum = ${formatMoney(sum as Money)}` : "components and total are denominated differently — cannot compare",
        evidenceReferences: [note.totalFactId, ...componentIds].map((factId, i) => ({ evidenceReferenceId: `${discriminator}:${i}`, factId, noteId: note.noteId })),
        affected,
        remediationGuidance: pass ? "No action required." : `Note "${note.title}": the declared total does not equal the sum of its components. The difference is reported, never adjusted.`,
        discriminator,
      });
    }
    return results;
  },
};
