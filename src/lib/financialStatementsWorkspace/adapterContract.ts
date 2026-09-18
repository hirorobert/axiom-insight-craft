// financialStatementsWorkspace/adapterContract.ts — the typed application
// boundary between CFOClose workspace data (companies, trial_balance_uploads,
// account_mappings, financial_statement_documents, ...) and the
// framework-neutral canonicalStatement engine (src/lib/canonicalStatement/**).
//
// Nothing in this file, or anywhere else under financialStatementsWorkspace/,
// computes an authoritative accounting result. Every adapter here only
// shapes workspace data into canonicalStatement's own input contracts
// (canonicalStatement/adapters.ts) and reports what it could and could not
// do — arithmetic correctness and business-rule evaluation stay entirely
// inside canonicalStatement/validation.ts and canonicalStatement/rules/**.
//
// Boundary rule: modules in this directory may import from
// canonicalStatement/**, never the other way around, and must never
// duplicate a check the canonical validator or rule pack already owns.

import type { ReportingFrameworkKind } from "@/lib/canonicalStatement/types";

export const ADAPTER_CONTRACT_VERSION = "1.0.0";

export type AdapterKind = "TRIAL_BALANCE" | "PDF" | "DOCX" | "XLSX" | "IXBRL";

export interface AdapterIdentity {
  readonly adapterKind: AdapterKind;
  /** Bumped whenever this adapter's normalization behavior changes — never the contract version above. */
  readonly adapterVersion: string;
}

export type AdapterDiagnosticSeverity = "BLOCKING" | "WARNING";

/**
 * An actionable, machine-readable diagnostic from an adapter run. BLOCKING
 * diagnostics accompany an `AdapterRejectedError` (nothing was extracted).
 * WARNING diagnostics accompany a returned result — data the adapter could
 * still honestly produce, alongside a caller-visible explanation of what it
 * left out and why (e.g. an account classification this adapter version
 * does not yet map into a statement).
 */
export interface AdapterDiagnostic {
  readonly code: string;
  readonly severity: AdapterDiagnosticSeverity;
  readonly message: string;
  readonly accountKey?: string;
  readonly accountName?: string;
}

/**
 * Thrown when an adapter cannot honestly produce any extraction at all —
 * never thrown for "some accounts were ambiguous," only for input that is
 * structurally unusable (malformed rows, inconsistent denomination, an
 * unsupported framework for this adapter version, zero usable input).
 * Callers must render `diagnostics` to the reviewer, never swallow this.
 */
export class AdapterRejectedError extends Error {
  readonly identity: AdapterIdentity;
  readonly diagnostics: readonly AdapterDiagnostic[];
  constructor(identity: AdapterIdentity, diagnostics: readonly AdapterDiagnostic[]) {
    super(
      `${identity.adapterKind} adapter v${identity.adapterVersion} rejected input with ` +
        `${diagnostics.length} blocking diagnostic(s): ${diagnostics.map((d) => `[${d.code}] ${d.message}`).join("; ")}`,
    );
    this.name = "AdapterRejectedError";
    this.identity = identity;
    this.diagnostics = diagnostics;
  }
}

/** The exact CHECK-constrained values of `companies.reporting_framework` (see 20260701000001 / 20260903100000). */
export type CompanyReportingFrameworkDbValue = "ifrs_for_smes" | "full_ifrs" | "ipsas_accrual" | "ipsas_cash";

const FRAMEWORK_DB_TO_CANONICAL: Record<CompanyReportingFrameworkDbValue, ReportingFrameworkKind> = {
  ifrs_for_smes: "IFRS_FOR_SMES",
  full_ifrs: "IFRS",
  ipsas_accrual: "IPSAS_ACCRUAL",
  ipsas_cash: "IPSAS_CASH",
};

export class UnresolvedFrameworkError extends Error {
  constructor(readonly rawValue: string | null | undefined) {
    super(
      rawValue
        ? `"${rawValue}" is not a recognized companies.reporting_framework value`
        : "companies.reporting_framework is not set for this company/period — a reporting framework must be explicitly chosen before statements can be prepared",
    );
    this.name = "UnresolvedFrameworkError";
  }
}

/**
 * Resolves `companies.reporting_framework` to the canonical engine's
 * `ReportingFrameworkKind` — never guesses, never defaults. A NULL or
 * unrecognized DB value throws `UnresolvedFrameworkError` rather than
 * silently falling back to any particular framework (Iron Dome 4.4: no
 * silent defaults).
 */
export function resolveCanonicalFramework(rawValue: string | null | undefined): ReportingFrameworkKind {
  if (!rawValue || !(rawValue in FRAMEWORK_DB_TO_CANONICAL)) {
    throw new UnresolvedFrameworkError(rawValue);
  }
  return FRAMEWORK_DB_TO_CANONICAL[rawValue as CompanyReportingFrameworkDbValue];
}

export class UnresolvedCurrencyError extends Error {
  constructor(readonly rawValue: string | null | undefined) {
    super(
      rawValue
        ? `"${rawValue}" is not a valid ISO 4217 currency code`
        : "companies.currency is not set for this company — a presentation currency must be explicitly chosen before statements can be prepared",
    );
    this.name = "UnresolvedCurrencyError";
  }
}
