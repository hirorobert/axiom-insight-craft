// financialGeneration/notesAndSchedules.ts — notes, accounting policies and
// supporting schedules, assembled ONLY from preparer-supplied evidence.
//
// No policy wording, note wording or disclosure is ever generated: the words are
// the preparer's, kept verbatim with provenance to the evidence row. This module
// arranges them:
//   * a POLICY row becomes an accounting policy; a DISCLOSURE row a textual one;
//   * a NOTE row becomes a note (its body a textual disclosure attached to it);
//   * a supporting schedule becomes numeric facts on a note — a movement schedule
//     where opening/closing roles exist, otherwise a breakdown with a total —
//     joined to the face by `ties_to_line_key`, so the canonical rules (note to
//     face, movement reconciliation, schedule casting) check them;
//   * the framework profile's disclosure areas become a checklist whose every
//     item is PROVIDED, NOT_APPLICABLE_WITH_RATIONALE or MISSING — never guessed.
// Note numbers are the deterministic ones from noteNumbering.ts.

import type { AccountingPolicy, CanonicalFinancialStatementReport, MonetaryFact, Note, NoteReference, ProvenanceRecord, StatementLine, TextualDisclosure } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import type { DisclosureArea } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { deriveNoteNumbering } from "@/lib/financialStatementsWorkspace/noteNumbering";
import { amountOf, byCodepoint, columnReader, evidenceFact, periodRef, slug, type GenerationDiagnostic } from "./common";

export type ChecklistState = "PROVIDED" | "NOT_APPLICABLE_WITH_RATIONALE" | "MISSING";

export interface ChecklistItem {
  readonly areaId: string;
  readonly label: string;
  readonly reference: string;
  readonly state: ChecklistState;
  /** The note/policy key that satisfies it, or the N/A rationale text. */
  readonly satisfiedBy?: string;
  readonly rationale?: string;
}

export interface NotesAssembly {
  readonly notes: readonly Note[];
  readonly noteReferences: readonly NoteReference[];
  readonly accountingPolicies: readonly AccountingPolicy[];
  readonly textualDisclosures: readonly TextualDisclosure[];
  readonly facts: readonly MonetaryFact[];
  readonly checklist: readonly ChecklistItem[];
  readonly diagnostics: readonly GenerationDiagnostic[];
  /** schedule key -> its evidence batch and row numbers, for drill-down. */
  readonly scheduleRows: Readonly<Record<string, { readonly batchId: string; readonly rowNumbers: readonly number[] }>>;
}

function lineByKey(report: CanonicalFinancialStatementReport, key: string): StatementLine | "NONE" | "AMBIGUOUS" {
  const matches: StatementLine[] = [];
  for (const st of report.statements) for (const sec of st.sections) for (const l of sec.lines) if (l.lineId === key || l.concept === key) matches.push(l);
  return matches.length === 0 ? "NONE" : matches.length > 1 ? "AMBIGUOUS" : matches[0];
}

function textProvenance(batch: EvidenceBatch, row: number, text: string): ProvenanceRecord {
  return {
    source: { sourceDocumentId: batch.evidenceBatchId, sourceHash: batch.contentHash, artifactKind: "EVIDENCE_BATCH", ...(batch.sourceFileName ? { originalFileName: batch.sourceFileName } : {}) },
    locator: { kind: "EVIDENCE_ROW", batchId: batch.evidenceBatchId, rowNumber: row },
    extractionMethod: "EVIDENCE_BATCH_DERIVED",
    extractionConfidence: { kind: "CERTAIN" },
    originalText: text,
  };
}

/** Notes built elsewhere (e.g. the cash perimeter) that need deterministic numbering; `unreferencedNoteIds` are legitimately not referenced from a face line. */
export interface ExtraNotes {
  readonly notes: readonly Note[];
  readonly unreferencedNoteIds: readonly string[];
}

