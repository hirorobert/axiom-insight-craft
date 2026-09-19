// financialGeneration/persistedAuthority.ts — what must live IN the report document.
//
// A report version is the immutable record of an accounting position. Three things the
// workspace used to compute only in the browser affect whether that position may be reviewed
// or finalised, so the DATABASE — the authority for publication — must be able to see them in the
// stored document itself:
//
//   * the budget-versus-actual comparison (facts, a note, one line record per budget line and,
//     when the comparison cannot be made, an explicit gap record);
//   * the disclosure checklist (one record per framework disclosure area and its state);
//   * the trial-balance mapping coverage (how many accounts were reviewed, unmapped, ambiguous).
//
// All three are ordinary canonical content: facts with evidence provenance, a note, and textual
// disclosures whose ids are a documented contract with fs_publication_blockers(). Because they are
// in the document, changing the budget CHANGES the report's content identity, so a budget-only
// evidence change is a new persisted version like any other — not a silent side effect.

import { sha256Hex } from "@/lib/canonicalStatement/serialization";
import { formatMoney, type Money } from "@/lib/canonicalStatement/money";
import type { CanonicalFinancialStatementReport, MonetaryFact, Note, TextualDisclosure } from "@/lib/canonicalStatement/types";
import type { EvidenceBatch } from "@/lib/financialEvidence/types";
import type { FrameworkProfile } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { byCodepoint, evidenceFact, periodRef, slug } from "./common";
import { percentOneDecimal, type BudgetActualComparison, type BudgetActualLine } from "./budgetActual";
import type { ChecklistItem } from "./notesAndSchedules";

// ── ids: the contract with the database ────────────────────────────────────
export const BUDGET_NOTE_ID = "note:budget-vs-actual";
export const budgetLineDisclosureId = (lineKey: string) => `budget:line:${slug(lineKey)}`;
export const BUDGET_GAP_DISCLOSURE_ID = "budget:gap";
export const checklistDisclosureId = (areaId: string) => `checklist:${areaId}`;
export const MAPPING_COVERAGE_DISCLOSURE_ID = "mapping:coverage";
const budgetFactId = (role: "comparison" | "variance", lineKey: string) => `fact:budget:${role}:${slug(lineKey)}`;

export interface MappingCoverage {
  readonly total: number;
  readonly unmapped: number;
  readonly ambiguous: number;
}

/** What a stored budget line record says. JSON text so a stored version can be re-read exactly. */
interface BudgetLineRecord {
  readonly lineKey: string;
  readonly label: string;
  readonly nature: string;
  readonly basis: "FINAL_BUDGET" | "ORIGINAL_BUDGET";
  readonly original: string;
  readonly final: string | null;
  readonly matched: boolean;
  readonly actualFactId: string | null;
  readonly required: boolean | null;
  readonly explanation: string | null;
  readonly row: number;
  readonly notes: readonly string[];
}

const evidenceProvenance = (batch: EvidenceBatch, row: number, text: string): TextualDisclosure["provenance"] => ({
  source: { sourceDocumentId: batch.evidenceBatchId, sourceHash: batch.contentHash, artifactKind: "EVIDENCE_BATCH", ...(batch.sourceFileName ? { originalFileName: batch.sourceFileName } : {}) },
  locator: { kind: "EVIDENCE_ROW", batchId: batch.evidenceBatchId, rowNumber: Math.max(1, row) },
  extractionMethod: "EVIDENCE_BATCH_DERIVED",
  extractionConfidence: { kind: "CERTAIN" },
  originalText: text,
});

// ── budget ─────────────────────────────────────────────────────────────────

export interface BudgetEmbedding {
  readonly facts: readonly MonetaryFact[];
  readonly notes: readonly Note[];
  readonly disclosures: readonly TextualDisclosure[];
}

