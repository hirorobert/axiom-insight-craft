// financialGeneration/applyEvidence.ts — folds validated evidence into a
// canonical report: the direct cash flow, statement of changes in equity, IPSAS
// cash receipts and payments, notes/policies/schedules and the budget comparison.
//
// Pure. The input report is never mutated; a NEW aggregate is returned and passed
// through validateCanonicalReport, so evidence can never introduce a malformed
// report. Evidence that is not usable (INVALID, REQUIRES_REVIEW, extracted
// candidates) is ignored, and its exclusion is reported. Unresolved authority is
// reported as a gap, never filled.

import { CANONICAL_CONCEPTS } from "@/lib/canonicalStatement/concepts";
import type { Money } from "@/lib/canonicalStatement/money";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport, type MonetaryFact, type Statement, type StatementLine } from "@/lib/canonicalStatement/types";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { isUsableEvidence } from "@/lib/financialEvidence/intake";
import type { EvidenceBatch, EvidenceType, PeriodRole } from "@/lib/financialEvidence/types";
import type { FrameworkProfile } from "@/lib/financialStatementsWorkspace/frameworkProfiles";
import { buildBudgetActual, type BudgetActualComparison, type BudgetActualOptions } from "./budgetActual";
import { buildDirectCashFlow, type CashFlowPeriodInput } from "./cashFlowDirect";
import { amountOf, columnReader, type EvidenceRowRef, type GenerationDiagnostic, type GenerationResult } from "./common";
import { buildEquityStatement, type EquityPeriodInput } from "./equityStatement";
import { buildIpsasCashStatement, type IpsasCashPeriodInput } from "./ipsasCash";
import { assembleNotes, type ChecklistItem } from "./notesAndSchedules";
import { cashPerimeterFactId, establishCashPerimeter, type CashPerimeterResult } from "./cashPerimeter";

export interface StoredEvidence {
  readonly batch: EvidenceBatch;
  readonly version: number;
}

/** The latest version of every series (type, role, period, series key). Superseded versions never feed a statement. */
export function latestPerSeries(stored: readonly StoredEvidence[]): readonly EvidenceBatch[] {
  const best = new Map<string, StoredEvidence>();
  for (const s of stored) {
    const b = s.batch;
    const key = [b.companyId, b.reportingPeriodId, b.evidenceType, b.periodRole, b.seriesKey].join("|");
    const cur = best.get(key);
    if (!cur || s.version > cur.version) best.set(key, s);
  }
  return [...best.values()].sort((a, b) => (a.batch.evidenceBatchId < b.batch.evidenceBatchId ? -1 : 1)).map((s) => s.batch);
}

export interface ApplyEvidenceInput {
  readonly report: CanonicalFinancialStatementReport;
  readonly profile: FrameworkProfile;
  /** Latest version of each series only (see latestPerSeries). */
  readonly evidence: readonly EvidenceBatch[];
  /** Account keys of trial-balance accounts professionally reviewed as cash accounts. */
  readonly cashAccountKeys?: readonly string[];
  readonly budget?: BudgetActualOptions;
}

export interface EvidenceUse {
  readonly evidenceType: EvidenceType;
  readonly periodRole: PeriodRole;
  readonly evidenceBatchId: string;
  readonly used: boolean;
  readonly reason: string;
}

export type GeneratedKind = "STATEMENT_OF_CASH_FLOWS" | "STATEMENT_OF_CHANGES_IN_EQUITY" | "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS";

export interface GeneratedSummary {
  readonly kind: GeneratedKind;
  readonly result: GenerationResult;
}

export interface ApplyEvidenceResult {
  /** null when the evidence cannot form a valid canonical report (e.g. a cash-basis report whose only statement is an evidence gap). */
  readonly report: CanonicalFinancialStatementReport | null;
  readonly generated: readonly GeneratedSummary[];
  readonly budgetActual: BudgetActualComparison | { status: "EVIDENCE_GAP"; reasons: readonly string[] } | null;
  readonly checklist: readonly ChecklistItem[];
  readonly evidenceIndex: Readonly<Record<string, readonly EvidenceRowRef[]>>;
  /** The multi-account cash perimeter when a cash account map was supplied; null otherwise. */
  readonly cashPerimeter: CashPerimeterResult | null;
  readonly use: readonly EvidenceUse[];
  readonly diagnostics: readonly GenerationDiagnostic[];
}

