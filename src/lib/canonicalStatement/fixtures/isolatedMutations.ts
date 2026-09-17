// canonicalStatement/fixtures/isolatedMutations.ts — one mutation function
// per rule, each applied to ISOLATED_BASELINE and changing only what that
// rule's own defect requires. Every function returns a NEW
// CanonicalFinancialStatementReport (the baseline is never mutated) that
// still passes `validateCanonicalReport` — see isolatedRuleFixtures.test.ts
// for the proof that each mutation trips exactly its target rule and
// leaves every other rule's outcome exactly as documented below.

import { moneyFromDecimalString } from "../money";
import { CANONICAL_CONCEPTS } from "../concepts";
import { CURRENT } from "./builders";
import {
  CCY,
  capitalCur,
  cashCmp,
  cashLine,
  closingCashCfCur,
  ppeLine,
  ppeNoteClosing,
  ppeNoteTotal,
  profitLine,
  SCALE,
  totalEquityCur,
  ISOLATED_BASELINE,
} from "./isolatedBaseline";
import type { CanonicalFinancialStatementReport, MonetaryFact, StatementLine } from "../types";

function amount(value: string): ReturnType<typeof moneyFromDecimalString> {
  return moneyFromDecimalString(CCY, SCALE, value);
}

/** Replaces one fact's value by factId, leaving every other field (including version) untouched. Never mutates the input. */
function withFactValue(report: CanonicalFinancialStatementReport, factId: string, newAmountStr: string): CanonicalFinancialStatementReport {
  return {
    ...report,
    facts: report.facts.map((f): MonetaryFact => (f.factId === factId ? { ...f, value: amount(newAmountStr) } : f)),
  };
}

function withFactReportingPeriod(report: CanonicalFinancialStatementReport, factId: string, periodId: string, isComparative: boolean): CanonicalFinancialStatementReport {
  return {
    ...report,
    facts: report.facts.map((f): MonetaryFact => (f.factId === factId ? { ...f, reportingPeriod: { periodId, isComparative } } : f)),
  };
}

function withLine(report: CanonicalFinancialStatementReport, lineId: string, transform: (line: StatementLine) => StatementLine): CanonicalFinancialStatementReport {
  return {
    ...report,
    statements: report.statements.map((s) => ({
      ...s,
      sections: s.sections.map((sec) => ({ ...sec, lines: sec.lines.map((l) => (l.lineId === lineId ? transform(l) : l)) })),
    })),
  };
}

function addFacts(report: CanonicalFinancialStatementReport, facts: readonly MonetaryFact[]): CanonicalFinancialStatementReport {
  return { ...report, facts: [...report.facts, ...facts] };
}

// ─── Rule 1 — sfp-equation ─────────────────────────────────────────────────
// Bumps total_equity's CURRENT value by +10,000, and compensates its own
// casting child (capital) by the same +10,000 so Rule 2's casting check for
// total_equity still holds. Only the equation (assets = liabilities +
// equity) breaks, because assets/liabilities are untouched: 800,000 vs
// 200,000 + 610,000 = 810,000.
export function mutateRule1SfpEquation(): CanonicalFinancialStatementReport {
  let report = withFactValue(ISOLATED_BASELINE, totalEquityCur.factId, "610000.00");
  report = withFactValue(report, capitalCur.factId, "610000.00");
  return report;
}

// ─── Rule 2 — subtotal-casting ─────────────────────────────────────────────
// Bumps the P&L "profit" TOTAL's own CURRENT value only — revenue/expenses
// (its casting children) are untouched, so the SFP equation (which never
// reads P&L facts) is entirely unaffected.
export function mutateRule2SubtotalCasting(): CanonicalFinancialStatementReport {
  return withFactValue(ISOLATED_BASELINE, profitLine.factBindings[0].factId, "410000.00");
}

// ─── Rule 3 — note-to-face-reconciliation ──────────────────────────────────
// Mutates the PPE note's `totalFactId` fact only — a fact distinct from
// both the face PPE line's own fact and the movement schedule's
// closingBalanceFactId, so neither Rule 1/2 (which read the face fact) nor
// Rule 7 (which reads the movement schedule's own closing fact) are touched.
export function mutateRule3NoteToFace(): CanonicalFinancialStatementReport {
  return withFactValue(ISOLATED_BASELINE, ppeNoteTotal.factId, "550000.00");
}

