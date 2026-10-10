import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { SessionTimeoutProvider } from "@/components/SessionTimeoutProvider";
import Index from "./pages/Index";
import Dashboard from "./pages/Dashboard";
import Auth from "./pages/Auth";
import Settings from "./pages/Settings";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import UploadStatus from "./pages/UploadStatus";
import NotFound from "./pages/NotFound";

// Workspace architecture — Architecture v3.1
import WorkspaceLayout from "./pages/workspace/WorkspaceLayout";
import WorkspaceOverview from "./pages/workspace/WorkspaceOverview";

// Stage workspaces (sequence: prepare → reconcile → statements → tax → compliance → filing → monitor). The tax stage is
// and the Statements, Compliance, Filing and Monitor stages are withheld from customers (src/lib/workspace/moduleAvailability.ts);
// their pages are deliberately not imported here. Customers reach Prepare and Reconcile only.
import PrepareWorkspace from "./pages/workspace/PrepareWorkspace";
import ReconcileWorkspace from "./pages/workspace/ReconcileWorkspace";
// IssuesWorkspace is retired — /issues redirects to /compliance (Phase D removes file)
import IssuesWorkspace from "./pages/workspace/IssuesWorkspace";

// Engagement mandate — scope-aware route guard (routes always exist)
import StageScopeGate from "./components/workspace/StageScopeGate";
import { OverviewAccessGate } from "./components/workspace/WorkspaceAccessGate";
import WorkspaceUnavailable from "./components/workspace/WorkspaceUnavailable";
// The reporting routes' access gate (server rollout + Statements access); small, and holds no reporting code itself.
import ReportingAccessGate from "./components/reporting/ReportingAccessGate";
import { WITHHELD_WORKSPACE_ROUTE_SEGMENTS } from "./lib/workspace/moduleAvailability";
import { WORKBENCH_NAVIGATION_ENABLED } from "./lib/workbench/gate";
import { RELEASED_WORKBENCH_PAGES, REPORTING_PAGES_SHIPPED } from "./lib/workbench/routes";
import { RouteMeta } from "./components/seo/RouteMeta";
// Workbench alias (WORKBENCH_NAVIGATION_ENABLED only): one canonical destination, keeping the query (report version).
import { WorkbenchAliasRedirect } from "./components/workbench/WorkbenchAliasRedirect";

// Command Center — partner-level cross-engagement view
import CommandCenter from "./pages/command/CommandCenter";

const queryClient = new QueryClient();

// ── Legacy deep-link redirect: /workspace/:id/:year/safisha → /prepare, etc. ──
// Handles any bookmarks pointing to engine-named sub-routes.

import PaymentReturn from "@/pages/billing/PaymentReturn";
import CommercialAdmin from "@/pages/commercial/CommercialAdmin";
import Pricing from "@/pages/Pricing";
import Plans from "@/pages/Plans";
import { serviceEnquiryRoutes } from "@/lib/serviceEnquiry/serviceEnquiryRoutes";

function LegacySubRouteRedirect({ to }: { to: string }) {
  const { companyId, periodYear } = useParams<{ companyId: string; periodYear: string }>();
  return <Navigate to={`/workspace/${companyId}/${periodYear}/${to}`} replace />;
}


// Internal, development-only visual-acceptance page for the 7 classification states — never present in a
// production build (see src/lib/workspace/classificationAcceptanceGate.ts). import.meta.env.DEV is a Vite
// compile-time constant, statically false in every `vite build` output, so this ternary's lazy() call is dead
// code there and the route below is never registered.
// Workbench Trial balance › Intake (I1-A A3): a separate chunk, reached only through the gated route below.
const TrialBalanceIntake = lazy(() => import("@/pages/workspace/TrialBalanceIntake"));
// Online payment: loaded only when a customer opens checkout or their orders.
const Checkout = lazy(() => import("@/pages/billing/Checkout"));
const Orders = lazy(() => import("@/pages/billing/Orders"));
const CloseFindings = lazy(() => import("@/pages/workspace/CloseFindings"));
const CloseAdjustments = lazy(() => import("@/pages/workspace/CloseAdjustments"));
// Financial Statements and Sign-off & Exports (workbench): a separate chunk, reached only through the released routes below.
// A literal gate (REPORTING_PAGES_SHIPPED): while it is false the chunk is not in the build at all.
const ReportingWorkbenchPage = REPORTING_PAGES_SHIPPED
  ? lazy(() => import("@/pages/workspace/ReportingWorkbenchPage"))
  : (_: { page: "fs-statements" | "fs-notes" | "fs-schedules" | "fs-comparatives" | "signoff" | "exports" }) => null;

