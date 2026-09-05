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

// Stage workspaces (sequence: prepare → reconcile → statements → tax → compliance → filing → monitor)
import PrepareWorkspace from "./pages/workspace/PrepareWorkspace";
import ReconcileWorkspace from "./pages/workspace/ReconcileWorkspace";
import StatementsWorkspace from "./pages/workspace/StatementsWorkspace";
import TaxWorkspace from "./pages/workspace/TaxWorkspace";
import ComplianceWorkspace from "./pages/workspace/ComplianceWorkspace";
import FilingWorkspace from "./pages/workspace/FilingWorkspace";
import MonitorWorkspace from "./pages/workspace/MonitorWorkspace";
// IssuesWorkspace is retired — /issues redirects to /compliance (Phase D removes file)
import IssuesWorkspace from "./pages/workspace/IssuesWorkspace";

// Engagement mandate — scope-aware route guard (routes always exist)
import StageScopeGate from "./components/workspace/StageScopeGate";

// Command Center — partner-level cross-engagement view
import CommandCenter from "./pages/command/CommandCenter";

const queryClient = new QueryClient();

// ── Legacy deep-link redirect: /workspace/:id/:year/safisha → /prepare, etc. ──
// Handles any bookmarks pointing to engine-named sub-routes.

function LegacySubRouteRedirect({ to }: { to: string }) {
  const { companyId, periodYear } = useParams<{ companyId: string; periodYear: string }>();
  return <Navigate to={`/workspace/${companyId}/${periodYear}/${to}`} replace />;
}

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
                  <Route index element={<WorkspaceOverview />} />

                  {/* Architecture v3.1 canonical routes */}
                  <Route path="prepare"    element={<StageScopeGate stage="prepare"><PrepareWorkspace /></StageScopeGate>} />
                  <Route path="reconcile"  element={<StageScopeGate stage="reconcile"><ReconcileWorkspace /></StageScopeGate>} />
                  <Route path="statements" element={<StageScopeGate stage="statements"><StatementsWorkspace /></StageScopeGate>} />
                  <Route path="tax"        element={<StageScopeGate stage="tax"><TaxWorkspace /></StageScopeGate>} />
                  <Route path="compliance" element={<StageScopeGate stage="compliance"><ComplianceWorkspace /></StageScopeGate>} />
                  <Route path="filing"     element={<StageScopeGate stage="filing"><FilingWorkspace /></StageScopeGate>} />
                  <Route path="monitor"    element={<StageScopeGate stage="monitor"><MonitorWorkspace /></StageScopeGate>} />

                  {/* Compatibility redirects — engine-named sub-routes → accounting slugs */}
                  <Route path="safisha"   element={<LegacySubRouteRedirect to="prepare" />} />
                  <Route path="hesabu"    element={<LegacySubRouteRedirect to="statements" />} />
                  <Route path="kinga"     element={<LegacySubRouteRedirect to="tax" />} />
                  <Route path="analytics" element={<LegacySubRouteRedirect to="monitor" />} />
                  <Route path="issues"    element={<LegacySubRouteRedirect to="compliance" />} />
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
                <Route path="/terms" element={<Terms />} />
                <Route path="/privacy" element={<Privacy />} />
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
