// NON-PRODUCTION HARNESS. The trial-balance journey from the account home to the result, with synthetic data only:
//   · the REAL EngagementHub (account home) and its REAL FirstUpload, with the same callbacks Dashboard passes (the same
//     route helpers: engagementNextAction, firstUploadResultRoute);
//   · Dashboard's REAL returning-user routing decision (decideReturningUserRoute), so Back to /dashboard behaves as it
//     does in the app (one open engagement → its overview);
//   · the REAL `prepare` alias redirect and the REAL Prepare page (PrepareWorkspace + useWorkspaceData);
//   · the workspace Overview is NOT mounted here: its route shows a labelled placeholder with the URL it received.
// The backend is ../trial-balance/syntheticBackend.ts extended by ./syntheticClient.ts. The state is kept in this tab's
// sessionStorage so a page reload (refresh) finds the same synthetic records. Scenes: ?scene=first|draft|existing.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import "../../src/index.css";
import { Toaster } from "../../src/components/ui/sonner";
import EngagementHub from "../../src/pages/workspace/EngagementHub";
import PrepareWorkspace from "../../src/pages/workspace/PrepareWorkspace";
import { WorkbenchAliasRedirect } from "../../src/components/workbench/WorkbenchAliasRedirect";
import { useWorkspaceData } from "../../src/hooks/useWorkspaceData";
import { WorkspaceContext } from "../../src/contexts/WorkspaceContext";
import { EngagementContext, type EngagementContextValue } from "../../src/contexts/EngagementContext";
import { deriveWorkspaceState } from "../../src/lib/workspace/deriveWorkspaceState";
import { engagementNextAction, firstUploadResultRoute } from "../../src/lib/workspace/engagementNextAction";
import { applyForceHub, decideReturningUserRoute } from "../../src/lib/workspace/resolveReturningUserRoute";
import type { ActiveEngagementEntry } from "../../src/hooks/useActiveEngagements";
import type { WorkspacePurpose } from "../../src/lib/workspace/engagementGroups";
import type { UploadSnapshot } from "../../src/lib/workspace/types";
import { AuthProvider } from "../trial-balance/syntheticAuth";
import { COMPANY, ENGAGEMENT, PERIOD, harnessRestore, harnessSnapshot, supabase as base, tb } from "../trial-balance/syntheticBackend";
import { journey } from "./syntheticClient";

if (!import.meta.env.DEV) {
  throw new Error("dev-harness is a non-production tool and cannot run in a production build.");
}

const KEY = "journey-harness-state";
const OTHER_COMPANY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CSV = {
  balancedNeedsReview: "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n1100,Trade receivables,500.00,\n2000,Trade payables,,600.00\n4000,Sales revenue,,1400.00\n",
  replacement: "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1700.00,\n1100,Trade receivables,300.00,\n2000,Trade payables,,600.00\n4000,Sales revenue,,1400.00\n",
};
const purposes: Record<string, WorkspacePurpose> = {};

function save() {
  try { sessionStorage.setItem(KEY, JSON.stringify({ tb: harnessSnapshot(), drafts: journey.drafts, purposes })); } catch { /* */ }
}
setInterval(save, 300);
window.addEventListener("beforeunload", save);

async function seed(scene: string) {
  tb.tables.trial_balance_uploads = []; tb.tables.tb_certifications = []; tb.tables.account_mappings = [];
  journey.drafts = [];
  if (scene === "first" || scene === "draft") {
    tb.tables.companies = []; tb.tables.fiscal_periods = [];
  }
  if (scene === "draft") {
    const draftId = "dddd0001-0000-4000-8000-000000000000";
    const path = `drafts/synthetic/${draftId}`;
    tb.blobs[path] = new TextEncoder().encode(CSV.balancedNeedsReview);
    journey.drafts.push({ draft_id: draftId, key: "seed", file_name: "fy2025-trial-balance.csv", file_size: CSV.balancedNeedsReview.length, object_path: path, expires_at: new Date(Date.now() + 864e5).toISOString(), state: "reserved", stored: true });
  }
  if (scene === "existing") {
    tb.tables.fiscal_periods = [{ id: PERIOD, company_id: COMPANY, reporting_currency: "TZS", reporting_start: "2025-01-01", reporting_end: "2025-12-31" }];
    const uploadId = "upld0001-0000-4000-8000-000000000000";
    const path = `workspaces/${COMPANY}/${uploadId}/fy2025-original.csv`;
    tb.blobs[path] = new TextEncoder().encode(CSV.balancedNeedsReview);
    tb.tables.trial_balance_uploads.unshift({
      id: uploadId, file_name: "fy2025-original.csv", file_path: path, file_size: CSV.balancedNeedsReview.length, status: "processing",
      company_id: COMPANY, company_name: "Synthetic Trading Co", period_year: 2025, period_id: PERIOD, engagement_id: ENGAGEMENT,
      uploaded_at: new Date().toISOString(), processed_at: null, is_valid: null, validation_report: null, accounting_errors: null, processing_result: null,
      safisha_status: null, lifecycle_state: "active_unprocessed", version: 1,
    });
    await base.functions.invoke("process-trial-balance", { body: { uploadId, clientRequestId: "seed-check" } });
  }
  save();
}

