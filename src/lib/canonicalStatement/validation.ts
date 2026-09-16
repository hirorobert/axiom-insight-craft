// canonicalStatement/validation.ts — the runtime boundary for
// CanonicalFinancialStatementReport. TypeScript's `readonly`/interface
// shapes disappear at runtime: an uploaded document, an Edge Function
// payload, a future Arelle-derived aggregate, or hand-built JSON can all
// arrive as `unknown` and be structurally wrong in ways the compiler never
// sees. Nothing downstream (the rule engine, reviewState.ts) may assume an
// aggregate is well-formed unless it has passed through
// `validateCanonicalReport` / `safeValidateCanonicalReport` first.
//
// Uses this repository's existing validation dependency (`zod`, already a
// project dependency — see src/pages/Auth.tsx for the established
// `import { z } from "zod"` convention) rather than introducing a second
// schema library for this one module.
//
// ─── The validation/rule-pack boundary (read this before changing either) ──
//
// This validator enforces STRUCTURAL integrity: is the aggregate a
// well-formed, internally-navigable graph? Every ID a binding or reference
// depends on to be *interpretable at all* must resolve (fact bindings,
// casting children, movement-schedule fact ids, Note.monetaryFactIds,
// TextualDisclosure.relatedNoteId) — a dangling pointer here means the
// aggregate is not just wrong, it is not evaluable. It also enforces that
// every fact binding's periodId is at least a DECLARED period (either the
// current period or one of `comparativePeriods`), and that a fact's own
// `reportingPeriod.isComparative` flag is self-consistent with a periodId
// that resolves to the current or a declared comparative period.
//
// It deliberately does NOT enforce semantic/business correctness — that is
// the rule pack's job, on a validation-passing aggregate:
//   - a fact's own currency/scale matching the report's presentation
//     currency/scale is Rule 5 (currency-scale-consistency)'s job;
//   - a fact BOUND under periodId P actually being sourced from period P —
//     i.e. the bound fact's own `reportingPeriod.periodId` agreeing with
//     the binding's periodId — is Rule 4 (comparative-period-alignment)'s
//     job. Validation only confirms the binding's periodId is declared and
//     that a fact naming a declared period is self-consistent about being
//     comparative or not; it does NOT cross-check a binding against the
//     fact it points to, because that cross-check — a binding silently
//     pointing at a fact from the wrong period — is precisely the
//     authoring defect Rule 4 exists to catch on an otherwise valid
//     aggregate (see fixtures/defectiveFixture.ts's rogue-period defect,
//     which validates cleanly and is Rule 4's job to FAIL);
//   - a NoteReference's `toNoteId`/`fromLineId` actually resolving is Rule
//     10 (orphaned-note-reference-detection)'s job — by definition, that
//     rule exists to detect exactly the case validation would otherwise
//     reject, so it cannot be a hard rejection here;
//   - wrong totals, missing comparative figures, duplicate concepts, bad
//     movement roll-forwards are Rules 1/2/7/8/9's job — these are valid
//     numbers in valid positions, just numerically/structurally wrong in a
//     way only the rule pack is positioned to explain.
// A validation-passing aggregate can still fail every one of the ten
// rules — that is the whole point of an adversarial fixture "constructed
// from a valid aggregate and then mutated one defect at a time" staying
// valid while still exercising the rule pack's FAIL path.

import { z } from "zod";
import {
  CANONICAL_SCHEMA_VERSION,
  CURRENT_PERIOD_ID,
  isValidPresentationMultiplier,
  type CanonicalFinancialStatementReport,
} from "./types";
import { isValidCurrencyCode } from "./money";

// ─── Result / error types ────────────────────────────────────────────────

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

// Discriminated on the string field `status` (not a boolean) — this
// TypeScript toolchain's control-flow narrowing does not reliably narrow a
// union discriminated by a `true`/`false` literal field (verified via an
// isolated repro: `{ok:true}|{ok:false}` fails to narrow after
// `if (result.ok)`, while the string-literal equivalent narrows correctly)
// — so `status` is the real discriminant every caller must switch on.
export type ValidationResult =
  | { readonly status: "VALID"; readonly report: CanonicalFinancialStatementReport }
  | { readonly status: "INVALID"; readonly issues: readonly ValidationIssue[] };

