// frameworkPacks/coverage.ts — the coverage matrix: for every requirement of a pack, how far this product honours it.
//
//   VALIDATED                  implemented AND independently validated: a golden fixture whose expected output was
//                              prepared OUTSIDE this code by a named qualified reviewer, and a sign-off date. Passing
//                              tests whose expectations the implementation produced never counts.
//   IMPLEMENTED_NOT_VALIDATED  a code path exists (named below; a test proves every named symbol exists).
//   MISSING                    not produced. Where the pack marks the requirement blocking, the report cannot be
//                              finalised while it applies.
//
// No product copy or export may claim more than this matrix says (frameworkPackCoverage.test.ts scans for compliance
// claims). Each later increment changes entries here in the same PR that adds the code.

import type { CoverageStatus, FrameworkPack } from "./types";

export interface ImplementationRef {
  /** Repository-relative file. */
  readonly file: string;
  /** An exported TypeScript symbol, or (for .sql) a literal that must appear in the file. */
  readonly symbol: string;
}

export interface IndependentValidation {
  readonly fixture: string;
  readonly reviewer: string;
  readonly qualification: string;
  readonly signedOff: string;
}

export interface CoverageEntry {
  readonly status: CoverageStatus;
  readonly implementedBy?: readonly ImplementationRef[];
  readonly validation?: IndependentValidation;
  /** What is and is not covered — always stated for a partial implementation. */
  readonly note?: string;
}

const COMPOSITION_SQL = "supabase/migrations/20261018100000_fs_statement_composition.sql";
/** The database composition (20261018100000): a line of the vocabulary, or a named construct of fs_statement_composition. */
const COMPOSED = (literal: string) => ({ file: COMPOSITION_SQL, symbol: literal });
const VIEW = { file: "src/lib/statements/composition.ts", symbol: "statementViews" };
const READINESS = (code: string) => ({ file: "supabase/migrations/20261017100000_signoff_completion_requirements.sql", symbol: code });

/** IFRS for SMEs (both editions share requirement ids). */
export const IFRS_FOR_SMES_COVERAGE: Readonly<Record<string, CoverageEntry>> = {
  "smes.set.sfp": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [COMPOSED("FUNCTION public.fs_statement_composition"), VIEW],
    note: "Composed by the database from the authoritative reporting input and reviewed presentation assignments (pack lines, current/non-current sections); totals only for a fully presented period. The earlier client adapter remains for the legacy workspace." },
  "smes.set.sci": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [COMPOSED("FUNCTION public.fs_statement_composition"), VIEW],
    note: "Profit or loss composed by the database (income lines less expense lines, profit before tax, tax). No other comprehensive income." },
  "smes.set.socie": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [{ file: "src/lib/financialGeneration/equityStatement.ts", symbol: "buildEquityStatement" }],
    note: "Only from preparer-supplied EQUITY_MOVEMENTS evidence; never derived from a closing trial balance. The 3.18 alternative is not offered." },
  "smes.set.scf": { status: "IMPLEMENTED_NOT_VALIDATED",
    implementedBy: [{ file: "src/lib/financialGeneration/cashFlowDirect.ts", symbol: "buildDirectCashFlow" }, { file: "src/lib/financialGeneration/cashLedgerAuthority.ts", symbol: "establishCashLedgerAuthority" }],
    note: "Direct method only, from a TRANSACTION_LEDGER evidence batch reconciled account by account to the trial-balance cash movement. Never manufactured from a closing trial balance." },
  "smes.set.notes": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [{ file: "src/lib/financialGeneration/notesAndSchedules.ts", symbol: "assembleNotes" }],
    note: "Preparer-supplied wording kept verbatim; nothing is generated." },
  "smes.comparatives": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [READINESS("COMPARATIVE_PERIOD_MISSING")],
    note: "Server blocks REVIEWED/FINAL without comparatives unless a first-period declaration is in force. One comparative period only." },
  "smes.period.annual": { status: "MISSING", note: "No period-length check and no longer/shorter-period disclosure." },
  ...Object.fromEntries(([["a", "cash_and_cash_equivalents"], ["b", "trade_and_other_receivables"], ["c", "other_financial_assets"], ["d", "inventories"],
    ["e", "property_plant_and_equipment"], ["ea", "investment_property_cost"], ["f", "investment_property_fair_value"], ["g", "intangible_assets"],
    ["h", "biological_assets_cost"], ["i", "biological_assets_fair_value"], ["j", "investments_in_associates"], ["k", "investments_in_jointly_controlled_entities"],
    ["l", "trade_and_other_payables"], ["m", "other_financial_liabilities"], ["n", "current_tax"], ["o", "deferred_tax"], ["p", "provisions"],
    ["q", "non_controlling_interest"], ["r", "equity_attributable_to_owners"]] as const).map(([l, line]) =>
    [`smes.sfp.4_2_${l}`, { status: "IMPLEMENTED_NOT_VALIDATED" as const, implementedBy: [COMPOSED(`'sfp.${line}'`), COMPOSED("FUNCTION public.fs_assign_presentation")],
      note: "Presented when reviewed accounts are assigned to the line (prepare_close, append-only history); an unassigned or incompatible account blocks and leaves totals uncomputed." }])),
  "smes.sfp.4_4": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [COMPOSED("FUNCTION public._fs_presentation_status")],
    note: "Sections follow the reviewed classification; a line's position (current, non-current, deferred tax always non-current) is enforced. No liquidity-order option." },
  "smes.sci.5_5_a": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [COMPOSED("'sci.revenue'")] },
  "smes.sci.5_5_b": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [COMPOSED("'sci.finance_costs'")], note: "By reviewed assignment of the account to the finance-costs line." },
  "smes.sci.5_5_c": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [COMPOSED("'sci.share_of_associates'")], note: "A line only; equity-method accounting itself is not computed here." },
  "smes.sci.5_5_d": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [COMPOSED("'sci.tax_expense'")], note: "From preparer-recorded balances only (no tax engine)." },
  "smes.sci.5_5_e": { status: "MISSING" },
  "smes.sci.5_5_f": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [COMPOSED("'profitOrLossMinor'")],
    note: "Computed by the database only when every account of the period is presented." },
  "smes.sci.5_5_g": { status: "MISSING", note: "No other comprehensive income support." },
  "smes.sci.5_5_h": { status: "MISSING" },
  "smes.sci.5_5_i": { status: "MISSING", note: "Not presented; where there is no OCI the standard permits 'profit or loss' (5.5(f)) instead." },
  "smes.sci.5_11": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [COMPOSED("EXPENSE_ANALYSIS_MIXED")],
    note: "By function (cost of sales, other expenses) or by nature (employee benefits, depreciation, other); mixing both blocks." },
  "smes.note.compliance": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [READINESS("DISCLOSURE_CHECKLIST_INCOMPLETE")],
    note: "Checklist area 'basis-of-preparation' must be provided or not-applicable with rationale; the wording is the preparer's." },
  "smes.note.identification": { status: "MISSING" },
  "smes.note.policies": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [READINESS("DISCLOSURE_CHECKLIST_INCOMPLETE")], note: "Checklist area 'accounting-policies'." },
  "smes.note.judgements": { status: "MISSING", note: "Not tracked as its own requirement." },
  "smes.note.estimates": { status: "MISSING", note: "Not tracked as its own requirement." },
  "smes.note.subclassifications": { status: "MISSING" },
  "smes.note.share_capital": { status: "MISSING" },
  "smes.note.early_application": { status: "MISSING" },
};

