/**
 * deriveWorkspaceState — Deterministic 14-path workflow engine.
 *
 * Pure function: given company + period + upload snapshot → WorkspaceState.
 * No DB access. No side effects. No async. Fully testable.
 *
 * Architecture v3.1 mission slugs (professional accounting lifecycle):
 *   prepare → reconcile → statements → tax → compliance → filing → monitor
 *
 * reconcile and compliance are na() in all paths until Phase B adds DB signals.
 *
 * Paths (ordered by priority — first match wins):
 *  1. No upload                   → Import Trial Balance
 *  2. Upload processing           → Wait / Refresh
 *  3. Upload needs_review         → Resolve Account Classifications
 *  4. Upload error/blocked        → Resolve Upload Error
 *  5. Upload invalid (is_valid=false)      → Fix Validation Errors
 *  6. Safisha blocked/exceptions           → Resolve Reconciliation Exceptions
 *  7. Safisha clean, HESABU not run        → Validate Draft Statements
 *  8. TB valid (pre-safisha), no HESABU    → Validate Draft Statements
 *  9. HESABU passed, KINGA not run         → Compute Corporate Tax
 * 10. KINGA signed, filing not submitted   → Prepare Filing Package
 * 11. Filing submitted                     → Review Completed Engagement
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
        prepare:    { status: "not_started", label: "Prepare Data",     summary: "No trial balance imported",     href: `${b}/prepare` },
        reconcile:  na("Reconcile",          "reconcile",  companyId, periodYear, "Available — EFDMS and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Import trial balance first"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Complete Prepare Data first"),
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Filing",     "filing",     companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor",            "monitor",    companyId, periodYear),
      },
      nextAction: {
        id: "import-trial-balance",
        label: "Import Trial Balance",
        description: "Upload the trial balance to start this engagement",
        href: `${b}/prepare`,
        blocked: false,
        mission: "prepare",
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
        prepare:    { status: "in_progress", label: "Prepare Data",     summary: "Parsing and classifying trial balance…", href: `${b}/prepare` },
        reconcile:  na("Reconcile",          "reconcile",  companyId, periodYear, "Available — EFDMS and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Awaiting Prepare Data"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Awaiting Prepare Data"),
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Filing",     "filing",     companyId, periodYear, "Awaiting Compute Tax"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "wait-processing",
        label: "Processing in progress",
        description: "Trial balance is being parsed — this takes 30–90 seconds",
        href: `${b}/prepare`,
        blocked: true,
        blocker: "Engine is running",
        mission: "prepare",
        priority: 2,
      },
    };
  }

  // ── PATH 3: Needs review ──────────────────────────────────────────────────
  if (upload.status === "needs_review") {
    return {
      ...uploadCommon,
      missions: {
        prepare:    { status: "review_required", label: "Prepare Data",     summary: "Account classification review required", href: `${b}/prepare` },
        reconcile:  na("Reconcile",              "reconcile",  companyId, periodYear, "Available — EFDMS and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Resolve Prepare Data review items first"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Complete Prepare Data first"),
        compliance: na("Compliance Review",      "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Filing",     "filing",     companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "resolve-classifications",
        label: "Resolve Account Classifications",
        description: "Some accounts could not be auto-classified — manual review required before processing can continue",
        href: `${b}/prepare`,
        blocked: false,
        mission: "prepare",
        priority: 3,
      },
    };
  }

  // ── PATH 4: Error / blocked ───────────────────────────────────────────────
  if (upload.status === "error" || upload.status === "blocked") {
    return {
      ...uploadCommon,
      missions: {
        prepare:    { status: "blocked", label: "Prepare Data",     summary: "Upload processing failed", href: `${b}/prepare` },
        reconcile:  na("Reconcile",      "reconcile",  companyId, periodYear, "Available — EFDMS and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Resolve Prepare Data error first"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Complete Prepare Data first"),
        compliance: na("Compliance Review", "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Filing",     "filing",     companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "resolve-upload-error",
        label: "Resolve Upload Error",
        description: "Processing failed — review the validation report and reprocess or upload a corrected file",
        href: `${b}/prepare`,
        blocked: false,
        mission: "prepare",
        priority: 4,
      },
    };
  }

  // ── PATH 5: Invalid trial balance ─────────────────────────────────────────
  if (upload.isValid === false) {
    return {
      ...uploadCommon,
      missions: {
        prepare:    { status: "blocked", label: "Prepare Data",     summary: "Validation errors present", href: `${b}/prepare` },
        reconcile:  na("Reconcile",      "reconcile",  companyId, periodYear, "Available — EFDMS and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Clear validation errors first"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Complete Prepare Data first"),
        compliance: na("Compliance Review", "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Filing",     "filing",     companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "fix-validation-errors",
        label: "Fix Validation Errors",
        description: "Trial balance has accounting errors that must be resolved before processing can continue",
        href: `${b}/prepare`,
        blocked: false,
        mission: "prepare",
        priority: 5,
      },
    };
  }

  // ── PATH 6: Safisha blocked (reconciliation exceptions) ───────────────────
  const safishaBlocked =
    upload.safishaStatus !== null &&
    upload.safishaStatus !== "clean";

  if (safishaBlocked) {
    // Statements may have already been validated even while Prepare Data is blocked.
    // Show the true statements state so the workspace reflects what has actually been done.
    const statementsInPrepareBlock: MissionState = upload.hesabuPassedAt
      ? { status: "passed",      label: "Prepare Statements", summary: "Statements validated",                         href: `${b}/statements` }
      : { status: "in_progress", label: "Prepare Statements", summary: "Available — draft validation can proceed",     href: `${b}/statements` };

    return {
      ...uploadCommon,
      missions: {
        prepare:    { status: "blocked", label: "Prepare Data", summary: `EFDMS reconciliation: ${upload.safishaStatus}`, href: `${b}/prepare`, blocker: upload.safishaStatus ?? undefined },
        reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — EFDMS and journal review"),
        statements: statementsInPrepareBlock,
        tax:        locked("Compute Tax",    "tax",    companyId, periodYear, "Prepare Data reconciliation must clear before tax computation (constitutional gate)"),
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Filing", "filing", companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "resolve-reconciliation",
        label: "Resolve Reconciliation Exceptions",
        description: `EFDMS matching blocked (${upload.safishaStatus}) — resolve exceptions before tax computation can run`,
        href: `${b}/prepare`,
        blocked: false,
        mission: "prepare",
        priority: 6,
      },
    };
  }

  const safishaClean = upload.safishaStatus === "clean";

  // ── PATH 7 + 8: TB valid, no HESABU yet ──────────────────────────────────
  if (!upload.hesabuPassedAt) {
    const prepareSummary = safishaClean
      ? "TB clean — EFDMS reconciled"
      : "TB validated and processed";

    return {
      ...uploadCommon,
      missions: {
        prepare:    { status: "passed", label: "Prepare Data",     summary: prepareSummary, href: `${b}/prepare` },
        reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — EFDMS and journal review"),
        statements: { status: "ready",  label: "Prepare Statements", summary: "Ready to validate statements", href: `${b}/statements` },
        tax:        locked("Compute Tax",    "tax",    companyId, periodYear, "Complete Prepare Statements validation first"),
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Filing", "filing", companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "validate-draft-statements",
        label: "Validate Draft Statements",
        description: safishaClean
          ? "TB is reconciled and clean — run statement validation"
          : "TB is valid — cross-validate the draft financial statements",
        href: `${b}/statements`,
        blocked: false,
        mission: "statements",
        priority: 7,
      },
    };
  }

  // ── PATH 9: HESABU passed, KINGA not yet run ──────────────────────────────
  if (!upload.kingaSignedAt) {
    const taxBlocked = !safishaClean;
    return {
      ...uploadCommon,
      lastUpdatedAt: upload.hesabuPassedAt ?? upload.processedAt ?? upload.uploadedAt,
      missions: {
        prepare:    { status: safishaClean ? "passed" : "blocked", label: "Prepare Data",     summary: safishaClean ? "TB clean and reconciled" : "Reconciliation exceptions present", href: `${b}/prepare` },
        reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — EFDMS and journal review"),
        statements: { status: "passed", label: "Prepare Statements", summary: "Statements validated", href: `${b}/statements` },
        tax:        taxBlocked
          ? locked("Compute Tax", "tax", companyId, periodYear, "Prepare Data reconciliation must clear first (constitutional gate)")
          : { status: "ready", label: "Compute Tax", summary: "Ready to compute corporate tax", href: `${b}/tax` },
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Filing", "filing", companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "compute-corporate-tax",
        label: "Compute Corporate Tax",
        description: taxBlocked
          ? "Statements validated — resolve Prepare Data reconciliation to unlock tax computation"
          : "Statements validated — compute corporate income tax (ITA Cap.332)",
        href: `${b}/tax`,
        blocked: taxBlocked,
        blocker: taxBlocked ? "Prepare Data reconciliation must clear first" : undefined,
        mission: "tax",
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
        prepare:    { status: "passed", label: "Prepare Data",     summary: "TB clean and reconciled",     href: `${b}/prepare` },
        reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — EFDMS and journal review"),
        statements: { status: "passed", label: "Prepare Statements", summary: "Statements validated",       href: `${b}/statements` },
        tax:        { status: "signed", label: "Compute Tax",        summary: "Tax computed and signed",    href: `${b}/tax` },
        compliance: na("Compliance Review", "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     { status: "ready",  label: "Prepare Filing",     summary: "Ready to prepare filing package", href: `${b}/filing` },
        monitor:    na("Monitor", "monitor", companyId, periodYear),
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
      prepare:    { status: "signed", label: "Prepare Data",     summary: "TB clean and reconciled",        href: `${b}/prepare` },
      reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — EFDMS and journal review"),
      statements: { status: "signed", label: "Prepare Statements", summary: "Statements validated and signed", href: `${b}/statements` },
      tax:        { status: "signed", label: "Compute Tax",        summary: "Tax computed and signed",        href: `${b}/tax` },
      compliance: na("Compliance Review", "compliance", companyId, periodYear, "Available after tax computation"),
      filing:     { status: "signed", label: "Prepare Filing",     summary: "Filed with TRA",                 href: `${b}/filing` },
      monitor:    na("Monitor", "monitor", companyId, periodYear),
    },
    nextAction: {
      id: "review-completed-engagement",
      label: "Review Completed Engagement",
      description: "Filing submitted — engagement is complete. Review analytics or archive.",
      href: `${b}/monitor`,
      blocked: false,
      mission: "monitor",
      priority: 11,
    },
  };
}