export function assembleNotes(report: CanonicalFinancialStatementReport, notesBatch: EvidenceBatch | null, scheduleBatches: readonly EvidenceBatch[], areas: readonly DisclosureArea[], extra?: ExtraNotes): NotesAssembly {
  const diagnostics: GenerationDiagnostic[] = [];
  const notes = new Map<string, Note>(extra?.notes.map((n) => [n.noteId, n] as const) ?? []);
  const refs: NoteReference[] = [];
  const policies: AccountingPolicy[] = [];
  const disclosures: TextualDisclosure[] = [];
  const facts: MonetaryFact[] = [];
  const scheduleRows: Record<string, { batchId: string; rowNumbers: number[] }> = {};
  const currentPeriodId = report.period.periodId;
  const noteIdOf = (key: string) => `note:${slug(key)}`;

  const addRef = (fromLineId: string, noteId: string) => {
    const id = `ref:${slug(`${fromLineId}->${noteId}`)}`;
    if (!refs.some((r) => r.noteReferenceId === id)) refs.push({ noteReferenceId: id, fromLineId, toNoteId: noteId });
  };
  const resolveLines = (keys: string, context: string): StatementLine[] => {
    const out: StatementLine[] = [];
    for (const key of keys.split(";").map((k) => k.trim()).filter(Boolean)) {
      const l = lineByKey(report, key);
      if (l === "NONE") diagnostics.push({ code: "LINE_KEY_UNRESOLVED", severity: "WARNING", message: `${context}: line key "${key}" matches no statement line, so no note reference was created.` });
      else if (l === "AMBIGUOUS") diagnostics.push({ code: "LINE_KEY_AMBIGUOUS", severity: "WARNING", message: `${context}: line key "${key}" matches more than one statement line; no note reference was created.` });
      else out.push(l);
    }
    return out;
  };

  // ── supporting schedules ────────────────────────────────────────────────
  for (const batch of scheduleBatches) {
    if (batch.periodRole !== "CURRENT") {
      diagnostics.push({ code: "COMPARATIVE_SCHEDULE_NOT_RENDERED", severity: "INFO", message: `Schedule batch ${batch.evidenceBatchId} is for a comparative period; comparative note columns are not generated in this version.` });
      continue;
    }
    const read = columnReader(batch);
    const byKey = new Map<string, number[]>();
    for (let row = 1; row <= batch.document.rows.length; row++) byKey.set(read(row, "schedule_key"), [...(byKey.get(read(row, "schedule_key")) ?? []), row]);
    for (const [key, rows] of [...byKey.entries()].sort((a, b) => byCodepoint(a[0], b[0]))) {
      const noteId = noteIdOf(key);
      const factIdOf = (row: number) => `fact:sch:${slug(key)}:r${row}`;
      const rowsByRole = (role: string) => rows.filter((r) => read(r, "role") === role);
      for (const row of rows) facts.push(evidenceFact(batch, factIdOf(row), amountOf(batch, read(row, "amount")), periodRef(currentPeriodId, false), row, `${read(row, "role")}: ${read(row, "row_label")}`));
      scheduleRows[key] = { batchId: batch.evidenceBatchId, rowNumbers: rows };

      const opening = rowsByRole("OPENING")[0];
      const closing = rowsByRole("CLOSING")[0];
      const total = rowsByRole("TOTAL")[0];
      let note: Note = { noteId, noteNumber: "0", title: read(rows[0], "schedule_title"), monetaryFactIds: rows.map(factIdOf) };
      if (opening && closing) {
        note = {
          ...note,
          totalFactId: factIdOf(closing),
          movementSchedule: {
            scheduleId: `schedule:${slug(key)}`,
            openingBalanceFactId: factIdOf(opening),
            additionFactIds: rowsByRole("ADDITION").map(factIdOf),
            disposalFactIds: rowsByRole("DISPOSAL").map(factIdOf),
            otherMovements: [
              ...rowsByRole("OTHER_ADD").map((r) => ({ factId: factIdOf(r), sign: "ADD" as const })),
              ...rowsByRole("OTHER_SUBTRACT").map((r) => ({ factId: factIdOf(r), sign: "SUBTRACT" as const })),
            ],
            closingBalanceFactId: factIdOf(closing),
          },
        };
      } else if (total) {
        note = { ...note, totalFactId: factIdOf(total) };
      } else if (closing) {
        note = { ...note, totalFactId: factIdOf(closing) };
      } else {
        diagnostics.push({ code: "SCHEDULE_NO_TOTAL", severity: "WARNING", message: `Schedule "${key}" has neither a TOTAL nor a CLOSING row, so it cannot be tied to the face or cast.` });
      }
      notes.set(noteId, note);
      const tie = rows.map((r) => read(r, "ties_to_line_key")).find((v) => v !== "");
      if (tie) for (const l of resolveLines(tie, `Schedule "${key}"`)) addRef(l.lineId, noteId);
      else diagnostics.push({ code: "SCHEDULE_NOT_TIED_TO_FACE", severity: "INFO", message: `Schedule "${key}" names no ties_to_line_key, so it is not reconciled to a line on the face.` });
    }
  }

  // ── notes, policies and disclosures ─────────────────────────────────────
  const areaState = new Map<string, ChecklistItem>();
  if (notesBatch) {
    const read = columnReader(notesBatch);
    for (let row = 1; row <= notesBatch.document.rows.length; row++) {
      const kind = read(row, "kind");
      const key = read(row, "key");
      const title = read(row, "title");
      const body = notesBatch.document.rows[row - 1][notesBatch.document.columns.indexOf("body")];
      const ref = read(row, "checklist_ref");
      const notApplicable = read(row, "applicability") === "NOT_APPLICABLE";
      const provenance = textProvenance(notesBatch, row, body);
      if (ref !== "") {
        const area = areas.find((a) => a.id === ref);
        if (!area) diagnostics.push({ code: "CHECKLIST_REF_UNKNOWN", severity: "WARNING", message: `Row ${row}: checklist reference "${ref}" is not a disclosure area of this framework profile.` });
        else areaState.set(ref, notApplicable ? { areaId: area.id, label: area.label, reference: area.reference, state: "NOT_APPLICABLE_WITH_RATIONALE", satisfiedBy: key, rationale: body } : { areaId: area.id, label: area.label, reference: area.reference, state: "PROVIDED", satisfiedBy: key });
      }
      if (notApplicable) continue; // a not-applicable declaration is recorded on the checklist, not published as a note
      if (kind === "POLICY") policies.push({ policyId: `policy:${slug(key)}`, topic: title, text: body, provenance });
      else if (kind === "DISCLOSURE") disclosures.push({ disclosureId: `disclosure:${slug(key)}`, text: `${title}\n${body}`, provenance });
      else {
        const noteId = noteIdOf(key);
        const existing = notes.get(noteId);
        notes.set(noteId, existing ? { ...existing, title } : { noteId, noteNumber: "0", title, monetaryFactIds: [] });
        disclosures.push({ disclosureId: `disclosure:${slug(`note:${key}`)}`, relatedNoteId: noteId, text: body, provenance });
        const applies = read(row, "applies_to_line_keys");
        if (applies) for (const l of resolveLines(applies, `Note "${key}"`)) addRef(l.lineId, noteId);
      }
    }
  }

  const checklist: ChecklistItem[] = areas.map((a) => areaState.get(a.id) ?? { areaId: a.id, label: a.label, reference: a.reference, state: "MISSING" });

  // Deterministic numbering: assemble, derive, then set the derived number on each note.
  const provisional: CanonicalFinancialStatementReport = { ...report, notes: [...notes.values()], noteReferences: [...report.noteReferences, ...refs] };
  const numbering = deriveNoteNumbering(provisional);
  const numbered = [...notes.values()].map((n) => ({ ...n, noteNumber: numbering.numberByNoteId.get(n.noteId) ?? "0" })).sort((a, b) => Number(a.noteNumber) - Number(b.noteNumber));
  for (const d of numbering.diagnostics) if (d.code === "NOTE_NOT_REFERENCED" && !(d.noteId && extra?.unreferencedNoteIds.includes(d.noteId))) diagnostics.push({ code: "NOTE_NOT_REFERENCED", severity: "WARNING", message: d.message });

  return { notes: numbered, noteReferences: refs, accountingPolicies: policies, textualDisclosures: disclosures, facts, checklist, diagnostics, scheduleRows };
}

