/**
 * deriveWorkspaceState — Deterministic 14-path workflow engine.
 *
 * Pure function: given company + period + upload snapshot → WorkspaceState.
 * No DB access. No side effects. No async. Fully testable.
 *
 * Paths (ordered by priority — first match wins):
 *  1. No upload                 → Import Trial Balance
 *  2. Upload processing         → Wait / Refresh
 *  3. Upload needs_review       → Resolve Account Classifications
 *  4. Upload error/blocked      → Resolve Upload Error
 *  5. Upload invalid (is_valid = false)  → Fix Validation Errors
 *  6. Safisha blocked/exceptions         → Resolve Reconciliation Exceptions
 *  7. Safisha clean, HESABU not run      → Validate Draft Statements
 *  8. TB valid (pre-safisha), no HESABU  → Validate Draft Statements
 *  9. HESABU passed, KINGA not run       → Compute Corporate Tax
 * 10. KINGA signed, filing not submitted → Prepare Filing Package
 * 11. Filing submitted                   → Review Completed Engagement
 */

import type {
  UploadSnapshot,
  WorkspaceState,
  MissionState,
  NextAction,
  MissionStatus,
} from "./types";

function base(companyId: string, periodYear: number) {
  return `/workspace/${companyId}/${periodYear}`;
}

function locked(
  missionLabel: string,
  missionSlug: string,
  companyId: string,
  periodYear: number,
  blocker: string,
): MissionState {
  return {
    status: "locked" as MissionStatus,
    label: missionLabel,
    summary: "Prerequisites not met",
    href: `${base(companyId, periodYear)}/${missionSlug}`,
    blocker,
  };
}

function na(
  missionLabel: string,
  missionSlug: string,
  companyId: string,
  periodYear: number,
  summary = "Available at any time",
): MissionState {
  return {
    status: "not_applicable" as MissionStatus,
    label: missionLabel,
    summary,
    href: `${base(companyId, periodYear)}/${missionSlug}`,
  };
}

