/**
 * WorkspaceOverview — Command center.
 *
 * Renders exactly:
 *   1. Client header  — company name, fiscal year, TIN (no "ENGAGEMENT" label)
 *   2. Next action    — ONE primary CTA with human-readable description
 *   3. Mission table  — 7 rows, one consistent layout: icon | label + status line | badge | action
 *   4. Recent uploads — active upload highlighted; BLOCKED rows show reason + re-upload button
 *
 * Design rules enforced here:
 *   - No jargon labels ("ENGAGEMENT", "MISSION STATUS")
 *   - Status badge always has text — never "— —"
 *   - Locked stages show why they are locked (blocker text)
 *   - BLOCKED upload shows the specific validation failure, not just the word "BLOCKED"
 *   - One dominant action button per screen
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
  ChevronRight,
  AlertTriangle,
  Calendar,
  RefreshCw,
  Upload,
  Info,
  Sparkles,
  X,
  ChevronDown,
} from "lucide-react";
import { STAGE_SEQUENCE, STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { MissionStatus } from "@/lib/workspace/types";

const COACH_STORAGE_KEY = "saff-workspace-coach-dismissed";

// ── Status badge metadata ────────────────────────────────────────────────────
//
// Every status has a human-readable label, a colour class, and an icon.
// Nothing is ever just "—" or blank — the user always knows what state they are in.

const STATUS_META: Record<
  MissionStatus,
  { label: string; className: string; icon: React.ReactNode }
> = {
  not_started:    { label: "Not started",      className: "text-muted-foreground",           icon: <Minus className="w-3.5 h-3.5" /> },
  in_progress:    { label: "In progress",      className: "text-primary",                    icon: <Clock className="w-3.5 h-3.5 animate-pulse" /> },
  ready:          { label: "Ready",            className: "text-primary font-semibold",      icon: <ChevronRight className="w-3.5 h-3.5" /> },
  passed:         { label: "Passed",           className: "text-accent",                     icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
  review_required:{ label: "Review required",  className: "text-amber-600 dark:text-amber-400", icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  blocked:        { label: "Blocked",          className: "text-destructive",                icon: <XCircle className="w-3.5 h-3.5" /> },
  signed:         { label: "Signed off",       className: "text-accent",                     icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
  locked:         { label: "Locked",           className: "text-muted-foreground/50",        icon: <Lock className="w-3 h-3" /> },
  not_applicable: { label: "Not applicable",   className: "text-muted-foreground/40",        icon: <Minus className="w-3 h-3" /> },
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

  // ── First-run coach layer state (persisted) ───────────────────────────────
  const [coachDismissed, setCoachDismissed] = useState(true);
  const [uploadsOpen, setUploadsOpen] = useState(false);

  useEffect(() => {
    try {
      setCoachDismissed(localStorage.getItem(COACH_STORAGE_KEY) === "1");
    } catch {
      /* localStorage unavailable — leave coach hidden */
    }
  }, []);

  // Auto-refresh: while the active Trial Balance upload is still processing,
  // poll every 4s so the status badge (Processing → Ready/Blocked/Failed)
  // updates in real time without requiring the user to click Refresh.
  const activeUploadStatus = upload?.status;
  useEffect(() => {
    if (!activeUploadStatus) return;
    const isPolling =
      activeUploadStatus === "processing" ||
      activeUploadStatus === "needs_review" ||
      activeUploadStatus === "pending" ||
      activeUploadStatus === "queued";
    if (!isPolling) return;
    const interval = setInterval(() => {
      refreshUpload();
    }, 4000);
    return () => clearInterval(interval);
  }, [activeUploadStatus, refreshUpload]);

  const dismissCoach = () => {
    setCoachDismissed(true);
    try { localStorage.setItem(COACH_STORAGE_KEY, "1"); } catch { /* noop */ }
  };

  if (loading) {
    return (
      <div className="space-y-8 max-w-5xl">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { nextAction, missions, lastUpdatedAt } = workspaceState;
  const basePath = `/workspace/${companyId}/${periodYear}`;

  // TIN validity guard — a real TAN TIN is all-numeric
  const tinMissing =
    !company?.tin ||
    /PUT-REAL|placeholder/i.test(company.tin) ||
    !/^\d+$/.test(company.tin.replace(/-/g, ""));

  // Show coach until Prepare has passed — covers both "no upload yet" and
  // "upload exists but validation not yet cleared" first-run states.
  const prepareStatus = missions.prepare.status;
  const prepareDone = prepareStatus === "passed" || prepareStatus === "signed";
  const hasUpload = uploads.length > 0;
  const isFirstRun = !prepareDone;
  const showCoach = isFirstRun && !coachDismissed;

  // Determine active stage index (first non-passed, non-locked, non-NA stage)
  const activeIndex = STAGE_SEQUENCE.findIndex((slug) => {
    const s = missions[slug].status;
    return s !== "passed" && s !== "signed" && s !== "locked" && s !== "not_applicable";
  });

  const blockedUploadsCount = uploads.filter(
    (u) => u.status === "blocked" || u.status === "error"
  ).length;

  return (
    <div className="space-y-8 max-w-5xl">

      {/* ── 1. Client identity strip ────────────────────────────────────── */}
      <div className="flex items-start justify-between pb-6 border-b border-border">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground leading-tight">
            {company?.name ?? "—"}
          </h1>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Calendar className="w-3.5 h-3.5 shrink-0" />
              <span className="tabular-nums">
                Year ended {periodYear > 2000 ? `30 Jun ${periodYear}` : "—"}
              </span>
            </div>

            {tinMissing ? (
              <Link
                to="/settings"
                className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 underline underline-offset-2"
              >
                <AlertTriangle className="w-3 h-3" />
                TIN not set — add it in Settings
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                TIN: {company!.tin}
              </span>
            )}

            {lastUpdatedAt && (
              <span className="text-xs text-muted-foreground">
                Updated {formatRelative(lastUpdatedAt)}
              </span>
            )}
          </div>
        </div>

        <Button variant="ghost" size="sm" onClick={refreshUpload} title="Refresh" className="shrink-0 ml-4">
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* ── 2. First-run coach layer ────────────────────────────────────── */}
      {showCoach && (
        <div className="relative rounded-md border border-primary/25 bg-primary/[0.04] p-6">
          <button
            type="button"
            onClick={dismissCoach}
            className="absolute top-3 right-3 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
            aria-label="Dismiss guide"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-start gap-4 pr-8">
            <div className="shrink-0 rounded-md bg-primary p-2 text-primary-foreground">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-foreground">
                  {hasUpload ? "Continue where you left off." : "Welcome — start here."}
                </p>
                {hasUpload && upload && (() => {
                  const s = upload.status;
                  const isReady = s === "complete" || s === "valid";
                  const isFailed = s === "blocked" || s === "error";
                  const isProcessing = s === "processing" || s === "needs_review";
                  const badge = isReady
                    ? { label: "Ready", cls: "text-accent bg-accent/10 border-accent/30", icon: <CheckCircle2 className="w-3 h-3" /> }
                    : isFailed
                    ? { label: s === "blocked" ? "Blocked" : "Failed", cls: "text-destructive bg-destructive/10 border-destructive/30", icon: <XCircle className="w-3 h-3" /> }
                    : isProcessing
                    ? { label: "Processing", cls: "text-primary bg-primary/10 border-primary/30", icon: <Clock className="w-3 h-3 animate-pulse" /> }
                    : { label: String(s), cls: "text-muted-foreground bg-muted border-border", icon: <Minus className="w-3 h-3" /> };
                  return (
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${badge.cls}`}
                      title={`Trial Balance status: ${badge.label}`}
                    >
                      {badge.icon}
                      Trial Balance · {badge.label}
                    </span>
                  );
                })()}
              </div>
              <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                {hasUpload ? (
                  <>
                    A <strong className="text-foreground">Trial Balance</strong> is already uploaded for FY{periodYear}. Continue to finish validation — Reconcile, statements, tax, filing and monitoring unlock as each stage passes.
                  </>
                ) : (
                  <>
                    Upload your <strong className="text-foreground">Trial Balance</strong> to validate it. Reconcile, statements, tax, filing and monitoring unlock automatically as each stage passes.
                  </>
                )}
              </p>
              <div className="mt-4">
                <Button
                  onClick={() => navigate(`${basePath}/prepare`)}
                  size="lg"
                  className="h-11 px-5 text-sm font-semibold shadow-sm"
                >
                  {hasUpload ? (
                    <ArrowRight className="w-4 h-4 mr-2" />
                  ) : (
                    <Upload className="w-4 h-4 mr-2" />
                  )}
                  {hasUpload ? "Continue Trial Balance" : "Upload Trial Balance"}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  Validates against Tanzania chart of accounts and ITA Cap.332 before anything else runs.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 3. Hero action — one dominant CTA (suppressed during first-run coach) ── */}
      {!showCoach && (
      <div className="rounded-md border border-border bg-card p-8">
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.18em] uppercase">
          Next step
        </p>
        <div className="mt-3 flex flex-col md:flex-row md:items-end md:justify-between gap-6">
          <div className="min-w-0 md:max-w-2xl">
            <p className="text-xl md:text-2xl font-semibold text-foreground leading-snug tracking-tight">
              {nextAction.description}
            </p>
            {nextAction.blocker && (
              <p className="mt-2 text-sm text-muted-foreground flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 shrink-0" />
                {nextAction.blocker}
              </p>
            )}
          </div>
          <Button
            onClick={() => navigate(nextAction.href)}
            disabled={nextAction.blocked}
            size="lg"
            variant={nextAction.blocked ? "outline" : "default"}
            className="shrink-0 whitespace-nowrap h-12 px-6 text-base font-semibold shadow-sm"
          >
            {nextAction.label}
            {!nextAction.blocked && <ArrowRight className="w-4 h-4 ml-2" />}
          </Button>
        </div>
      </div>
      )}

      {/* ── 4. Linear stage rail — 7 canonical stages ───────────────────── */}
      <div>
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.18em] uppercase">
            Workflow
          </p>
          <p className="text-[11px] text-muted-foreground/70 tracking-wide">
            {activeIndex >= 0 ? `Step ${activeIndex + 1} of ${STAGE_SEQUENCE.length}` : "All stages complete"}
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
          {STAGE_SEQUENCE.map((slug, i) => {
            const config  = STAGE_CONFIGS[slug];
            const mission = missions[slug];
            const meta    = STATUS_META[mission.status];
            const Icon    = config.icon;

            const isLocked   = mission.status === "locked" || mission.status === "not_applicable";
            const isActive   = i === activeIndex;
            const isComplete = mission.status === "passed" || mission.status === "signed";
            const canOpen    = !isLocked;

            const stageContent = (
              <div
                className={[
                  "h-full rounded-md border p-3 flex flex-col gap-2 transition-all",
                  isActive
                    ? "border-primary bg-primary/[0.06] shadow-sm"
                    : isComplete
                    ? "border-accent/40 bg-accent/[0.04]"
                    : isLocked
                    ? "border-border bg-muted/20 opacity-60"
                    : "border-border bg-card hover:border-primary/40 hover:bg-secondary/20",
                ].join(" ")}
              >
                <div className="flex items-center justify-between">
                  <span className={[
                    "text-[10px] font-bold tracking-[0.15em] uppercase",
                    isActive ? "text-primary" : "text-muted-foreground/60",
                  ].join(" ")}>
                    Step {String(i + 1).padStart(2, "0")}
                  </span>
                  <Icon className={[
                    "w-3.5 h-3.5 shrink-0",
                    isActive ? "text-primary" : isComplete ? "text-accent" : "text-muted-foreground/50",
                  ].join(" ")} />
                </div>
                <p className={[
                  "text-sm font-semibold leading-tight",
                  isLocked ? "text-muted-foreground" : "text-foreground",
                ].join(" ")}>
                  {mission.label}
                </p>
                <div className={`mt-auto flex items-center gap-1 text-[11px] font-medium ${meta.className}`}>
                  {meta.icon}
                  <span className="truncate">{meta.label}</span>
                </div>
              </div>
            );

            return canOpen ? (
              <Link key={slug} to={mission.href} className="block">
                {stageContent}
              </Link>
            ) : (
              <div key={slug} title={mission.blocker ?? "Not available"}>{stageContent}</div>
            );
          })}
        </div>
      </div>

      {/* ── 5. Recent uploads (secondary, collapsible) ──────────────────── */}
      {uploads.length > 0 && (
        <div className="border-t border-border pt-6">
          <button
            type="button"
            onClick={() => setUploadsOpen((v) => !v)}
            className="w-full flex items-center justify-between text-left group"
          >
            <div className="flex items-center gap-3">
              <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.18em] uppercase">
                Recent uploads
              </p>
              <span className="text-xs text-muted-foreground/70">
                {uploads.length} file{uploads.length === 1 ? "" : "s"}
              </span>
              {blockedUploadsCount > 0 && (
                <span className="text-[10px] font-semibold text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                  {blockedUploadsCount} blocked
                </span>
              )}
            </div>
            <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${uploadsOpen ? "rotate-180" : ""}`} />
          </button>

          {uploadsOpen && (
          <div className="mt-3 border border-border rounded-md divide-y divide-border">
            {uploads.slice(0, 5).map((u) => {
              const isActive  = u.id === upload?.id;
              const isBlocked = u.status === "blocked" || u.status === "error";
              const reason    = isBlocked ? blockedReason(u as Parameters<typeof blockedReason>[0]) : null;

              return (
                <div
                  key={u.id}
                  className={[
                    "px-5 py-3 transition-colors",
                    isActive  ? "bg-secondary/30 border-l-2 border-l-primary" : "hover:bg-secondary/10",
                    isBlocked ? "border-l-2 border-l-destructive" : "",
                  ].join(" ")}
                >
                  {/* Row 1: filename + meta */}
                  <div className="flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <p className={[
                        "text-sm font-mono truncate",
                        isActive ? "text-foreground font-semibold" : "text-muted-foreground",
                      ].join(" ")}>
                        {isActive && (
                          <span className="text-primary font-sans font-medium text-xs mr-2">
                            ACTIVE ·
                          </span>
                        )}
                        {u.file_name}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-xs tabular-nums">
                      <span className="text-muted-foreground">{formatFileSize(u.file_size)}</span>
                      <span
                        className={[
                          "font-medium",
                          u.status === "complete" || u.status === "valid"
                            ? "text-accent"
                            : isBlocked
                            ? "text-destructive"
                            : "text-muted-foreground",
                        ].join(" ")}
                      >
                        {u.status === "complete" ? "Complete"
                          : u.status === "valid" ? "Valid"
                          : u.status === "blocked" ? "Blocked"
                          : u.status === "error" ? "Failed"
                          : u.status === "processing" ? "Processing…"
                          : u.status}
                      </span>
                      <span className="text-muted-foreground">{formatRelative(u.uploaded_at)}</span>
                    </div>
                  </div>

                  {/* Row 2: BLOCKED reason + resolution (only for failed uploads) */}
                  {isBlocked && reason && (
                    <div className="mt-2 flex items-start justify-between gap-4">
                      <p className="text-xs text-destructive flex items-start gap-1.5 leading-relaxed">
                        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        {reason}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs shrink-0 h-7 px-2 border-destructive/30 text-destructive hover:bg-destructive/5"
                        onClick={() => navigate(`${basePath}/prepare`)}
                      >
                        <Upload className="w-3 h-3 mr-1" />
                        Re-upload
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}

          {uploadsOpen && uploads.length > 5 && (
            <Link
              to={`${basePath}/prepare`}
              className="block text-xs text-muted-foreground hover:text-foreground pt-2 text-right"
            >
              View all {uploads.length} uploads →
            </Link>
          )}
        </div>
      )}

    </div>
  );
}
