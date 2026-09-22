/**
 * deriveWorkspaceState — Deterministic workflow engine.
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
 *  1.  No upload                            → Import Trial Balance
 *  2.  Upload processing                    → Wait / Refresh
 *  3.  Upload needs_review                  → Resolve Account Classifications
 *  4.  Upload error/blocked                 → Resolve Upload Error
 *  5.  Upload invalid (is_valid=false)      → Fix Validation Errors
 *  6.  Safisha blocked/exceptions           → Resolve Reconciliation Exceptions
 *  6B. Certification not "certified"        → Certify the trial balance / Resolve trial-balance difference
 *  7.  Safisha clean, HESABU not run        → Validate Draft Statements
 *  8.  TB valid (pre-safisha), no HESABU    → Validate Draft Statements
 *  9.  HESABU passed, KINGA not run         → Compute Corporate Tax
 * 10.  KINGA signed, filing not submitted   → Prepare Filing Package
 * 11.  Filing submitted                     → Review Completed Engagement
 *
 * PATH 6B is the single authority for "is this trial balance safe to build statements on".
 * It reads UploadSnapshot.certificationVerdict, which the caller (useWorkspaceData.ts) derives
 * from the SAME computeCertificationReadiness()/tb_certifications ledger PrepareWorkspace's own
 * pre-flight panel already uses — never a second, independently-derived signal. See that
 * module's own doc comment for the six-layer (L1-L6) evidence model this verdict summarises.
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
        reconcile:  na("Reconcile",          "reconcile",  companyId, periodYear, "Available — reconciliation and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Import trial balance first"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Complete Prepare Data first"),
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Outputs",    "filing",     companyId, periodYear, "Complete Compute Tax first"),
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
        reconcile:  na("Reconcile",          "reconcile",  companyId, periodYear, "Available — reconciliation and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Awaiting Prepare Data"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Awaiting Prepare Data"),
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Outputs",    "filing",     companyId, periodYear, "Awaiting Compute Tax"),
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
        reconcile:  na("Reconcile",              "reconcile",  companyId, periodYear, "Available — reconciliation and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Resolve Prepare Data review items first"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Complete Prepare Data first"),
        compliance: na("Compliance Review",      "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Outputs",    "filing",     companyId, periodYear, "Complete Compute Tax first"),
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
        reconcile:  na("Reconcile",      "reconcile",  companyId, periodYear, "Available — reconciliation and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Resolve Prepare Data error first"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Complete Prepare Data first"),
        compliance: na("Compliance Review", "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Outputs",    "filing",     companyId, periodYear, "Complete Compute Tax first"),
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
        reconcile:  na("Reconcile",      "reconcile",  companyId, periodYear, "Available — reconciliation and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, "Clear validation errors first"),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Complete Prepare Data first"),
        compliance: na("Compliance Review", "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Outputs",    "filing",     companyId, periodYear, "Complete Compute Tax first"),
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
        prepare:    { status: "blocked", label: "Prepare Data", summary: `Reconciliation: ${upload.safishaStatus}`, href: `${b}/prepare`, blocker: upload.safishaStatus ?? undefined },
        reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — reconciliation and journal review"),
        statements: statementsInPrepareBlock,
        tax:        locked("Compute Tax",    "tax",    companyId, periodYear, "Prepare Data reconciliation must clear before tax computation (constitutional gate)"),
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Outputs", "filing", companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "resolve-reconciliation",
        label: "Resolve Reconciliation Exceptions",
        description: `Reconciliation matching blocked (${upload.safishaStatus}) — resolve exceptions before tax computation can run`,
        href: `${b}/prepare`,
        blocked: false,
        mission: "prepare",
        priority: 6,
      },
    };
  }

  // ── PATH 6B: Certification not yet established ────────────────────────────
  // Iron Dome: the ABSENCE of a certification record is never evidence of certification.
  // Only the literal verdict "certified" may unlock statement readiness — this is the SAME
  // authority PrepareWorkspace's own six-layer pre-flight panel already uses
  // (computeCertificationReadiness, sourced from the tb_certifications ledger), now the
  // ONE place Overview, the tab bar and Prepare Statements all agree with it. Before this
  // path existed, a trial balance whose classification completed (is_valid=true) but whose
  // arithmetic certification failed or had not yet been read could reach PATH 7/8 below and
  // wrongly announce "TB is valid — cross-validate the draft financial statements" while
  // Prepare Data's own pre-flight panel simultaneously showed CHECKS FAILED for the same
  // upload — a direct, live-observed contradiction (Debits != Credits, 2026-09-22).
  //
  // upload.certificationVerdict is undefined whenever the caller has not (yet) resolved the
  // certification read — treated identically to "not certified", never as silent success.
  if (upload.certificationVerdict !== "certified") {
    const verdict = upload.certificationVerdict;
    const isFailure = verdict === "blocked" || verdict === "review";
    const blockerText =
      upload.certificationBlocker ??
      (isFailure ? "This trial balance failed certification." : "This trial balance is not yet certified.");

    return {
      ...uploadCommon,
      missions: {
        prepare: isFailure
          ? { status: "blocked", label: "Prepare Data", summary: "Trial balance certification failed", href: `${b}/prepare`, blocker: blockerText }
          : { status: "in_progress", label: "Prepare Data", summary: "Awaiting trial-balance certification", href: `${b}/prepare` },
        reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — reconciliation and journal review"),
        statements: locked("Prepare Statements", "statements", companyId, periodYear, blockerText),
        tax:        locked("Compute Tax",        "tax",        companyId, periodYear, "Complete Prepare Data first"),
        compliance: na("Compliance Review",      "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Outputs",    "filing",     companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: isFailure ? "fix-certification-failure" : "await-certification",
        label: isFailure ? "Resolve trial-balance difference" : "Certify the trial balance",
        description: blockerText,
        href: `${b}/prepare`,
        blocked: false,
        mission: "prepare",
        priority: 4,
      },
    };
  }

  const safishaClean = upload.safishaStatus === "clean";

  // ── PATH 7 + 8: TB valid, no HESABU yet ──────────────────────────────────
  if (!upload.hesabuPassedAt) {
    const prepareSummary = safishaClean
      ? "TB clean — reconciled"
      : "TB validated and processed";

    return {
      ...uploadCommon,
      missions: {
        prepare:    { status: "passed", label: "Prepare Data",     summary: prepareSummary, href: `${b}/prepare` },
        reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — reconciliation and journal review"),
        statements: { status: "ready",  label: "Prepare Statements", summary: "Ready to validate statements", href: `${b}/statements` },
        tax:        locked("Compute Tax",    "tax",    companyId, periodYear, "Complete Prepare Statements validation first"),
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Outputs", "filing", companyId, periodYear, "Complete Compute Tax first"),
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
        reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — reconciliation and journal review"),
        statements: { status: "passed", label: "Prepare Statements", summary: "Statements validated", href: `${b}/statements` },
        tax:        taxBlocked
          ? locked("Compute Tax", "tax", companyId, periodYear, "Prepare Data reconciliation must clear first (constitutional gate)")
          : { status: "ready", label: "Compute Tax", summary: "Ready to compute corporate tax", href: `${b}/tax` },
        compliance: na("Compliance Review",  "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     locked("Prepare Outputs", "filing", companyId, periodYear, "Complete Compute Tax first"),
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "compute-corporate-tax",
        label: "Compute Corporate Tax",
        description: taxBlocked
          ? "Statements validated — resolve Prepare Data reconciliation to unlock tax computation"
          : "Statements validated — compute corporate income tax",
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
        reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — reconciliation and journal review"),
        statements: { status: "passed", label: "Prepare Statements", summary: "Statements validated",       href: `${b}/statements` },
        tax:        { status: "signed", label: "Compute Tax",        summary: "Tax computed and signed",    href: `${b}/tax` },
        compliance: na("Compliance Review", "compliance", companyId, periodYear, "Available after tax computation"),
        filing:     { status: "ready",  label: "Prepare Outputs",    summary: "Ready to assemble disclosure and filing-readiness outputs", href: `${b}/filing` },
        monitor:    na("Monitor", "monitor", companyId, periodYear),
      },
      nextAction: {
        id: "prepare-filing-package",
        label: "Prepare Engagement Outputs",
        description: "Tax computation is signed — assemble disclosure notes, management material and filing-readiness outputs",
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
      reconcile:  na("Reconcile", "reconcile", companyId, periodYear, "Available — reconciliation and journal review"),
      statements: { status: "signed", label: "Prepare Statements", summary: "Statements validated and signed", href: `${b}/statements` },
      tax:        { status: "signed", label: "Compute Tax",        summary: "Tax computed and signed",        href: `${b}/tax` },
      compliance: na("Compliance Review", "compliance", companyId, periodYear, "Available after tax computation"),
      filing:     { status: "signed", label: "Prepare Outputs",    summary: "Output and submission status recorded", href: `${b}/filing` },
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
