/**
 * WorkspaceLayout — Shell for all workspace pages.
 *
 * Renders:
 *   1. Top bar   — logo | company · period breadcrumb | utility links
 *   2. Sub-nav   — 7 accounting stage tabs with status indicators
 *   3. <Outlet>  — child route (WorkspaceOverview or stage workspace)
 *
 * Architecture v3.1: stage labels and order are driven by stageMetadata.ts —
 * no duplicate slug arrays or label maps in this file.
 *
 * Provides WorkspaceContext to all child routes.
 * Handles auth guard — redirects to /auth if not signed in.
 */

import { useEffect } from "react";
import { Outlet, useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { WorkspaceContext } from "@/contexts/WorkspaceContext";
import { useWorkspaceData } from "@/hooks/useWorkspaceData";
import { SaffLogo } from "@/components/SaffLogo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CheckCircle2,
  XCircle,
  Lock,
  Clock,
  Minus,
  Settings,
  ArrowLeft,
  RefreshCw,
} from "lucide-react";
import { STAGE_SEQUENCE, STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { MissionStatus } from "@/lib/workspace/types";

// ── Status indicator ────────────────────────────────────────────────────────

function StatusDot({ status }: { status: MissionStatus }) {
  switch (status) {
    case "passed":
    case "signed":
      return <CheckCircle2 className="w-3.5 h-3.5 text-accent shrink-0" />;
    case "blocked":
    case "review_required":
      return <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />;
    case "locked":
      return <Lock className="w-3 h-3 text-muted-foreground/50 shrink-0" />;
    case "in_progress":
      return <Clock className="w-3.5 h-3.5 text-primary shrink-0 animate-pulse" />;
    case "ready":
      return <div className="w-2 h-2 bg-primary shrink-0" />;
    case "not_started":
    case "not_applicable":
    default:
      return <Minus className="w-3 h-3 text-muted-foreground/40 shrink-0" />;
  }
}

// ── Layout ─────────────────────────────────────────────────────────────────

export default function WorkspaceLayout() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceData = useWorkspaceData();

  const { companyId, periodYear, company, workspaceState, loading } = workspaceData;

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  if (authLoading) return null;

  const basePath = `/workspace/${companyId}/${periodYear}`;

  // Active tab detection
  const pathSegments = location.pathname.split("/");
  const activeSlug = pathSegments[4] ?? "overview"; // /workspace/:cId/:year/:slug

  return (
    <WorkspaceContext.Provider value={workspaceData}>
      <div className="min-h-screen bg-background flex flex-col">
        {/* ── Top bar ──────────────────────────────────────────────────── */}
        <header className="sticky top-0 z-50 bg-background border-b border-border">
          <div className="max-w-screen-2xl mx-auto px-6 h-14 flex items-center justify-between gap-6">
            {/* Left: logo + breadcrumb */}
            <div className="flex items-center gap-4 min-w-0">
              <Button variant="ghost" size="sm" asChild className="shrink-0 -ml-2">
                <Link to="/" className="flex items-center gap-2">
                  <ArrowLeft className="w-4 h-4" />
                </Link>
              </Button>
              <SaffLogo variant="header" className="h-7 w-auto shrink-0" />
              <div className="h-4 w-px bg-border shrink-0" />
              {loading ? (
                <Skeleton className="h-4 w-40" />
              ) : (
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <span className="font-semibold text-foreground truncate">
                    {company?.name ?? "Loading…"}
                  </span>
                  <span className="text-muted-foreground shrink-0">·</span>
                  <span className="text-muted-foreground tabular-nums shrink-0">
                    FY{periodYear}
                  </span>
                </div>
              )}
            </div>

            {/* Right: refresh + settings */}
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={workspaceData.refreshUpload}
                title="Refresh"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/settings">
                  <Settings className="w-4 h-4" />
                </Link>
              </Button>
            </div>
          </div>
        </header>

        {/* ── Stage sub-nav ─────────────────────────────────────────────── */}
        <nav className="bg-background border-b border-border sticky top-14 z-40">
          <div className="max-w-screen-2xl mx-auto px-6">
            <div className="flex items-center gap-0 overflow-x-auto">
              {/* Overview tab */}
              <Link
                to={basePath}
                className={[
                  "flex items-center gap-1.5 px-4 py-3 text-xs font-medium border-b-2 transition-colors whitespace-nowrap",
                  activeSlug === "overview" || pathSegments.length === 4
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                ].join(" ")}
              >
                OVERVIEW
              </Link>

              {/* Stage tabs — driven by stageMetadata canonical sequence */}
              {STAGE_SEQUENCE.map((slug) => {
                const config = STAGE_CONFIGS[slug];
                const mission = workspaceState.missions[slug];
                const isActive = activeSlug === slug;
                const isLocked = mission.status === "locked";

                return (
                  <Link
                    key={slug}
                    to={`${basePath}/${slug}`}
                    className={[
                      "flex items-center gap-1.5 px-4 py-3 text-xs font-medium border-b-2 transition-colors whitespace-nowrap",
                      isActive
                        ? "border-primary text-foreground"
                        : isLocked
                        ? "border-transparent text-muted-foreground/40 pointer-events-none"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                    ].join(" ")}
                  >
                    <span className="text-muted-foreground">
                      {config.icon}
                    </span>
                    <span className="tracking-wide">{config.tabLabel}</span>
                    {!loading && <StatusDot status={mission.status} />}
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>

        {/* ── Page content ──────────────────────────────────────────────── */}
        <main className="flex-1 max-w-screen-2xl mx-auto w-full px-6 py-8">
          <Outlet />
        </main>
      </div>
    </WorkspaceContext.Provider>
  );
}
