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

const ADAPTER = { file: "src/lib/financialStatementsWorkspace/trialBalanceAdapter.ts", symbol: "createTrialBalanceAdapter" };
const READINESS = (code: string) => ({ file: "supabase/migrations/20261017100000_signoff_completion_requirements.sql", symbol: code });

/** IFRS for SMEs (both editions share requirement ids). */
export const IFRS_FOR_SMES_COVERAGE: Readonly<Record<string, CoverageEntry>> = {
  "smes.set.sfp": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [ADAPTER],
    note: "Sections by account classification (current/non-current assets and liabilities, equity). The 4.2 minimum line items are not composed (see smes.sfp.4_2_*)." },
  "smes.set.sci": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [ADAPTER],
    note: "Profit or loss by classification (revenue, cost of goods sold, operating expenses, other income, taxes). No other comprehensive income." },
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
  ...Object.fromEntries(["a", "b", "c", "d", "e", "ea", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r"].map((l) =>
    [`smes.sfp.4_2_${l}`, { status: "MISSING" as const, note: "No reviewed account-to-presentation-line authority exists; account classifications are coarser than the 4.2 line items." }])),
  "smes.sfp.4_4": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [ADAPTER], note: "Current/non-current from the reviewed classification; no liquidity-order option." },
  "smes.sci.5_5_a": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [ADAPTER], note: "The 'revenue' classification." },
  "smes.sci.5_5_b": { status: "MISSING", note: "Finance costs are not distinguished from other expenses by any reviewed authority." },
  "smes.sci.5_5_c": { status: "MISSING" },
  "smes.sci.5_5_d": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [ADAPTER], note: "The 'taxes' classification, from preparer-recorded balances only (no tax engine)." },
  "smes.sci.5_5_e": { status: "MISSING" },
  "smes.sci.5_5_f": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [{ file: "src/lib/financialStatementsWorkspace/trialBalanceAdapter.ts", symbol: "NET_RESULT_CONCEPT" }],
    note: "Computed only when every profit-or-loss section is available for the period." },
  "smes.sci.5_5_g": { status: "MISSING", note: "No other comprehensive income support." },
  "smes.sci.5_5_h": { status: "MISSING" },
  "smes.sci.5_5_i": { status: "MISSING", note: "Not presented; where there is no OCI the standard permits 'profit or loss' (5.5(f)) instead." },
  "smes.sci.5_11": { status: "IMPLEMENTED_NOT_VALIDATED", implementedBy: [ADAPTER], note: "Function basis only, through the cost-of-goods-sold / operating-expenses classifications." },
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
