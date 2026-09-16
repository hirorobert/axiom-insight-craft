// Rule 3 — note-to-face reconciliation: a face line's value must equal the
// total disclosed in each note it references. A note with no declared
// `totalFactId` and no `movementSchedule` is narrative-only and NOT_APPLICABLE
// to this rule — reconciliation is never guessed from prose.

import { equalsWithinTolerance, formatMoney } from "../money";
import { resolveFact, statementContainingLine } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const RULE_ID = "note-to-face-reconciliation";
export const RULE_VERSION = "1.0.0";

export const noteToFaceReconciliationRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Note-to-face reconciliation",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    for (const noteRef of ctx.report.noteReferences) {
      const note = ctx.report.notes.find((n) => n.noteId === noteRef.toNoteId);
      const line = ctx.report.statements.flatMap((s) => s.sections.flatMap((sec) => sec.lines)).find((l) => l.lineId === noteRef.fromLineId);
      const discriminator = `${noteRef.noteReferenceId}`;
      const statement = line ? statementContainingLine(ctx.report, line.lineId) : undefined;
      const affected = { statementId: statement?.statementId, noteId: note?.noteId, lineId: line?.lineId };

      if (!note || !line) {
        // Broken-reference detection itself is Rule 10's job — this rule only
        // reconciles amounts, so it stays silent (NOT_APPLICABLE) here rather
        // than duplicating that finding.
        results.push({
          outcome: "NOT_APPLICABLE",
          severity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "face line value = note total",
          deterministicCalculation: "the referenced line or note does not resolve — see broken-note-reference rule",
          evidenceReferences: [],
          affected,
          remediationGuidance: "No action required from this rule.",
          discriminator,
        });
        continue;
      }

      const noteTotalFactId = note.totalFactId ?? note.movementSchedule?.closingBalanceFactId ?? null;
      if (!noteTotalFactId) {
        results.push({
          outcome: "NOT_APPLICABLE",
          severity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "face line value = note total",
          deterministicCalculation: `note "${note.noteId}" is narrative-only — no total declared to reconcile`,
          evidenceReferences: [],
          affected,
          remediationGuidance: "No action required.",
          discriminator,
        });
        continue;
      }

      const face = resolveFact(ctx, line.currentFactId);
      const noteTotal = resolveFact(ctx, noteTotalFactId);

      if (face.status !== "PRESENT" || noteTotal.status !== "PRESENT") {
        results.push({
          outcome: "INSUFFICIENT_EVIDENCE",
          severity: "MEDIUM",
          observedValues: {
            faceValue: { kind: "MONEY", value: face.status === "PRESENT" ? face.money : null },
            noteTotal: { kind: "MONEY", value: noteTotal.status === "PRESENT" ? noteTotal.money : null },
          },
          expectedRelationship: "face line value = note total",
          deterministicCalculation: "the face value or the note total is missing",
          evidenceReferences: [],
          affected,
          remediationGuidance: "Ensure both the face line and the note total are extracted before this rule can run.",
          discriminator,
        });
        continue;
      }

      const denominationMatches = face.money.currency === noteTotal.money.currency && face.money.scale === noteTotal.money.scale;
      const pass = denominationMatches && equalsWithinTolerance(face.money, noteTotal.money, ctx.tolerance);

      results.push({
        outcome: denominationMatches ? (pass ? "PASS" : "FAIL") : "INSUFFICIENT_EVIDENCE",
        severity: "HIGH",
        observedValues: {
          faceValue: { kind: "MONEY", value: face.money },
          noteTotal: { kind: "MONEY", value: noteTotal.money },
        },
        expectedRelationship: "face line value = note total",
        deterministicCalculation: denominationMatches
          ? `${formatMoney(face.money)} vs ${formatMoney(noteTotal.money)}`
          : "the face value and note total are denominated differently — cannot compare",
        evidenceReferences: [
          { evidenceReferenceId: `${discriminator}:face`, factId: line.currentFactId, lineId: line.lineId },
          { evidenceReferenceId: `${discriminator}:note`, factId: noteTotalFactId, noteId: note.noteId },
        ],
        affected,
        remediationGuidance: pass ? "No action required." : `Reconcile note "${note.noteId}" against face line "${line.lineId}" — they disagree.`,
        discriminator,
      });
    }
    return results;
  },
};
