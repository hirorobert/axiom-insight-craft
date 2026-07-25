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
} from "lucide-react";
import { STAGE_SEQUENCE, STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { MissionStatus } from "@/lib/workspace/types";

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

  return (
    <div className="space-y-10 max-w-5xl">

      {/* ── 1. Client header ────────────────────────────────────────────── */}
      <div className="flex items-start justify-between pb-6 border-b border-border">
        <div className="min-w-0">
          {/* Company name — no "ENGAGEMENT" label, no section header */}
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

            {/* TIN — show real value or a clear action prompt */}
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

      {/* ── 2. Next required action ─────────────────────────────────────── */}
      {/*
       *  ONE card. ONE button. No repeated heading text.
       *  The heading describes the situation; the button names the action.
       */}
      <div className="border border-border p-6 space-y-3">
        <p className="text-xs font-semibold text-muted-foreground tracking-widest uppercase">
          Next step
        </p>
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-base font-semibold text-foreground leading-snug">
              {nextAction.description}
            </p>
            {nextAction.blocker && (
              <p className="mt-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
                <Lock className="w-3 h-3 shrink-0" />
                {nextAction.blocker}
              </p>
            )}
          </div>
          <Button
            onClick={() => navigate(nextAction.href)}
            disabled={nextAction.blocked}
            variant={nextAction.blocked ? "outline" : "default"}
            className="shrink-0 whitespace-nowrap"
          >
            {nextAction.label}
            {!nextAction.blocked && <ArrowRight className="w-4 h-4 ml-2" />}
          </Button>
        </div>
      </div>

      {/* ── 3. Stage progress table ─────────────────────────────────────── */}
      {/*
       *  One consistent row layout for all 7 stages:
       *    [icon] [label + status subtitle]          [badge]  [action]
       *
       *  Status subtitle is always present — locked rows explain the blocker,
       *  not_started rows say "not yet started", etc.
       *  No row ever shows blank status or "— —".
       */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground tracking-widest uppercase mb-3">
          Workflow progress
        </p>
        <div className="border border-border divide-y divide-border">
          {STAGE_SEQUENCE.map((slug) => {
            const config  = STAGE_CONFIGS[slug];
            const mission = missions[slug];
            const meta    = STATUS_META[mission.status];
            const Icon    = config.icon;

            const isLocked = mission.status === "locked" || mission.status === "not_applicable";
            const canOpen  = !isLocked;

            // Subtitle: prefer blocker message for locked/blocked, else summary
            const subtitle = mission.status === "locked"
              ? (mission.blocker ?? "Complete earlier stages first")
              : mission.status === "not_applicable"
              ? "Not required for this engagement"
              : mission.status === "not_started"
              ? config.description
              : (mission.summary ?? config.description);

            return (
              <div
                key={slug}
                className={[
                  "flex items-center gap-4 px-5 py-4 transition-colors",
                  canOpen ? "hover:bg-secondary/30" : "opacity-60",
                ].join(" ")}
              >
                {/* Stage icon */}
                <div className="text-muted-foreground shrink-0">
                  <Icon className="w-4 h-4" />
                </div>

                {/* Label + subtitle */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {mission.label}
                  </p>
                  <p className={[
                    "text-xs mt-0.5 leading-relaxed",
                    mission.status === "blocked" ? "text-destructive/80" : "text-muted-foreground",
                  ].join(" ")}>
                    {subtitle}
                  </p>
                </div>

                {/* Status badge — always has text, never blank */}
                <div className={`flex items-center gap-1.5 text-xs font-medium tabular-nums shrink-0 ${meta.className}`}>
                  {meta.icon}
                  <span className="hidden sm:inline">{meta.label}</span>
                </div>

                {/* Action — Open for available stages, nothing for locked/NA */}
                <div className="shrink-0 w-14 sm:w-16 text-right">
                  {canOpen ? (
                    <Link
                      to={mission.href}
                      className="text-xs text-primary hover:text-primary/80 flex items-center justify-end gap-0.5"
                    >
                      Open
                      <ChevronRight className="w-3 h-3" />
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground/30 select-none">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 4. Recent uploads ───────────────────────────────────────────── */}
      {/*
       *  Active upload is highlighted with a border.
       *  BLOCKED rows show the specific reason (not just the word "BLOCKED")
       *  and a "Re-upload" button so the user knows exactly what to do.
       */}
      {uploads.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground tracking-widest uppercase mb-3">
            Trial balance uploads
          </p>
          <div className="border border-border divide-y divide-border">
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

          {uploads.length > 5 && (
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
