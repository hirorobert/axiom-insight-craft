// Rule 7 — movement reconciliation: opening balance + additions - disposals
// +/- other movements = closing balance, for every Note that declares a
// movementSchedule (e.g. a PPE roll-forward). Notes without a schedule are
// NOT_APPLICABLE — most notes are narrative and have nothing to roll forward.

import { addMoney, equalsWithinTolerance, formatMoney, subtractMoney, sumMoney, type Money } from "../money";
import { resolveFact } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";
import type { MovementSchedule } from "../types";

export const RULE_ID = "movement-reconciliation";
export const RULE_VERSION = "1.0.0";

function evaluateSchedule(ctx: RuleContext, noteId: string, schedule: MovementSchedule): RuleEvaluationResult {
  const discriminator = schedule.scheduleId;
  const affected = { noteId };

  const opening = resolveFact(ctx, schedule.openingBalanceFactId);
  const closing = resolveFact(ctx, schedule.closingBalanceFactId);
  const additions = schedule.additionFactIds.map((id) => resolveFact(ctx, id));
  const disposals = schedule.disposalFactIds.map((id) => resolveFact(ctx, id));
  const other = schedule.otherMovements.map((ref) => ({ sign: ref.sign, resolved: resolveFact(ctx, ref.factId) }));

  const allResolved = [opening, closing, ...additions, ...disposals, ...other.map((o) => o.resolved)];
  const anyMissing = allResolved.some((r) => r.status !== "PRESENT");
  if (anyMissing) {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      severity: "MEDIUM",
      observedValues: {
        openingBalance: { kind: "MONEY", value: opening.status === "PRESENT" ? opening.money : null },
        closingBalance: { kind: "MONEY", value: closing.status === "PRESENT" ? closing.money : null },
      },
      expectedRelationship: "opening + additions - disposals +/- other movements = closing",
      deterministicCalculation: "one or more movement-schedule facts are missing",
      evidenceReferences: [],
      affected,
      remediationGuidance: `Ensure every fact in movement schedule "${schedule.scheduleId}" is extracted before this rule can run.`,
      discriminator,
    };
  }

  try {
    const openingMoney = (opening as { money: Money }).money;
    const closingMoney = (closing as { money: Money }).money;
    const additionsSum = sumMoney(additions.map((a) => (a as { money: Money }).money)) ?? { ...openingMoney, minorUnits: 0n };
    const disposalsSum = sumMoney(disposals.map((d) => (d as { money: Money }).money)) ?? { ...openingMoney, minorUnits: 0n };

    let running = addMoney(openingMoney, additionsSum);
    running = subtractMoney(running, disposalsSum);
    for (const { sign, resolved } of other) {
      const value = (resolved as { money: Money }).money;
      running = sign === "ADD" ? addMoney(running, value) : subtractMoney(running, value);
    }

    const pass = equalsWithinTolerance(running, closingMoney, ctx.tolerance);
    return {
      outcome: pass ? "PASS" : "FAIL",
      severity: "HIGH",
      observedValues: {
        openingBalance: { kind: "MONEY", value: openingMoney },
        computedClosing: { kind: "MONEY", value: running },
        reportedClosing: { kind: "MONEY", value: closingMoney },
      },
      expectedRelationship: "opening + additions - disposals +/- other movements = closing",
      deterministicCalculation: `${formatMoney(openingMoney)} + additions - disposals +/- other = ${formatMoney(running)} vs reported ${formatMoney(closingMoney)}`,
      evidenceReferences: [
        { evidenceReferenceId: `${discriminator}:opening`, factId: schedule.openingBalanceFactId },
        { evidenceReferenceId: `${discriminator}:closing`, factId: schedule.closingBalanceFactId },
      ],
      affected,
      remediationGuidance: pass ? "No action required." : `Movement schedule "${schedule.scheduleId}" does not reconcile — investigate the additions/disposals/other-movements figures.`,
      discriminator,
    };
  } catch {
    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      severity: "MEDIUM",
      observedValues: {},
      expectedRelationship: "opening + additions - disposals +/- other movements = closing",
      deterministicCalculation: "movement schedule facts are not all the same currency/scale — cannot sum",
      evidenceReferences: [],
      affected,
      remediationGuidance: "Resolve the currency/scale mismatch within this movement schedule.",
      discriminator,
    };
  }
}

export const movementReconciliationRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Movement reconciliation",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    for (const note of ctx.report.notes) {
      if (!note.movementSchedule) continue;
      results.push(evaluateSchedule(ctx, note.noteId, note.movementSchedule));
    }
    if (results.length === 0) {
      return [
        {
          outcome: "NOT_APPLICABLE",
          severity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "opening + additions - disposals +/- other movements = closing",
          deterministicCalculation: "no note declares a movement schedule",
          evidenceReferences: [],
          affected: {},
          remediationGuidance: "No action required.",
          discriminator: "no-movement-schedules",
        },
      ];
    }
    return results;
  },
};
