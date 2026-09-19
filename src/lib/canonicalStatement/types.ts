// canonicalStatement/types.ts — the format-neutral canonical financial
// statement model. This is the shared accounting core for two workflows
// that must never be merged into one another:
//
//   A. statements PREPARED from a reviewed trial balance (HESABU); and
//   B. statements UPLOADED and reviewed as documents (financial-statement-intake).
//
// Both workflows may only converge by normalizing into this model via an
// adapter (see adapters.ts) — never by one workflow reaching into the
// other's tables or types directly. `CanonicalFinancialStatementReport
// .provenanceOrigin` records which workflow produced a given instance so
// downstream code can never silently conflate them.
//
// Every extracted fact (MonetaryFact) is immutable and versioned: a
// correction never overwrites a fact, it appends a new version with an
// explicit reviewer decision — atomically, via reviewState.ts's
// `recordFactCorrection` (the only public way to do this; see that file).
// Nothing in this file mutates in place — every helper elsewhere in this
// module tree returns new values.
//
// TypeScript types describe shape at compile time only — they do not
// validate a value that arrives as `unknown` (parsed JSON, an Edge Function
// payload, a future Arelle-derived aggregate). validateCanonicalReport /
// safeValidateCanonicalReport in validation.ts are the runtime boundary
// that actually enforces these invariants against untrusted input; treat
// the interfaces below as the *target* shape, not a guarantee.

import type { CurrencyCode, Money, RoundingPolicy } from "./money";

export const CANONICAL_SCHEMA_VERSION = "1.0.0";

// ─── Identity ────────────────────────────────────────────────────────────

export interface ReportIdentity {
  readonly reportId: string;
  /** FK into the existing `companies` table — the only tie back into the rest of the system. */
  readonly companyId: string;
  /** Version of this report instance as a whole (distinct from any single fact's own version). */
  readonly reportVersion: number;
}

export interface EntityIdentity {
  readonly legalName: string;
  /** Optional descriptive metadata only — this model stays jurisdiction-neutral; no rule below branches on it. */
  readonly taxIdentificationNumber?: string;
  readonly jurisdiction?: string;
}

// ─── Periods ─────────────────────────────────────────────────────────────

/** Reserved periodId for the report's own current period — never reusable by a ComparativePeriod. */
export const CURRENT_PERIOD_ID = "CURRENT";

export interface ReportingPeriod {
  readonly periodId: string; // conventionally "CURRENT" — see CURRENT_PERIOD_ID
  readonly startDate: string; // ISO 8601 calendar date, "YYYY-MM-DD"
  readonly endDate: string;
  readonly periodYear: number;
}

export interface ComparativePeriod {
  readonly periodId: string; // must differ from CURRENT_PERIOD_ID and from every other declared period
  readonly startDate: string;
  readonly endDate: string;
  readonly periodYear: number;
  readonly isRestated: boolean;
  readonly restatementReason?: string;
}

/** A lightweight pointer used on facts — resolved against `report.period` / `report.comparativePeriods`. */
export interface ReportingPeriodRef {
  readonly periodId: string;
  readonly isComparative: boolean;
}

export type ReportingFrameworkKind = "IFRS" | "IFRS_FOR_SMES" | "IPSAS_ACCRUAL" | "IPSAS_CASH";

export interface ReportingFramework {
  readonly kind: ReportingFrameworkKind;
  readonly version?: string;
}

export interface PresentationCurrency {
  readonly currency: CurrencyCode;
  readonly scale: number;
  readonly roundingPolicy: RoundingPolicy;
  /** e.g. 1n (units), 1000n (thousands), 1000000n (millions) — kept as bigint for exactness. */
  readonly presentationMultiplier: bigint;
}

export function isValidPresentationMultiplier(value: bigint): boolean {
  return value === 1n || value === 1000n || value === 1000000n;
}

// ─── Provenance ──────────────────────────────────────────────────────────

export type ArtifactKind = "PDF" | "DOCX" | "XLSX" | "IXBRL" | "TRIAL_BALANCE" | "EVIDENCE_BATCH";

export interface SourceArtifact {
  readonly sourceDocumentId: string;
  /** sha256 hex of the artifact bytes — content identity, mirroring the intake function's own discipline. */
  readonly sourceHash: string;
  readonly artifactKind: ArtifactKind;
  /** Metadata only — never storage/object identity, never used to resolve a fact. */
  readonly originalFileName?: string;
  readonly mimeType?: string;
}