export interface CoverageRow { readonly requirementId: string; readonly label: string; readonly kind: string; readonly citations: string; readonly status: CoverageStatus; readonly evidence: string; readonly note: string }

export function coverageRows(pack: FrameworkPack, coverage: Readonly<Record<string, CoverageEntry>>): CoverageRow[] {
  return pack.requirements.map((r) => {
    const e = coverage[r.id];
    if (!e) throw new Error(`coverage: no entry for ${r.id}`);
    return {
      requirementId: r.id, label: r.label, kind: r.kind,
      citations: r.citations.map((c) => `${c.paragraph} [${c.verification}]`).join("; "),
      status: e.status,
      evidence: e.status === "VALIDATED" ? `${e.validation!.fixture} — ${e.validation!.reviewer}, ${e.validation!.signedOff}` : (e.implementedBy ?? []).map((i) => `${i.file}#${i.symbol}`).join("<br>"),
      note: e.note ?? "",
    };
  });
}

export function renderCoverageMatrix(packs: readonly FrameworkPack[], coverage: Readonly<Record<string, CoverageEntry>>): string {
  const out: string[] = [
    "# Coverage matrix — IFRS for SMEs",
    "",
    "GENERATED by `bun scripts/release/renderCoverageMatrix.mjs` from `src/lib/frameworkPacks/` — do not edit; a test pins this file to the code.",
    "",
    "- **VALIDATED** — implemented and independently validated (golden fixture prepared outside the code by a named qualified reviewer). **None yet.**",
    "- **IMPLEMENTED_NOT_VALIDATED** — a code path exists (named; existence tested). Not a compliance claim.",
    "- **MISSING** — not produced; blocks finalisation where the requirement applies and is blocking.",
    "",
    "No complete-compliance claim is made for any framework.",
  ];
  for (const pack of packs) {
    const rows = coverageRows(pack, coverage);
    const count = (s: CoverageStatus) => rows.filter((r) => r.status === s).length;
    out.push("", `## ${pack.edition.title} — pack \`${pack.id}\` v${pack.packVersion}`, "",
      `Effective for annual periods beginning on or after ${pack.edition.effectiveForPeriodsBeginningOnOrAfter}. Requirements: ${rows.length} — VALIDATED ${count("VALIDATED")}, IMPLEMENTED_NOT_VALIDATED ${count("IMPLEMENTED_NOT_VALIDATED")}, MISSING ${count("MISSING")}.`,
      "", "| Requirement | Kind | Citation [verification] | Status | Implemented by / validated by | Note |", "|---|---|---|---|---|---|");
    for (const r of rows) out.push(`| \`${r.requirementId}\` ${r.label} | ${r.kind} | ${r.citations} | ${r.status} | ${r.evidence} | ${r.note} |`);
  }
  return out.join("\n") + "\n";
}