export class CanonicalValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    super(`CanonicalFinancialStatementReport failed validation with ${issues.length} issue(s): ${issues.map((i) => `[${i.path.join(".")}] ${i.code}: ${i.message}`).join("; ")}`);
    this.name = "CanonicalValidationError";
    this.issues = issues;
  }
}

// ─── Primitive checks ────────────────────────────────────────────────────

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects malformed shapes AND calendar-invalid dates (e.g. "2026-02-30") — never silently clamps to a nearby valid date. */
function isValidIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_SHAPE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const SOURCE_HASH_SHAPE = /^[0-9a-fA-F]{64}$/;
const nonEmptyId = z.string().min(1, "id must not be empty");

const isoDateSchema = z.string().refine(isValidIsoCalendarDate, { message: "must be a valid ISO 8601 calendar date (YYYY-MM-DD)" });

// ─── Leaf schemas ────────────────────────────────────────────────────────

const moneySchema = z.object({
  // Structural well-formedness only — whether this agrees with the report's
  // OWN presentation currency/scale is Rule 5's job, not a hard rejection
  // here (see module comment).
  currency: z.string().refine(isValidCurrencyCode, { message: "must be a 3-letter uppercase ISO 4217 code" }),
  scale: z.number().int().nonnegative(),
  minorUnits: z.bigint(),
});

const roundingPolicySchema = z.object({
  mode: z.enum(["HALF_UP", "HALF_EVEN", "TRUNCATE", "CEILING", "FLOOR"]),
  scale: z.number().int().nonnegative(),
});

const presentationCurrencySchema = z.object({
  currency: z.string().refine(isValidCurrencyCode, { message: "must be a 3-letter uppercase ISO 4217 code" }),
  scale: z.number().int().nonnegative(),
  roundingPolicy: roundingPolicySchema,
  presentationMultiplier: z.bigint().refine(isValidPresentationMultiplier, { message: "presentationMultiplier must be 1n, 1000n, or 1000000n" }),
}).superRefine((value, ctx) => {
  if (value.roundingPolicy.scale !== value.scale) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "roundingPolicy.scale must equal presentationCurrency.scale", path: ["roundingPolicy", "scale"] });
  }
});

const sourceArtifactSchema = z.object({
  sourceDocumentId: nonEmptyId,
  sourceHash: z.string().regex(SOURCE_HASH_SHAPE, "must be exactly 64 hexadecimal characters"),
  artifactKind: z.enum(["PDF", "DOCX", "XLSX", "IXBRL", "TRIAL_BALANCE"]),
  originalFileName: z.string().optional(),
  mimeType: z.string().optional(),
});

const boundingBoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const sourceLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PDF_PAGE"), page: z.number().int().positive(), boundingBox: boundingBoxSchema.optional() }),
  z.object({ kind: z.literal("DOCX_ELEMENT"), elementPath: nonEmptyId }),
  z.object({ kind: z.literal("XLSX_CELL"), sheetName: nonEmptyId, cellRef: nonEmptyId }),
  z.object({ kind: z.literal("IXBRL_ELEMENT"), elementId: nonEmptyId, xpath: z.string().optional() }),
  z.object({ kind: z.literal("TRIAL_BALANCE_ROW"), accountCode: nonEmptyId, uploadId: nonEmptyId }),
  z.object({ kind: z.literal("MANUAL"), note: z.string() }),
]);

const extractionConfidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CERTAIN") }),
  z.object({ kind: z.literal("ESTIMATED"), score: z.number().finite().min(0).max(1) }),
]);

const provenanceRecordSchema = z.object({
  source: sourceArtifactSchema,
  locator: sourceLocatorSchema,
  extractionMethod: z.enum(["TRIAL_BALANCE_DERIVED", "IXBRL_TAGGED", "PDF_TEXT_LAYOUT", "PDF_OCR", "DOCX_STRUCTURED", "XLSX_CELL", "MANUAL_REVIEWER_ENTRY"]),
  extractionConfidence: extractionConfidenceSchema,
  originalText: z.string(),
});

const reportingPeriodRefSchema = z.object({ periodId: nonEmptyId, isComparative: z.boolean() });

