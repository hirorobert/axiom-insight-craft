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
import { WITHHELD_WORKSPACE_ROUTE_SEGMENTS } from "./lib/workspace/moduleAvailability";
import { WORKBENCH_NAVIGATION_ENABLED } from "./lib/workbench/gate";
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
                  <Route path="reconcile"  element={<StageScopeGate stage="reconcile"><ReconcileWorkspace /></StageScopeGate>} />

                  {/* Compatibility redirects — engine-named sub-routes → accounting slugs */}
                  <Route path="safisha"   element={<LegacySubRouteRedirect to="prepare" />} />
                  <Route path="hesabu"    element={<LegacySubRouteRedirect to="statements" />} />
                  <Route path="kinga"     element={<LegacySubRouteRedirect to="tax" />} />
                  <Route path="analytics" element={<LegacySubRouteRedirect to="monitor" />} />
                  <Route path="issues"    element={<LegacySubRouteRedirect to="compliance" />} />

                  {/* Modules withheld from customers (moduleAvailability.ts): the stage and its legacy alias render the
                      neutral boundary — old bookmarks, refreshes and typed URLs never mount or load the module. */}
                  {WITHHELD_WORKSPACE_ROUTE_SEGMENTS.map((segment) => (
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