export function embedBudgetComparison(report: CanonicalFinancialStatementReport, budget: EvidenceBatch, result: BudgetActualComparison | { readonly status: "EVIDENCE_GAP"; readonly reasons: readonly string[] }): BudgetEmbedding {
  if (result.status === "EVIDENCE_GAP") {
    const text = `The budget comparison cannot be made: ${result.reasons.join(" ")}`;
    return { facts: [], notes: [], disclosures: [{ disclosureId: BUDGET_GAP_DISCLOSURE_ID, text, provenance: evidenceProvenance(budget, 1, text) }] };
  }
  const period = periodRef(report.period.periodId, false);
  const facts: MonetaryFact[] = [];
  const disclosures: TextualDisclosure[] = [];
  const noteFactIds: string[] = [];
  const lines = [...result.lines].sort((a, b) => byCodepoint(a.lineKey, b.lineKey));
  for (const l of lines) {
    facts.push(evidenceFact(budget, budgetFactId("comparison", l.lineKey), l.budget, period, l.evidenceRow, `${l.comparisonBasis === "FINAL_BUDGET" ? "final" : "original"} budget of ${l.lineKey}`));
    noteFactIds.push(budgetFactId("comparison", l.lineKey));
    if (l.variance) {
      facts.push(evidenceFact(budget, budgetFactId("variance", l.lineKey), l.variance, period, 0, `computed: actual − ${l.comparisonBasis === "FINAL_BUDGET" ? "final" : "original"} budget of ${l.lineKey}`));
      noteFactIds.push(budgetFactId("variance", l.lineKey));
    }
    if (l.actualFactId) noteFactIds.push(l.actualFactId);
    const record: BudgetLineRecord = {
      lineKey: l.lineKey,
      label: l.label,
      nature: l.nature,
      basis: l.comparisonBasis,
      original: formatMoney(l.originalBudget),
      final: l.finalBudget ? formatMoney(l.finalBudget) : null,
      matched: l.actual !== null,
      actualFactId: l.actualFactId,
      required: l.explanationRequired,
      explanation: l.preparerExplanation,
      row: l.evidenceRow,
      notes: l.notes,
    };
    const text = JSON.stringify(record);
    disclosures.push({ disclosureId: budgetLineDisclosureId(l.lineKey), text, provenance: evidenceProvenance(budget, l.evidenceRow, text) });
  }
  const note: Note = { noteId: BUDGET_NOTE_ID, noteNumber: "0", title: "Comparison of budget and actual amounts", monetaryFactIds: [...new Set(noteFactIds)] };
  return { facts, notes: [note], disclosures };
}

/** Rebuilds the comparison table from a STORED report, so a historical version shows exactly its own budget. */
export function budgetFromReport(report: CanonicalFinancialStatementReport): BudgetActualComparison | { readonly status: "EVIDENCE_GAP"; readonly reasons: readonly string[] } | null {
  const gap = report.textualDisclosures.find((d) => d.disclosureId === BUDGET_GAP_DISCLOSURE_ID);
  if (gap) return { status: "EVIDENCE_GAP", reasons: [gap.text] };
  const lineDisclosures = report.textualDisclosures.filter((d) => d.disclosureId.startsWith("budget:line:"));
  if (lineDisclosures.length === 0) return null;
  const latest = (id: string): Money | null => {
    let best: MonetaryFact | null = null;
    for (const f of report.facts) if (f.factId === id && (!best || f.version > best.version)) best = f;
    return best?.value ?? null;
  };
  const out: BudgetActualLine[] = [];
  let batchId = "";
  for (const d of lineDisclosures) {
    let r: BudgetLineRecord;
    try {
      r = JSON.parse(d.text) as BudgetLineRecord;
    } catch {
      return { status: "EVIDENCE_GAP", reasons: [`The stored budget line record ${d.disclosureId} is unreadable.`] };
    }
    if (d.provenance.locator.kind === "EVIDENCE_ROW") batchId = d.provenance.locator.batchId;
    const comparison = latest(budgetFactId("comparison", r.lineKey));
    if (!comparison) continue;
    const actual = r.actualFactId ? latest(r.actualFactId) : null;
    const variance = latest(budgetFactId("variance", r.lineKey));
    const direction: BudgetActualLine["direction"] = !variance ? "NOT_JUDGED" : variance.minorUnits === 0n ? "NONE" : r.nature === "REVENUE" ? (variance.minorUnits > 0n ? "FAVOURABLE" : "ADVERSE") : r.nature === "EXPENSE" ? (variance.minorUnits < 0n ? "FAVOURABLE" : "ADVERSE") : "NOT_JUDGED";
    out.push({
      lineKey: r.lineKey,
      label: r.label,
      nature: r.nature,
      comparisonBasis: r.basis,
      originalBudget: comparison,
      finalBudget: r.basis === "FINAL_BUDGET" ? comparison : null,
      budget: comparison,
      actual,
      actualLineId: null,
      actualFactId: r.actualFactId,
      variance,
      variancePercent: variance ? percentOneDecimal(variance.minorUnits, comparison.minorUnits) : null,
      direction,
      preparerExplanation: r.explanation,
      explanationRequired: r.required,
      evidenceRow: r.row,
      notes: r.notes,
    });
  }
  out.sort((a, b) => byCodepoint(a.lineKey, b.lineKey));
  return { status: "GENERATED", lines: out, diagnostics: [], evidenceBatchId: batchId };
}

