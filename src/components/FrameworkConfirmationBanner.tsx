/**
 * FrameworkConfirmationBanner.tsx — Ω∞ Slice 14 UX integration.
 *
 * Read-only, informational only — no new write path. Sits above the
 * existing reporting-framework <Select> in CompanyManager.tsx; that
 * dropdown (and the form's own Save button) remains the only way to change
 * anything. This component computes purely from data CompanyManager
 * already has in hand (the current dropdown value) — no new fetch, no new
 * edge-function call, no account_mapping_memory read (that table isn't
 * even applied to the live database yet — Slice 12).
 */

import { detectEntityAccountingContext } from "@/lib/accounting/detectEntityContext";
import { classifyConfirmationPosture } from "@/lib/accounting/confirmationPosture";
import { buildFrameworkBannerContent } from "@/lib/accounting/frameworkConfirmationBannerContent";
import { ShieldCheck, HelpCircle, AlertTriangle } from "lucide-react";

interface FrameworkConfirmationBannerProps {
  /**
   * The raw companies.reporting_framework DB string value, exactly as the
   * form currently holds it. Phase 1: this column has no schema default —
   * null means genuinely not yet selected, and detectEntityAccountingContext
   * already treats it as UNKNOWN/NONE confidence correctly.
   */
  reportingFrameworkDbValue: string | null;
}

const TONE_STYLES: Record<
  "quiet" | "question" | "explicit-ask",
  { container: string; icon: JSX.Element }
> = {
  quiet: {
    container: "border-border bg-muted/30 text-muted-foreground",
    icon: <ShieldCheck className="w-3.5 h-3.5 shrink-0" />,
  },
  question: {
    container: "border-accent/30 bg-accent/5 text-foreground",
    icon: <HelpCircle className="w-3.5 h-3.5 shrink-0" />,
  },
  "explicit-ask": {
    container: "border-amber-500/30 bg-amber-500/5 text-foreground",
    icon: <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-500" />,
  },
};

export function FrameworkConfirmationBanner({
  reportingFrameworkDbValue,
}: FrameworkConfirmationBannerProps) {
  const context = detectEntityAccountingContext({
    companyReportingFrameworkDbValue: reportingFrameworkDbValue,
  });
  const posture = classifyConfirmationPosture(context.reportingFramework);
  const content = buildFrameworkBannerContent(
    context.reportingFramework.value,
    context.reportingFramework.confidence,
    posture,
  );

  if (!content.tone) return null;

  const style = TONE_STYLES[content.tone];

  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${style.container}`}>
      {style.icon}
      <div>
        <p className="font-medium">{content.headline}</p>
        {content.detail && <p className="mt-0.5 opacity-90">{content.detail}</p>}
      </div>
    </div>
  );
}
