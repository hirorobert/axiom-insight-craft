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

export function EntityContextSuggestion({ reportingFrameworkDbValue }: Props) {
  const ctx = detectEntityAccountingContext({ companyReportingFrameworkDbValue: reportingFrameworkDbValue });
  const fw = ctx.reportingFramework;

  if (fw.confidence === "NONE") return null;

  return (
    <p
      data-testid="entity-context-suggestion"
      data-confidence={fw.confidence}
      className="text-[11px] text-muted-foreground"
      title={fw.evidence[0]?.detail}
    >
      Reporting framework: {FRAMEWORK_LABEL[fw.value]} ({CONFIDENCE_LABEL[fw.confidence]})
    </p>
  );
}