const ClassificationStatesAcceptance = import.meta.env.DEV
  ? lazy(() => import("@/pages/internal/ClassificationStatesAcceptance"))
  : null;

// Same dev-only-forever boundary as ClassificationStatesAcceptance — extends its gallery to the
// full canonical workflow (deriveWorkspaceState's 11 paths, including contradiction/missing-
// certification/stale-processing/direct-route). Never present in a production build.
const WorkspaceStatesAcceptance = import.meta.env.DEV
  ? lazy(() => import("@/pages/internal/WorkspaceStatesAcceptance"))
  : null;

const PlanStatesAcceptance = import.meta.env.DEV
  ? lazy(() => import("@/pages/internal/PlanStatesAcceptance"))
  : null;

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <SessionTimeoutProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              {/* Per-route title, description, canonical URL and robots (src/lib/seo/publicMeta.ts). */}
              <RouteMeta />
              <Routes>
                {/* ── Public landing ── */}
                <Route path="/" element={<Index />} />

                {/* ── Command Center — partner cross-engagement view ── */}
                <Route path="/command" element={<CommandCenter />} />

                {/* ── Workspace architecture — primary post-login experience ── */}
                <Route
                  path="/workspace/:companyId/:periodYear"
                  element={
                    <PageErrorBoundary pageName="Workspace">
                      <WorkspaceLayout />
                    </PageErrorBoundary>
                  }
                >
                  <Route index element={<OverviewAccessGate><WorkspaceOverview /></OverviewAccessGate>} />

                  {/* Architecture v3.1 canonical routes */}
                  <Route path="prepare"    element={WORKBENCH_NAVIGATION_ENABLED ? <WorkbenchAliasRedirect segment="prepare" /> : <StageScopeGate stage="prepare"><PrepareWorkspace /></StageScopeGate>} />
                  {/* Workbench canonical routes — registered only when WORKBENCH_NAVIGATION_ENABLED (src/lib/workbench/routes.ts). */}
                  {WORKBENCH_NAVIGATION_ENABLED && <Route path="trial-balance" element={<WorkbenchAliasRedirect segment="trial-balance" />} />}
                  {WORKBENCH_NAVIGATION_ENABLED && <Route path="trial-balance/intake" element={<StageScopeGate stage="prepare"><Suspense fallback={null}><TrialBalanceIntake /></Suspense></StageScopeGate>} />}
                  {WORKBENCH_NAVIGATION_ENABLED && <Route path="trial-balance/review" element={<StageScopeGate stage="prepare"><PrepareWorkspace /></StageScopeGate>} />}
                  {/* Close Review › Findings: registered only once the page is released (routes.ts RELEASED_WORKBENCH_PAGES). */}
                  {WORKBENCH_NAVIGATION_ENABLED && RELEASED_WORKBENCH_PAGES.has("close-findings") && <Route path="close/findings" element={<StageScopeGate stage="prepare"><ReportingAccessGate prepareStage><Suspense fallback={null}><CloseFindings /></Suspense></ReportingAccessGate></StageScopeGate>} />}
                  {WORKBENCH_NAVIGATION_ENABLED && RELEASED_WORKBENCH_PAGES.has("close-adjustments") && <Route path="close/adjustments" element={<StageScopeGate stage="prepare"><ReportingAccessGate prepareStage><Suspense fallback={null}><CloseAdjustments /></Suspense></ReportingAccessGate></StageScopeGate>} />}
                  {/* Financial Statements and Sign-off & Exports: each registered only once its page is released (routes.ts
                      RELEASED_WORKBENCH_PAGES), behind ReportingAccessGate: server-granted access to the Statements stage AND the
                    company enabled for reporting by the server (rollout allow-list). */}
                  {WORKBENCH_NAVIGATION_ENABLED && RELEASED_WORKBENCH_PAGES.has("fs-statements") && <Route path="statements" element={<ReportingAccessGate><Suspense fallback={null}><ReportingWorkbenchPage page="fs-statements" /></Suspense></ReportingAccessGate>} />}
                  {WORKBENCH_NAVIGATION_ENABLED && RELEASED_WORKBENCH_PAGES.has("fs-notes") && <Route path="statements/notes" element={<ReportingAccessGate><Suspense fallback={null}><ReportingWorkbenchPage page="fs-notes" /></Suspense></ReportingAccessGate>} />}
                  {WORKBENCH_NAVIGATION_ENABLED && RELEASED_WORKBENCH_PAGES.has("fs-schedules") && <Route path="statements/schedules" element={<ReportingAccessGate><Suspense fallback={null}><ReportingWorkbenchPage page="fs-schedules" /></Suspense></ReportingAccessGate>} />}
                  {WORKBENCH_NAVIGATION_ENABLED && RELEASED_WORKBENCH_PAGES.has("fs-comparatives") && <Route path="statements/comparatives" element={<ReportingAccessGate><Suspense fallback={null}><ReportingWorkbenchPage page="fs-comparatives" /></Suspense></ReportingAccessGate>} />}
                  {WORKBENCH_NAVIGATION_ENABLED && RELEASED_WORKBENCH_PAGES.has("signoff") && <Route path="signoff" element={<ReportingAccessGate><Suspense fallback={null}><ReportingWorkbenchPage page="signoff" /></Suspense></ReportingAccessGate>} />}
                  {WORKBENCH_NAVIGATION_ENABLED && RELEASED_WORKBENCH_PAGES.has("exports") && <Route path="signoff/exports" element={<ReportingAccessGate><Suspense fallback={null}><ReportingWorkbenchPage page="exports" /></Suspense></ReportingAccessGate>} />}
                  <Route path="reconcile"  element={<StageScopeGate stage="reconcile"><ReconcileWorkspace /></StageScopeGate>} />

                  {/* Compatibility redirects — engine-named sub-routes → accounting slugs */}
                  <Route path="safisha"   element={<LegacySubRouteRedirect to="prepare" />} />
                  <Route path="hesabu"    element={<LegacySubRouteRedirect to="statements" />} />
                  <Route path="kinga"     element={<LegacySubRouteRedirect to="tax" />} />
                  <Route path="analytics" element={<LegacySubRouteRedirect to="monitor" />} />
                  <Route path="issues"    element={<LegacySubRouteRedirect to="compliance" />} />

                  {/* Modules withheld from customers (moduleAvailability.ts): the stage and its legacy alias render the
                      neutral boundary — old bookmarks, refreshes and typed URLs never mount or load the module. */}
                  {/* With the reporting pages shipped, "statements" is the reporting route above (its own access gate renders the
                      same unavailable boundary to every company without reporting access); every other withheld segment as before. */}
                  {WITHHELD_WORKSPACE_ROUTE_SEGMENTS.filter((segment) => !(REPORTING_PAGES_SHIPPED && segment === "statements")).map((segment) => (
                    <Route key={segment} path={segment} element={<WorkspaceUnavailable />} />
                  ))}
                </Route>

                {/* ── Compatibility redirects — top-level legacy routes ── */}
                {/* /dashboard → the company selector (unchanged, then routes to /workspace) */}
                <Route
                  path="/dashboard"
                  element={
                    <PageErrorBoundary pageName="Dashboard">
                      <Dashboard />
                    </PageErrorBoundary>
                  }
                />

                {/* ── Auth + utility ── */}
                <Route path="/auth" element={<Auth />} />
                <Route path="/pricing" element={<Pricing />} />
                <Route path="/request-access" element={<Navigate to="/pricing" replace />} />
                <Route path="/plans" element={<Plans />} />
                {/* /contact and /admin/enquiries exist only behind the `service_enquiry_phase1` gate (OFF by default). */}
                {serviceEnquiryRoutes()}
                <Route path="/terms" element={<Terms />} />
                <Route path="/billing/checkout" element={<Suspense fallback={null}><Checkout /></Suspense>} />
                <Route path="/billing/orders" element={<Suspense fallback={null}><Orders /></Suspense>} />
                <Route path="/billing/payment/return" element={<PaymentReturn />} />
                <Route path="/commercial/admin" element={<CommercialAdmin />} />
                <Route path="/privacy" element={<Privacy />} />
                {/* /internal/acceptance/classification-states exists only in a dev build (import.meta.env.DEV). */}
                {ClassificationStatesAcceptance && (
                  <Route
                    path="/internal/acceptance/classification-states"
                    element={
                      <Suspense fallback={null}>
                        <ClassificationStatesAcceptance />
                      </Suspense>
                    }
                  />
                )}
                {/* /internal/acceptance/workflow-states exists only in a dev build (import.meta.env.DEV). */}
                {WorkspaceStatesAcceptance && (
                  <Route
                    path="/internal/acceptance/workflow-states"
                    element={
                      <Suspense fallback={null}>
                        <WorkspaceStatesAcceptance />
                      </Suspense>
                    }
                  />
                )}
                {PlanStatesAcceptance && (
                  <Route path="/internal/acceptance/plan-states" element={<Suspense fallback={null}><PlanStatesAcceptance /></Suspense>} />
                )}
                <Route
                  path="/uploads/status"
                  element={
                    <PageErrorBoundary pageName="UploadStatus">
                      <UploadStatus />
                    </PageErrorBoundary>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <PageErrorBoundary pageName="Settings">
                      <Settings />
                    </PageErrorBoundary>
                  }
                />

                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
          </SessionTimeoutProvider>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