const monetaryFactSchema = z.object({
  factId: nonEmptyId,
  version: z.number().int().min(1),
  value: moneySchema.nullable(),
  reportingPeriod: reportingPeriodRefSchema,
  signConvention: z.enum(["DEBIT_POSITIVE", "CREDIT_POSITIVE", "NATURAL"]),
  provenance: provenanceRecordSchema,
  supersedesVersion: z.number().int().min(1).nullable(),
});

const factBindingSchema = z.object({ periodId: nonEmptyId, factId: nonEmptyId });

const statementLineSchema = z.object({
  lineId: nonEmptyId,
  label: z.string(),
  concept: nonEmptyId,
  role: z.enum(["DETAIL", "SUBTOTAL", "TOTAL"]),
  normalBalance: z.enum(["DEBIT_NORMAL", "CREDIT_NORMAL"]),
  isContra: z.boolean(),
  factBindings: z.array(factBindingSchema),
  castingChildLineIds: z.array(z.string()),
}).superRefine((line, ctx) => {
  const seenPeriods = new Set<string>();
  line.factBindings.forEach((binding, i) => {
    if (seenPeriods.has(binding.periodId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate binding for periodId "${binding.periodId}" — at most one binding per period is allowed`, path: ["factBindings", i, "periodId"] });
    }
    seenPeriods.add(binding.periodId);
  });
  if (line.castingChildLineIds.includes(line.lineId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a line cannot list itself as its own casting child", path: ["castingChildLineIds"] });
  }
});

const statementSectionSchema = z.object({ sectionId: nonEmptyId, label: z.string(), lines: z.array(statementLineSchema) });

const statementSchema = z.object({
  statementId: nonEmptyId,
  type: z.enum([
    "STATEMENT_OF_FINANCIAL_POSITION",
    "STATEMENT_OF_PROFIT_OR_LOSS",
    "STATEMENT_OF_COMPREHENSIVE_INCOME",
    "STATEMENT_OF_CHANGES_IN_EQUITY",
    "STATEMENT_OF_CASH_FLOWS",
    "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS",
  ]),
  title: z.string(),
  sections: z.array(statementSectionSchema),
});

const signedFactRefSchema = z.object({ factId: nonEmptyId, sign: z.enum(["ADD", "SUBTRACT"]) });

const movementScheduleSchema = z.object({
  scheduleId: nonEmptyId,
  openingBalanceFactId: nonEmptyId,
  additionFactIds: z.array(nonEmptyId),
  disposalFactIds: z.array(nonEmptyId),
  otherMovements: z.array(signedFactRefSchema),
  closingBalanceFactId: nonEmptyId,
});

const noteSchema = z.object({
  noteId: nonEmptyId,
  noteNumber: z.string(),
  title: z.string(),
  monetaryFactIds: z.array(z.string()),
  totalFactId: z.string().optional(),
  movementSchedule: movementScheduleSchema.optional(),
});

const noteReferenceSchema = z.object({ noteReferenceId: nonEmptyId, fromLineId: nonEmptyId, toNoteId: nonEmptyId });

const accountingPolicySchema = z.object({ policyId: nonEmptyId, topic: z.string(), text: z.string(), provenance: provenanceRecordSchema });
const textualDisclosureSchema = z.object({ disclosureId: nonEmptyId, relatedNoteId: z.string().optional(), text: z.string(), provenance: provenanceRecordSchema });

const reportIdentitySchema = z.object({ reportId: nonEmptyId, companyId: nonEmptyId, reportVersion: z.number().int().min(1) });
const entityIdentitySchema = z.object({ legalName: z.string(), taxIdentificationNumber: z.string().optional(), jurisdiction: z.string().optional() });

function periodSchema<T extends z.ZodRawShape>(extra: T) {
  return z
    .object({
      periodId: nonEmptyId,
      startDate: isoDateSchema,
      endDate: isoDateSchema,
      periodYear: z.number().int(),
      ...extra,
    })
    .superRefine((period, ctx) => {
      if (period.startDate > period.endDate) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "startDate must be on or before endDate", path: ["startDate"] });
      }
      const startYear = Number(period.startDate.slice(0, 4));
      const endYear = Number(period.endDate.slice(0, 4));
      if (period.periodYear !== startYear && period.periodYear !== endYear) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `periodYear (${period.periodYear}) must equal the start-date year (${startYear}) or end-date year (${endYear})`, path: ["periodYear"] });
      }
    });
}

const reportingPeriodSchema = periodSchema({});
const comparativePeriodSchema = periodSchema({ isRestated: z.boolean(), restatementReason: z.string().optional() });

const reportingFrameworkSchema = z.object({ kind: z.enum(["IFRS", "IFRS_FOR_SMES", "IPSAS_ACCRUAL", "IPSAS_CASH"]), version: z.string().optional() });

// ─── Root schema ─────────────────────────────────────────────────────────

const canonicalFinancialStatementReportBaseSchema = z.object({
  schemaVersion: z.string(),
  reportIdentity: reportIdentitySchema,
  entity: entityIdentitySchema,
  period: reportingPeriodSchema,
  comparativePeriods: z.array(comparativePeriodSchema),
  framework: reportingFrameworkSchema,
  presentationCurrency: presentationCurrencySchema,
  statements: z.array(statementSchema),
  notes: z.array(noteSchema),
  noteReferences: z.array(noteReferenceSchema),
  accountingPolicies: z.array(accountingPolicySchema),
  textualDisclosures: z.array(textualDisclosureSchema),
  facts: z.array(monetaryFactSchema),
  provenanceOrigin: z.enum(["TRIAL_BALANCE_DERIVED", "DOCUMENT_REVIEWED"]),
});

function addDuplicates(ctx: z.RefinementCtx, ids: readonly string[], path: (string | number)[], label: string): void {
  const seen = new Map<string, number>();
  ids.forEach((id, i) => {
    if (seen.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate ${label} "${id}"`, path: [...path, i] });
    }
    seen.set(id, i);
  });
}