/** The latest active upload as the snapshot deriveWorkspaceState reads (a harness approximation of fetchWorkspaceSnapshot). */
function snapshotFor(companyId: string, name: string): UploadSnapshot | null {
  const u = tb.tables.trial_balance_uploads.find((x) => x.company_id === companyId && ["active_unprocessed", "active_processing", "active_processed", "blocked"].includes(String(x.lifecycle_state)));
  if (!u) return null;
  const cert = [...tb.tables.tb_certifications].reverse().find((c) => c.upload_id === u.id);
  const verdict = !cert ? "pending" : cert.is_blocking ? "blocked" : cert.requires_review ? "review" : "certified";
  return { id: String(u.id), companyId, companyName: name, periodYear: 2025, status: String(u.status), isValid: (u.is_valid as boolean | null) ?? null, safishaStatus: null,
    uploadedAt: String(u.uploaded_at), processedAt: (u.processed_at as string | null) ?? null, hasMapping: true, certificationVerdict: verdict };
}

function entriesNow(): ActiveEngagementEntry[] {
  const out: ActiveEngagementEntry[] = [];
  const company = tb.tables.companies.find((c) => c.id === COMPANY);
  const period = tb.tables.fiscal_periods.find((p) => p.id === PERIOD);
  const entry = (companyId: string, name: string, engagementId: string, state: ActiveEngagementEntry["workspaceState"], start: string | null, end: string | null): ActiveEngagementEntry => ({
    engagementId, companyId, companyName: name, periodYear: 2025, engagementType: "composite", framework: null, capabilities: ["FINANCIAL_STATEMENTS"],
    workspaceState: state, openedAt: "2026-10-01T00:00:00Z", periodStart: start, periodEnd: end, workspacePurpose: purposes[companyId] ?? null,
  });
  if (company && period) {
    const name = String(company.name);
    out.push(entry(COMPANY, name, ENGAGEMENT, deriveWorkspaceState(COMPANY, name, 2025, snapshotFor(COMPANY, name)), String(period.reporting_start ?? "2025-01-01"), String(period.reporting_end ?? "2025-12-31")));
  }
  if (new URLSearchParams(location.search).get("scene") === "existing") {
    // A second engagement (pure state only, no records behind it) so the account home lists more than one.
    out.push(entry(OTHER_COMPANY, "Synthetic Services Ltd", "eeeeeeee-0000-4000-8000-00000000000b",
      deriveWorkspaceState(OTHER_COMPANY, "Synthetic Services Ltd", 2025, { id: "other-upload", companyId: OTHER_COMPANY, companyName: "Synthetic Services Ltd", periodYear: 2025, status: "needs_review", isValid: null, safishaStatus: null, uploadedAt: "2026-10-01T00:00:00Z", processedAt: "2026-10-01T00:01:00Z", hasMapping: true, certificationVerdict: "review" }),
      "2025-01-01", "2025-12-31"));
  }
  return out;
}

const BILLING = { hasBillingCustomer: true, planCode: "STARTER", licenceStatus: "ACTIVE", effectiveStart: "2026-01-01", effectiveEnd: null, entitlements: [], billingInterval: null, billingIntervalCount: null, scheduledEffectiveEnd: null, nextEffectiveStart: null, nextEffectiveEnd: null, nextBillingInterval: null, nextBillingIntervalCount: null } as const;

function Hub() {
  const navigate = useNavigate();
  const location = useLocation();
  const [, force] = useState(0);
  // Read once on arrival and after a recorded purpose, as useActiveEngagements does (it is not a live subscription).
  const [entries, setEntries] = useState(entriesNow);
  const forceHub = !!(location.state as { forceHub?: boolean } | null)?.forceHub;
  const route = applyForceHub(decideReturningUserRoute(entries, [], [], 0), forceHub);
  if (route.kind === "resume") return <Navigate to={`/workspace/${route.entry.companyId}/${route.entry.periodYear}`} replace />;
  return (
    <EngagementHub
      entries={entries}
      companiesWithoutEngagement={[]}
      onResume={(e) => navigate(engagementNextAction(e.workspaceState).href)}
      onStartService={() => undefined}
      onSetPurpose={async (companyId, purpose, reason) => {
        if (reason.trim().length < 3) return "Not recorded: a reason of at least 3 characters is required.";
        if (purposes[companyId] === purpose) return "That purpose is already recorded.";
        purposes[companyId] = purpose; setEntries(entriesNow()); force((n) => n + 1); return "Recorded.";
      }}
      account={{
        billing: BILLING as never, billingLoading: false, billingError: false,
        capacity: { capacity: 3, used: tb.tables.companies.length, planCode: "STARTER", determined: true }, capacityLoading: false, capacityError: false,
        onRetry: () => undefined, onSignOut: () => undefined,
        onCompanyCreated: (companyId, year) => navigate(`/workspace/${companyId}/${year}`, { replace: true }),
        onOpenTrialBalance: (companyId, year, uploadId) => navigate(firstUploadResultRoute(companyId, year, uploadId)),
        initialAddOpen: tb.tables.companies.length === 0,
      }}
    />
  );
}