// ─── Rule 4 — comparative-period-alignment ─────────────────────────────────
// Changes the CASH line's comparative FACT's own `reportingPeriod` to an
// undeclared period id, while the BINDING itself (cashLine's factBindings
// entry) still points at the declared "COMPARATIVE_1". Every other rule
// resolves facts by BINDING periodId, not by the fact's own metadata, so
// this is invisible to Rules 1/2/9 — only Rule 4, which explicitly compares
// the two, can see it. Still schema-valid: validation checks the binding's
// periodId is declared (it is) and self-consistency for a periodId that IS
// declared (this one, "COMPARATIVE_ROGUE", is not, so that check does not
// apply — see validation.ts's own module comment).
export function mutateRule4ComparativeAlignment(): CanonicalFinancialStatementReport {
  return withFactReportingPeriod(ISOLATED_BASELINE, cashCmp.factId, "COMPARATIVE_ROGUE", true);
}

// ─── Rule 5 — currency-scale-consistency ───────────────────────────────────
// Adds one freestanding DETAIL line, bound to a fact denominated in USD
// while the report presents in TZS. Not part of any casting, equation,
// note, or cash-flow reconciliation, so nothing else can see it.
export function mutateRule5CurrencyScale(): CanonicalFinancialStatementReport {
  const usdFact: MonetaryFact = {
    factId: "iso-defect-other-assets",
    version: 1,
    value: { currency: "USD", scale: SCALE, minorUnits: 5000000n },
    reportingPeriod: CURRENT,
    signConvention: "NATURAL",
    provenance: ppeNoteTotal.provenance,
    supersedesVersion: null,
  };
  const [sfp, ...rest] = ISOLATED_BASELINE.statements;
  const otherAssetsLine: StatementLine = {
    lineId: "iso-defect-other-assets-line",
    label: "Other financial assets",
    concept: "other_financial_assets",
    role: "DETAIL",
    normalBalance: "DEBIT_NORMAL",
    isContra: false,
    factBindings: [{ periodId: "CURRENT", factId: usdFact.factId }],
    castingChildLineIds: [],
  };
  const mutatedSfp = { ...sfp, sections: [{ ...sfp.sections[0], lines: [...sfp.sections[0].lines, otherAssetsLine] }, ...sfp.sections.slice(1)] };
  return addFacts({ ...ISOLATED_BASELINE, statements: [mutatedSfp, ...rest] }, [usdFact]);
}

// ─── Rule 6 — cashflow-closing-cash-reconciliation ─────────────────────────
// Mutates the cash-flow statement's own closing-cash fact (a fact distinct
// from the SFP's cash fact) — the SFP side of the comparison is untouched.
export function mutateRule6CashFlowClosing(): CanonicalFinancialStatementReport {
  return withFactValue(ISOLATED_BASELINE, closingCashCfCur.factId, "310000.00");
}

// ─── Rule 7 — movement-reconciliation ──────────────────────────────────────
// Mutates the movement schedule's own closingBalanceFactId fact — a fact
// distinct from the note's totalFactId used by Rule 3 — so the note-to-face
// reconciliation (which reads totalFactId) is untouched.
export function mutateRule7MovementReconciliation(): CanonicalFinancialStatementReport {
  return withFactValue(ISOLATED_BASELINE, ppeNoteClosing.factId, "510000.00");
}