const one = (batches: readonly EvidenceBatch[], type: EvidenceType, role: PeriodRole): EvidenceBatch | undefined => batches.find((b) => b.evidenceType === type && b.periodRole === role);

/** A report shell for evidence-only statements (e.g. IPSAS cash basis, which has no trial-balance route). */
export function evidenceOnlyReport(input: { reportId: string; companyId: string; entityName: string; periodYear: number; startDate: string; endDate: string; framework: CanonicalFinancialStatementReport["framework"]; currency: string; scale: number; comparativeYear?: number }): CanonicalFinancialStatementReport {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    reportIdentity: { reportId: input.reportId, companyId: input.companyId, reportVersion: 1 },
    entity: { legalName: input.entityName },
    period: { periodId: "CURRENT", startDate: input.startDate, endDate: input.endDate, periodYear: input.periodYear },
    comparativePeriods:
      input.comparativeYear === undefined
        ? []
        : [{ periodId: `PRIOR_${input.comparativeYear}`, startDate: `${input.comparativeYear}${input.startDate.slice(4)}`, endDate: `${input.comparativeYear}${input.endDate.slice(4)}`, periodYear: input.comparativeYear, isRestated: false }],
    framework: input.framework,
    presentationCurrency: { currency: input.currency, scale: input.scale, roundingPolicy: { mode: "HALF_UP", scale: input.scale }, presentationMultiplier: 1n },
    statements: [],
    notes: [],
    noteReferences: [],
    accountingPolicies: [],
    textualDisclosures: [],
    facts: [],
    provenanceOrigin: "TRIAL_BALANCE_DERIVED",
  };
}

function latestFactValue(report: CanonicalFinancialStatementReport, factId: string): Money | null {
  const versions = report.facts.filter((f) => f.factId === factId);
  if (versions.length === 0) return null;
  return versions.reduce((a, b) => (b.version > a.version ? b : a)).value;
}

/** Opening cash for a period = closing cash of the period before it, from the comparative SFP or from prior-period statements evidence. */
function openingCashFor(report: CanonicalFinancialStatementReport, evidence: readonly EvidenceBatch[], role: PeriodRole, perimeter: CashPerimeterResult | null): { money: Money; source: string } | null {
  if (role === "CURRENT" && perimeter?.status === "ESTABLISHED" && report.comparativePeriods[0]) {
    const fromPerimeter = perimeter.facts.find((f) => f.factId === cashPerimeterFactId("cfexpected", report.comparativePeriods[0].periodId))?.value;
    if (fromPerimeter) return { money: fromPerimeter, source: "the comparative-period cash perimeter (all mapped cash accounts)" };
  }
  if (role === "CURRENT") {
    const comparative = report.comparativePeriods[0];
    const sfp = report.statements.find((s) => s.type === "STATEMENT_OF_FINANCIAL_POSITION");
    const cashLine = sfp?.sections.flatMap((s) => s.lines).find((l) => l.concept === CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP);
    const factId = comparative && cashLine ? cashLine.factBindings.find((b) => b.periodId === comparative.periodId)?.factId : undefined;
    const fromSfp = factId ? latestFactValue(report, factId) : null;
    if (fromSfp) return { money: fromSfp, source: "the comparative-period statement of financial position" };
  }
  const prior = one(evidence, "PRIOR_PERIOD_STATEMENTS", role === "CURRENT" ? "COMPARATIVE" : "COMPARATIVE");
  if (prior && role === "CURRENT") {
    const read = columnReader(prior);
    for (let row = 1; row <= prior.document.rows.length; row++) {
      if (read(row, "statement_type") === "FINANCIAL_POSITION" && read(row, "line_key") === CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP) return { money: amountOf(prior, read(row, "amount")), source: `prior-period statements evidence batch ${prior.evidenceBatchId} row ${row}` };
    }
  }
  return null;
}

