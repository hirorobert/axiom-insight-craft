/**
 * frameworkConfirmationBannerContent.ts — Ω∞ public-sector / framework
 * intelligence engine, Slice 14: UX integration (Section XVII).
 *
 * Pure content-selection logic for the framework-detection banner —
 * separated from the React component (FrameworkConfirmationBanner.tsx) so
 * the copy/tone decisions are unit-testable without rendering anything.
 *
 * Deliberately informational only, no action buttons: no "Confirm" write
 * path exists yet (Slice 12's mapping-memory table isn't wired to any live
 * edge function — Slice 13 stopped short of that for a database this
 * session cannot integration-test). The banner sits above the EXISTING,
 * already-functional reporting-framework <Select> in CompanyManager.tsx —
 * changing that dropdown and clicking the form's own Save button IS the
 * "change" action; this banner does not need to invent a second one.
 */

import type { ReportingFramework, ConfidenceLevel } from "./entityContext";
import type { ConfirmationPosture } from "./confirmationPosture";

export interface FrameworkBannerContent {
  /** null = render nothing (NO_PROMPT_NEEDED or nothing to say yet). */
  tone: "quiet" | "question" | "explicit-ask" | null;
  headline: string | null;
  detail: string | null;
}

const FRAMEWORK_DISPLAY_LABEL: Record<ReportingFramework, string> = {
  IPSAS_ACCRUAL: "IPSAS Accrual",
  IFRS: "Full IFRS",
  IFRS_FOR_SMES: "IFRS for SMEs",
  OTHER_CONFIRMED: "a confirmed framework outside IFRS/IPSAS",
  UNKNOWN: "an unknown framework",
};

export function buildFrameworkBannerContent(
  framework: ReportingFramework,
  confidence: ConfidenceLevel,
  posture: ConfirmationPosture,
): FrameworkBannerContent {
  if (posture === "NO_PROMPT_NEEDED" || framework === "UNKNOWN") {
    return { tone: null, headline: null, detail: null };
  }

  const label = FRAMEWORK_DISPLAY_LABEL[framework];

  switch (posture) {
    case "QUIET_CONFIRMATION":
      return {
        tone: "quiet",
        headline: `Accounting profile: ${label}`,
        detail: "Detected with high confidence from your saved company settings.",
      };
    case "COMPACT_QUESTION":
      return {
        tone: "question",
        headline: `This company appears to report under ${label}.`,
        detail: "Confirmed by an explicit setting change, though not yet backed by audited evidence — double-check the dropdown below.",
      };
    case "EXPLICIT_ASK":
      return {
        tone: "explicit-ask",
        headline: `Reporting framework is not yet confirmed.`,
        detail: `Currently set to ${label} (the unconfirmed default). Please review the dropdown below and set it deliberately for this entity — confidence: ${confidence}.`,
      };
  }
}