export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Discriminated by artifact kind so a PDF page can never be confused with an XLSX cell. */
export type SourceLocator =
  | { readonly kind: "PDF_PAGE"; readonly page: number; readonly boundingBox?: BoundingBox }
  | { readonly kind: "DOCX_ELEMENT"; readonly elementPath: string }
  | { readonly kind: "XLSX_CELL"; readonly sheetName: string; readonly cellRef: string }
  | { readonly kind: "IXBRL_ELEMENT"; readonly elementId: string; readonly xpath?: string }
  | { readonly kind: "TRIAL_BALANCE_ROW"; readonly accountCode: string; readonly uploadId: string }
  /** A row of a controlled evidence batch (financialEvidence/**) — batchId is the immutable batch identity, rowNumber is 1-based within the parsed data rows. */
  | { readonly kind: "EVIDENCE_ROW"; readonly batchId: string; readonly rowNumber: number; /** Set on a COMPUTED fact (a total): the factId it is derived under, so two totals with equal values never share a provenance fingerprint. */ readonly derivation?: string }
  | { readonly kind: "MANUAL"; readonly note: string };

export type ExtractionMethod =
  | "TRIAL_BALANCE_DERIVED"
  | "IXBRL_TAGGED"
  | "PDF_TEXT_LAYOUT"
  | "PDF_OCR"
  | "DOCX_STRUCTURED"
  | "XLSX_CELL"
  | "EVIDENCE_BATCH_DERIVED"
  | "MANUAL_REVIEWER_ENTRY";

export type ExtractionConfidence = { readonly kind: "CERTAIN" } | { readonly kind: "ESTIMATED"; readonly score: number };

export interface ProvenanceRecord {
  readonly source: SourceArtifact;
  readonly locator: SourceLocator;
  readonly extractionMethod: ExtractionMethod;
  readonly extractionConfidence: ExtractionConfidence;
  /** Verbatim as it appeared in the source — never normalized, never re-derived. */
  readonly originalText: string;
}

// ─── Facts ───────────────────────────────────────────────────────────────

export type SignConvention = "DEBIT_POSITIVE" | "CREDIT_POSITIVE" | "NATURAL";

/**
 * An immutable, versioned extracted fact. `value: null` means MISSING — the
 * source never presented this figure at all. A Money with minorUnits 0n is
 * a genuine reported zero. These two states must never be conflated: no
 * code in this module tree may default a missing fact's value to zero.
 *
 * A correction never mutates an existing MonetaryFact — it produces a new
 * one with `version = supersedesVersion + 1` and `supersedesVersion` set,
 * atomically alongside an explicit CorrectFactDecision (see
 * reviewState.ts's `recordFactCorrection` — the only public way to append
 * a correction). The fact ledger (`CanonicalFinancialStatementReport.facts`)
 * is append-only.
 */
export interface MonetaryFact {
  readonly factId: string;
  readonly version: number;
  readonly value: Money | null;
  readonly reportingPeriod: ReportingPeriodRef;
  readonly signConvention: SignConvention;
  readonly provenance: ProvenanceRecord;
  readonly supersedesVersion: number | null;
}

// ─── Statements ──────────────────────────────────────────────────────────

export type StatementType =
  | "STATEMENT_OF_FINANCIAL_POSITION"
  | "STATEMENT_OF_PROFIT_OR_LOSS"
  | "STATEMENT_OF_COMPREHENSIVE_INCOME"
  | "STATEMENT_OF_CHANGES_IN_EQUITY"
  | "STATEMENT_OF_CASH_FLOWS"
  | "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS"; // IPSAS cash basis primary statement

export type LineRole = "DETAIL" | "SUBTOTAL" | "TOTAL";
export type NormalBalance = "DEBIT_NORMAL" | "CREDIT_NORMAL";

/**
 * Binds a line to exactly one fact for exactly one period. A line may carry
 * any number of bindings — one for the current period, and zero or more for
 * declared comparative periods — never more than one binding per periodId
 * (enforced by validation.ts, not by this type). This replaced a pair of
 * singular `currentFactId`/`comparativeFactId` fields, which could not
 * represent more than one comparative period without silently reusing the
 * same fact for every comparative column.
 */
export interface FactBinding {
  readonly periodId: string;
  readonly factId: string;
}