function OverviewPlaceholder() {
  const { companyId, periodYear } = useParams();
  const navigate = useNavigate();
  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }} data-testid="overview-placeholder">
      <p><b>Workspace overview — not mounted in this harness.</b></p>
      <p>Entity <code data-testid="overview-company">{companyId}</code>, period <code data-testid="overview-year">{periodYear}</code>.</p>
      <p><button onClick={() => navigate(`/workspace/${companyId}/${periodYear}/prepare`)}>Open the trial balance (Prepare)</button>{" "}
        <button onClick={() => navigate("/dashboard", { state: { forceHub: true } })}>Account home (logo)</button></p>
    </div>
  );
}

const engagement = {
  engagement: { id: ENGAGEMENT, fiscal_period_id: PERIOD, company_id: COMPANY },
  mandate: { capabilities: ["FINANCIAL_STATEMENTS"] }, authorities: [], events: [], canAmend: true, loading: false,
  refresh: () => undefined, createEngagement: async () => undefined, grantCapability: async () => undefined, revokeCapability: async () => undefined,
  missionViews: [],
} as unknown as EngagementContextValue;

function Prepare() {
  const data = useWorkspaceData();
  const navigate = useNavigate();
  return (
    <WorkspaceContext.Provider value={data}>
      <EngagementContext.Provider value={engagement}>
        <div style={{ padding: "6px 16px", fontSize: 12 }}><button data-testid="harness-home" onClick={() => navigate("/dashboard", { state: { forceHub: true } })}>← Account home (logo)</button></div>
        <div style={{ padding: 16 }}><PrepareWorkspace /></div>
      </EngagementContext.Provider>
    </WorkspaceContext.Provider>
  );
}

function Bar() {
  const location = useLocation();
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 400); return () => clearInterval(t); }, []);
  return (
    <div style={{ padding: 6, fontFamily: "monospace", fontSize: 11, borderBottom: "1px solid #ccc", display: "flex", flexWrap: "wrap", gap: 6, overflowWrap: "anywhere" }} data-testid="harness-bar">
      <span>SYNTHETIC HARNESS · route <b data-testid="harness-route">{location.pathname + location.search}</b></span>
      <button data-testid="refuse-period" onClick={() => { journey.refusePeriod = "CURRENCY_DIFFERS_FROM_EXISTING"; force((n) => n + 1); }}>refuse next period ({journey.refusePeriod ?? "off"})</button>
      <button data-testid="inject-in_progress" onClick={() => { tb.inject = "in_progress"; }}>next check: in progress</button>
      <button data-testid="inject-server_error" onClick={() => { tb.inject = "server_error"; }}>next check: 503</button>
    </div>
  );
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const scene = params.get("scene") ?? "first";
  const saved = (() => { try { return sessionStorage.getItem(KEY); } catch { return null; } })();
  if (saved && !params.has("reset")) {
    const s = JSON.parse(saved) as { tb: string; drafts: typeof journey.drafts; purposes: typeof purposes };
    harnessRestore(s.tb); journey.drafts = s.drafts; Object.assign(purposes, s.purposes);
  } else {
    if (params.has("reset")) history.replaceState(null, "", `${location.pathname}?scene=${encodeURIComponent(scene)}${location.hash}`);
    await seed(scene);
  }
  if (!location.hash) location.hash = "#/dashboard";
  createRoot(document.getElementById("root")!).render(
    <HashRouter>
      <AuthProvider>
        <Bar />
        <Routes>
          <Route path="/dashboard" element={<Hub />} />
          <Route path="/workspace/:companyId/:periodYear" element={<OverviewPlaceholder />} />
          <Route path="/workspace/:companyId/:periodYear/prepare" element={<WorkbenchAliasRedirect segment="prepare" />} />
          <Route path="/workspace/:companyId/:periodYear/trial-balance/review" element={<Prepare />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        <Toaster />
      </AuthProvider>
    </HashRouter>,
  );
}
void boot();
