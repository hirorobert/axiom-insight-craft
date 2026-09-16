// Rule 10 — broken or orphaned note-reference detection.
// "Broken": a NoteReference.toNoteId that does not resolve to any Note.
// "Orphaned": a NoteReference.fromLineId that does not resolve to any
// StatementLine (a dangling back-reference from a since-removed/renumbered
// line). A Note that legitimately has zero inbound references (e.g. "Basis
// of preparation") is normal and never flagged — this rule only follows
// NoteReference edges, it never infers that every Note must be referenced.

import { allLines } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const RULE_ID = "orphaned-note-reference-detection";
export const RULE_VERSION = "1.0.0";

export const orphanedNoteReferenceDetectionRule: RuleDefinition = {
  ruleId: RULE_ID,
  ruleVersion: RULE_VERSION,
  title: "Broken or orphaned note-reference detection",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    if (ctx.report.noteReferences.length === 0) {
      return [
        {
          outcome: "NOT_APPLICABLE",
          severity: "INFORMATIONAL",
          observedValues: {},
          expectedRelationship: "every note reference resolves to an existing line and an existing note",
          deterministicCalculation: "this report declares no note references",
          evidenceReferences: [],
          affected: {},
          remediationGuidance: "No action required.",
          discriminator: "no-note-references",
        },
      ];
    }

    const noteIds = new Set(ctx.report.notes.map((n) => n.noteId));
    const lineIds = new Set(ctx.report.statements.flatMap((s) => allLines(s).map((l) => l.lineId)));

    return ctx.report.noteReferences.map((ref) => {
      const noteExists = noteIds.has(ref.toNoteId);
      const lineExists = lineIds.has(ref.fromLineId);
      const discriminator = ref.noteReferenceId;
      const affected = { lineId: lineExists ? ref.fromLineId : undefined, noteId: noteExists ? ref.toNoteId : undefined };

      if (noteExists && lineExists) {
        return {
          outcome: "PASS" as const,
          severity: "LOW" as const,
          observedValues: {},
          expectedRelationship: "every note reference resolves to an existing line and an existing note",
          deterministicCalculation: `"${ref.fromLineId}" -> "${ref.toNoteId}" both resolve`,
          evidenceReferences: [{ evidenceReferenceId: discriminator, lineId: ref.fromLineId, noteId: ref.toNoteId }],
          affected,
          remediationGuidance: "No action required.",
          discriminator,
        };
      }

      const reasons: string[] = [];
      if (!noteExists) reasons.push(`toNoteId "${ref.toNoteId}" does not resolve to any note (broken reference)`);
      if (!lineExists) reasons.push(`fromLineId "${ref.fromLineId}" does not resolve to any statement line (orphaned reference)`);

      return {
        outcome: "FAIL" as const,
        severity: "HIGH" as const,
        observedValues: {},
        expectedRelationship: "every note reference resolves to an existing line and an existing note",
        deterministicCalculation: reasons.join("; "),
        evidenceReferences: [],
        affected,
        remediationGuidance: "Remove the dangling note reference, or restore/re-link the missing line or note.",
        discriminator,
      };
    });
  },
};
