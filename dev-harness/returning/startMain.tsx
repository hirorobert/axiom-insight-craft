// NON-PRODUCTION HARNESS. The returning-client journey from the REAL Trial Balance Review page: one engagement, one disposable PostgreSQL.
// The accountant uploads the new year's trial balance on the REAL Prepare page (PrepareWorkspace + useWorkspaceData; reserve -> signed URL -> register ->
// the real process-trial-balance handler, all over the loopback bridge), then goes on to the REAL Check my books view, Close Review adjustments and
// reporting workbench in the SAME engagement.
//
//   ?bridge=http://127.0.0.1:54996&as=preparer  (as: owner | preparer | partner | viewer | outsider - a SIMULATED identity, not GoTrue)
//   #/workspace/<company>/2026/trial-balance/review   #/close/books   #/close/adjustments   #/statements   #/signoff
//
// Isolation: outside src/, reachable only through the Vite dev server (vite.start.config.ts, which swaps the Supabase client and the auth context for
// loopback stand-ins), refuses a production build and any non-loopback bridge; nothing under src/ imports it. NOT covered (stated): the app shell and
// workspace layout, GoTrue sign-in, the account home, Edge Function deployment, the engagement mandate context (stubbed - its own journey covers it).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import "../../src/index.css";
import { Toaster } from "../../src/components/ui/sonner";
import { WorkbenchNav } from "../../src/components/workbench/WorkbenchNav";
import { ReportingWorkbench } from "../../src/components/reporting/ReportingWorkbench";
import type { ReportingPage } from "../../src/components/reporting/shared";
import { CheckBooksView } from "../../src/components/readiness/CheckBooksView";
import { AdjustmentsView } from "../../src/components/closeReview/AdjustmentsView";
import PrepareWorkspace from "../../src/pages/workspace/PrepareWorkspace";
import { useWorkspaceData } from "../../src/hooks/useWorkspaceData";
import { WorkspaceContext } from "../../src/contexts/WorkspaceContext";
import { EngagementContext, type EngagementContextValue } from "../../src/contexts/EngagementContext";
import { readinessClient } from "../../src/lib/readiness/client";
import { adjustmentsClient } from "../../src/lib/closeReview/adjustments";
import { activeWorkbenchPage, deriveWorkbenchNavigation, WORKBENCH_GROUPS, type WorkbenchPageId } from "../../src/lib/workbench/routes";
import { parseReportVersion, withContext } from "../../src/lib/workbench/context";
import { loadAllowed, reportingBridgeDb } from "../reporting/bridgeDb";
import { bridgeInvoke, loadReturningSeed } from "./bridgeClient";
import { BRIDGE, SIM_USER } from "./bridgeSupabase";
import { AuthProvider } from "./startAuth";
import type { NavItem } from "../../src/lib/workspace/navigation";

if (!import.meta.env.DEV) throw new Error("dev-harness is a non-production tool and cannot run in a production build.");

const db = reportingBridgeDb(BRIDGE, SIM_USER);
const invoke = bridgeInvoke(BRIDGE, SIM_USER);
const readiness = readinessClient({ rpc: db.rpc }, invoke);
const adjustments = adjustmentsClient({ rpc: db.rpc });

const REPORTING = new Set<WorkbenchPageId>(["fs-statements", "fs-notes", "fs-schedules", "fs-comparatives", "signoff", "exports"]);
const ALL_PAGES = new Set<WorkbenchPageId>(WORKBENCH_GROUPS.flatMap((g) => g.pages.map((p) => p.id)));
const SEGMENT = Object.fromEntries(WORKBENCH_GROUPS.flatMap((g) => g.pages.map((p) => [p.id, p.segment]))) as Record<string, string>;
const ITEMS: NavItem[] = (["overview", "prepare", "statements"] as const).map((id) => ({ id, label: id, href: "/", disabled: false }));

interface Seed { companyId: string; periodId: string | null; engagementId: string | null; periodYear: number; users: Record<string, string> }