// ─── Rule 8 — duplicate-detection ──────────────────────────────────────────
// (a) A second TOTAL line sharing total_assets's concept+role. It casts the
//     SAME children (ppe + cash) as the real total_assets line, at a value
//     that ALSO matches their sum for both periods — so Rule 2's casting
//     check and Rule 9's missing-comparative check both legitimately PASS
//     for it too (more PASS results for those rules, never a new FAIL or
//     INSUFFICIENT_EVIDENCE — asserted explicitly in the test file). Rule 1
//     is unaffected regardless: it looks up total_assets via a first-match
//     lookup that already resolves to the ORIGINAL line before this one.
// (b) Two freestanding facts sharing one fingerprint (identical value,
//     period, and source locator) — neither bound to any line.
export function mutateRule8DuplicateDetection(): CanonicalFinancialStatementReport {
  const duplicateTotalFactCur: MonetaryFact = {
    factId: "iso-defect-dup-total-assets-cur",
    version: 1,
    value: amount("800000.00"), // matches ppe(500,000) + cash(300,000), same as the real total_assets line
    reportingPeriod: CURRENT,
    signConvention: "NATURAL",
    provenance: ppeNoteTotal.provenance,
    supersedesVersion: null,
  };
  const duplicateTotalFactCmp: MonetaryFact = {
    factId: "iso-defect-dup-total-assets-cmp",
    version: 1,
    value: amount("700000.00"), // matches ppe(450,000) + cash(250,000) comparative
    reportingPeriod: { periodId: "COMPARATIVE_1", isComparative: true },
    signConvention: "NATURAL",
    provenance: ppeNoteTotal.provenance,
    supersedesVersion: null,
  };
  const duplicateTotalLine: StatementLine = {
    lineId: "iso-defect-dup-total-assets-line",
    label: "Grand total assets",
    concept: CANONICAL_CONCEPTS.TOTAL_ASSETS,
    role: "TOTAL",
    normalBalance: "DEBIT_NORMAL",
    isContra: false,
    factBindings: [
      { periodId: "CURRENT", factId: duplicateTotalFactCur.factId },
      { periodId: "COMPARATIVE_1", factId: duplicateTotalFactCmp.factId },
    ],
    castingChildLineIds: [ppeLine.lineId, cashLine.lineId],
  };

  const sharedLocator = { kind: "MANUAL" as const, note: "iso-defect-duplicate-source-cell" };
  const fingerprintFactA: MonetaryFact = {
    factId: "iso-defect-fingerprint-a",
    version: 1,
    value: amount("777000.00"),
    reportingPeriod: CURRENT,
    signConvention: "NATURAL",
    provenance: { ...ppeNoteTotal.provenance, locator: sharedLocator },
    supersedesVersion: null,
  };
  const fingerprintFactB: MonetaryFact = {
    ...fingerprintFactA,
    factId: "iso-defect-fingerprint-b",
  };

  const [sfp, ...rest] = ISOLATED_BASELINE.statements;
  const mutatedSfp = { ...sfp, sections: [{ ...sfp.sections[0], lines: [...sfp.sections[0].lines, duplicateTotalLine] }, ...sfp.sections.slice(1)] };
  return addFacts({ ...ISOLATED_BASELINE, statements: [mutatedSfp, ...rest] }, [duplicateTotalFactCur, duplicateTotalFactCmp, fingerprintFactA, fingerprintFactB]);
}

// ─── Rule 9 — missing-comparative-detection ────────────────────────────────
// Removes the P&L "profit" TOTAL's COMPARATIVE_1 binding entirely. Profit
// is not read by the SFP equation (Rule 1) at all. The ONE documented
// secondary effect: Rule 2 (subtotal-casting) no longer produces a
// COMPARATIVE_1 result for the profit line, because there is no longer a
// binding for that period to check — this is an ABSENCE of a result, never
// a wrong PASS or FAIL, and is asserted explicitly in the test file.
export function mutateRule9MissingComparative(): CanonicalFinancialStatementReport {
  return withLine(ISOLATED_BASELINE, profitLine.lineId, (line) => ({
    ...line,
    factBindings: line.factBindings.filter((b) => b.periodId !== "COMPARATIVE_1"),
  }));
}

// ─── Rule 10 — orphaned-note-reference-detection ───────────────────────────
// Adds one new, freestanding NoteReference pointing at a nonexistent note.
// The existing valid PPE note reference is untouched. The ONE documented
// secondary effect: Rule 3 (note-to-face-reconciliation) also iterates
// every NoteReference, and for one whose target doesn't resolve it emits
// its own NOT_APPLICABLE ("broken-reference detection is Rule 10's job")
// rather than silently ignoring it — an unavoidable, already-documented
// consequence of Rule 3's own design, asserted explicitly in the test file
// as a NOT_APPLICABLE addition, never a FAIL.
export function mutateRule10OrphanedNoteReference(): CanonicalFinancialStatementReport {
  return {
    ...ISOLATED_BASELINE,
    noteReferences: [...ISOLATED_BASELINE.noteReferences, { noteReferenceId: "iso-defect-nr-broken", fromLineId: ppeLine.lineId, toNoteId: "no-such-note" }],
  };
}

export const ISOLATED_MUTATIONS: Readonly<Record<string, () => CanonicalFinancialStatementReport>> = {
  "sfp-equation": mutateRule1SfpEquation,
  "subtotal-casting": mutateRule2SubtotalCasting,
  "note-to-face-reconciliation": mutateRule3NoteToFace,
  "comparative-period-alignment": mutateRule4ComparativeAlignment,
  "currency-scale-consistency": mutateRule5CurrencyScale,
  "cashflow-closing-cash-reconciliation": mutateRule6CashFlowClosing,
  "movement-reconciliation": mutateRule7MovementReconciliation,
  "duplicate-detection": mutateRule8DuplicateDetection,
  "missing-comparative-detection": mutateRule9MissingComparative,
  "orphaned-note-reference-detection": mutateRule10OrphanedNoteReference,
};
