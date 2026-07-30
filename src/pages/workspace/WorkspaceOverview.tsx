/**
 * WorkspaceOverview — Command surface (editorial grade).
 *
 * One page, one resting place, one directive, one action.
 *   1. Masthead      — client name (display), fiscal year, TIN, updated stamp
 *   2. Directive     — the single sentence + the single button (absorbs coach)
 *   3. Ledger        — 7-row workflow as a numbered ledger, not card grid
 *   4. Files         — collapsed by default, quiet
 *
 * Design law:
 *   - No coloured status pills competing with content. One dot, one word.
 *   - No card grid for stages. A ledger is what accountants read.
 *   - Only ONE button carries visual weight per screen.
 *   - Generous vertical rhythm. Type is the interface.
 */

import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Lock,
  Minus,
  ArrowRight,
  AlertTriangle,
  RefreshCw,
  Upload,
  Info,
  ChevronDown,
} from "lucide-react";
import { STAGE_SEQUENCE, STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { MissionStatus } from "@/lib/workspace/types";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import TrialBalanceProgressLedger from "@/components/workspace/TrialBalanceProgressLedger";

// Single-dot status vocabulary — one word, one colour, no chips.
// The eye should never have to decode a badge to know where a stage stands.
const STATUS_META: Record<
  MissionStatus,
  { label: string; tone: "muted" | "active" | "done" | "warn" | "bad" | "off" }
> = {
  not_started:    { label: "Not started",     tone: "muted"  },
  in_progress:    { label: "In progress",     tone: "active" },
  ready:          { label: "Ready",           tone: "active" },
  passed:         { label: "Passed",          tone: "done"   },
  review_required:{ label: "Review required", tone: "warn"   },
  blocked:        { label: "Blocked",         tone: "bad"    },
  signed:         { label: "Signed off",      tone: "done"   },
  locked:         { label: "Locked",          tone: "off"    },
  not_applicable: { label: "Not applicable",  tone: "off"    },
};

const DOT_TONE: Record<"muted" | "active" | "done" | "warn" | "bad" | "off", string> = {
  muted:  "bg-muted-foreground/40",
  active: "bg-primary",
  done:   "bg-success",
  warn:   "bg-amber-500",
  bad:    "bg-destructive",
  off:    "bg-muted-foreground/20",
};

const TEXT_TONE: Record<"muted" | "active" | "done" | "warn" | "bad" | "off", string> = {
  muted:  "text-muted-foreground",
  active: "text-primary",
  done:   "text-success",
  warn:   "text-amber-600 dark:text-amber-500",
  bad:    "text-destructive",
  off:    "text-muted-foreground/50",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-TZ", {
    day: "numeric", month: "short", year: "numeric"
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Extract a human-readable reason from a blocked/errored upload
function blockedReason(u: {
  status: string;
  validation_report?: Record<string, unknown> | null;
  accounting_errors?: Record<string, unknown> | null;
}): string {
  // Try accounting_errors first (structured engine error)
  if (u.accounting_errors) {
    const errs = u.accounting_errors as Record<string, unknown>;
    if (typeof errs.message === "string") return errs.message;
    if (Array.isArray(errs.errors) && errs.errors.length > 0) {
      return String(errs.errors[0]);
    }
  }
  // Try validation_report
  if (u.validation_report) {
    const vr = u.validation_report as Record<string, unknown>;
    if (typeof vr.error === "string") return vr.error;
    if (typeof vr.message === "string") return vr.message;
    if (Array.isArray(vr.errors) && vr.errors.length > 0) return String(vr.errors[0]);
  }
  return "File could not be processed. Check the format and re-upload.";
}

// ── Component ───────────────────────────────────────────────────────────────
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

  const [uploadsOpen, setUploadsOpen] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Stamp the first time we see an upload so the "updated" line has a value.
  useEffect(() => {
    if (upload?.id && !lastRefreshedAt) setLastRefreshedAt(new Date());
  }, [upload?.id, lastRefreshedAt]);

  const handleRefreshUpload = () => {
    refreshUpload();
    setLastRefreshedAt(new Date());
  };

  // Retry the ingest pipeline when the active upload is Blocked/Failed.
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

      const { error: fnErr } = await supabase.functions.invoke("process-trial-balance", {
        body: { uploadId: upload.id },
      });
      if (fnErr) throw fnErr;

      handleRefreshUpload();
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
      activeUploadStatus === "needs_review" ||
      activeUploadStatus === "pending" ||
      activeUploadStatus === "queued";
    if (!isPolling) return;
    const interval = setInterval(() => handleRefreshUpload(), 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUploadStatus]);

  if (loading) {
    return (
      <div className="space-y-10 max-w-4xl">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  const { nextAction, missions, lastUpdatedAt } = workspaceState;
  const basePath = `/workspace/${companyId}/${periodYear}`;

  const tinMissing =
    !company?.tin ||
    /PUT-REAL|placeholder/i.test(company.tin) ||
    !/^\d+$/.test(company.tin.replace(/-/g, ""));

  const prepareStatus = missions.prepare.status;
  const prepareDone = prepareStatus === "passed" || prepareStatus === "signed";
  const hasUpload = uploads.length > 0;

  const activeIndex = STAGE_SEQUENCE.findIndex((slug) => {
    const s = missions[slug].status;
    return s !== "passed" && s !== "signed" && s !== "locked" && s !== "not_applicable";
  });

  const blockedUploadsCount = uploads.filter(
    (u) => u.status === "blocked" || u.status === "error"
  ).length;

  // ── Directive: the ONE sentence + ONE button on this screen ────────────
  // Absorbs first-run coach, next-action, and retry-on-failure into a single
  // resting place. The user never has to choose between two primary CTAs.
  type Directive = {
    eyebrow: string;
    headline: string;
    hint?: string;
    button: { label: string; href?: string; onClick?: () => void; icon: React.ReactNode; disabled?: boolean };
    tone: "primary" | "warn" | "muted";
  };

  let directive: Directive;

  if (!prepareDone && !hasUpload) {
    directive = {
      eyebrow: "Start here",
      headline: "Upload the trial balance to begin.",
      hint: "Validated against Tanzania chart of accounts and ITA Cap.332 before anything else runs.",
      button: {
        label: "Upload trial balance",
        href: `${basePath}/prepare`,
        icon: <Upload className="w-4 h-4" />,
      },
      tone: "primary",
    };
  } else if (!prepareDone && hasUpload) {
    const s = upload?.status;
    const isFailed = s === "blocked" || s === "error";
    const isProcessing = s === "processing" || s === "needs_review" || s === "pending" || s === "queued";
    if (isFailed) {
      directive = {
        eyebrow: "Action required",
        headline: "The trial balance could not be processed.",
        hint: "Re-run processing, or upload a corrected file.",
        button: {
          label: retrying ? "Retrying…" : "Retry processing",
          onClick: handleRetryProcessing,
          disabled: retrying,
          icon: <RefreshCw className={`w-4 h-4 ${retrying ? "animate-spin" : ""}`} />,
        },
        tone: "warn",
      };
    } else if (isProcessing) {
      directive = {
        eyebrow: "In progress",
        headline: "Trial balance is processing.",
        hint: "Status updates automatically. You can open Prepare Data to watch validation as it runs.",
        button: {
          label: "Open Prepare Data",
          href: `${basePath}/prepare`,
          icon: <ArrowRight className="w-4 h-4" />,
        },
        tone: "muted",
      };
    } else {
      directive = {
        eyebrow: "Continue",
        headline: "Finish validating the trial balance.",
        hint: "Reconcile, statements, tax, filing and monitoring unlock as each stage passes.",
        button: {
          label: "Continue trial balance",
          href: `${basePath}/prepare`,
          icon: <ArrowRight className="w-4 h-4" />,
        },
        tone: "primary",
      };
    }
  } else {
    // Prepare is done — hand off to the workspaceState's next action.
    directive = {
      eyebrow: "Next",
      headline: nextAction.description,
      hint: nextAction.blocker ?? undefined,
      button: {
        label: nextAction.label,
        href: nextAction.href,
        disabled: nextAction.blocked,
        icon: <ArrowRight className="w-4 h-4" />,
      },
      tone: nextAction.blocked ? "muted" : "primary",
    };
  }

  return (
    <div className="max-w-4xl">

      {/* ── 1. Masthead ─────────────────────────────────────────────────── */}
      <header className="pb-8 mb-10 border-b border-border">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold text-muted-foreground tracking-[0.22em] uppercase mb-3">
              Engagement · FY{periodYear > 2000 ? periodYear : "—"}
            </p>
            <h1 className="text-3xl md:text-[2.25rem] font-semibold tracking-tight text-foreground leading-[1.15]">
              {company?.name ?? "—"}
            </h1>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-4 text-[13px] text-muted-foreground">
              <span className="tabular-nums">
                Year ended {periodYear > 2000 ? `30 June ${periodYear}` : "—"}
              </span>
              {tinMissing ? (
                <Link
                  to="/settings"
                  className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-500 hover:underline underline-offset-4"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  TIN not set
                </Link>
              ) : (
                <span className="font-mono text-[12px]">TIN {company!.tin}</span>
              )}
              {lastUpdatedAt && (
                <span className="tabular-nums">Updated {formatRelative(lastUpdatedAt)}</span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={handleRefreshUpload}
            className="shrink-0 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors mt-1"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </header>

      {/* ── 2. Directive — the single resting place ─────────────────────── */}
      <section className="mb-14">
        <p className={[
          "text-[10px] font-semibold tracking-[0.22em] uppercase mb-4",
          directive.tone === "warn" ? "text-destructive" :
          directive.tone === "muted" ? "text-muted-foreground" :
          "text-primary",
        ].join(" ")}>
          {directive.eyebrow}
        </p>
        <h2 className="text-2xl md:text-[1.75rem] font-semibold tracking-tight text-foreground leading-[1.25] max-w-2xl">
          {directive.headline}
        </h2>
        {directive.hint && (
          <p className="mt-3 text-[14px] text-muted-foreground leading-relaxed max-w-2xl">
            {directive.hint}
          </p>
        )}

        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
          {directive.button.href ? (
            <Button
              asChild={!directive.button.disabled}
              disabled={directive.button.disabled}
              size="lg"
              variant={directive.tone === "muted" ? "outline" : "default"}
              className="h-12 px-6 text-[14px] font-semibold rounded-none shadow-none"
            >
              {directive.button.disabled ? (
                <span>
                  {directive.button.icon}
                  <span className="mx-2">{directive.button.label}</span>
                </span>
              ) : (
                <Link to={directive.button.href}>
                  {directive.button.icon}
                  <span className="mx-2">{directive.button.label}</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>
              )}
            </Button>
          ) : (
            <Button
              onClick={directive.button.onClick}
              disabled={directive.button.disabled}
              size="lg"
              variant={directive.tone === "warn" ? "destructive" : "default"}
              className="h-12 px-6 text-[14px] font-semibold rounded-none shadow-none"
            >
              {directive.button.icon}
              <span className="mx-2">{directive.button.label}</span>
            </Button>
          )}

          {/* Secondary: only when trial balance status is worth showing */}
          {upload && !prepareDone && (() => {
            const s = upload.status;
            const tone: "muted" | "active" | "done" | "warn" | "bad" | "off" =
              s === "complete" || s === "valid" ? "done" :
              s === "blocked" || s === "error" ? "bad" :
              s === "processing" || s === "needs_review" || s === "pending" || s === "queued" ? "active" :
              "muted";
            const label =
              s === "complete" || s === "valid" ? "Trial balance ready" :
              s === "blocked" ? "Trial balance blocked" :
              s === "error" ? "Trial balance failed" :
              s === "processing" ? "Trial balance processing" :
              s === "needs_review" ? "Trial balance needs review" :
              `Trial balance ${s}`;
            return (
              <span className="inline-flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className={`w-1.5 h-1.5 rounded-full ${DOT_TONE[tone]}`} />
                <span className={TEXT_TONE[tone]}>{label}</span>
                {lastRefreshedAt && (
                  <span className="text-muted-foreground/60 tabular-nums">· {formatRelative(lastRefreshedAt.toISOString())}</span>
                )}
              </span>
            );
          })()}
        </div>
      </section>

      {/* ── 3. Workflow ledger — 7 rows, numbered, no cards ─────────────── */}
      {/* ── 2b. Live trial balance ingestion ledger ─────────────────────── */}
      {upload && !prepareDone && (
        <TrialBalanceProgressLedger upload={upload} lastRefreshedAt={lastRefreshedAt} />
      )}

      <section className="mb-14">
        <div className="flex items-baseline justify-between mb-5">
          <p className="text-[10px] font-semibold text-muted-foreground tracking-[0.22em] uppercase">
            Workflow
          </p>
          <p className="text-[11px] text-muted-foreground/70 tabular-nums tracking-wide">
            {activeIndex >= 0 ? `Step ${activeIndex + 1} of ${STAGE_SEQUENCE.length}` : "All stages complete"}
          </p>
        </div>

        <ol className="border-t border-border">
          {STAGE_SEQUENCE.map((slug, i) => {
            const config  = STAGE_CONFIGS[slug];
            const mission = missions[slug];
            const meta    = STATUS_META[mission.status];
            const Icon    = config.icon;

            const isLocked   = mission.status === "locked" || mission.status === "not_applicable";
            const isActive   = i === activeIndex;
            const isComplete = mission.status === "passed" || mission.status === "signed";
            const canOpen    = !isLocked;

            const rowInner = (
              <div className={[
                "group grid grid-cols-[3.5rem_1.5rem_1fr_auto_1.5rem] items-center gap-4 py-4 border-b border-border transition-colors",
                canOpen ? "hover:bg-secondary/30 cursor-pointer" : "cursor-default",
                isActive ? "bg-primary/[0.03]" : "",
              ].join(" ")}>
                <span className={[
                  "text-[11px] font-mono tabular-nums pl-1",
                  isActive ? "text-primary font-semibold" : isComplete ? "text-success" : "text-muted-foreground/60",
                ].join(" ")}>
                  {String(i + 1).padStart(2, "0")}
                </span>

                <Icon className={[
                  "w-4 h-4",
                  isActive ? "text-primary" : isComplete ? "text-success" : isLocked ? "text-muted-foreground/30" : "text-muted-foreground",
                ].join(" ")} />

                <div className="min-w-0">
                  <p className={[
                    "text-[15px] font-medium leading-tight tracking-tight",
                    isLocked ? "text-muted-foreground" : "text-foreground",
                  ].join(" ")}>
                    {mission.label}
                  </p>
                  {isLocked && mission.blocker && (
                    <p className="mt-1 text-[12px] text-muted-foreground/70 leading-snug truncate">
                      {mission.blocker}
                    </p>
                  )}
                </div>

                <span className={`inline-flex items-center gap-2 text-[12px] ${TEXT_TONE[meta.tone]}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${DOT_TONE[meta.tone]}`} />
                  <span className="whitespace-nowrap">{meta.label}</span>
                </span>

                {canOpen ? (
                  <ArrowRight className={[
                    "w-4 h-4 transition-transform",
                    isActive ? "text-primary" : "text-muted-foreground/40 group-hover:text-foreground group-hover:translate-x-0.5",
                  ].join(" ")} />
                ) : (
                  <Lock className="w-3.5 h-3.5 text-muted-foreground/30" />
                )}
              </div>
            );

            return (
              <li key={slug}>
                {canOpen ? (
                  <Link to={mission.href} className="block">
                    {rowInner}
                  </Link>
                ) : (
                  <div title={mission.blocker ?? "Not available"}>{rowInner}</div>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {/* ── 4. Files — quiet, collapsed, secondary ──────────────────────── */}
      {uploads.length > 0 && (
        <section className="pt-2">
          <button
            type="button"
            onClick={() => setUploadsOpen((v) => !v)}
            className="w-full flex items-center justify-between text-left group py-2"
          >
            <div className="flex items-center gap-4">
              <p className="text-[10px] font-semibold text-muted-foreground tracking-[0.22em] uppercase">
                Files
              </p>
              <span className="text-[12px] text-muted-foreground/70 tabular-nums">
                {uploads.length}
              </span>
              {blockedUploadsCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-destructive">
                  <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
                  {blockedUploadsCount} blocked
                </span>
              )}
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${uploadsOpen ? "rotate-180" : ""}`} />
          </button>

          {uploadsOpen && (
            <ol className="mt-2 border-t border-border">
              {uploads.slice(0, 5).map((u) => {
                const isActive  = u.id === upload?.id;
                const isBlocked = u.status === "blocked" || u.status === "error";
                const reason    = isBlocked ? blockedReason(u as Parameters<typeof blockedReason>[0]) : null;
                const statusLabel =
                  u.status === "complete" ? "Complete" :
                  u.status === "valid" ? "Valid" :
                  u.status === "blocked" ? "Blocked" :
                  u.status === "error" ? "Failed" :
                  u.status === "processing" ? "Processing" : u.status;
                const tone: "muted" | "active" | "done" | "warn" | "bad" | "off" =
                  u.status === "complete" || u.status === "valid" ? "done" :
                  isBlocked ? "bad" :
                  u.status === "processing" ? "active" : "muted";

                return (
                  <li key={u.id} className="border-b border-border">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-6 py-3">
                      <p className={[
                        "text-[13px] font-mono truncate",
                        isActive ? "text-foreground" : "text-muted-foreground",
                      ].join(" ")}>
                        {isActive && <span className="text-primary font-sans text-[10px] font-semibold tracking-wider uppercase mr-2">Active</span>}
                        {u.file_name}
                      </p>
                      <span className="text-[12px] text-muted-foreground/70 tabular-nums">
                        {formatFileSize(u.file_size)}
                      </span>
                      <span className={`inline-flex items-center gap-2 text-[12px] ${TEXT_TONE[tone]}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${DOT_TONE[tone]}`} />
                        {statusLabel}
                      </span>
                      <span className="text-[12px] text-muted-foreground/60 tabular-nums whitespace-nowrap">
                        {formatRelative(u.uploaded_at)}
                      </span>
                    </div>
                    {isBlocked && reason && (
                      <div className="pb-3 flex items-start justify-between gap-6">
                        <p className="text-[12px] text-destructive/90 flex items-start gap-2 leading-relaxed">
                          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                          {reason}
                        </p>
                        <button
                          type="button"
                          onClick={() => navigate(`${basePath}/prepare`)}
                          className="text-[12px] font-medium text-destructive hover:underline underline-offset-4 whitespace-nowrap"
                        >
                          Re-upload →
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {uploadsOpen && uploads.length > 5 && (
            <Link
              to={`${basePath}/prepare`}
              className="mt-3 inline-block text-[12px] text-muted-foreground hover:text-foreground"
            >
              View all {uploads.length} files →
            </Link>
          )}
        </section>
      )}
    </div>
  );
}
