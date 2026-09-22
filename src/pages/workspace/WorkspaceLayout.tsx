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
import { EngagementContext } from "@/contexts/EngagementContext";
import { useWorkspaceData } from "@/hooks/useWorkspaceData";
import { useEngagementMandate } from "@/hooks/useEngagementMandate";
import { projectMandate } from "@/lib/workspace/mandate";
import { deriveWorkspaceNavigation } from "@/lib/workspace/navigation";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import type { CompanyReportingFrameworkDbValue } from "@/lib/accounting/frameworkAdapter";
import { detectEntityAccountingContext } from "@/lib/accounting/detectEntityContext";
import { classifyConfirmationPosture } from "@/lib/accounting/confirmationPosture";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CheckCircle2,
  XCircle,
  Lock,
  Clock,
  Minus,
  Settings,
  RefreshCw,
  LogOut,
  LifeBuoy,
  ChevronDown,
} from "lucide-react";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import { contactHref } from "@/lib/serviceEnquiry/entryPoints";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import type { MissionStatus, WorkspaceMission } from "@/lib/workspace/types";

/**
 * Tab word in professional sentence case, derived from the canonical metadata
 * (`tabLabel`) without modifying it: "RECONCILE" → "Reconcile".
 */
function tabWord(tabLabel: string): string {
  return tabLabel.charAt(0) + tabLabel.slice(1).toLowerCase();
}

// Wording of the persisted `companies.reporting_framework` value, identical to the labels Company Settings shows.
// EXHAUSTIVENESS AUTHORITY: `CompanyReportingFrameworkDbValue` (src/lib/accounting/frameworkAdapter.ts), the exported
// CHECK-constrained value set. Adding or removing a persisted value there fails the typecheck here until this map matches.
// (No neutral exported label mapping exists outside the flag-gated statements workspace, which the shell may not import.)
const PERSISTED_FRAMEWORK_LABEL: Record<CompanyReportingFrameworkDbValue, string> = {
  ifrs_for_smes: "IFRS for SMEs",
  full_ifrs: "Full IFRS",
  ipsas_accrual: "IPSAS Accrual",
  ipsas_cash: "IPSAS Cash Basis",
};

