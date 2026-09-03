/**
 * WorkspaceOverview — the authenticated first screen. One decision, nothing else.
 *
 * Three zones only:
 *   A. Engagement identity  — company · fiscal year, quiet. TIN only when it blocks.
 *   B. Current decision     — the ONE dominant CTA on this screen.
 *   C. Engagement path      — the canonical 7 stages as quiet orientation.
 *
 * Presentation only. Every count, status, lock reason and next action is read
 * from workspaceState / upload.processing_result. No accounting state is derived
 * here, nothing is written here, and no stage gate is evaluated here.
 */

import { useState, useEffect } from "react";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { Link } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ArrowRight, AlertTriangle, RefreshCw, Upload, Check, Lock } from "lucide-react";
import { STAGE_SEQUENCE, STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import CompanyTinDialog from "@/components/workspace/CompanyTinDialog";
import EngagementScopeDialog from "@/components/workspace/EngagementScopeDialog";
import PreviousEngagementWork from "@/components/workspace/PreviousEngagementWork";
import { useEngagement } from "@/contexts/EngagementContext";
import { buildPrepareReviewRoute } from "@/lib/workspace/resolveActiveUpload";
import { SurfaceCard } from "@/components/workspace/ui/Surface";

// ── Helpers ─────────────────────────────────────────────────────────────────

function countUnresolved(
  processingResult: Record<string, unknown> | null | undefined,
): { unresolved: number; total: number | null; classified: number | null } {
  const pr = (processingResult ?? null) as
    | { summary?: Record<string, unknown>; needs_review_accounts?: unknown }
    | null;
  const list = Array.isArray(pr?.needs_review_accounts) ? pr!.needs_review_accounts : null;
  const summary = pr?.summary ?? null;
  const total =
    summary && typeof summary.total_accounts === "number" ? summary.total_accounts : null;
  const classified =
    summary && typeof summary.auto_classified === "number" ? summary.auto_classified : null;
  const unresolved =
    list !== null
      ? list.length
      : total !== null && classified !== null
        ? Math.max(0, total - classified)
        : 0;
  return { unresolved, total, classified };
}

const num = (n: number) => n.toLocaleString("en-TZ");

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

  const [retrying, setRetrying] = useState(false);
  const [tinDialogOpen, setTinDialogOpen] = useState(false);
  const [tinOverride, setTinOverride] = useState<string | null>(null);
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);

  const {
    engagement,
    mandate,
    missionViews,
    events,
    canAmend,
    loading: mandateLoading,
  } = useEngagement();

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

  const effectiveTin = tinOverride ?? company?.tin ?? null;
  const tinMissing =
    !effectiveTin ||
    /PUT-REAL|placeholder|todo|tbd/i.test(effectiveTin) ||
    !/^\d+$/.test(effectiveTin.replace(/-/g, ""));

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

  const { unresolved, total, classified } = countUnresolved(
    upload?.processing_result as Record<string, unknown> | null,
  );

  // TIN is an exception only when it is missing/invalid AND the current
  // canonical next action actually names it as the blocker. Phase 1 Slice 2
  // (DEFECT-GLOBAL-TIN-GATE-001): the upload gate that used to make TIN
  // unconditionally blocking pre-upload is gone -- SAFISHA upload/
  // certification no longer requires a TRA TIN at all, so its mere absence
  // before an upload exists is no longer itself a blocker. TIN only matters
  // where a real downstream workflow (e.g. TRA filing) actually needs it and
  // says so via nextAction.blocker.
  const tinBlocksNextAction = tinMissing && /tin/i.test(nextAction.blocker ?? "");

  // ── The single decision on this screen ────────────────────────────────────
  type Decision = {
    eyebrow: string;
    headline: string;
    detail?: string;
    button: {
      label: string;
      href?: string;
      onClick?: () => void;
      icon: React.ReactNode;
      disabled?: boolean;
    };
    tone: "primary" | "warn" | "muted";
  };

  let decision: Decision;

  const s = upload?.status;
  const isFailed = s === "blocked" || s === "error";
  const isProcessing = s === "processing" || s === "pending" || s === "queued";
  const needsReview = s === "needs_review" && unresolved > 0;

  const mandateUndeclared = !mandateLoading && (!engagement || !mandate || mandate.granted.length === 0);

  if (mandateUndeclared) {
    // Scope is declared, never inferred. Until it is declared there is no
    // defensible next accounting action, so this is the one decision.
    decision = {
      eyebrow: "Engagement",
      headline: "What are you preparing for this client?",
      detail:
        "Record the outcomes you were engaged to deliver for this period. SAFF then shows only the stages that mandate requires.",
      button: {
        label: canAmend ? "Declare engagement scope" : "Ask a partner to open the engagement",
        onClick: canAmend ? () => setScopeDialogOpen(true) : undefined,
        disabled: !canAmend,
        icon: <ArrowRight className="w-4 h-4" />,
      },
      tone: canAmend ? "primary" : "muted",
    };
  } else if (!hasUpload) {
    decision = {
      eyebrow: STAGE_CONFIGS.prepare.label,
      headline: "Upload the trial balance to open this engagement.",
      detail:
        "SAFF parses the workbook, checks that it balances, and classifies every account it can defend before anything downstream runs.",
      button: {
        label: "Upload trial balance",
        href: `${basePath}/prepare`,
        icon: <Upload className="w-4 h-4" />,
      },
      tone: "primary",
    };
  } else if (isFailed) {
    decision = {
      eyebrow: STAGE_CONFIGS.prepare.label,
      headline: "The trial balance could not be processed.",
      detail: "Re-run processing, or replace the file in Prepare Data.",
      button: {
        label: retrying ? "Retrying…" : "Retry processing",
        onClick: handleRetryProcessing,
        disabled: retrying,
        icon: <RefreshCw className={`w-4 h-4 ${retrying ? "animate-spin" : ""}`} />,
      },
      tone: "warn",
    };
  } else if (isProcessing) {
    decision = {
      eyebrow: STAGE_CONFIGS.prepare.label,
      headline: "Trial balance is processing.",
      detail:
        "This screen updates itself. The run continues on the server if you leave the page.",
      button: {
        label: "Open Prepare Data",
        href: `${basePath}/prepare`,
        icon: <ArrowRight className="w-4 h-4" />,
      },
      tone: "muted",
    };
  } else if (needsReview) {
    decision = {
      eyebrow: STAGE_CONFIGS.prepare.label,
      headline: `${num(unresolved)} ${unresolved === 1 ? "account requires" : "accounts require"} review`,
      detail:
        total !== null && classified !== null
          ? `${num(total)} accounts processed · ${num(classified)} classified · ${num(unresolved)} require professional review.`
          : "These accounts have no reliable classification and need a professional decision.",
      button: {
        label: `Review ${num(unresolved)} ${unresolved === 1 ? "account" : "accounts"}`,
        href: buildPrepareReviewRoute(companyId, periodYear, upload?.id ?? null),
        icon: <ArrowRight className="w-4 h-4" />,
      },
      tone: "primary",
    };
  } else if (!prepareDone) {
    decision = {
      eyebrow: STAGE_CONFIGS.prepare.label,
      headline: "Finish preparing the trial balance.",
      detail: "Later stages open as each one passes.",
      button: {
        label: "Open Prepare Data",
        href: `${basePath}/prepare`,
        icon: <ArrowRight className="w-4 h-4" />,
      },
      tone: "primary",
    };
  } else {
    const activeSlug = activeIndex >= 0 ? pathStages[activeIndex] : null;
    decision = {
      eyebrow: activeSlug ? STAGE_CONFIGS[activeSlug].label : "Engagement complete",
      headline: nextAction.description,
      detail: nextAction.blocker ?? undefined,
      button: {
        label: nextAction.label,
        href: nextAction.href,
        disabled: nextAction.blocked,
        icon: <ArrowRight className="w-4 h-4" />,
      },
      tone: nextAction.blocked ? "muted" : "primary",
    };
  }

  const eyebrowTone =
    decision.tone === "warn"
      ? "text-destructive"
      : decision.tone === "muted"
        ? "text-muted-foreground"
        : "text-primary";

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
        open={scopeDialogOpen}
        onOpenChange={setScopeDialogOpen}
        mode={engagement ? "amend" : "declare"}
      />

      {/* ── ZONE A · Engagement identity ─────────────────────────────────────
          The company and fiscal year already live in the workspace header, so
          repeating them here would be a second representation of the same fact.
          Zone A therefore carries only what is actionable: a blocking TIN.
          TIN never appears merely because the record holds a value. */}
      {company && (
        <p className="mb-6 text-[12px] text-muted-foreground tracking-wide">
          <span className="text-foreground/80">{company.name}</span>
          <span className="px-1.5 text-muted-foreground/50">·</span>
          <span className="tabular-nums">FY{periodYear}</span>
        </p>
      )}

      {tinBlocksNextAction && (
        <header className="mb-6">
          <button
            type="button"
            onClick={() => setTinDialogOpen(true)}
            className="inline-flex items-center gap-2 text-[13px] text-amber-600 dark:text-amber-500 hover:underline underline-offset-4"
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            TIN required — add it
          </button>
        </header>
      )}

      {/* ── ZONE B · Current decision — the one centre of gravity ────────── */}
      <section className="mb-10 sm:mb-14" data-testid="current-decision">
        <SurfaceCard className="px-5 py-8 sm:px-8 sm:py-10">
          <p className={`text-[10px] font-semibold uppercase tracking-[0.22em] mb-5 ${eyebrowTone}`}>
            {decision.eyebrow}
          </p>
          <h2 className="text-2xl sm:text-[2rem] font-semibold tracking-tight text-foreground leading-[1.2] max-w-xl">
            {decision.headline}
          </h2>
          {decision.detail && (
            <p className="mt-4 text-[14px] text-muted-foreground leading-relaxed max-w-xl">
              {decision.detail}
            </p>
          )}

          <div className="mt-8">
            {decision.button.href && !decision.button.disabled ? (
              <Button
                asChild
                size="lg"
                data-testid="primary-cta"
                variant={decision.tone === "muted" ? "outline" : "default"}
                className="h-12 w-full sm:w-auto px-6 text-[14px] font-semibold rounded-none shadow-none"
              >
                <Link to={decision.button.href}>
                  {decision.button.icon}
                  <span className="mx-2">{decision.button.label}</span>
                </Link>
              </Button>
            ) : (
              <Button
                onClick={decision.button.onClick}
                disabled={decision.button.disabled}
                size="lg"
                data-testid="primary-cta"
                variant={decision.tone === "warn" ? "destructive" : "default"}
                className="h-12 w-full sm:w-auto px-6 text-[14px] font-semibold rounded-none shadow-none"
              >
                {decision.button.icon}
                <span className="mx-2">{decision.button.label}</span>
              </Button>
            )}
          </div>
        </SurfaceCard>
      </section>

      {/* ── ZONE C · Engagement path — quiet orientation, zero CTA weight ── */}
      <nav aria-label="Engagement path" data-testid="engagement-path">
        <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 -mx-1">
          {pathStages.map((slug, i) => {
            const mission = missions[slug];
            const isLocked = mission.status === "locked" || mission.status === "not_applicable";
            const isComplete = mission.status === "passed" || mission.status === "signed";
            const isCurrent = i === activeIndex;
            const label = STAGE_CONFIGS[slug].label;

            const inner = (
              <span
                className={[
                  "inline-flex items-center gap-1.5 px-2 py-1 text-[12px] whitespace-nowrap",
                  isCurrent
                    ? "text-foreground font-medium"
                    : isComplete
                      ? "text-muted-foreground"
                      : isLocked
                        ? "text-muted-foreground/45"
                        : "text-muted-foreground/70",
                ].join(" ")}
              >
                {isComplete && <Check className="w-3 h-3 text-success shrink-0" />}
                {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                {isLocked && <Lock className="w-3 h-3 shrink-0 text-muted-foreground/40" />}
                {label}
              </span>
            );

            return (
              <li key={slug} className="flex items-center">
                {isLocked ? (
                  <span
                    title={
                      mission.blocker
                        ? `Locked — ${mission.blocker}`
                        : "Locked — an earlier stage must pass first"
                    }
                    aria-label={
                      mission.blocker
                        ? `${label}. Locked — ${mission.blocker}`
                        : `${label}. Locked.`
                    }
                    className="cursor-default"
                  >
                    {inner}
                  </span>
                ) : (
                  <Link
                    to={mission.href}
                    title={STAGE_CONFIGS[slug].description}
                    className="hover:text-foreground transition-colors"
                  >
                    {inner}
                  </Link>
                )}
                {i < pathStages.length - 1 && (
                  <span aria-hidden className="text-muted-foreground/25 text-[11px] px-0.5">
                    /
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Mandate footnote — one quiet line, and the only amend affordance. */}
      {engagement && mandate && mandate.granted.length > 0 && (
        <p className="mt-4 text-[12px] text-muted-foreground/80">
          This engagement covers {mandate.granted.length}{" "}
          {mandate.granted.length === 1 ? "outcome" : "outcomes"}.
          {canAmend && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => setScopeDialogOpen(true)}
                className="underline underline-offset-4 hover:text-foreground"
              >
                Amend scope
              </button>
            </>
          )}
        </p>
      )}

      <PreviousEngagementWork views={missionViews} events={events} />
    </div>
  );
}