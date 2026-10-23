// NON-PRODUCTION: actual application pages, simulated transport and auth. Never included in the application build.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Routes, Route, useLocation } from "react-router-dom";
import { AuthProvider } from "../trial-balance/syntheticAuth";
import "./client";
import "../../src/index.css";
import Dashboard from "../../src/pages/Dashboard";
import AddCompany from "../../src/pages/AddCompany";
import Settings from "../../src/pages/Settings";
import WorkspaceLayout from "../../src/pages/workspace/WorkspaceLayout";
import WorkspaceOverview from "../../src/pages/workspace/WorkspaceOverview";
import PrepareWorkspace from "../../src/pages/workspace/PrepareWorkspace";
import TrialBalanceIntake from "../../src/pages/workspace/TrialBalanceIntake";
import { ManagementRouter } from "../../src/components/account/ManagementWindow";
import { WorkbenchAliasRedirect } from "../../src/components/workbench/WorkbenchAliasRedirect";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { Toaster } from "../../src/components/ui/sonner";
import { ActivityProvider } from "../../src/components/feedback/Activity";

if (!import.meta.env.DEV) throw new Error("Non-production harness only");
function Harness() {
  const l = useLocation();
  return <><div className="bg-amber-50 px-3 py-1 text-xs" data-testid="fixture-route">ISOLATED UI FIXTURE · {l.pathname}{l.search}{l.hash}</div>
    <ManagementRouter>{(location) => <Routes location={location}>
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/companies/new" element={<AddCompany />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/workspace/:companyId/:periodYear" element={<WorkspaceLayout />}>
        <Route index element={<WorkspaceOverview />} />
        <Route path="prepare" element={<WorkbenchAliasRedirect segment="prepare" />} />
        <Route path="trial-balance/review" element={<PrepareWorkspace />} />
        <Route path="trial-balance/intake" element={<TrialBalanceIntake />} />
      </Route>
      <Route path="*" element={<Dashboard />} />
    </Routes>}</ManagementRouter><Toaster /></>;
}
const router = createBrowserRouter([{ path: "*", element: <Harness /> }]);
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><TooltipProvider><AuthProvider><ActivityProvider><RouterProvider router={router} /></ActivityProvider></AuthProvider></TooltipProvider></QueryClientProvider>);
