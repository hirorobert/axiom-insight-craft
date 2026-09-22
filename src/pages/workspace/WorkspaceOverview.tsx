/**
 * WorkspaceOverview — the authenticated first screen. One decision, nothing else.
 *
 * Two zones only:
 *   A. Engagement identity  — company · fiscal year, quiet. TIN only when it blocks.
 *   B. Current decision     — the ONE dominant CTA on this screen.
 *
 * The former Zone C ("Engagement path" — a dot/check/lock chip strip
 * repeating the same 7 stages) was removed: WorkspaceLayout's own persistent
 * top tab bar already shows every stage's status on this exact page, in a
 * plainer underline-tab convention. Rendering the identical information
 * twice, in two different visual metaphors, directly beneath the one
 * dominant CTA this screen exists to present, was pure duplication — and
 * the dot/check/lock chip path was, of the two, the one that read as a
 * game's level-progress tracker rather than professional software chrome.
 *
 * Presentation only. Every count, status, lock reason and next action is read
 * from workspaceState / upload.processing_result. No accounting state is derived
 * here, nothing is written here, and no stage gate is evaluated here.
 */

import { useState, useEffect } from "react";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { Link, useNavigate } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, AlertTriangle, FileText } from "lucide-react";
import { STAGE_SEQUENCE, STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import CompanyTinDialog from "@/components/workspace/CompanyTinDialog";
import EngagementScopeDialog from "@/components/workspace/EngagementScopeDialog";
import PreviousEngagementWork from "@/components/workspace/PreviousEngagementWork";
import { useEngagement } from "@/contexts/EngagementContext";
import { buildPrepareReviewRoute, buildPrepareUploadRoute } from "@/lib/workspace/resolveActiveUpload";
import { capabilityTitle, ENGAGEMENT_CAPABILITIES } from "@/lib/workspace/mandate";
import { readRememberedOutcome } from "@/lib/product/outcomes";
import { DecisionCard, buildClassificationDecision, type Decision } from "@/components/workspace/DecisionCard";
import ServiceLaunchpad from "@/components/workspace/ServiceLaunchpad";
import DataChoiceCard from "@/components/workspace/DataChoiceCard";
import { EntityContextSuggestion } from "@/components/workspace/EntityContextSuggestion";
import { useDataStart } from "@/hooks/useDataStart";
import { deriveLaunchState, LAUNCH_COPY } from "@/lib/workspace/onboardingState";
import { evaluateTaxProfile, TAX_PROFILE_COPY } from "@/lib/jurisdiction/taxProfile";
import { resolveNextActionDestination } from "@/lib/workspace/resolveNextActionDestination";
import { deriveClassificationPresentation } from "@/lib/workspace/classificationPresentation";
import { deriveOrientationSummary } from "@/lib/workspace/deriveOrientationSummary";
import { detectEntityAccountingContext } from "@/lib/accounting/detectEntityContext";
import { classifyConfirmationPosture } from "@/lib/accounting/confirmationPosture";

// ── Helpers ─────────────────────────────────────────────────────────────────

const num = (n: number) => n.toLocaleString("en-US");

// ── File provenance ─────────────────────────────────────────────────────────
// Pure formatting of the stored upload record. A value that is missing or not
// a usable measurement returns null so the caller omits it — nothing is ever
// substituted.

function formatFileSize(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const RELATIVE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function describeUploadTime(uploadedAt: string, nowMs: number): { relative: string; exact: string } | null {
  const uploaded = new Date(uploadedAt);
  const uploadedMs = uploaded.getTime();
  if (Number.isNaN(uploadedMs)) return null;

  const exact = uploaded.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const seconds = Math.round((nowMs - uploadedMs) / 1000);
  // Older than a week (or in the future, from clock skew): a date is more honest than "412 days ago".
  if (seconds < 0 || seconds > RELATIVE_WINDOW_SECONDS) {
    return { relative: uploaded.toLocaleDateString("en-GB", { dateStyle: "medium" }), exact };
  }
  if (seconds < 60) return { relative: "just now", exact };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { relative: RELATIVE_TIME.format(-minutes, "minute"), exact };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { relative: RELATIVE_TIME.format(-hours, "hour"), exact };
  return { relative: RELATIVE_TIME.format(-Math.floor(hours / 24), "day"), exact };
}

function ActiveFileProvenance({
  fileName,
  fileSize,
  uploadedAt,
  manageHref,
}: {
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  manageHref: string;
}) {
  const size = formatFileSize(fileSize);
  const time = describeUploadTime(uploadedAt, Date.now());
  return (
    <div className="mb-3 flex items-center justify-between gap-4" data-testid="active-file-provenance">
      <p className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
        <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate font-mono text-foreground/80" title={fileName}>
          {fileName}
        </span>
        {size && (
          <>
            <span aria-hidden="true" className="text-muted-foreground/50">·</span>
            <span className="shrink-0">{size}</span>
          </>
        )}
        {time && (
          <>
            <span aria-hidden="true" className="text-muted-foreground/50">·</span>
            <time className="shrink-0" dateTime={uploadedAt} title={time.exact}>
              {time.relative}
            </time>
          </>
        )}
      </p>
      <Link
        to={manageHref}
        className="shrink-0 whitespace-nowrap text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        Manage file <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export default function WorkspaceOverview() {
  const {
    company,
    upload,
    uploads,
    workspaceState,
    loading,
    periodYear,
    companyId,
    refreshUpload,
  } = useWorkspace();

  const navigate = useNavigate();

  const [retrying, setRetrying] = useState(false);
  const [tinDialogOpen, setTinDialogOpen] = useState(false);
  const [tinOverride, setTinOverride] = useState<string | null>(null);
  // Two distinct entry points, one dialog: "add" (Start another service — pure addition, no
  // friction) and "amend" (Amend this engagement — can withdraw a service, audited when it does).
  // null = closed.
  const [scopeDialogMode, setScopeDialogMode] = useState<"add" | "amend" | null>(null);

  const {
    engagement,
    mandate,
    missionViews,
    events,
    canAmend,
    loading: mandateLoading,
    createEngagement,
  } = useEngagement();
  // Durable data choice for this workspace (never a URL flag, local flag or navigation history).
  const dataStart = useDataStart(engagement?.id ?? null);

  // Retry the ingest pipeline when the active upload failed.
  const handleRetryProcessing = async () => {
    if (!upload?.id || retrying) return;
    setRetrying(true);
    toast.info(`Retrying: ${upload.file_name ?? "Trial Balance"}…`);
    try {
      await supabase
        .from("trial_balance_uploads")
        .update({
          status: "processing",
          processing_result: null,
          accounting_errors: null,
          is_valid: null,
        })
        .eq("id", upload.id);

      await ensureFreshSession();
      const clientRequestId = crypto.randomUUID();
      const { error: fnErr } = await supabase.functions.invoke("process-trial-balance", {
        body: { uploadId: upload.id, clientRequestId },
      });
      if (fnErr) throw fnErr;

      refreshUpload();
      toast.success("Re-processing started. Status will update automatically.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry failed";
      toast.error(`Retry failed: ${msg}`);
    } finally {
      setRetrying(false);
    }
  };

  // Poll while the trial balance is still processing.
  const activeUploadStatus = upload?.status;
  useEffect(() => {
    if (!activeUploadStatus) return;
    const isPolling =
      activeUploadStatus === "processing" ||
      activeUploadStatus === "pending" ||
      activeUploadStatus === "queued";
    if (!isPolling) return;
    const interval = setInterval(() => refreshUpload(), 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUploadStatus]);

  if (loading) {
    return (
      <div className="space-y-8 max-w-3xl">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  const { nextAction, missions } = workspaceState;
  const basePath = `/workspace/${companyId}/${periodYear}`;
  const selectedOutcome = readRememberedOutcome();

  // A stored value alone is not a decision: pre-cut-over rows may hold the historical 'ifrs_for_smes' default. The
  // existing confirmation authority (detector provenance + classifyConfirmationPosture, as in FrameworkConfirmationBanner)
  // says when a framework is settled — HIGH confidence or professionally confirmed, which also implies a recognised value.
  // Only then is the header breadcrumb the authority and the suggestion redundant; otherwise it stays as the setup aid.
  const frameworkPosture = classifyConfirmationPosture(
    detectEntityAccountingContext({ companyReportingFrameworkDbValue: company?.reporting_framework, companyCreatedAt: company?.created_at }).reportingFramework,
  );
  const frameworkConfirmed = frameworkPosture === "QUIET_CONFIRMATION" || frameworkPosture === "NO_PROMPT_NEEDED";

  const effectiveTin = tinOverride ?? company?.tin ?? null;
  const granted = mandate?.granted ?? null;
  const orientation = deriveOrientationSummary(workspaceState, granted);
  // A tax-profile warning needs (1) an active tax/filing service, (2) a configured jurisdiction that requires the field
  // and (3) the field actually missing. No jurisdiction is configured for a workspace today, so it never fires by inference.
  const jurisdiction = company?.filing_jurisdiction ?? null;
  const taxProfile = evaluateTaxProfile({ granted, jurisdiction, taxIdentifier: effectiveTin });

  const prepareStatus = missions.prepare.status;
  const prepareDone = prepareStatus === "passed" || prepareStatus === "signed";
  const hasUpload = uploads.length > 0;

  // The active path is the mandate's path. Stages outside the mandate are not
  // part of orientation; retained work has its own read-only section.
  const pathStages = STAGE_SEQUENCE.filter((slug) =>
    missionViews.some((v) => v.stage === slug && v.visible),
  );

  const activeIndex = pathStages.findIndex((slug) => {
    const s = missions[slug].status;
    return s !== "passed" && s !== "signed" && s !== "locked" && s !== "not_applicable";
  });

  // Classification outcome — deterministic, side-effect-free, exhaustively typed. The ONE place that interprets
  // upload.status + upload.processing_result into a classification narrative; see classificationPresentation.ts for
  // the proven data lineage (mapping_completeness.mapped_accounts is "classified" — never summary.auto_classified,
  // which is proven to count Tier 4-5 only and excludes every professionally-approved mapping).
  const classification = deriveClassificationPresentation(upload?.status, upload?.processing_result);

  // ── The single decision on this screen ────────────────────────────────────
  let decision: Decision;

  // The four non-happy-path classification states each get their own branch below; the two count-bearing "done"
  // states (COMPLETE_WITH_REVIEW / PARTIAL) share the review branch, and COMPLETE_NO_REVIEW / NOT_COMPUTED fall
  // through to the ordinary "finish preparing" branch, where COMPLETE_NO_REVIEW additionally supplies its own detail.
  const isFailed = classification.state === "FAILED";
  const isProcessing = classification.state === "PROCESSING";
  const isInconsistent = classification.state === "INCONSISTENT";
  // deriveWorkspaceState's PATH 6B — the trial balance's own account classification may be entirely done
  // (classification.state could read COMPLETE_NO_REVIEW here) while the SEPARATE, authoritative SAFISHA
  // certification (tb_certifications) is not "certified" yet. Checked via workspaceState, not classification,
  // because classification has no visibility into certification at all.
  const isCertificationBlocked = nextAction.id === "fix-certification-failure" || nextAction.id === "await-certification";
  const needsReview = classification.state === "COMPLETE_WITH_REVIEW" || classification.state === "PARTIAL";

  const launchState = deriveLaunchState({ granted, hasUpload, dataStart: dataStart.choice });

  // The two existing Prepare Data destinations classification decisions route to — unchanged route builders.
  const prepareHref = `${basePath}/prepare`;
  const reviewHref = buildPrepareReviewRoute(companyId, periodYear, upload?.id ?? null);
  const classificationDecisionOptions = { retrying, onRetry: handleRetryProcessing, prepareHref, reviewHref };

  if (launchState === "IMPORT_PENDING") {
    decision = {
      eyebrow: STAGE_CONFIGS.prepare.label,
      headline: "Continue importing your trial balance.",
      detail: "You chose to import data. Nothing has been uploaded yet.",
      button: { label: LAUNCH_COPY.primaryAction, href: `${basePath}/prepare`, icon: <ArrowRight className="w-4 h-4" /> },
      tone: "primary",
    };
  } else if (launchState === "EMPTY_WORKSPACE" || (!hasUpload && launchState === "ACTIVE")) {
    // The genuine empty workspace: nothing is pending and nothing redirects. Importing later is a quiet, optional action.
    decision = {
      eyebrow: "Workspace",
      headline: "Your workspace is ready.",
      detail: "No financial data has been added yet. Add it whenever you are ready.",
      // empty → import is the one permitted follow-up transition: recorded on the server, then the single upload surface opens.
      button: {
        label: LAUNCH_COPY.emptyStateCta,
        onClick: async () => {
          if (await dataStart.record("import")) navigate(`${basePath}/prepare`);
        },
        icon: <ArrowRight className="w-4 h-4" />,
      },
      tone: "muted",
    };
  } else if (isFailed) {
    decision = buildClassificationDecision(classification, classificationDecisionOptions);
  } else if (isProcessing) {
    decision = buildClassificationDecision(classification, classificationDecisionOptions);
  } else if (isInconsistent) {
    // Impossible or self-contradictory values (see classificationPresentation.ts) — fail closed. Never guessed or
    // silently normalised, and never presented as a review item, since the review screen reads the same corrupt data.
    decision = buildClassificationDecision(classification, classificationDecisionOptions);
  } else if (isCertificationBlocked) {
    // workspaceState.missions.prepare.status is "blocked" for a reason classification alone cannot see — arithmetic
    // or another tb_certifications failure (deriveWorkspaceState PATH 6B). classification itself may read
    // COMPLETE_NO_REVIEW here (account mapping genuinely finished), which is exactly the contradiction this branch
    // exists to prevent: without it, the generic "!prepareDone" branch below would show "No review required" while
    // the trial balance has NOT actually been certified as safe to build statements on. workspaceState.nextAction
    // is the single authority for this text — the same one PrepareWorkspace's own pre-flight panel is built from.
    decision = {
      eyebrow: STAGE_CONFIGS.prepare.label,
      headline: nextAction.label,
      detail: nextAction.description,
      button: {
        label: nextAction.label,
        href: nextAction.href,
        icon: <ArrowRight className="w-4 h-4" />,
      },
      tone: "warn",
      offersFileReplacement: true,
    };
  } else if (needsReview) {
    decision = buildClassificationDecision(classification, classificationDecisionOptions);
  } else if (!prepareDone) {
    // Surfaces the classification result immediately when it is authoritatively available (COMPLETE_NO_REVIEW).
    // NOT_COMPUTED and every other non-terminal state fall back to the plain "later stages open" line — never a
    // fabricated count, and never a claim that this stage is finished (prepareDone still governs that separately).
    // Same mapping function the internal classification-states acceptance page uses — one semantic authority.
    decision = buildClassificationDecision(classification, classificationDecisionOptions);
  } else {
    const activeSlug = activeIndex >= 0 ? pathStages[activeIndex] : null;
    const destination = resolveNextActionDestination({
      activeSlug,
      basePath,
      nextActionHref: nextAction.href,
      nextActionLabel: nextAction.label,
      routeIntent: selectedOutcome?.routeIntent,
    });
    const button = {
      label: destination.label,
      href: destination.href,
      disabled: nextAction.blocked,
      icon: <ArrowRight className="w-4 h-4" />,
    };
    decision = {
      eyebrow: activeSlug ? STAGE_CONFIGS[activeSlug].label : "Engagement complete",
      headline: nextAction.description,
      detail: nextAction.blocker ?? undefined,
      button,
      tone: nextAction.blocked ? "muted" : "primary",
    };
  }

  // One route to the exact upload on screen, from the existing Prepare route builder.
  const manageUploadHref = buildPrepareUploadRoute(companyId, periodYear, upload?.id ?? null);

  return (
    <div className="max-w-3xl">
      {company && (
        <CompanyTinDialog
          open={tinDialogOpen}
          onOpenChange={setTinDialogOpen}
          companyId={company.id}
          companyName={company.name}
          currentTin={effectiveTin}
          onSaved={(tin) => setTinOverride(tin)}
        />
      )}

      <EngagementScopeDialog
        open={scopeDialogMode !== null && canAmend}
        onOpenChange={(v) => setScopeDialogMode(v ? scopeDialogMode : null)}
        mode={!engagement ? "declare" : (scopeDialogMode ?? "amend")}
      />

      {/* ── ZONE A · Engagement identity ─────────────────────────────────────
          The company and fiscal year already live in the workspace header, so
          repeating them here would be a second representation of the same fact.
          Zone A therefore carries only what is actionable: a blocking TIN.
          TIN never appears merely because the record holds a value. */}
      {company && (
        <div className="mb-2 flex flex-wrap items-center text-[12px] text-muted-foreground tracking-wide" data-testid="orientation-identity">
          <span className="text-foreground/80">{company.name}</span>
          <span className="px-1.5 text-muted-foreground/50">·</span>
          <span className="tabular-nums">FY{periodYear}</span>
          {orientation.service && (
            <>
              <span className="px-1.5 text-muted-foreground/50">·</span>
              <span>{orientation.service}</span>
            </>
          )}
          {!frameworkConfirmed && (
            <>
              <span className="px-1.5 text-muted-foreground/50">·</span>
              <EntityContextSuggestion reportingFrameworkDbValue={company.reporting_framework} companyCreatedAt={company.created_at} />
            </>
          )}
        </div>
      )}

      {company && (
        <div className="mb-6 flex flex-wrap items-baseline gap-x-1.5 text-[12px] text-muted-foreground" data-testid="orientation-status">
          <span>
            <span className="font-medium text-foreground/70">{orientation.currentStageLabel}:</span> {orientation.currentStatusLabel}
          </span>
          {orientation.lastCompletedMilestone && (
            <span className="text-muted-foreground/70" data-testid="orientation-last-milestone">
              — last completed: {orientation.lastCompletedMilestone.stageLabel}
              {orientation.lastCompletedMilestone.at &&
                ` (${new Date(orientation.lastCompletedMilestone.at).toLocaleDateString("en-GB", { dateStyle: "medium" })})`}
            </span>
          )}
        </div>
      )}

      {taxProfile.warn && (
        <header className="mb-6">
          <button
            type="button"
            onClick={() => setTinDialogOpen(true)}
            className="inline-flex items-center gap-2 text-[13px] text-amber-600 dark:text-amber-500 hover:underline underline-offset-4"
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {TAX_PROFILE_COPY.warning}
          </button>
        </header>
      )}

      {/* ── ZONE B · Current decision — the one centre of gravity ────────── */}
      <section className="mb-10 sm:mb-14" data-testid="current-decision">

        {mandateLoading || dataStart.loading ? (
          <Skeleton className="h-56 w-full" />
        ) : launchState === "LAUNCHPAD" ? (
          <ServiceLaunchpad canChoose={canAmend} companyId={companyId} jurisdiction={jurisdiction} onConfirm={(selected) => createEngagement(selected)} />
        ) : launchState === "DATA_CHOICE" ? (
          <DataChoiceCard
            onImport={async () => {
              // Persist first; only then leave the Overview for the single canonical upload surface.
              if (await dataStart.record("import")) navigate(`${basePath}/prepare`);
              else throw new Error("Your choice could not be saved. Try again.");
            }}
            onStartEmpty={async () => {
              // Persist first; the Overview then re-derives to the genuine empty workspace. No navigation.
              if (!(await dataStart.record("empty"))) throw new Error("Your choice could not be saved. Try again.");
            }}
          />
        ) : (
          /* ── Standard decision surface ───────────────────────────────── */
          <>
            {/* The stored record of the file this decision is about — shown only from the typed upload contract, never inferred. */}
            {upload && (
              <ActiveFileProvenance
                fileName={upload.file_name}
                fileSize={upload.file_size}
                uploadedAt={upload.uploaded_at}
                manageHref={manageUploadHref}
              />
            )}

            <DecisionCard decision={decision} manageUploadHref={manageUploadHref} />
          </>
        )}
      </section>

      {/* Services row — the mandated outcomes from the persisted engagement scope, and the only amend affordance.
          Names the actual outcomes (not just a bare count) so the destination this engagement is heading toward
          is visible from the home screen, not only inside the scope dialog where it was chosen. */}
      {engagement && mandate && mandate.granted.length > 0 && (
        <div className="mt-6 flex items-start justify-between gap-4 border-t border-border pt-5" data-testid="engagement-services">
          <p className="min-w-0 text-[12px] text-muted-foreground">
            <span className="mr-2 text-[10px] font-semibold uppercase tracking-[0.18em]">Services</span>
            {mandate.granted.map((cap) => capabilityTitle(cap)).join(", ")}
          </p>
          {canAmend && (
            <div className="flex shrink-0 items-center gap-4">
              {mandate.granted.length < ENGAGEMENT_CAPABILITIES.length && (
                <button
                  type="button"
                  onClick={() => setScopeDialogMode("add")}
                  title="Add a service — no reason needed, your existing services are unaffected"
                  className="whitespace-nowrap text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  data-testid="start-another-service"
                >
                  Start another service <span aria-hidden="true">→</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setScopeDialogMode("amend")}
                title={LAUNCH_COPY.scopeEditor}
                className="whitespace-nowrap text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
                data-testid="amend-engagement"
              >
                Amend this engagement <span aria-hidden="true">→</span>
              </button>
            </div>
          )}
        </div>
      )}

      <PreviousEngagementWork views={missionViews} events={events} />
    </div>
  );
}