export interface StatementLine {
  readonly lineId: string;
  readonly label: string;
  /**
   * A canonical, framework-neutral concept key (e.g. "total_assets"),
   * deliberately distinct from `label` so two lines that happen to share a
   * printed label (e.g. two rows both labeled "Total") are never conflated
   * structurally — only `concept` identity matters to the rule pack.
   */
  readonly concept: string;
  readonly role: LineRole;
  readonly normalBalance: NormalBalance;
  readonly isContra: boolean;
  readonly factBindings: readonly FactBinding[];
  /** For SUBTOTAL/TOTAL lines only: the sibling lineIds (within the same statement) this total is declared to sum. Never inferred. */
  readonly castingChildLineIds: readonly string[];
}

export interface StatementSection {
  readonly sectionId: string;
  readonly label: string;
  readonly lines: readonly StatementLine[];
}

export interface Statement {
  readonly statementId: string;
  readonly type: StatementType;
  readonly title: string;
  readonly sections: readonly StatementSection[];
}

// ─── Notes ───────────────────────────────────────────────────────────────

export type MovementSign = "ADD" | "SUBTRACT";

export interface SignedFactRef {
  readonly factId: string;
  readonly sign: MovementSign;
}

/** opening + additions - disposals +/- otherMovements = closing (Rule 7). */
export interface MovementSchedule {
  readonly scheduleId: string;
  readonly openingBalanceFactId: string;
  readonly additionFactIds: readonly string[];
  readonly disposalFactIds: readonly string[];
  readonly otherMovements: readonly SignedFactRef[];
  readonly closingBalanceFactId: string;
}

export interface Note {
  readonly noteId: string;
  readonly noteNumber: string;
  readonly title: string;
  readonly monetaryFactIds: readonly string[];
  /** The fact this note's total should reconcile to a face line (Rule 3) — undefined for narrative-only notes. */
  readonly totalFactId?: string;
  readonly movementSchedule?: MovementSchedule;
}

/**
 * A cross-reference from a face line to a note. `report.noteReferences` is
 * the SOLE representation of this edge — a `StatementLine` does not also
 * carry a `noteReferenceIds` list. That duplicated representation existed
 * earlier and was removed: nothing enforced it stayed in sync with this
 * array, so a line could carry a noteReferenceId this array had no matching
 * entry for, and neither validation nor any rule would ever notice (silent
 * corruption). `rules/shared.ts`'s `noteReferencesForLine(report, lineId)`
 * derives "this line's note references" by filtering on `fromLineId` —
 * that is the only correct way to ask the question now.
 *
 * Its OWN identity (`noteReferenceId`, and the `fromLineId`/`toNoteId`
 * strings it carries) is what validation.ts checks for well-formedness and
 * uniqueness. Whether `toNoteId`/`fromLineId` actually resolve to a real
 * note/line is deliberately NOT a validation-time rejection — Rule 10
 * (orphaned-note-reference-detection) exists specifically to detect and
 * report a dangling reference as a reviewable finding on an otherwise valid
 * aggregate, mirroring a real document where a cross-reference to a
 * renumbered or removed note is a genuine, correctable authoring defect,
 * not structural corruption. See validation.ts's module comment for the
 * full validation/rule-pack boundary this follows throughout.
 */
export interface NoteReference {
  readonly noteReferenceId: string;
  readonly fromLineId: string;
  readonly toNoteId: string;
}

// ─── Policies and disclosures ──────────────────────────────────────────────

export interface AccountingPolicy {
  readonly policyId: string;
  readonly topic: string;
  readonly text: string;
  readonly provenance: ProvenanceRecord;
}

export interface TextualDisclosure {
  readonly disclosureId: string;
  readonly relatedNoteId?: string;
  readonly text: string;
  readonly provenance: ProvenanceRecord;
}

// ─── The report itself ───────────────────────────────────────────────────

export type ProvenanceOrigin = "TRIAL_BALANCE_DERIVED" | "DOCUMENT_REVIEWED";