/** Append-only revision history of notes/policies across the batches of one series (oldest first). */
export interface NoteRevision {
  readonly key: string;
  readonly kind: string;
  readonly version: number;
  readonly evidenceBatchId: string;
  readonly change: "ADDED" | "CHANGED" | "REMOVED" | "UNCHANGED";
  readonly bodySha: string;
}

export function noteRevisionHistory(versions: readonly { readonly version: number; readonly batch: EvidenceBatch }[], hash: (s: string) => string): readonly NoteRevision[] {
  const ordered = [...versions].sort((a, b) => a.version - b.version);
  const out: NoteRevision[] = [];
  let previous = new Map<string, string>();
  for (const v of ordered) {
    const read = columnReader(v.batch);
    const current = new Map<string, string>();
    for (let row = 1; row <= v.batch.document.rows.length; row++) current.set(`${read(row, "kind")}:${read(row, "key")}`, hash(v.batch.document.rows[row - 1].join("\u0000")));
    for (const [k, sha] of current) {
      const [kind, key] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
      out.push({ key, kind, version: v.version, evidenceBatchId: v.batch.evidenceBatchId, change: !previous.has(k) ? "ADDED" : previous.get(k) === sha ? "UNCHANGED" : "CHANGED", bodySha: sha });
    }
    for (const [k, sha] of previous) {
      if (!current.has(k)) out.push({ key: k.slice(k.indexOf(":") + 1), kind: k.slice(0, k.indexOf(":")), version: v.version, evidenceBatchId: v.batch.evidenceBatchId, change: "REMOVED", bodySha: sha });
    }
    previous = current;
  }
  return out;
}