function isPersistedFramework(value: string | null | undefined): value is CompanyReportingFrameworkDbValue {
  return !!value && Object.prototype.hasOwnProperty.call(PERSISTED_FRAMEWORK_LABEL, value);
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
          {SERVICE_ENQUIRY_SURFACES.helpSupportLinks && (
            <Link
              to={contactHref("help_support")}
              className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-secondary transition-colors"
              onClick={() => setOpen(false)}
            >
              <LifeBuoy className="w-4 h-4" />
              Help &amp; support
            </Link>
          )}
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
  const engagementApi = useEngagementMandate(companyId, periodYear);
  const missionViews = projectMandate(workspaceState.missions, engagementApi.mandate);

  // Stages the mandate keeps in the active rail. While the mandate is loading or
  // undeclared, projectMandate returns every stage — nothing is ever hidden on
  // unknown scope.
  const scopeDeclared = !!engagementApi.mandate && engagementApi.mandate.granted.length > 0;
  const navItems = deriveWorkspaceNavigation({
    basePath: `/workspace/${companyId}/${periodYear}`,
    scopeDeclared,
    missionViews: engagementApi.loading ? [] : missionViews,
  });

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

  // The value shown is only the persisted companies.reporting_framework; null or unrecognised omits it (never inferred
  // or defaulted). Whether it is a settled decision comes from the existing confirmation authority (the same one
  // FrameworkConfirmationBanner uses): only HIGH confidence / professionally confirmed counts. A legacy default
  // ('ifrs_for_smes' on a pre-cut-over row) or an unbacked preparer selection is shown marked "unconfirmed".
  const persistedFramework = company?.reporting_framework;
  const frameworkLabel = isPersistedFramework(persistedFramework) ? PERSISTED_FRAMEWORK_LABEL[persistedFramework] : null;
  const confirmationPosture = classifyConfirmationPosture(
    detectEntityAccountingContext({ companyReportingFrameworkDbValue: persistedFramework, companyCreatedAt: company?.created_at }).reportingFramework,
  );
  const frameworkConfirmed = confirmationPosture === "QUIET_CONFIRMATION" || confirmationPosture === "NO_PROMPT_NEEDED";

  return (
    <WorkspaceContext.Provider value={workspaceData}>
     <EngagementContext.Provider value={{ ...engagementApi, missionViews }}>
      <div className="min-h-screen bg-background flex flex-col">

        {/* ── Top bar ──────────────────────────────────────────────────────── */}
        <header className="sticky top-0 z-50 bg-background border-b border-border">
          <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">

            {/* Left: logo (home) + breadcrumb — the logo is the only way back,
                so there is no competing back arrow. */}
            <div className="flex items-center gap-3 min-w-0">
              <Link
                to="/dashboard"
                // Explicit escape to the hub — never silently re-lands back in this exact workspace.
                // See Dashboard.tsx's forceHub / resolveReturningUserRoute.ts's applyForceHub.
                state={{ forceHub: true }}
                title="CFOClose — back to your workspaces"
                aria-label="CFOClose home"
                className="shrink-0 -ml-1 rounded px-1 py-1 transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CFOCloseWordmark className="text-base" />
              </Link>
              <div className="h-4 w-px bg-border shrink-0" />
              {loading ? (
                <Skeleton className="h-4 w-36" />
              ) : (
                // Two lines below sm (company · FY, then the framework), one line from sm up. The header keeps its h-14,
                // so the sticky stage nav offset is unaffected; every part truncates instead of overflowing.
                <div className="flex min-w-0 flex-col justify-center gap-0.5 text-sm leading-tight sm:flex-row sm:items-center sm:gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-semibold text-foreground truncate max-w-[140px] sm:max-w-xs">
                      {company?.name ?? "Loading…"}
                    </span>
                    <span className="text-muted-foreground shrink-0">·</span>
                    <span className="text-muted-foreground tabular-nums shrink-0 font-mono text-xs">
                      {periodLabel}
                    </span>
                  </div>
                  {frameworkLabel && (
                    <div
                      data-testid="workspace-framework"
                      data-confirmed={frameworkConfirmed}
                      className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground sm:text-xs"
                      title={`Reporting framework: ${frameworkLabel}${frameworkConfirmed ? "" : " (unconfirmed)"}`}
                    >
                      <span aria-hidden="true" className="hidden shrink-0 sm:block">·</span>
                      <span className="min-w-0 truncate">
                        <span className="sr-only">Reporting framework: </span>
                        {frameworkLabel}
                      </span>
                      {!frameworkConfirmed && <span className="shrink-0 text-[10px] sm:text-xs">(unconfirmed)</span>}
                    </div>
                  )}
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

              {navItems.map((item) => {
                const isOverview = item.id === "overview";
                const isActive = isOverview ? activeSlug === "overview" || pathSegments.length === 4 : activeSlug === item.id;
                const base = "flex items-center gap-1 px-2 sm:px-3 xl:px-4 py-3 text-[11px] sm:text-xs font-medium border-b-2 transition-colors shrink-0";
                if (isOverview) {
                  return (
                    <Link
                      key="overview"
                      to={item.href}
                      className={[base, isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"].join(" ")}
                    >
                      <span>Overview</span>
                    </Link>
                  );
                }
                const slug = item.id as WorkspaceMission;
                const config = STAGE_CONFIGS[slug];
                const mission = workspaceState.missions[slug];
                const Icon = config.icon;
                const lockedReasonId = `stage-locked-${slug}`;
                const tab = (
                  <Link
                    key={slug}
                    to={item.href}
                    aria-label={config.label}
                    aria-disabled={item.disabled || undefined}
                    aria-describedby={item.disabled ? lockedReasonId : undefined}
                    title={item.disabled ? undefined : item.inputEvidenceOnly ? `${config.description} — input evidence for this workspace` : config.description}
                    className={[base, isActive ? "border-primary text-foreground" : item.disabled ? "border-transparent text-muted-foreground/40" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"].join(" ")}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden md:inline xl:hidden">{tabWord(config.tabLabel)}</span>
                    <span className="hidden xl:inline">{config.label}</span>
                    <span className="md:hidden sr-only">{config.label}</span>
                    {item.disabled && <span id={lockedReasonId} className="sr-only">{item.reason} {item.action}</span>}
                    {!loading && <StatusDot status={mission.status} />}
                  </Link>
                );
                // A locked tab keeps its href (tapping opens the stage's own lock explanation); the tooltip adds the
                // explanation on hover and keyboard focus. Radix does not open tooltips on touch, so touch is served by that tap-through.
                return item.disabled ? (
                  <Tooltip key={slug}>
                    <TooltipTrigger asChild>{tab}</TooltipTrigger>
                    <TooltipContent>{config.label} — complete earlier stages first</TooltipContent>
                  </Tooltip>
                ) : (
                  tab
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
     </EngagementContext.Provider>
    </WorkspaceContext.Provider>
  );
}