export interface CanonicalFinancialStatementReport {
  readonly schemaVersion: string;
  readonly reportIdentity: ReportIdentity;
  readonly entity: EntityIdentity;
  readonly period: ReportingPeriod;
  readonly comparativePeriods: readonly ComparativePeriod[];
  readonly framework: ReportingFramework;
  readonly presentationCurrency: PresentationCurrency;
  readonly statements: readonly Statement[];
  readonly notes: readonly Note[];
  readonly noteReferences: readonly NoteReference[];
  readonly accountingPolicies: readonly AccountingPolicy[];
  readonly textualDisclosures: readonly TextualDisclosure[];
  /** Append-only fact ledger — every version of every fact ever recorded, never pruned. */
  readonly facts: readonly MonetaryFact[];
  readonly provenanceOrigin: ProvenanceOrigin;
}

// ─── Rule evaluation / findings ──────────────────────────────────────────

export type RuleOutcome = "PASS" | "FAIL" | "NOT_APPLICABLE" | "INSUFFICIENT_EVIDENCE";

/**
 * Describes the severity of the underlying issue IF this rule's outcome is
 * FAIL or INSUFFICIENT_EVIDENCE — never the "severity of a pass." A PASS or
 * NOT_APPLICABLE record still carries this field (every rule declares one
 * fixed failure-risk classification for the check it performs), but
 * `actionable` and `status` are what determine whether it means anything
 * operationally; a dashboard must never render a PASS record's
 * failureSeverity as an "open critical finding."
 */
export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL";

export type FindingStatus = "NOT_ACTIONABLE" | "OPEN" | "ACCEPTED" | "REJECTED" | "DEFERRED" | "AWAITING_EVIDENCE";

export function isActionableOutcome(outcome: RuleOutcome): boolean {
  return outcome === "FAIL" || outcome === "INSUFFICIENT_EVIDENCE";
}

export type ObservedValue =
  | { readonly kind: "MONEY"; readonly value: Money | null; readonly factId?: string }
  | { readonly kind: "COUNT"; readonly value: number }
  | { readonly kind: "TEXT"; readonly value: string }
  | { readonly kind: "PERIOD"; readonly value: string };

export interface EvidenceReference {
  readonly evidenceReferenceId: string;
  readonly factId?: string;
  readonly factVersion?: number;
  readonly lineId?: string;
  readonly noteId?: string;
  readonly statementId?: string;
  readonly locator?: SourceLocator;
}

export interface RulePackIdentity {
  readonly rulePackId: string;
  readonly rulePackVersion: string;
}

export interface RuleExecution {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly rulePack: RulePackIdentity;
  readonly engineVersion: string;
  readonly executedAgainstReportId: string;
  readonly executedAgainstSchemaVersion: string;
}

/**
 * One rule's evaluation of one target, in one run.
 *
 * Two identities, deliberately separate (see serialization.ts for the
 * algorithm):
 *
 * - `findingKey` — durable identity of *what is being checked*: the same
 *   rule, against the same target, in the same report lineage. It does NOT
 *   change when the outcome changes, when the report is corrected to a new
 *   `reportVersion`, or when observed values change. A reviewer decision
 *   that should "follow" an issue across correction cycles (e.g. "I've
 *   reviewed this line before, keep deferring it") targets a `findingKey`.
 *
 * - `evaluationId` — immutable identity of *this exact evaluated result*:
 *   it changes whenever the outcome, the observed values, the evidence, or
 *   the reportVersion changes. A reviewer decision that should apply only
 *   to one specific run's result (e.g. "I accept THIS specific FAIL,
 *   computed from THIS specific data") targets an `evaluationId`.
 *
 * `createdAt` is informational only — excluded from both hashes and from
 * every deterministic-replay/serialization comparison in this module tree.
 * Two reruns of the same rule pack against the same report therefore
 * produce identical `findingKey`s AND identical `evaluationId`s regardless
 * of when either run happened.
 *
 * `actionable` is derived from `outcome` (`isActionableOutcome`) and is
 * never true for PASS/NOT_APPLICABLE. `status` is forced to
 * "NOT_ACTIONABLE" for a non-actionable record — a PASS or NOT_APPLICABLE
 * result is never rendered as an "open" finding, regardless of
 * `failureSeverity`.
 */
export interface RuleEvaluationRecord {
  readonly findingKey: string;
  readonly evaluationId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly rulePack: RulePackIdentity;
  readonly engineVersion: string;
  readonly outcome: RuleOutcome;
  readonly actionable: boolean;
  readonly failureSeverity: FindingSeverity;
  readonly status: FindingStatus;
  readonly observedValues: Readonly<Record<string, ObservedValue>>;
  readonly expectedRelationship: string;
  readonly deterministicCalculation: string;
  readonly evidenceReferences: readonly EvidenceReference[];
  readonly affected: {
    readonly statementId?: string;
    readonly noteId?: string;
    readonly lineId?: string;
  };
  readonly remediationGuidance: string;
  readonly createdAt: string;
}

