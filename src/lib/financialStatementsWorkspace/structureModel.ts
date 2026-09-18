// financialStatementsWorkspace/structureModel.ts — the Structure stage model:
// framework, reporting period, comparative period, presentation currency,
// scale, statement composition and mapping completeness, with a diagnostic
// for anything unresolved. Nothing here is defaulted: a missing framework,
// currency or period basis is a blocking diagnostic, not a guess.

import type { FrameworkProfile } from "./frameworkProfiles";
import type { StatementComposition } from "./statementComposition";
import type { AmbiguousAccount, UnmappedAccount } from "./mapWorkspaceTrialBalance";
import type { PeriodBasis } from "./reportingPeriod";

export type StructureSeverity = "BLOCKING" | "ATTENTION";

export interface StructureDiagnostic {
  readonly code: "FRAMEWORK_NOT_SET" | "CURRENCY_NOT_SET" | "PERIOD_BASIS_ASSUMED" | "COMPARATIVE_MISSING" | "ACCOUNTS_UNMAPPED" | "ACCOUNTS_AMBIGUOUS" | "COMPOSITION_INCOMPLETE" | "FRAMEWORK_UNSUPPORTED_FROM_TRIAL_BALANCE";
  readonly severity: StructureSeverity;
  readonly message: string;
}

export interface StructureInput {
  readonly profile: FrameworkProfile | null;
  readonly rawFramework: string | null;
  readonly currency: string | null;
  readonly periodYear: number;
  readonly period: { readonly startDate: string; readonly endDate: string; readonly basis: PeriodBasis };
  readonly comparativePeriodYear: number | null;
  readonly comparativeAvailable: boolean;
  readonly composition: StatementComposition | null;
  readonly mapping: { readonly totalAccounts: number; readonly unmapped: readonly UnmappedAccount[]; readonly ambiguous: readonly AmbiguousAccount[] } | null;
}

export interface StructureModel {
  readonly framework: { readonly label: string; readonly resolved: boolean };
  readonly period: { readonly label: string; readonly basisNote: string | null };
  readonly comparative: { readonly label: string; readonly available: boolean };
  readonly currency: { readonly label: string; readonly resolved: boolean };
  readonly scale: { readonly label: string };
  readonly mapping: { readonly mapped: number; readonly total: number; readonly unmapped: readonly UnmappedAccount[]; readonly ambiguous: readonly AmbiguousAccount[]; readonly complete: boolean } | null;
  readonly composition: StatementComposition | null;
  readonly diagnostics: readonly StructureDiagnostic[];
  readonly hasBlocking: boolean;
}

export function buildStructure(input: StructureInput): StructureModel {
  const diagnostics: StructureDiagnostic[] = [];

  if (!input.profile) {
    diagnostics.push({
      code: "FRAMEWORK_NOT_SET",
      severity: "BLOCKING",
      message: input.rawFramework ? `"${input.rawFramework}" is not a recognised reporting framework.` : "No reporting framework is selected for this company. Choose one in company settings.",
    });
  } else if (input.profile.trialBalance.status === "UNSUPPORTED") {
    diagnostics.push({ code: "FRAMEWORK_UNSUPPORTED_FROM_TRIAL_BALANCE", severity: "BLOCKING", message: input.profile.trialBalance.reason });
  }
  if (!input.currency) diagnostics.push({ code: "CURRENCY_NOT_SET", severity: "BLOCKING", message: "No presentation currency is set for this company." });
  if (input.period.basis === "CALENDAR_YEAR_ASSUMED") {
    diagnostics.push({ code: "PERIOD_BASIS_ASSUMED", severity: "BLOCKING", message: `The company has no fiscal year end, so ${input.period.startDate} to ${input.period.endDate} is only an assumption. Set the fiscal year end to confirm the reporting period.` });
  }
  if (input.profile?.comparativesRequired && !input.comparativeAvailable) {
    diagnostics.push({ code: "COMPARATIVE_MISSING", severity: "BLOCKING", message: `No comparative period is available (${input.profile.comparativesReference}). Import the ${input.periodYear - 1} trial balance.` });
  }
  if (input.mapping && input.mapping.unmapped.length > 0) {
    diagnostics.push({ code: "ACCOUNTS_UNMAPPED", severity: "BLOCKING", message: `${input.mapping.unmapped.length} account(s) have no reviewed mapping and are excluded from the statements.` });
  }
  if (input.mapping && input.mapping.ambiguous.length > 0) {
    diagnostics.push({ code: "ACCOUNTS_AMBIGUOUS", severity: "BLOCKING", message: `${input.mapping.ambiguous.length} account(s) have conflicting mappings and are excluded until reviewed.` });
  }
  if (input.composition && input.composition.blockers.length > 0) {
    diagnostics.push({ code: "COMPOSITION_INCOMPLETE", severity: "ATTENTION", message: `${input.composition.blockers.length} required statement(s) or element(s) are incomplete.` });
  }

  const mapped = input.mapping ? input.mapping.totalAccounts - input.mapping.unmapped.length - input.mapping.ambiguous.length : 0;
  return {
    framework: { label: input.profile?.displayName ?? "Not set", resolved: !!input.profile },
    period: {
      label: `${input.period.startDate} to ${input.period.endDate}`,
      basisNote: input.period.basis === "CALENDAR_YEAR_ASSUMED" ? "Assumed calendar year — not confirmed" : null,
    },
    comparative: { label: input.comparativePeriodYear ? String(input.comparativePeriodYear) : "None", available: input.comparativeAvailable },
    currency: { label: input.currency ?? "Not set", resolved: !!input.currency },
    scale: { label: "Full currency units, 2 decimal places — no rounding or scaling applied" },
    mapping: input.mapping
      ? { mapped, total: input.mapping.totalAccounts, unmapped: input.mapping.unmapped, ambiguous: input.mapping.ambiguous, complete: input.mapping.unmapped.length === 0 && input.mapping.ambiguous.length === 0 && input.mapping.totalAccounts > 0 }
      : null,
    composition: input.composition,
    diagnostics,
    hasBlocking: diagnostics.some((d) => d.severity === "BLOCKING"),
  };
}