export function deriveWorkspaceState(
  companyId: string,
  companyName: string,
  periodYear: number,
  upload: UploadSnapshot | null,
): WorkspaceState {
  const b = base(companyId, periodYear);

  // ── PATH 1: No upload ─────────────────────────────────────────────────────
  if (!upload) {
    return {
      companyId,
      periodYear,
      companyName,
      missions: {
        safisha:   { status: "not_started", label: "SAFISHA",   summary: "No trial balance imported", href: `${b}/safisha` },
        hesabu:    locked("HESABU",    "hesabu",    companyId, periodYear, "Import trial balance first"),
        kinga:     locked("KINGA",     "kinga",     companyId, periodYear, "Complete SAFISHA first"),
        filing:    locked("FILING",    "filing",    companyId, periodYear, "Complete KINGA first"),
        analytics: na("ANALYTICS", "analytics", companyId, periodYear),
        issues:    na("ISSUES",    "issues",    companyId, periodYear),
      },
      nextAction: {
        id: "import-trial-balance",
        label: "Import Trial Balance",
        description: "Upload the trial balance to start this engagement",
        href: "/#upload",
        blocked: false,
        mission: "safisha",
        priority: 1,
      },
    };
  }

  const uploadCommon = {
    companyId,
    periodYear,
    companyName,
    currentUploadId: upload.id,
    lastUpdatedAt: upload.processedAt ?? upload.uploadedAt,
  };

  // ── PATH 2: Processing ────────────────────────────────────────────────────
  if (upload.status === "processing") {
    return {
      ...uploadCommon,
      missions: {
        safisha:   { status: "in_progress", label: "SAFISHA", summary: "Parsing and classifying trial balance…", href: `${b}/safisha` },
        hesabu:    locked("HESABU", "hesabu", companyId, periodYear, "Awaiting SAFISHA"),
        kinga:     locked("KINGA",  "kinga",  companyId, periodYear, "Awaiting SAFISHA"),
        filing:    locked("FILING", "filing", companyId, periodYear, "Awaiting KINGA"),
        analytics: na("ANALYTICS", "analytics", companyId, periodYear),
        issues:    na("ISSUES",    "issues",    companyId, periodYear),
      },
      nextAction: {
        id: "wait-processing",
        label: "Processing in progress",
        description: "Trial balance is being parsed — this takes 30–90 seconds",
        href: `${b}/safisha`,
        blocked: true,
        blocker: "Engine is running",
        mission: "safisha",
        priority: 2,
      },
    };
  }

  // ── PATH 3: Needs review ──────────────────────────────────────────────────
  if (upload.status === "needs_review") {
    return {
      ...uploadCommon,
      missions: {
        safisha:   { status: "review_required", label: "SAFISHA", summary: "Account classification review required", href: `${b}/safisha` },
        hesabu:    locked("HESABU", "hesabu", companyId, periodYear, "Resolve SAFISHA review items first"),
        kinga:     locked("KINGA",  "kinga",  companyId, periodYear, "Complete SAFISHA first"),
        filing:    locked("FILING", "filing", companyId, periodYear, "Complete KINGA first"),
        analytics: na("ANALYTICS", "analytics", companyId, periodYear),
        issues:    na("ISSUES",    "issues",    companyId, periodYear),
      },
      nextAction: {
        id: "resolve-classifications",
        label: "Resolve Account Classifications",
        description: "Some accounts could not be auto-classified — manual review required before processing can continue",
        href: `${b}/safisha`,
        blocked: false,
        mission: "safisha",
        priority: 3,
      },
    };
  }

  // ── PATH 4: Error / blocked ───────────────────────────────────────────────
  if (upload.status === "error" || upload.status === "blocked") {
    return {
      ...uploadCommon,
      missions: {
        safisha:   { status: "blocked", label: "SAFISHA", summary: "Upload processing failed", href: `${b}/safisha` },
        hesabu:    locked("HESABU", "hesabu", companyId, periodYear, "Resolve SAFISHA error first"),
        kinga:     locked("KINGA",  "kinga",  companyId, periodYear, "Complete SAFISHA first"),
        filing:    locked("FILING", "filing", companyId, periodYear, "Complete KINGA first"),
        analytics: na("ANALYTICS", "analytics", companyId, periodYear),
        issues:    na("ISSUES",    "issues",    companyId, periodYear),
      },
      nextAction: {
        id: "resolve-upload-error",
        label: "Resolve Upload Error",
        description: "Processing failed — review the validation report and reprocess or upload a corrected file",
        href: `${b}/safisha`,
        blocked: false,
        mission: "safisha",
        priority: 4,
      },
    };
  }

  // ── PATH 5: Invalid trial balance ─────────────────────────────────────────
  if (upload.isValid === false) {
    return {
      ...uploadCommon,
      missions: {
        safisha:   { status: "blocked", label: "SAFISHA", summary: "Validation errors present", href: `${b}/safisha` },
        hesabu:    locked("HESABU", "hesabu", companyId, periodYear, "Clear validation errors first"),
        kinga:     locked("KINGA",  "kinga",  companyId, periodYear, "Complete SAFISHA first"),
        filing:    locked("FILING", "filing", companyId, periodYear, "Complete KINGA first"),
        analytics: na("ANALYTICS", "analytics", companyId, periodYear),
        issues:    na("ISSUES",    "issues",    companyId, periodYear),
      },
      nextAction: {
        id: "fix-validation-errors",
        label: "Fix Validation Errors",
        description: "Trial balance has accounting errors that must be resolved before processing can continue",
        href: `${b}/safisha`,
        blocked: false,
        mission: "safisha",
        priority: 5,
      },
    };
  }

  // ── PATH 6: Safisha blocked (reconciliation exceptions) ───────────────────
  const safishaBlocked =
    upload.safishaStatus !== null &&
    upload.safishaStatus !== "clean";

  if (safishaBlocked) {
    return {
      ...uploadCommon,
      missions: {
        safisha:   { status: "blocked", label: "SAFISHA", summary: `EFDMS reconciliation: ${upload.safishaStatus}`, href: `${b}/safisha`, blocker: upload.safishaStatus ?? undefined },
        hesabu:    { status: "in_progress", label: "HESABU", summary: "Available — draft validation can proceed", href: `${b}/hesabu` },
        kinga:     locked("KINGA",  "kinga",  companyId, periodYear, "SAFISHA reconciliation must clear before tax computation (constitutional gate)"),
        filing:    locked("FILING", "filing", companyId, periodYear, "Complete KINGA first"),
        analytics: na("ANALYTICS", "analytics", companyId, periodYear),
        issues:    na("ISSUES",    "issues",    companyId, periodYear),
      },
      nextAction: {
        id: "resolve-reconciliation",
        label: "Resolve Reconciliation Exceptions",
        description: `EFDMS matching blocked (${upload.safishaStatus}) — resolve exceptions before tax computation can run`,
        href: `${b}/safisha`,
        blocked: false,
        mission: "safisha",
        priority: 6,
      },
    };
  }

  const safishaClean = upload.safishaStatus === "clean";

  // ── PATH 7 + 8: TB valid, no HESABU yet ──────────────────────────────────
  if (!upload.hesabuPassedAt) {
    const safishaSummary = safishaClean
      ? "TB clean — EFDMS reconciled"
      : "TB validated and processed";

    return {
      ...uploadCommon,
      missions: {
        safisha:   { status: "passed",    label: "SAFISHA", summary: safishaSummary, href: `${b}/safisha` },
        hesabu:    { status: "ready",     label: "HESABU",  summary: "Ready to validate statements", href: `${b}/hesabu` },
        kinga:     locked("KINGA",  "kinga",  companyId, periodYear, "Complete HESABU validation first"),
        filing:    locked("FILING", "filing", companyId, periodYear, "Complete KINGA first"),
        analytics: na("ANALYTICS", "analytics", companyId, periodYear),
        issues:    na("ISSUES",    "issues",    companyId, periodYear),
      },
      nextAction: {
        id: "validate-draft-statements",
        label: "Validate Draft Statements",
        description: safishaClean
          ? "TB is reconciled and clean — run HESABU to validate the financial statements"
          : "TB is valid — run HESABU to cross-validate the draft financial statements",
        href: `${b}/hesabu`,
        blocked: false,
        mission: "hesabu",
        priority: 7,
      },
    };
  }

  // ── PATH 9: HESABU passed, KINGA not yet run ──────────────────────────────
  if (!upload.kingaSignedAt) {
    const kingaBlocked = !safishaClean;
    return {
      ...uploadCommon,
      lastUpdatedAt: upload.hesabuPassedAt ?? upload.processedAt ?? upload.uploadedAt,
      missions: {
        safisha: { status: safishaClean ? "passed" : "blocked", label: "SAFISHA", summary: safishaClean ? "TB clean and reconciled" : "Reconciliation exceptions present", href: `${b}/safisha` },
        hesabu:  { status: "passed", label: "HESABU", summary: "Statements validated", href: `${b}/hesabu` },
        kinga:   kingaBlocked
          ? locked("KINGA", "kinga", companyId, periodYear, "SAFISHA reconciliation must clear first (constitutional gate)")
          : { status: "ready", label: "KINGA", summary: "Ready to compute corporate tax", href: `${b}/kinga` },
        filing:    locked("FILING", "filing", companyId, periodYear, "Complete KINGA first"),
        analytics: na("ANALYTICS", "analytics", companyId, periodYear),
        issues:    na("ISSUES",    "issues",    companyId, periodYear),
      },
      nextAction: {
        id: "compute-corporate-tax",
        label: "Compute Corporate Tax",
        description: kingaBlocked
          ? "HESABU validated — resolve SAFISHA reconciliation to unlock KINGA"
          : "HESABU validated — run KINGA to compute corporate income tax (ITA Cap.332)",
        href: `${b}/kinga`,
        blocked: kingaBlocked,
        blocker: kingaBlocked ? "SAFISHA reconciliation must clear first" : undefined,
        mission: "kinga",
        priority: 9,
      },
    };
  }

  // ── PATH 10: KINGA signed, not filed ─────────────────────────────────────
  if (!upload.filingSubmittedAt) {
    return {
      ...uploadCommon,
      lastUpdatedAt: upload.kingaSignedAt ?? upload.hesabuPassedAt ?? upload.processedAt ?? upload.uploadedAt,
      missions: {
        safisha:   { status: "passed", label: "SAFISHA", summary: "TB clean and reconciled", href: `${b}/safisha` },
        hesabu:    { status: "passed", label: "HESABU",  summary: "Statements validated", href: `${b}/hesabu` },
        kinga:     { status: "signed", label: "KINGA",   summary: "Tax computed and signed", href: `${b}/kinga` },
        filing:    { status: "ready",  label: "FILING",  summary: "Ready to prepare filing package", href: `${b}/filing` },
        analytics: na("ANALYTICS", "analytics", companyId, periodYear),
        issues:    na("ISSUES",    "issues",    companyId, periodYear),
      },
      nextAction: {
        id: "prepare-filing-package",
        label: "Prepare Filing Package",
        description: "Tax computation is signed — prepare the TRA filing package and record submission",
        href: `${b}/filing`,
        blocked: false,
        mission: "filing",
        priority: 10,
      },
    };
  }

  // ── PATH 11: All complete ─────────────────────────────────────────────────
  return {
    ...uploadCommon,
    lastUpdatedAt: upload.filingSubmittedAt,
    missions: {
      safisha:   { status: "signed", label: "SAFISHA", summary: "TB clean and reconciled", href: `${b}/safisha` },
      hesabu:    { status: "signed", label: "HESABU",  summary: "Statements validated and signed", href: `${b}/hesabu` },
      kinga:     { status: "signed", label: "KINGA",   summary: "Tax computed and signed", href: `${b}/kinga` },
      filing:    { status: "signed", label: "FILING",  summary: "Filed with TRA", href: `${b}/filing` },
      analytics: na("ANALYTICS", "analytics", companyId, periodYear),
      issues:    na("ISSUES",    "issues",    companyId, periodYear),
    },
    nextAction: {
      id: "review-completed-engagement",
      label: "Review Completed Engagement",
      description: "Filing submitted — engagement is complete. Review analytics or archive.",
      href: `${b}/analytics`,
      blocked: false,
      mission: "analytics",
      priority: 11,
    },
  };
}