// ─── Reviewer decisions ──────────────────────────────────────────────────

export type ReviewerDecisionType =
  | "ACCEPT_FINDING"
  | "REJECT_FINDING"
  | "ACCEPT_FACT"
  | "CORRECT_FACT"
  | "CORRECT_EVIDENCE"
  | "REQUEST_EVIDENCE"
  | "DEFER";

/**
 * A finding-directed decision must declare which identity it targets — see
 * RuleEvaluationRecord's doc comment for the semantic difference. There is
 * no default: every decision that references a finding is explicit about
 * whether it follows the durable issue or pins one immutable evaluation.
 */
export type FindingTarget =
  | { readonly kind: "FINDING_KEY"; readonly findingKey: string }
  | { readonly kind: "EVALUATION_ID"; readonly evaluationId: string };

interface ReviewerDecisionBase {
  readonly decisionId: string;
  readonly decisionType: ReviewerDecisionType;
  /** firm_members.id — the canonical actor identity used across this repository (never auth.users.id). */
  readonly reviewerId: string;
  readonly decidedAt: string;
  readonly rationale?: string;
}

export interface AcceptFindingDecision extends ReviewerDecisionBase {
  readonly decisionType: "ACCEPT_FINDING";
  readonly target: FindingTarget;
}

export interface RejectFindingDecision extends ReviewerDecisionBase {
  readonly decisionType: "REJECT_FINDING";
  readonly target: FindingTarget;
  readonly rationale: string;
}

export interface AcceptFactDecision extends ReviewerDecisionBase {
  readonly decisionType: "ACCEPT_FACT";
  readonly factId: string;
  readonly factVersion: number;
}

export interface CorrectFactDecision extends ReviewerDecisionBase {
  readonly decisionType: "CORRECT_FACT";
  readonly factId: string;
  readonly supersedesVersion: number;
  readonly newVersion: number;
  readonly correctedValue: Money | null;
  readonly rationale: string;
  /**
   * Optimistic-concurrency guard: the `reportIdentity.reportVersion` this
   * decision was formed against. `reviewState.ts`'s `recordFactCorrection`
   * rejects the command outright if the state's current reportVersion has
   * since moved past this value — this is a pure in-memory domain command,
   * not a database transaction; a real persistence layer must still enforce
   * its own compare-and-swap on `reportVersion` at the storage boundary.
   */
  readonly expectedReportVersion: number;
}

/**
 * A correction to SOURCE EVIDENCE (transaction classification, equity movement, budget figure, cash-basis
 * figure, schedule figure, note/disclosure text, cash account map ...). Evidence is immutable: the correction
 * is a NEW evidence version whose one cell differs, recorded atomically with the new report version, its
 * re-evaluation and this decision (see fs_apply_correction_group). It never edits a batch in place.
 */
export interface CorrectEvidenceDecision extends ReviewerDecisionBase {
  readonly decisionType: "CORRECT_EVIDENCE";
  readonly evidenceType: string;
  readonly supersedesBatchId: string;
  readonly newBatchId: string;
  /** 1-based data row of the corrected cell. */
  readonly rowNumber: number;
  readonly column: string;
  readonly previousValue: string;
  readonly correctedValue: string;
  readonly rationale: string;
  /** Optimistic-concurrency guard, exactly as for CORRECT_FACT. */
  readonly expectedReportVersion: number;
}

export interface RequestEvidenceDecision extends ReviewerDecisionBase {
  readonly decisionType: "REQUEST_EVIDENCE";
  readonly target?: FindingTarget;
  readonly factId?: string;
  readonly requestedEvidence: string;
}

export interface DeferDecision extends ReviewerDecisionBase {
  readonly decisionType: "DEFER";
  readonly target?: FindingTarget;
  readonly factId?: string;
  readonly deferUntil?: string;
}

export type ReviewerDecision =
  | AcceptFindingDecision
  | RejectFindingDecision
  | AcceptFactDecision
  | CorrectFactDecision
  | CorrectEvidenceDecision
  | RequestEvidenceDecision
  | DeferDecision;

export type ReviewerDecisionLog = readonly ReviewerDecision[];