export const canonicalFinancialStatementReportSchema = canonicalFinancialStatementReportBaseSchema.superRefine((report, ctx) => {
  // 1. schemaVersion exact match.
  if (report.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `schemaVersion must be exactly "${CANONICAL_SCHEMA_VERSION}"`, path: ["schemaVersion"] });
  }

  // 3. ID uniqueness within namespace.
  addDuplicates(ctx, report.statements.map((s) => s.statementId), ["statements"], "statementId");
  const allLineIds = report.statements.flatMap((s) => s.sections.flatMap((sec) => sec.lines.map((l) => l.lineId)));
  addDuplicates(ctx, allLineIds, ["statements"], "lineId");
  // D. sectionId unique within the report (report-wide, matching lineId's own report-wide scope).
  const allSectionIds = report.statements.flatMap((s) => s.sections.map((sec) => sec.sectionId));
  addDuplicates(ctx, allSectionIds, ["statements"], "sectionId");
  addDuplicates(ctx, report.notes.map((n) => n.noteId), ["notes"], "noteId");
  addDuplicates(ctx, report.noteReferences.map((r) => r.noteReferenceId), ["noteReferences"], "noteReferenceId");
  addDuplicates(ctx, report.accountingPolicies.map((p) => p.policyId), ["accountingPolicies"], "policyId");
  addDuplicates(ctx, report.textualDisclosures.map((d) => d.disclosureId), ["textualDisclosures"], "disclosureId");
  // E. movement scheduleId unique within the report.
  const allScheduleIds = report.notes.flatMap((n) => (n.movementSchedule ? [n.movementSchedule.scheduleId] : []));
  addDuplicates(ctx, allScheduleIds, ["notes"], "movementSchedule.scheduleId");

  // 7 & 8. current/comparative periodId uniqueness; comparative may never reuse the current periodId.
  if (report.period.periodId !== CURRENT_PERIOD_ID) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `report.period.periodId must be "${CURRENT_PERIOD_ID}"`, path: ["period", "periodId"] });
  }
  const allPeriodIds = [report.period.periodId, ...report.comparativePeriods.map((p) => p.periodId)];
  addDuplicates(ctx, allPeriodIds, ["comparativePeriods"], "periodId");
  report.comparativePeriods.forEach((p, i) => {
    if (p.periodId === report.period.periodId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `comparativePeriods[${i}] reuses the current period's periodId`, path: ["comparativePeriods", i, "periodId"] });
    }
  });

  // Fact lineage: (factId, version) uniqueness (16), version-1 origin (17), contiguous non-branching chain (18).
  const factsById = new Map<string, typeof report.facts>();
  report.facts.forEach((fact) => factsById.set(fact.factId, [...(factsById.get(fact.factId) ?? []), fact]));
  for (const [factId, versions] of factsById) {
    const seenVersions = new Set<number>();
    for (const fact of versions) {
      if (seenVersions.has(fact.version)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `fact "${factId}" has more than one entry at version ${fact.version}`, path: ["facts"] });
      }
      seenVersions.add(fact.version);
    }
    const sorted = [...versions].sort((a, b) => a.version - b.version);
    if (sorted[0].version !== 1 || sorted[0].supersedesVersion !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `fact "${factId}" lineage must begin at version 1 with supersedesVersion=null`, path: ["facts"] });
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].version !== sorted[i - 1].version + 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `fact "${factId}" has a gap in its version chain before version ${sorted[i].version}`, path: ["facts"] });
      }
      if (sorted[i].supersedesVersion !== sorted[i].version - 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `fact "${factId}" version ${sorted[i].version} must declare supersedesVersion=${sorted[i].version - 1}`, path: ["facts"] });
      }
    }
  }

  // 15 (fact existence) / 20 (casting children exist, same statement, no self-reference) / 21 (movement schedule fact refs).
  const knownFactIds = new Set(report.facts.map((f) => f.factId));
  function checkFactRef(factId: string, path: (string | number)[]): void {
    if (!knownFactIds.has(factId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `references factId "${factId}", which does not exist in report.facts`, path });
    }
  }

  // F. every fact binding's periodId must be either the current period or a declared comparative period.
  const declaredPeriodIds = new Set<string>([CURRENT_PERIOD_ID, ...report.comparativePeriods.map((p) => p.periodId)]);

  report.statements.forEach((statement, si) => {
    const lineIdsInStatement = new Set(statement.sections.flatMap((sec) => sec.lines.map((l) => l.lineId)));
    statement.sections.forEach((section, seci) => {
      section.lines.forEach((line, li) => {
        line.factBindings.forEach((binding, bi) => {
          checkFactRef(binding.factId, ["statements", si, "sections", seci, "lines", li, "factBindings", bi, "factId"]);
          if (!declaredPeriodIds.has(binding.periodId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `factBinding periodId "${binding.periodId}" is neither "${CURRENT_PERIOD_ID}" nor a declared comparative period`,
              path: ["statements", si, "sections", seci, "lines", li, "factBindings", bi, "periodId"],
            });
          }
        });
        line.castingChildLineIds.forEach((childId, ci) => {
          if (!lineIdsInStatement.has(childId)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `castingChildLineIds references "${childId}", which is not a line within the same statement "${statement.statementId}"`, path: ["statements", si, "sections", seci, "lines", li, "castingChildLineIds", ci] });
          }
        });
      });
    });
  });

  // G. a fact's own reportingPeriod.isComparative must agree with whether its periodId is the current period or a declared comparative period (self-consistency only — an undeclared/rogue periodId is Rule 4's concern, not a validation rejection; see the module boundary comment).
  const declaredComparativePeriodIds = new Set(report.comparativePeriods.map((p) => p.periodId));
  report.facts.forEach((f, fi) => {
    const { periodId, isComparative } = f.reportingPeriod;
    if (periodId === CURRENT_PERIOD_ID && isComparative) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `fact "${f.factId}" declares reportingPeriod.periodId="${CURRENT_PERIOD_ID}" but isComparative=true`, path: ["facts", fi, "reportingPeriod", "isComparative"] });
    } else if (declaredComparativePeriodIds.has(periodId) && !isComparative) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `fact "${f.factId}" declares reportingPeriod.periodId="${periodId}" (a declared comparative period) but isComparative=false`, path: ["facts", fi, "reportingPeriod", "isComparative"] });
    }
  });

  // A & B. Note.monetaryFactIds must resolve to real facts and contain no duplicates.
  report.notes.forEach((note, ni) => {
    addDuplicates(ctx, note.monetaryFactIds, ["notes", ni, "monetaryFactIds"], "factId");
    note.monetaryFactIds.forEach((id, i) => checkFactRef(id, ["notes", ni, "monetaryFactIds", i]));
    if (note.totalFactId) checkFactRef(note.totalFactId, ["notes", ni, "totalFactId"]);
    if (note.movementSchedule) {
      const ms = note.movementSchedule;
      checkFactRef(ms.openingBalanceFactId, ["notes", ni, "movementSchedule", "openingBalanceFactId"]);
      checkFactRef(ms.closingBalanceFactId, ["notes", ni, "movementSchedule", "closingBalanceFactId"]);
      ms.additionFactIds.forEach((id, i) => checkFactRef(id, ["notes", ni, "movementSchedule", "additionFactIds", i]));
      ms.disposalFactIds.forEach((id, i) => checkFactRef(id, ["notes", ni, "movementSchedule", "disposalFactIds", i]));
      ms.otherMovements.forEach((ref, i) => checkFactRef(ref.factId, ["notes", ni, "movementSchedule", "otherMovements", i, "factId"]));
    }
  });

  // C. every TextualDisclosure.relatedNoteId must resolve to an existing Note.
  const knownNoteIds = new Set(report.notes.map((n) => n.noteId));
  report.textualDisclosures.forEach((disclosure, di) => {
    if (disclosure.relatedNoteId && !knownNoteIds.has(disclosure.relatedNoteId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `relatedNoteId "${disclosure.relatedNoteId}" does not resolve to any note`, path: ["textualDisclosures", di, "relatedNoteId"] });
    }
  });

  // 22. No duplicate source-document IDs with conflicting hashes.
  const sourceHashesByDocId = new Map<string, Set<string>>();
  function recordSource(source: z.infer<typeof sourceArtifactSchema>): void {
    const hashes = sourceHashesByDocId.get(source.sourceDocumentId) ?? new Set<string>();
    hashes.add(source.sourceHash);
    sourceHashesByDocId.set(source.sourceDocumentId, hashes);
  }
  report.facts.forEach((f) => recordSource(f.provenance.source));
  report.accountingPolicies.forEach((p) => recordSource(p.provenance.source));
  report.textualDisclosures.forEach((d) => recordSource(d.provenance.source));
  for (const [sourceDocumentId, hashes] of sourceHashesByDocId) {
    if (hashes.size > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `sourceDocumentId "${sourceDocumentId}" is associated with ${hashes.size} conflicting sourceHash values`, path: ["facts"] });
    }
  }

  // 24. Framework-specific structural contradictions.
  const statementTypes = new Set(report.statements.map((s) => s.type));
  if (report.framework.kind === "IPSAS_CASH") {
    if (statementTypes.has("STATEMENT_OF_FINANCIAL_POSITION")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an IPSAS_CASH report cannot contain a STATEMENT_OF_FINANCIAL_POSITION (an accrual-basis statement)", path: ["framework", "kind"] });
    }
    if (!statementTypes.has("STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an IPSAS_CASH report must contain a STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS", path: ["framework", "kind"] });
    }
  } else {
    if (statementTypes.has("STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${report.framework.kind} report cannot contain a STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS (a cash-basis statement)`, path: ["framework", "kind"] });
    }
    if (!statementTypes.has("STATEMENT_OF_FINANCIAL_POSITION")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${report.framework.kind} report must contain a STATEMENT_OF_FINANCIAL_POSITION`, path: ["framework", "kind"] });
    }
  }
});

// ─── Public API ──────────────────────────────────────────────────────────

function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message }));
}

/** Never repairs, never coerces — fails closed with the full structured issue list. */
export function safeValidateCanonicalReport(input: unknown): ValidationResult {
  const result = canonicalFinancialStatementReportSchema.safeParse(input);
  if (!result.success) {
    return { status: "INVALID", issues: toValidationIssues(result.error) };
  }
  return { status: "VALID", report: result.data as CanonicalFinancialStatementReport };
}

/** Same validation as `safeValidateCanonicalReport`, throwing `CanonicalValidationError` on failure instead of returning a result object. */
export function validateCanonicalReport(input: unknown): CanonicalFinancialStatementReport {
  const result = safeValidateCanonicalReport(input);
  if (result.status === "VALID") {
    return result.report;
  }
  throw new CanonicalValidationError(result.issues);
}
