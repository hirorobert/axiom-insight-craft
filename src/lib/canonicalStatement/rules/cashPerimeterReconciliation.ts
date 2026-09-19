// Rule 6 v2 — cash-flow closing cash reconciles to the cash PERIMETER.
//
// Rule 6 v1 compares the cash-flow closing figure with ONE statement-of-financial-position
// line. That is wrong for a real entity whose cash is several bank accounts, cash on hand,
// mobile money, restricted/designated cash, overdrafts and an ECL allowance. When the report
// carries a cash-perimeter note (see financialGeneration/cashPerimeter.ts) this rule
//
//   1. tests   cash-flow closing cash  =  gross cash + overdrafts included in cash
//      (the ledger-derived figure against the trial-balance-derived perimeter), and
//   2. shows the reconciliation to the statement of financial position:
//        cash-flow closing cash − ECL allowance + overdraft included = net SFP cash
//      explaining the legitimate presentation differences.
//
// Nothing is adjusted: a difference is reported with every component. With no perimeter note
// the rule is exactly Rule 6 v1. If a perimeter note exists but carries no figures (the
// perimeter could not be established), the result is INSUFFICIENT_EVIDENCE — never a guess.

import { CANONICAL_CONCEPTS } from "../concepts";
import { equalsWithinTolerance, formatMoney, addMoney, negateMoney, subtractMoney, type Money } from "../money";
import { cashFlowClosingReconciliationRule } from "./cashFlowClosingReconciliation";
import { allPeriodIds, factIdForPeriod, resolveFact, resolveLineByConcept, statementsOfType } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const CASH_PERIMETER_NOTE_ID = "note:cash-perimeter";
const fid = (role: string, period: string) => `fact:cashperim:${role}:${period}`;

