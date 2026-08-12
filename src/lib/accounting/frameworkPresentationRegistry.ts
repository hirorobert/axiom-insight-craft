/**
 * frameworkPresentationRegistry.ts — Ω∞ public-sector / framework
 * intelligence engine, Slice 3: Framework Presentation Registry.
 *
 * Data-driven registry (Section IV: "composable registries/adapters", not
 * branching code) mapping a ReportingFramework to its statement presentation
 * (display label, statement names, statutory footer). Replaces the
 * if/else-that-throws `getFrameworkConfig()` previously inlined in
 * ExportStatements.tsx — that function's own comment invited exactly this:
 * "When a third framework is added, refactor to Framework Adapter pattern."
 *
 * Content below is ported VERBATIM from the two existing branches — no
 * statutory-citation wording changed. Only IFRS_FOR_SMES and IPSAS_ACCRUAL
 * have entries today, matching exactly what CompanyManager.tsx allows a
 * preparer to select (full_ifrs and ipsas_cash are UI-disabled "coming
 * soon" — PHASE-0-PUBLIC-SECTOR-REALITY-AUDIT.md §2). Adding a third
 * framework's presentation (e.g. an IPSAS agency/LGA variant, Section IX)
 * means adding a registry entry here, never a new if-branch anywhere.
 */

import type { ReportingFramework } from "./entityContext";

export interface FrameworkPresentation {
  displayLabel: string;
  statementNames: {
    balanceSheet: string;
    incomeStatement: string;
    equity: string;
    cashFlow: string;
  };
  footer: string;
}

const FRAMEWORK_PRESENTATION_REGISTRY: Partial<
  Record<ReportingFramework, FrameworkPresentation>
> = {
  IFRS_FOR_SMES: {
    displayLabel: "IFRS for SMEs",
    statementNames: {
      balanceSheet: "Statement of Financial Position",
      incomeStatement: "Statement of Comprehensive Income",
      equity: "Statement of Changes in Equity",
      cashFlow: "Statement of Cash Flows",
    },
    footer:
      "Prepared in accordance with the International Financial Reporting " +
      "Standard for Small and Medium-sized Entities (IFRS for SMEs) as issued by the IASB.",
  },
  IPSAS_ACCRUAL: {
    displayLabel: "IPSAS Accrual",
    statementNames: {
      balanceSheet: "Statement of Financial Position",
      incomeStatement: "Statement of Financial Performance",
      equity: "Statement of Changes in Net Assets/Equity",
      cashFlow: "Statement of Cash Flows",
    },
    footer:
      "Prepared in accordance with International Public Sector Accounting " +
      "Standards (IPSAS) as issued by the IPSASB. Accrual basis.",
  },
};

/**
 * Look up presentation for a ReportingFramework. Returns null — never
 * throws, never guesses (C4) — when no registry entry exists yet. Callers
 * decide how to surface that; ExportStatements.tsx preserves its existing
 * blocking-toast behavior for anything without an entry.
 */
export function getFrameworkPresentation(
  framework: ReportingFramework,
): FrameworkPresentation | null {
  return FRAMEWORK_PRESENTATION_REGISTRY[framework] ?? null;
}

/** The frameworks with real presentation content registered today. */
export function supportedPresentationFrameworks(): ReportingFramework[] {
  return Object.keys(FRAMEWORK_PRESENTATION_REGISTRY) as ReportingFramework[];
}
