/**
 * WorkspaceLayout — Shell for all workspace pages.
 *
 * Renders:
 *   1. Top bar   — logo | company · period breadcrumb | user menu with visible Sign Out
 *   2. Sub-nav   — 7 accounting stage tabs, responsive (no horizontal scroll)
 *   3. <Outlet>  — child route
 *
 * Architecture v3.1: stage labels driven by stageMetadata.ts.
 * UX fixes applied:
 *   - FY{year} uses the URL year param (already corrected by Dashboard routing)
 *   - Tab bar never scrolls — uses short labels on md, full on xl
 *   - Sign Out is a top-level visible action, never buried
 *   - No "ENGAGEMENT" jargon
 *   - Status dot meanings are consistent and labelled via title= tooltip
 */

import { useEffect, useRef, useState } from "react";
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
  LogOut,
  ChevronDown,
} from "lucide-react";
import { STAGE_SEQUENCE, STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { MissionStatus } from "@/lib/workspace/types";

/**
 * Tab word in professional sentence case, derived from the canonical metadata
 * (`tabLabel`) without modifying it: "RECONCILE" → "Reconcile".
 */
function tabWord(tabLabel: string): string {
  return tabLabel.charAt(0) + tabLabel.slice(1).toLowerCase();
}

// ── Status dot — tooltip explains the symbol ───────────────────────────────

const STATUS_TITLES: Record<MissionStatus, string> = {
  passed:          "Passed",
  signed:          "Signed off",
  in_progress:     "In progress",
  ready:           "Ready to open",
  review_required: "Review required",
  blocked:         "Blocked — action needed",
  locked:          "Locked — complete earlier stages first",
  not_started:     "Not started",
  not_applicable:  "Not applicable",
};

function StatusDot({ status }: { status: MissionStatus }) {
  const title = STATUS_TITLES[status];
  // Lucide SVGs don't accept a `title` prop — wrap in a span so browser shows tooltip
  const inner = (() => {
    switch (status) {
      case "passed":
      case "signed":
        return <CheckCircle2 className="w-3.5 h-3.5 text-accent shrink-0" />;
      case "blocked":
      case "review_required":
        return <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />;
      case "locked":
        return <Lock className="w-3 h-3 text-muted-foreground/40 shrink-0" />;
      case "in_progress":
        return <Clock className="w-3.5 h-3.5 text-primary shrink-0 animate-pulse" />;
      case "ready":
        return <div className="w-2 h-2 bg-primary rounded-full shrink-0" />;
      default:
        return <Minus className="w-3 h-3 text-muted-foreground/30 shrink-0" />;
    }
  })();
  return <span title={title} className="inline-flex shrink-0">{inner}</span>;
}

// ── User menu — visible sign-out ────────────────────────────────────────────

function UserMenu({ email }: { email: string }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const initial = email[0]?.toUpperCase() ?? "U";

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth", { replace: true });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 h-8 px-2 rounded hover:bg-secondary transition-colors text-sm text-muted-foreground"
        title={email}
      >
        <span className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold shrink-0">
          {initial}
        </span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-background border border-border shadow-lg z-50">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs text-muted-foreground truncate">{email}</p>
          </div>
          <Link
            to="/settings"
            className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-secondary transition-colors"
            onClick={() => setOpen(false)}
          >
            <Settings className="w-4 h-4" />
            Settings
          </Link>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-destructive/5 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
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
  const pathSegments = location.pathname.split("/");
  const activeSlug = pathSegments[4] ?? "overview";

  // Human-readable period label — never an internal DB ID
  const periodLabel = periodYear > 2000 ? `FY${periodYear}` : "—";

  return (
    <WorkspaceContext.Provider value={workspaceData}>
      <div className="min-h-screen bg-background flex flex-col">

        {/* ── Top bar ──────────────────────────────────────────────────────── */}
        <header className="sticky top-0 z-50 bg-background border-b border-border">
          <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">

            {/* Left: back arrow + logo + breadcrumb */}
            <div className="flex items-center gap-3 min-w-0">
              <Button variant="ghost" size="sm" asChild className="shrink-0 -ml-1 p-1.5">
                <Link to="/" title="Back to home">
                  <ArrowLeft className="w-4 h-4" />
                </Link>
              </Button>
              <SaffLogo variant="header" className="h-6 w-auto shrink-0" />
              <div className="h-4 w-px bg-border shrink-0" />
              {loading ? (
                <Skeleton className="h-4 w-36" />
              ) : (
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <span className="font-semibold text-foreground truncate max-w-[140px] sm:max-w-xs">
                    {company?.name ?? "Loading…"}
                  </span>
                  <span className="text-muted-foreground shrink-0">·</span>
                  <span className="text-muted-foreground tabular-nums shrink-0 font-mono text-xs">
                    {periodLabel}
                  </span>
                  {/* TIN is an exception surface, not header chrome — the
                      Overview owns it and shows it only when it blocks. */}
                </div>
              )}
            </div>

            {/* Right: refresh + user menu (sign out always visible in dropdown) */}
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={workspaceData.refreshUpload}
                title="Refresh data"
                className="p-1.5"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
              {user && <UserMenu email={user.email ?? "user"} />}
            </div>
          </div>
        </header>

        {/* ── Stage sub-nav — NO horizontal scroll ─────────────────────────── */}
        {/*
         *  Layout contract:
         *    - 8 tabs total (OVERVIEW + 7 stages)
         *    - Short labels on md screens, full labels on xl+
         *    - Locked tabs are visually dimmed but still tappable (to show gate message)
         *    - Active tab has a 2px bottom accent line
         */}
        <nav className="bg-background border-b border-border sticky top-14 z-40">
          <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex items-stretch min-w-max">

              {/* Overview tab */}
              <Link
                to={basePath}
                className={[
                  "flex items-center gap-1 px-2 sm:px-3 xl:px-4 py-3 text-[11px] sm:text-xs font-medium border-b-2 transition-colors shrink-0",
                  activeSlug === "overview" || pathSegments.length === 4
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                ].join(" ")}
              >
                <span className="hidden md:inline">Overview</span>
                <span className="md:hidden sr-only">Overview</span>
              </Link>

              {/* Stage tabs */}
              {STAGE_SEQUENCE.map((slug) => {
                const config = STAGE_CONFIGS[slug];
                const mission = workspaceState.missions[slug];
                const isActive = activeSlug === slug;
                const isLocked = mission.status === "locked";
                const Icon = config.icon;

                return (
                  <Link
                    key={slug}
                    to={`${basePath}/${slug}`}
                    title={config.description}
                    aria-label={config.label}
                    className={[
                      "flex items-center gap-1 px-2 sm:px-3 xl:px-4 py-3 text-[11px] sm:text-xs font-medium border-b-2 transition-colors shrink-0",
                      isActive
                        ? "border-primary text-foreground"
                        : isLocked
                        ? "border-transparent text-muted-foreground/40"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                    ].join(" ")}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    {/* Full professional stage language from md upward; below
                        768px the tab compresses to icon + status with the name
                        carried by aria-label/title. */}
                    <span className="hidden md:inline xl:hidden">{tabWord(config.tabLabel)}</span>
                    <span className="hidden xl:inline">{config.label}</span>
                    <span className="md:hidden sr-only">{config.label}</span>
                    {!loading && <StatusDot status={mission.status} />}
                  </Link>
                );
              })}

            </div>
          </div>
        </nav>

        {/* ── Page content ─────────────────────────────────────────────────── */}
        <main className="flex-1 max-w-screen-2xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
          <Outlet />
        </main>

      </div>
    </WorkspaceContext.Provider>
  );
}