export const cashPerimeterReconciliationRule: RuleDefinition = {
  ruleId: "cashflow-closing-cash-reconciliation",
  ruleVersion: "2.0.0",
  title: "Cash-flow closing cash reconciliation (cash perimeter)",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const note = ctx.report.notes.find((n) => n.noteId === CASH_PERIMETER_NOTE_ID);
    if (!note) return cashFlowClosingReconciliationRule.evaluate(ctx);

    const cashFlowStatements = [...statementsOfType(ctx.report, "STATEMENT_OF_CASH_FLOWS"), ...statementsOfType(ctx.report, "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS")];
    const expectation = "cash-flow closing cash = gross cash + overdrafts included in cash; less ECL allowance = net cash on the statement of financial position";
    if (cashFlowStatements.length === 0) {
      return [{ outcome: "NOT_APPLICABLE", failureSeverity: "INFORMATIONAL", observedValues: {}, expectedRelationship: expectation, deterministicCalculation: "no cash flow / cash receipts and payments statement is present in this report", evidenceReferences: [], affected: { noteId: note.noteId }, remediationGuidance: "No action required.", discriminator: "no-cashflow-statement" }];
    }
    const results: RuleEvaluationResult[] = [];
    for (const st of cashFlowStatements) {
      const closing = resolveLineByConcept(st, CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF);
      const affected = { statementId: st.statementId, noteId: note.noteId };
      if (closing.status !== "UNIQUE") {
        results.push({ outcome: "INSUFFICIENT_EVIDENCE", failureSeverity: "HIGH", observedValues: {}, expectedRelationship: expectation, deterministicCalculation: closing.status === "NONE" ? "the statement has no closing-cash line" : "the statement has more than one closing-cash line", evidenceReferences: [], affected, remediationGuidance: "Present exactly one closing cash line.", discriminator: `${st.statementId}:closing-line` });
        continue;
      }
      for (const periodId of allPeriodIds(ctx.report)) {
        const isComparative = periodId !== ctx.report.period.periodId;
        const closingFactId = factIdForPeriod(closing.line, periodId);
        if (!closingFactId && isComparative) continue;
        const discriminator = `${st.statementId}:${periodId}`;
        const cf = resolveFact(ctx, closingFactId);
        const expected = resolveFact(ctx, fid("cfexpected", periodId));
        if (cf.status !== "PRESENT" || expected.status !== "PRESENT") {
          if (isComparative && expected.status !== "PRESENT") continue; // a comparative perimeter that could not be established is disclosed by the generator
          results.push({
            outcome: "INSUFFICIENT_EVIDENCE",
            failureSeverity: "CRITICAL",
            observedValues: { closingCash: { kind: "MONEY", value: cf.status === "PRESENT" ? cf.money : null }, perimeterCash: { kind: "MONEY", value: expected.status === "PRESENT" ? expected.money : null } },
            expectedRelationship: expectation,
            deterministicCalculation: expected.status !== "PRESENT" ? "the cash perimeter could not be established for this period (see the generation diagnostics)" : "the cash-flow closing cash is missing for this period",
            evidenceReferences: [],
            affected,
            remediationGuidance: "Complete the cash account map so every reviewed cash account has a category and appears in the trial balance; nothing is assumed in its place.",
            discriminator,
            periodId,
          });
          continue;
        }
        const denominationOk = cf.money.currency === expected.money.currency && cf.money.scale === expected.money.scale;
        const pass = denominationOk && equalsWithinTolerance(cf.money, expected.money, ctx.tolerance);
        const ecl = resolveFact(ctx, fid("ecl", periodId));
        const overdraft = resolveFact(ctx, fid("overdraft", periodId));
        const net = resolveFact(ctx, fid("net", periodId));
        const gross = resolveFact(ctx, fid("gross", periodId));
        const restricted = resolveFact(ctx, fid("restricted", periodId));
        const m = (r: ReturnType<typeof resolveFact>): Money | null => (r.status === "PRESENT" ? r.money : null);
        let calc: string;
        if (!denominationOk) calc = "denominated differently — cannot compare";
        else if (pass && ecl.status === "PRESENT" && overdraft.status === "PRESENT" && net.status === "PRESENT" && gross.status === "PRESENT") {
          // closing − ECL allowance (a positive amount) + overdrafts in cash (added back) = net SFP cash
          const allowance = negateMoney(ecl.money); // −E, a positive amount
          const overdraftAddBack = negateMoney(overdraft.money); // −O, a positive amount
          const rebuilt = addMoney(subtractMoney(cf.money, allowance), overdraftAddBack); // closing − allowance + overdrafts
          const restrictedText = restricted.status === "PRESENT" ? `; of gross cash ${formatMoney(gross.money)}, ${formatMoney(restricted.money)} is restricted or designated` : "";
          calc = `closing cash ${formatMoney(cf.money)} − ECL allowance ${formatMoney(allowance)} + overdrafts included in cash ${formatMoney(overdraftAddBack)} = net cash on the statement of financial position ${formatMoney(rebuilt)} (statement shows ${formatMoney(net.money)})${restrictedText}`;
        } else calc = `${formatMoney(cf.money)} vs perimeter ${formatMoney(expected.money)}`;
        results.push({
          outcome: denominationOk ? (pass ? "PASS" : "FAIL") : "INSUFFICIENT_EVIDENCE",
          failureSeverity: "CRITICAL",
          observedValues: {
            closingCash: { kind: "MONEY", value: cf.money },
            perimeterCash: { kind: "MONEY", value: expected.money },
            grossCash: { kind: "MONEY", value: m(gross) },
            restrictedCash: { kind: "MONEY", value: m(restricted) },
            eclAllowance: { kind: "MONEY", value: m(ecl) },
            overdraftsInCash: { kind: "MONEY", value: m(overdraft) },
            netSfpCash: { kind: "MONEY", value: m(net) },
          },
          expectedRelationship: expectation,
          deterministicCalculation: calc,
          evidenceReferences: [
            { evidenceReferenceId: `${discriminator}:closing`, factId: closingFactId },
            { evidenceReferenceId: `${discriminator}:perimeter`, factId: fid("cfexpected", periodId), noteId: note.noteId },
          ],
          affected,
          remediationGuidance: pass ? "No action required." : "The ledger-derived closing cash does not equal the cash perimeter built from the trial balance. Reconcile the ledger to the mapped accounts; the difference is reported, never adjusted.",
          discriminator,
          periodId,
        });
      }
    }
    return results;
  },
};
