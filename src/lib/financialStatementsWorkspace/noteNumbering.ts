// financialStatementsWorkspace/noteNumbering.ts — deterministic note
// numbering and note/face cross-reference diagnostics over canonical data.
// Only real report content is used: nothing here invents a note, a policy
// or a reference. Numbers are assigned by order of first reference from the
// face statements (statement order, section order, line order), then any
// unreferenced notes follow in noteId order — independent of the order the
// notes array happens to be stored in.

import type { CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";

export type NoteDiagnosticCode = "NOTE_NOT_REFERENCED" | "REFERENCE_TO_MISSING_NOTE" | "REFERENCE_FROM_MISSING_LINE" | "DECLARED_NUMBER_DIFFERS";

export interface NoteDiagnostic {
  readonly code: NoteDiagnosticCode;
  readonly message: string;
  readonly noteId?: string;
  readonly lineId?: string;
}

export interface NoteNumberingResult {
  /** noteId -> derived note number (1-based, as text). */
  readonly numberByNoteId: ReadonlyMap<string, string>;
  /** face lineId -> derived note numbers referenced from it, ascending numerically. */
  readonly noteNumbersByLineId: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics: readonly NoteDiagnostic[];
}

export function deriveNoteNumbering(report: CanonicalFinancialStatementReport): NoteNumberingResult {
  const noteIds = new Set(report.notes.map((n) => n.noteId));
  const lineOrder: string[] = [];
  for (const statement of report.statements) for (const section of statement.sections) for (const line of section.lines) lineOrder.push(line.lineId);
  const lineIds = new Set(lineOrder);
  const lineRank = new Map(lineOrder.map((id, i) => [id, i]));

  const diagnostics: NoteDiagnostic[] = [];
  const orderedRefs = [...report.noteReferences].sort((a, b) => {
    const ra = lineRank.get(a.fromLineId) ?? Number.MAX_SAFE_INTEGER;
    const rb = lineRank.get(b.fromLineId) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || a.toNoteId.localeCompare(b.toNoteId) || a.noteReferenceId.localeCompare(b.noteReferenceId);
  });

  const numberByNoteId = new Map<string, string>();
  let next = 1;
  for (const ref of orderedRefs) {
    if (!lineIds.has(ref.fromLineId)) {
      diagnostics.push({ code: "REFERENCE_FROM_MISSING_LINE", message: `Note reference "${ref.noteReferenceId}" points from line "${ref.fromLineId}", which is not on any statement.`, lineId: ref.fromLineId, noteId: ref.toNoteId });
      continue;
    }
    if (!noteIds.has(ref.toNoteId)) {
      diagnostics.push({ code: "REFERENCE_TO_MISSING_NOTE", message: `Line "${ref.fromLineId}" references note "${ref.toNoteId}", which does not exist.`, lineId: ref.fromLineId, noteId: ref.toNoteId });
      continue;
    }
    if (!numberByNoteId.has(ref.toNoteId)) numberByNoteId.set(ref.toNoteId, String(next++));
  }
  for (const note of [...report.notes].sort((a, b) => a.noteId.localeCompare(b.noteId))) {
    if (!numberByNoteId.has(note.noteId)) {
      numberByNoteId.set(note.noteId, String(next++));
      diagnostics.push({ code: "NOTE_NOT_REFERENCED", message: `Note "${note.title}" is not referenced from any line on the face of the statements.`, noteId: note.noteId });
    }
  }
  for (const note of report.notes) {
    const derived = numberByNoteId.get(note.noteId);
    if (note.noteNumber && derived && note.noteNumber !== derived) {
      diagnostics.push({ code: "DECLARED_NUMBER_DIFFERS", message: `Note "${note.title}" declares number ${note.noteNumber} but its deterministic position is ${derived}.`, noteId: note.noteId });
    }
  }

  const byLine = new Map<string, string[]>();
  for (const ref of orderedRefs) {
    const n = numberByNoteId.get(ref.toNoteId);
    if (!n || !lineIds.has(ref.fromLineId)) continue;
    const list = byLine.get(ref.fromLineId) ?? [];
    if (!list.includes(n)) list.push(n);
    byLine.set(ref.fromLineId, list);
  }
  for (const list of byLine.values()) list.sort((a, b) => Number(a) - Number(b));

  diagnostics.sort((a, b) => a.code.localeCompare(b.code) || (a.noteId ?? "").localeCompare(b.noteId ?? "") || (a.lineId ?? "").localeCompare(b.lineId ?? ""));
  return { numberByNoteId, noteNumbersByLineId: byLine, diagnostics };
}
