import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { SessionTimeoutProvider } from "@/components/SessionTimeoutProvider";
import Index from "./pages/Index";
import Dashboard from "./pages/Dashboard";
import Auth from "./pages/Auth";
import Settings from "./pages/Settings";
import UploadStatus from "./pages/UploadStatus";
import NotFound from "./pages/NotFound";

// Workspace architecture
import WorkspaceLayout from "./pages/workspace/WorkspaceLayout";
import WorkspaceOverview from "./pages/workspace/WorkspaceOverview";
import SafishaWorkspace from "./pages/workspace/SafishaWorkspace";
import HesabuWorkspace from "./pages/workspace/HesabuWorkspace";
import KingaWorkspace from "./pages/workspace/KingaWorkspace";
import FilingWorkspace from "./pages/workspace/FilingWorkspace";
import AnalyticsWorkspace from "./pages/workspace/AnalyticsWorkspace";
import IssuesWorkspace from "./pages/workspace/IssuesWorkspace";

const queryClient = new QueryClient();

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
                <Route path="/" element={<Index />} />
                {/* Workspace architecture — primary post-login experience */}
                <Route
                  path="/workspace/:companyId/:periodYear"
                  element={
                    <PageErrorBoundary pageName="Workspace">
                      <WorkspaceLayout />
                    </PageErrorBoundary>
                  }
                >
                  <Route index element={<WorkspaceOverview />} />
                  <Route path="safisha"   element={<SafishaWorkspace />} />
                  <Route path="hesabu"    element={<HesabuWorkspace />} />
                  <Route path="kinga"     element={<KingaWorkspace />} />
                  <Route path="filing"    element={<FilingWorkspace />} />
                  <Route path="analytics" element={<AnalyticsWorkspace />} />
                  <Route path="issues"    element={<IssuesWorkspace />} />
                </Route>
                {/* Dashboard — compatibility redirect; select company/period then goes to workspace */}
                <Route
                  path="/dashboard"
                  element={
                    <PageErrorBoundary pageName="Dashboard">
                      <Dashboard />
                    </PageErrorBoundary>
                  }
                />
                <Route path="/auth" element={<Auth />} />
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
