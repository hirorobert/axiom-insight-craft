/**
 * EntityContextSuggestion — read-only reporting-framework signal (Slice 4B).
 *
 * Wraps detectEntityAccountingContext (src/lib/accounting/detectEntityContext.ts),
 * the only dimension of the entity-intelligence engine with any real evidence
 * today (companies.reporting_framework). Purely informational: no CTA, no
 * write path, never auto-applied. Renders nothing when there is no signal at
 * all (confidence NONE) — never guesses (Iron Dome §4.4).
 */

import { detectEntityAccountingContext } from "@/lib/accounting/detectEntityContext";
import type { ReportingFramework, ConfidenceLevel } from "@/lib/accounting/entityContext";

interface Props {
  reportingFrameworkDbValue: string | null | undefined;
}

const FRAMEWORK_LABEL: Record<ReportingFramework, string> = {
  IPSAS_ACCRUAL: "IPSAS (accrual)",
  IFRS: "Full IFRS",
  IFRS_FOR_SMES: "IFRS for SMEs",
  OTHER_CONFIRMED: "Other (confirmed)",
  UNKNOWN: "Unknown",
};

const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  HIGH: "confirmed",
  MEDIUM: "set by preparer",
  LOW: "unconfirmed default",
  NONE: "no signal",
};

export interface EntityContextSuggestionText {
  text: string;
  confidence: ConfidenceLevel;
  detail: string | undefined;
}

/**
 * Pure formatting boundary — separated from the component so this wording
 * (and the "no signal → nothing" rule) is unit-testable without a component-
 * rendering harness, which this project does not otherwise depend on.
 * Returns null exactly when there is no signal at all (confidence NONE).
 */
export function formatEntityContextSuggestion(
  reportingFrameworkDbValue: string | null | undefined,
): EntityContextSuggestionText | null {
  const ctx = detectEntityAccountingContext({ companyReportingFrameworkDbValue: reportingFrameworkDbValue });
  const fw = ctx.reportingFramework;

  if (fw.confidence === "NONE") return null;

  return {
    text: `Reporting framework: ${FRAMEWORK_LABEL[fw.value]} (${CONFIDENCE_LABEL[fw.confidence]})`,
    confidence: fw.confidence,
    detail: fw.evidence[0]?.detail,
  };
}

export function EntityContextSuggestion({ reportingFrameworkDbValue }: Props) {
  const formatted = formatEntityContextSuggestion(reportingFrameworkDbValue);
  if (!formatted) return null;

  return (
    <p
      data-testid="entity-context-suggestion"
      data-confidence={formatted.confidence}
      className="text-[11px] text-muted-foreground"
      title={formatted.detail}
    >
      {formatted.text}
    </p>
  );
}