// ── disclosure checklist ───────────────────────────────────────────────────

export const CHECKLIST_STATES = ["PROVIDED", "NOT_APPLICABLE_WITH_RATIONALE", "MISSING"] as const;

export function checklistDisclosures(profile: FrameworkProfile, checklist: readonly ChecklistItem[], notesBatch: EvidenceBatch | null, derivedSource: { readonly sourceDocumentId: string; readonly sourceHash: string }): TextualDisclosure[] {
  return [...checklist]
    .sort((a, b) => byCodepoint(a.areaId, b.areaId))
    .map((c) => {
      const text = `${c.state}: ${c.label} (${c.reference})${c.satisfiedBy ? ` — ${c.satisfiedBy}` : ""}`;
      const provenance: TextualDisclosure["provenance"] =
        c.state !== "MISSING" && notesBatch
          ? evidenceProvenance(notesBatch, 1, text)
          : {
              source: { sourceDocumentId: derivedSource.sourceDocumentId, sourceHash: derivedSource.sourceHash, artifactKind: "EVIDENCE_BATCH" },
              locator: { kind: "MANUAL", note: `disclosure checklist derived from the ${profile.kind} framework profile; no supporting evidence for area ${c.areaId}` },
              extractionMethod: "EVIDENCE_BATCH_DERIVED",
              extractionConfidence: { kind: "CERTAIN" },
              originalText: text,
            };
      return { disclosureId: checklistDisclosureId(c.areaId), text, provenance };
    });
}

// ── mapping coverage ───────────────────────────────────────────────────────

export function mappingCoverageDisclosure(report: CanonicalFinancialStatementReport, coverage: MappingCoverage): TextualDisclosure | null {
  const source = report.facts.find((f) => f.provenance.source.artifactKind === "TRIAL_BALANCE")?.provenance.source;
  if (!source) return null;
  const text = `total=${coverage.total};unmapped=${coverage.unmapped};ambiguous=${coverage.ambiguous}`;
  return {
    disclosureId: MAPPING_COVERAGE_DISCLOSURE_ID,
    text,
    provenance: { source, locator: { kind: "MANUAL", note: "trial-balance account mapping coverage recorded when the statements were prepared" }, extractionMethod: "TRIAL_BALANCE_DERIVED", extractionConfidence: { kind: "CERTAIN" }, originalText: text },
  };
}

/** The identity the derived (evidence-less) checklist records use as their source: a hash of the profile's own area list. */
export function derivedChecklistSource(profile: FrameworkProfile): { readonly sourceDocumentId: string; readonly sourceHash: string } {
  return { sourceDocumentId: `framework-profile:${profile.kind}`, sourceHash: sha256Hex(`${profile.kind}|${profile.disclosureAreas.map((a) => a.id).join(",")}`) };
}