export function applyEvidence(input: ApplyEvidenceInput): ApplyEvidenceResult {
  const { profile } = input;
  const diagnostics: GenerationDiagnostic[] = [];
  const use: EvidenceUse[] = [];
  const usable: EvidenceBatch[] = [];
  for (const b of input.evidence) {
    if (isUsableEvidence(b)) {
      usable.push(b);
    } else {
      use.push({ evidenceType: b.evidenceType, periodRole: b.periodRole, evidenceBatchId: b.evidenceBatchId, used: false, reason: b.evidenceType === "EXTRACTED_CANDIDATES" ? "Extracted candidates are review-only and never feed a statement." : `Excluded: validation status ${b.validationStatus}.` });
    }
  }

  let report = input.report;
  const comparative = report.comparativePeriods[0];
  if (report.comparativePeriods.length > 1) diagnostics.push({ code: "MULTIPLE_COMPARATIVES_NOT_SUPPORTED", severity: "WARNING", message: "Evidence-driven statements support one comparative period; only the first declared comparative is populated." });

  // Cash tie: when exactly one SFP line is a reviewed cash account, it carries the cash concept so Rule 6 can test the cash flow against it.
  const sfpIndex = report.statements.findIndex((s) => s.type === "STATEMENT_OF_FINANCIAL_POSITION");
  const cashKeys = input.cashAccountKeys ?? [];
  const mapBatch = one(usable, "CASH_ACCOUNT_MAP", "CURRENT");
  let perimeter: CashPerimeterResult | null = null;
  if (mapBatch && sfpIndex >= 0) {
    perimeter = establishCashPerimeter({ report, map: mapBatch, reviewedCashAccountKeys: cashKeys });
    diagnostics.push(...perimeter.diagnostics);
    use.push({ evidenceType: "CASH_ACCOUNT_MAP", periodRole: "CURRENT", evidenceBatchId: mapBatch.evidenceBatchId, used: perimeter.status === "ESTABLISHED", reason: perimeter.status === "ESTABLISHED" ? "Used to establish the multi-account cash perimeter." : `The perimeter could not be established: ${perimeter.reasons.join(" ")}` });
  } else if (mapBatch) {
    use.push({ evidenceType: "CASH_ACCOUNT_MAP", periodRole: "CURRENT", evidenceBatchId: mapBatch.evidenceBatchId, used: false, reason: "There is no statement of financial position to build the cash perimeter from." });
  }
  if (!mapBatch && sfpIndex >= 0 && cashKeys.length === 1) {
    const targetId = `line:detail:sfp:${cashKeys[0]}`;
    const sfp = report.statements[sfpIndex];
    const retagged: Statement = { ...sfp, sections: sfp.sections.map((sec) => ({ ...sec, lines: sec.lines.map((l): StatementLine => (l.lineId === targetId && !sfp.sections.some((s2) => s2.lines.some((x) => x.concept === CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP)) ? { ...l, concept: CANONICAL_CONCEPTS.CASH_AND_CASH_EQUIVALENTS_SFP } : l)) })) };
    report = { ...report, statements: report.statements.map((s, i) => (i === sfpIndex ? retagged : s)) };
  } else if (!mapBatch && sfpIndex >= 0) {
    diagnostics.push({ code: "CASH_ACCOUNT_MAP_REQUIRED", severity: "INFO", message: cashKeys.length === 0 ? "No trial-balance account is reviewed as a cash account and no cash account map was supplied, so closing cash cannot be tied to the trial balance." : `${cashKeys.length} accounts are reviewed as cash and no cash account map was supplied. Add a cash account map (each account's category, effect and cash-flow treatment): the closing-cash tie is reported as insufficient evidence rather than guessed.` });
  }

  const periodFor = (role: PeriodRole) => (role === "CURRENT" ? { periodId: report.period.periodId, isComparative: false } : comparative ? { periodId: comparative.periodId, isComparative: true } : null);
  const addStatements: Statement[] = [];
  const addFacts: MonetaryFact[] = [];
  const evidenceIndex: Record<string, readonly EvidenceRowRef[]> = {};
  const generated: GeneratedSummary[] = [];

  const collect = (kind: GeneratedKind, result: GenerationResult, batchesUsed: readonly EvidenceBatch[]) => {
    generated.push({ kind, result });
    diagnostics.push(...result.diagnostics);
    if (result.status === "GENERATED") {
      addStatements.push(result.statement);
      addFacts.push(...result.facts);
      Object.assign(evidenceIndex, result.evidenceIndex);
    }
    for (const b of batchesUsed) use.push({ evidenceType: b.evidenceType, periodRole: b.periodRole, evidenceBatchId: b.evidenceBatchId, used: result.status === "GENERATED", reason: result.status === "GENERATED" ? `Used for ${kind}.` : result.reasons.join(" ") });
  };
  const inputs = <T,>(type: EvidenceType, make: (batch: EvidenceBatch, p: { periodId: string; isComparative: boolean }, role: PeriodRole) => T): { items: T[]; batches: EvidenceBatch[] } => {
    const items: T[] = [];
    const batches: EvidenceBatch[] = [];
    for (const role of ["CURRENT", "COMPARATIVE"] as const) {
      const b = one(usable, type, role);
      const p = periodFor(role);
      if (b && p) {
        items.push(make(b, p, role));
        batches.push(b);
      } else if (b && !p) {
        use.push({ evidenceType: type, periodRole: role, evidenceBatchId: b.evidenceBatchId, used: false, reason: "The report declares no comparative period for this evidence." });
      }
    }
    return { items, batches };
  };

  if (profile.basis === "CASH") {
    const { items, batches } = inputs<IpsasCashPeriodInput>("IPSAS_CASH_RECEIPTS_PAYMENTS", (batch, p) => ({ ...p, batch }));
    if (items.length > 0) collect("STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS", buildIpsasCashStatement(items), batches);
  } else {
    const ledger = inputs<CashFlowPeriodInput>("TRANSACTION_LEDGER", (batch, p, role) => {
      const opening = openingCashFor(report, usable, role, perimeter);
      return { ...p, ledger: batch, openingCash: opening?.money ?? null, openingSource: opening?.source };
    });
    if (ledger.items.length > 0) collect("STATEMENT_OF_CASH_FLOWS", buildDirectCashFlow(ledger.items), ledger.batches);
    const equity = inputs<EquityPeriodInput>("EQUITY_MOVEMENTS", (batch, p) => ({ ...p, batch }));
    if (equity.items.length > 0) collect("STATEMENT_OF_CHANGES_IN_EQUITY", buildEquityStatement(equity.items), equity.batches);
  }

  // Notes, policies and schedules (need the statements above so lines can be resolved).
  const withStatements: CanonicalFinancialStatementReport = { ...report, statements: [...report.statements, ...addStatements], facts: [...report.facts, ...addFacts, ...(perimeter?.facts ?? [])] };
  const notesBatch = one(usable, "NOTES_AND_POLICIES", "CURRENT") ?? null;
  const scheduleBatches = usable.filter((b) => b.evidenceType === "SUPPORTING_SCHEDULE");
  const assembly = assembleNotes(withStatements, notesBatch, scheduleBatches, profile.disclosureAreas, perimeter?.note ? { notes: [perimeter.note], unreferencedNoteIds: [perimeter.note.noteId] } : undefined);
  diagnostics.push(...assembly.diagnostics);
  for (const b of [notesBatch, ...scheduleBatches]) if (b) use.push({ evidenceType: b.evidenceType, periodRole: b.periodRole, evidenceBatchId: b.evidenceBatchId, used: true, reason: "Assembled into notes, policies and schedules." });
  for (const [key, ref] of Object.entries(assembly.scheduleRows)) evidenceIndex[`schedule:${key}`] = [{ batchId: ref.batchId, rowNumbers: ref.rowNumbers }];

  let finalReport: CanonicalFinancialStatementReport | null = null;
  try {
    finalReport = validateCanonicalReport({
      ...withStatements,
      notes: [...report.notes, ...assembly.notes],
      noteReferences: [...report.noteReferences, ...assembly.noteReferences],
      accountingPolicies: [...report.accountingPolicies, ...assembly.accountingPolicies],
      textualDisclosures: [...report.textualDisclosures, ...assembly.textualDisclosures],
      facts: [...withStatements.facts, ...assembly.facts],
    });
  } catch (e) {
    diagnostics.push({ code: "REPORT_NOT_FORMABLE", severity: "ERROR", message: `The evidence does not yet form a valid canonical report: ${(e as Error).message}` });
  }

  let budgetActual: ApplyEvidenceResult["budgetActual"] = null;
  const budget = one(usable, "BUDGET", "CURRENT");
  if (budget) {
    budgetActual = finalReport ? buildBudgetActual(finalReport, budget, input.budget) : { status: "EVIDENCE_GAP" as const, reasons: ["No valid report exists to compare the budget against."] };
    if (budgetActual.status === "GENERATED") diagnostics.push(...budgetActual.diagnostics);
    use.push({ evidenceType: "BUDGET", periodRole: "CURRENT", evidenceBatchId: budget.evidenceBatchId, used: budgetActual.status === "GENERATED", reason: budgetActual.status === "GENERATED" ? "Used for the budget comparison." : budgetActual.reasons.join(" ") });
  }

  return { report: finalReport, generated, budgetActual, checklist: assembly.checklist, evidenceIndex, cashPerimeter: perimeter, use, diagnostics };
}
