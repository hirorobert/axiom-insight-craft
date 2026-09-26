// financialStatementsWorkspace/statementComposition.ts — the workspace-level
// statement-set model: for a framework profile and a canonical report (or
// none), which expected statements are PRESENT, PARTIAL, an EVIDENCE_GAP,
// UNSUPPORTED or UNDETERMINED, and exactly what evidence is required to
// close each gap.
//
// The absence of a transaction ledger is a first-class, supported state
// here: a required statement without evidence is represented as an explicit
// incomplete entry with its evidence requirements. It is never silently
// omitted, never given fabricated values, and can never contribute to a
// readiness claim. This module reads canonical data; it computes no amounts.

import type { CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";
import { NET_RESULT_CONCEPT } from "./trialBalanceAdapter";
import type { ExpectedStatement, FrameworkProfile, WorkspaceStatementKind } from "./frameworkProfiles";
import type { GenerationResult } from "@/lib/financialGeneration/common";
import type { BudgetActualComparison } from "@/lib/financialGeneration/budgetActual";

export type CompositionStatus = "PRESENT" | "PARTIAL" | "EVIDENCE_GAP" | "UNSUPPORTED" | "UNDETERMINED";

export interface CompositionEntry {
  readonly kind: WorkspaceStatementKind;
  readonly title: string;
  readonly reference: string;
  readonly requirement: ExpectedStatement["requirement"];
  readonly status: CompositionStatus;
  /** What evidence exists now (a description, never a value). */
  readonly availableEvidence: readonly string[];
  /** What is needed to complete the statement. Empty only when PRESENT. */
  readonly evidenceRequirements: readonly string[];
  /** For PRESENT/PARTIAL entries: the canonical statementId to render. */
  readonly statementId?: string;
  readonly condition?: string;
}

export interface CompositionInput {
  readonly profile: FrameworkProfile;
  readonly report: CanonicalFinancialStatementReport | null;
  readonly comparativeAvailable: boolean;
  /** True when at least one account is explicitly reviewed as a cash account. */
  readonly cashPerimeterReviewed: boolean;
  /** Results of evidence-driven generation, keyed by statement type. Absent = no evidence was applied. */
  readonly generated?: Readonly<Record<string, GenerationResult>>;
  readonly budgetActual?: BudgetActualComparison | { readonly status: "EVIDENCE_GAP"; readonly reasons: readonly string[] } | null;
}

export interface StatementComposition {
  readonly entries: readonly CompositionEntry[];
  /** Reasons the statement set cannot be called complete. Empty means no composition blocker. */
  readonly blockers: readonly string[];
}

const SCF_REQUIREMENTS = [
  "A period-complete cash-movement record classified as operating, investing and financing (this workspace holds no such transaction ledger).",
  "Opening and closing cash and cash equivalents agreed to the statement of financial position.",
  "Confirmation of the cash-equivalent perimeter through reviewed cash-account flags.",
];

const SOCIE_REQUIREMENTS = [
  "Opening equity by component, agreed to the prior period's closing equity.",
  "Each movement in the period by component: total comprehensive result, dividends or distributions, transfers and other reserve movements.",
  "Any prior-period adjustments or changes in accounting policy affecting opening equity.",
];

const BUDGET_REQUIREMENTS = [
  "The approved original and final budget amounts by line, on the same classification basis as the financial statements.",
  "An explanation of material differences between budget and actual amounts.",
];

export function labelForStatus(status: CompositionStatus): string {
  switch (status) {
    case "PRESENT":
      return "complete";
    case "PARTIAL":
      return "partially available";
    case "EVIDENCE_GAP":
      return "incomplete — evidence required";
    case "UNSUPPORTED":
      return "not supported from a trial balance";
    case "UNDETERMINED":
      return "not yet determined";
  }
}

export function composeStatements(input: CompositionInput): StatementComposition {
  const { profile, report } = input;
  const entries: CompositionEntry[] = [];

  for (const expected of profile.expectedStatements) {
    const base = { kind: expected.kind, title: expected.title, reference: expected.reference, requirement: expected.requirement, condition: expected.condition } as const;

    if (profile.trialBalance.status === "UNSUPPORTED") {
      entries.push({ ...base, status: "UNSUPPORTED", availableEvidence: [], evidenceRequirements: profile.trialBalance.evidenceRequirements });
      continue;
    }

    switch (expected.kind) {
      case "STATEMENT_OF_FINANCIAL_POSITION": {
        const st = report?.statements.find((s) => s.type === expected.kind);
        entries.push(
          st
            ? { ...base, status: "PRESENT", availableEvidence: ["Reviewed trial balance balances, mapped to the statement"], evidenceRequirements: [], statementId: st.statementId }
            : { ...base, status: "EVIDENCE_GAP", availableEvidence: [], evidenceRequirements: ["A reviewed trial balance with mapped balance-sheet accounts."] },
        );
        break;
      }
      case "STATEMENT_OF_PROFIT_OR_LOSS": {
        const st = report?.statements.find((s) => s.type === expected.kind);
        if (!st) {
          entries.push({ ...base, status: "EVIDENCE_GAP", availableEvidence: [], evidenceRequirements: ["A reviewed trial balance with mapped income and expense accounts."] });
          break;
        }
        const netResult = st.sections.flatMap((s) => s.lines).find((l) => l.concept === NET_RESULT_CONCEPT);
        const hasNet = !!netResult && netResult.factBindings.length > 0;
        entries.push(
          hasNet
            ? { ...base, status: "PRESENT", availableEvidence: ["Reviewed income and expense balances", `${profile.terminology.netResult} derived from them`], evidenceRequirements: [], statementId: st.statementId }
            : {
                ...base,
                status: "PARTIAL",
                availableEvidence: ["Reviewed income and expense section totals"],
                evidenceRequirements: [`At least one complete income section and one complete expense section, so "${profile.terminology.netResult}" can be presented.`],
                statementId: st.statementId,
              },
        );
        break;
      }
      case "STATEMENT_OF_COMPREHENSIVE_INCOME":
        entries.push({ ...base, status: "UNDETERMINED", availableEvidence: [], evidenceRequirements: ["Confirmation whether the entity has any other comprehensive income items, and their classification."] });
        break;
      case "STATEMENT_OF_CHANGES_IN_EQUITY": {
        const g = input.generated?.STATEMENT_OF_CHANGES_IN_EQUITY;
        if (g?.status === "GENERATED") {
          entries.push({ ...base, status: "PRESENT", availableEvidence: ["Validated equity-movement evidence"], evidenceRequirements: [], statementId: g.statement.statementId });
          break;
        }
        if (g?.status === "EVIDENCE_GAP") {
          entries.push({ ...base, status: "EVIDENCE_GAP", availableEvidence: ["Equity-movement evidence was supplied but is incomplete"], evidenceRequirements: [...g.reasons, ...SOCIE_REQUIREMENTS] });
          break;
        }
        entries.push({
          ...base,
          status: "EVIDENCE_GAP",
          availableEvidence: [
            report ? "Closing equity balances from the reviewed trial balance" : "No reviewed trial balance yet",
            input.comparativeAvailable ? "Prior-period closing balances (comparative trial balance)" : "No prior-period closing balances",
          ],
          evidenceRequirements: SOCIE_REQUIREMENTS,
        });
        break;
      }
      case "STATEMENT_OF_CASH_FLOWS": {
        const g = input.generated?.STATEMENT_OF_CASH_FLOWS;
        if (g?.status === "GENERATED") {
          const complete = g.statement.sections.some((s) => s.lines.some((l) => l.lineId === "line:cf:closing"));
          entries.push(
            complete
              ? { ...base, status: "PRESENT", availableEvidence: ["Validated cash transaction ledger", "Opening cash from reviewed evidence"], evidenceRequirements: [], statementId: g.statement.statementId }
              : { ...base, status: "PARTIAL", availableEvidence: ["Validated cash transaction ledger"], evidenceRequirements: ["Opening cash and cash equivalents, so opening and closing cash can be presented and agreed to the statement of financial position."], statementId: g.statement.statementId },
          );
          break;
        }
        if (g?.status === "EVIDENCE_GAP") {
          entries.push({ ...base, status: "EVIDENCE_GAP", availableEvidence: ["A cash ledger was supplied but is incomplete"], evidenceRequirements: [...g.reasons, ...SCF_REQUIREMENTS] });
          break;
        }
        entries.push({
          ...base,
          status: "EVIDENCE_GAP",
          availableEvidence: [input.cashPerimeterReviewed ? "Cash accounts reviewed and flagged" : "No cash accounts reviewed as the cash perimeter"],
          evidenceRequirements: SCF_REQUIREMENTS,
        });
        break;
      }
      case "BUDGET_VS_ACTUAL": {
        const b = input.budgetActual;
        if (b?.status === "GENERATED") entries.push({ ...base, status: "PRESENT", availableEvidence: ["Approved budget evidence", "Actual amounts from the statements"], evidenceRequirements: [] });
        else if (b?.status === "EVIDENCE_GAP") entries.push({ ...base, status: "EVIDENCE_GAP", availableEvidence: ["Budget evidence was supplied but cannot be compared"], evidenceRequirements: [...b.reasons, ...BUDGET_REQUIREMENTS] });
        else entries.push({ ...base, status: "EVIDENCE_GAP", availableEvidence: ["Actual amounts from the reviewed trial balance"], evidenceRequirements: BUDGET_REQUIREMENTS });
        break;
      }
      default: {
        const g = input.generated?.[expected.kind];
        if (g?.status === "GENERATED") entries.push({ ...base, status: "PRESENT", availableEvidence: ["Validated evidence"], evidenceRequirements: [], statementId: g.statement.statementId });
        else if (g?.status === "EVIDENCE_GAP") entries.push({ ...base, status: "EVIDENCE_GAP", availableEvidence: ["Evidence was supplied but is incomplete"], evidenceRequirements: [...g.reasons] });
        else entries.push({ ...base, status: "UNDETERMINED", availableEvidence: [], evidenceRequirements: [] });
      }
    }
  }

  const blockers: string[] = [];
  for (const e of entries) {
    if (e.requirement === "REQUIRED" && e.status !== "PRESENT") blockers.push(`${e.title} is ${labelForStatus(e.status)}.`);
  }
  if (profile.comparativesRequired && !input.comparativeAvailable) blockers.push(`Comparative-period figures are missing (${profile.comparativesReference}).`);
  return { entries, blockers };
}
