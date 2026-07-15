/**
 * WorkspaceOverview — Command center.
 *
 * Renders exactly:
 *   1. Context header — company, period, last-updated
 *   2. Next action   — ONE primary button, always present
 *   3. Mission table — 6 rows with status + Open link
 *   4. Recent activity — last 5 uploads
 *
 * Zero engine panels. Zero stacked cards. One screen = one mission.
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
  Building2,
  Calendar,
  RefreshCw,
} from "lucide-react";
import { STAGE_SEQUENCE, STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { MissionStatus } from "@/lib/workspace/types";

// ── Status rendering ────────────────────────────────────────────────────────

const STATUS_META: Record<
  MissionStatus,
  { label: string; className: string; icon: React.ReactNode }
> = {
  not_started:    { label: "NOT STARTED",      className: "text-muted-foreground",         icon: <Minus className="w-4 h-4" /> },
  in_progress:    { label: "IN PROGRESS",      className: "text-primary",                  icon: <Clock className="w-4 h-4 animate-pulse" /> },
  ready:          { label: "READY",            className: "text-primary font-semibold",    icon: <ChevronRight className="w-4 h-4" /> },
  passed:         { label: "PASSED",           className: "text-accent",                   icon: <CheckCircle2 className="w-4 h-4" /> },
  review_required:{ label: "REVIEW REQUIRED",  className: "text-destructive",              icon: <AlertTriangle className="w-4 h-4" /> },
  blocked:        { label: "BLOCKED",          className: "text-destructive",              icon: <XCircle className="w-4 h-4" /> },
  signed:         { label: "SIGNED",           className: "text-accent",                   icon: <CheckCircle2 className="w-4 h-4" /> },
  locked:         { label: "LOCKED",           className: "text-muted-foreground/50",      icon: <Lock className="w-3.5 h-3.5" /> },
  not_applicable: { label: "—",               className: "text-muted-foreground/50",      icon: <Minus className="w-3 h-3" /> },
};

// Icons are sized up (w-4) relative to the tab icons (w-3.5) for the overview table
const OVERVIEW_ICON_CLASS = "w-4 h-4";

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(dateStr).toLocaleDateString("en-TZ", { month: "short", day: "numeric" });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function WorkspaceOverview() {
  const { company, upload, uploads, workspaceState, loading, periodYear, companyId, refreshUpload } =
    useWorkspace();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { nextAction, missions, lastUpdatedAt } = workspaceState;
  const basePath = `/workspace/${companyId}/${periodYear}`;

  return (
    <div className="space-y-10 max-w-5xl">
      {/* ── 1. Context header ───────────────────────────────────────────── */}
      <div className="flex items-start justify-between border-b border-border pb-6">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <Building2 className="w-3.5 h-3.5" />
            <span>ENGAGEMENT</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {company?.name ?? "—"}
          </h1>
          <div className="flex items-center gap-4 mt-1">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Calendar className="w-3.5 h-3.5" />
              <span className="tabular-nums">FY{periodYear}</span>
            </div>
            {company?.tin && (
              <span className="text-xs text-muted-foreground font-mono">
                TIN: {company.tin}
              </span>
            )}
            {lastUpdatedAt && (
              <span className="text-xs text-muted-foreground">
                Last updated {formatRelative(lastUpdatedAt)}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={refreshUpload}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* ── 2. Next required action ─────────────────────────────────────── */}
      <div className="border border-border p-6">
        <p className="text-xs font-semibold text-muted-foreground tracking-widest mb-3">
          NEXT REQUIRED ACTION
        </p>
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-base font-semibold text-foreground mb-1">
              {nextAction.label}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
              {nextAction.description}
            </p>
            {nextAction.blocker && (
              <p className="mt-2 text-xs text-destructive flex items-center gap-1.5">
                <Lock className="w-3 h-3" />
                {nextAction.blocker}
              </p>
            )}
          </div>
          <Button
            onClick={() => navigate(nextAction.href)}
            disabled={nextAction.blocked}
            variant={nextAction.blocked ? "outline" : "default"}
            className="shrink-0"
          >
            {nextAction.label}
            {!nextAction.blocked && <ArrowRight className="w-4 h-4 ml-2" />}
          </Button>
        </div>
      </div>

      {/* ── 3. Mission status table ─────────────────────────────────────── */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground tracking-widest mb-3">
          MISSION STATUS
        </p>
        <div className="border border-border divide-y divide-border">
          {STAGE_SEQUENCE.map((slug) => {
            const config = STAGE_CONFIGS[slug];
            const mission = missions[slug];
            const meta = STATUS_META[mission.status];
            const Icon = config.icon;
            const isLocked = mission.status === "locked";
            const isNA = mission.status === "not_applicable";
            const canOpen = !isLocked;

            return (
              <div
                key={slug}
                className="flex items-center gap-4 px-5 py-4 hover:bg-secondary/30 transition-colors"
              >
                {/* Icon */}
                <div className={`text-muted-foreground shrink-0 ${OVERVIEW_ICON_CLASS}`}>
                  <Icon className="w-4 h-4" />
                </div>

                {/* Label + summary */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {mission.label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {mission.blocker ? (
                      <span className="text-destructive/70">{mission.blocker}</span>
                    ) : (
                      mission.summary
                    )}
                  </p>
                </div>

                {/* Status */}
                <div className={`flex items-center gap-1.5 text-xs font-medium tabular-nums shrink-0 ${meta.className}`}>
                  {meta.icon}
                  <span>{meta.label}</span>
                </div>

                {/* Open link */}
                <div className="shrink-0 w-16 text-right">
                  {canOpen && !isNA ? (
                    <Link
                      to={mission.href}
                      className="text-xs text-primary hover:text-primary/80 flex items-center justify-end gap-0.5"
                    >
                      Open
                      <ChevronRight className="w-3 h-3" />
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground/30">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 4. Recent uploads ───────────────────────────────────────────── */}
      {uploads.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground tracking-widest mb-3">
            RECENT UPLOADS
          </p>
          <div className="border border-border divide-y divide-border">
            {uploads.slice(0, 5).map((u) => {
              const isSelected = u.id === upload?.id;
              return (
                <div
                  key={u.id}
                  className={`flex items-center gap-4 px-5 py-3 ${isSelected ? "bg-secondary/30" : "hover:bg-secondary/20"} transition-colors`}
                >
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-mono truncate ${isSelected ? "text-foreground font-semibold" : "text-muted-foreground"}`}>
                      {u.file_name}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground tabular-nums">
                    <span>{formatFileSize(u.file_size)}</span>
                    <span
                      className={
                        u.status === "complete"
                          ? "text-accent"
                          : u.status === "error" || u.status === "blocked"
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      {u.status.toUpperCase()}
                    </span>
                    <span>{formatRelative(u.uploaded_at)}</span>
                  </div>
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
                                                                                                                                                                                                                                                                                                                                                                                                