function Shell({ seed, children }: { seed: Seed; children: ReactNode }) {
  const [allowed, setAllowed] = useState<string[]>([]);
  useEffect(() => { void loadAllowed(db, seed.companyId).then(setAllowed); }, [seed.companyId]);
  const model = useMemo(() => deriveWorkbenchNavigation("", ITEMS, ALL_PAGES, true), []);
  const { pathname, search } = useLocation();
  const page = activeWorkbenchPage(pathname, "");
  return (
    <div className="min-h-screen" style={{ display: "grid", gridTemplateColumns: "15rem minmax(0, 1fr)" }}>
      <aside className="border-r border-border bg-muted/30 p-3" data-testid="workbench-nav">
        <p className="mb-3 text-xs text-muted-foreground">Harness · signed in as <strong data-testid="sim-user">{SIM_USER}</strong> (simulated)</p>
        <a className="mb-3 block text-sm text-primary underline" data-testid="nav-trial-balance" href={`#/workspace/${seed.companyId}/${seed.periodYear}/trial-balance/review`}>Trial balance</a>
        <WorkbenchNav model={model} activePage={page} reportVersion={parseReportVersion(search)} groupStatus={() => null} />
      </aside>
      <main data-allowed={allowed.join(",")}>{children}</main>
    </div>
  );
}

function engagementFor(seed: Seed): EngagementContextValue {
  return { engagement: { id: seed.engagementId, fiscal_period_id: seed.periodId, company_id: seed.companyId }, mandate: { capabilities: ["FINANCIAL_STATEMENTS"] }, authorities: [], events: [], canAmend: true, loading: false,
  refresh: () => undefined, createEngagement: async () => undefined, grantCapability: async () => undefined, revokeCapability: async () => undefined, missionViews: [] } as unknown as EngagementContextValue;
}

function Prepare({ seed }: { seed: Seed }) {
  const data = useWorkspaceData();
  const engagement = useMemo(() => engagementFor(seed), [seed]);
  return (
    <Shell seed={seed}>
      <WorkspaceContext.Provider value={data}>
        <EngagementContext.Provider value={engagement}>
          <div style={{ padding: 16 }} data-testid="prepare-page"><PrepareWorkspace /></div>
        </EngagementContext.Provider>
      </WorkspaceContext.Provider>
    </Shell>
  );
}

function Workbench({ seed }: { seed: Seed }) {
  const { pathname, search } = useLocation();
  const [allowed, setAllowed] = useState<string[]>([]);
  useEffect(() => { void loadAllowed(db, seed.companyId).then(setAllowed); }, [seed.companyId]);
  const page = activeWorkbenchPage(pathname, "");
  const version = parseReportVersion(search);
  return (
    <Shell seed={seed}>
      {page === "close-books" ? (
        <div className="space-y-6 p-4">
          <h1 className="text-lg font-semibold">Close Review — Check my books · FY{seed.periodYear}</h1>
          <CheckBooksView companyId={seed.companyId} periodYear={seed.periodYear} client={readiness} allowed={allowed} />
        </div>
      ) : page === "close-adjustments" ? (
        <div className="space-y-6 p-4">
          <h1 className="text-lg font-semibold">Close Review — Adjustments · FY{seed.periodYear}</h1>
          <AdjustmentsView companyId={seed.companyId} periodYear={seed.periodYear} client={adjustments} allowed={allowed} currentUserId={seed.users[SIM_USER] ?? null} />
        </div>
      ) : page && REPORTING.has(page) ? (
        <ReportingWorkbench key={`${page}`} page={page as ReportingPage} companyId={seed.companyId} periodYear={seed.periodYear} legalName="Returning Client Limited" db={db}
          allowed={allowed} reportVersion={version} hrefFor={(p, v) => withContext(`/${SEGMENT[p]}`, { reportVersion: v })} />
      ) : <p className="p-4 text-sm">Open <a className="text-primary underline" href="#/close/books">Check my books</a>.</p>}
    </Shell>
  );
}

async function boot() {
  const seed = await loadReturningSeed<Seed>(BRIDGE, SIM_USER);
  if (!location.hash) location.hash = `#/workspace/${seed.companyId}/${seed.periodYear}/trial-balance/review`;
  createRoot(document.getElementById("root")!).render(
    <HashRouter><AuthProvider>
      <Routes>
        <Route path="/workspace/:companyId/:periodYear/trial-balance/review" element={<Prepare seed={seed} />} />
        <Route path="/*" element={<Workbench seed={seed} />} />
      </Routes>
      <Toaster />
    </AuthProvider></HashRouter>,
  );
}
void boot();
