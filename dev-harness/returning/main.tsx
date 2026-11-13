// NON-PRODUCTION HARNESS. One engagement, one disposable PostgreSQL: the REAL Check my books view, the REAL Close Review adjustments view and
// the REAL reporting workbench (statements, comparatives, sign-off), each over the loopback bridge of scripts/db-proof/serveReturning.mjs.
//
//   ?bridge=http://127.0.0.1:54996&as=preparer   (as: owner | preparer | partner | viewer | outsider - a SIMULATED identity, not GoTrue)
//   #/close/books  #/close/adjustments  #/statements  #/statements/comparatives  #/signoff
//
// Isolation: outside src/, reachable only through the Vite dev server, refuses a production build and any non-loopback bridge; nothing under
// src/ imports it. NOT covered here (stated, not hidden): the app shell, GoTrue sign-in, the Trial Balance Review page (its harness is an
// in-memory synthetic backend and cannot share this engagement), Edge Function deployment.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import "../../src/index.css";
import { WorkbenchNav } from "../../src/components/workbench/WorkbenchNav";
import { ReportingWorkbench } from "../../src/components/reporting/ReportingWorkbench";
import type { ReportingPage } from "../../src/components/reporting/shared";
import { CheckBooksView } from "../../src/components/readiness/CheckBooksView";
import { AdjustmentsView } from "../../src/components/closeReview/AdjustmentsView";
import { readinessClient } from "../../src/lib/readiness/client";
import { adjustmentsClient } from "../../src/lib/closeReview/adjustments";
import { activeWorkbenchPage, deriveWorkbenchNavigation, WORKBENCH_GROUPS, type WorkbenchPageId } from "../../src/lib/workbench/routes";
import { parseReportVersion, withContext } from "../../src/lib/workbench/context";
import { assertLoopback, loadAllowed, reportingBridgeDb } from "../reporting/bridgeDb";
import { bridgeInvoke, loadReturningSeed } from "./bridgeClient";
import type { NavItem } from "../../src/lib/workspace/navigation";

if (!import.meta.env.DEV) throw new Error("dev-harness is a non-production tool and cannot run in a production build.");

const q = new URLSearchParams(window.location.search);
const bridge = q.get("bridge") ?? "http://127.0.0.1:54996";
const simUser = q.get("as") ?? "preparer";
assertLoopback(bridge);
const db = reportingBridgeDb(bridge, simUser);
const invoke = bridgeInvoke(bridge, simUser);
const readiness = readinessClient({ rpc: db.rpc }, invoke);
const adjustments = adjustmentsClient({ rpc: db.rpc });

const REPORTING = new Set<WorkbenchPageId>(["fs-statements", "fs-notes", "fs-schedules", "fs-comparatives", "signoff", "exports"]);
const ALL_PAGES = new Set<WorkbenchPageId>(WORKBENCH_GROUPS.flatMap((g) => g.pages.map((p) => p.id)));
const SEGMENT = Object.fromEntries(WORKBENCH_GROUPS.flatMap((g) => g.pages.map((p) => [p.id, p.segment]))) as Record<string, string>;
const ITEMS: NavItem[] = (["overview", "prepare", "statements"] as const).map((id) => ({ id, label: id, href: "/", disabled: false }));

interface Seed { companyId: string; periodYear: number; users: Record<string, string> }

function Harness({ seed }: { seed: Seed }) {
  const { pathname, search } = useLocation();
  const [allowed, setAllowed] = useState<string[]>([]);
  useEffect(() => { void loadAllowed(db, seed.companyId).then(setAllowed); }, [seed.companyId]);
  const page = activeWorkbenchPage(pathname, "");
  const version = parseReportVersion(search);
  const model = useMemo(() => deriveWorkbenchNavigation("", ITEMS, ALL_PAGES, true), []);
  return (
    <div className="min-h-screen" style={{ display: "grid", gridTemplateColumns: "15rem minmax(0, 1fr)" }}>
      <aside className="border-r border-border bg-muted/30 p-3" data-testid="workbench-nav">
        <p className="mb-3 text-xs text-muted-foreground">Harness · signed in as <strong data-testid="sim-user">{simUser}</strong> (simulated)</p>
        <WorkbenchNav model={model} activePage={page} reportVersion={version} groupStatus={() => null} />
      </aside>
      <main>
        {page === "close-books" ? (
          <div className="space-y-6 p-4">
            <h1 className="text-lg font-semibold">Close Review — Check my books · FY{seed.periodYear}</h1>
            <CheckBooksView companyId={seed.companyId} periodYear={seed.periodYear} client={readiness} allowed={allowed} />
          </div>
        ) : page === "close-adjustments" ? (
          <div className="space-y-6 p-4">
            <h1 className="text-lg font-semibold">Close Review — Adjustments · FY{seed.periodYear}</h1>
            <AdjustmentsView companyId={seed.companyId} periodYear={seed.periodYear} client={adjustments} allowed={allowed} currentUserId={seed.users[simUser] ?? null} />
          </div>
        ) : page && REPORTING.has(page) ? (
          <ReportingWorkbench key={`${page}`} page={page as ReportingPage} companyId={seed.companyId} periodYear={seed.periodYear} legalName="Returning Client Limited" db={db}
            allowed={allowed} reportVersion={version} hrefFor={(p, v) => withContext(`/${SEGMENT[p]}`, { reportVersion: v })} />
        ) : <p className="p-4 text-sm">Open <a className="text-primary underline" href="#/close/books">Check my books</a>.</p>}
      </main>
    </div>
  );
}

async function boot() {
  const seed = await loadReturningSeed<Seed>(bridge, simUser);
  createRoot(document.getElementById("root")!).render(<HashRouter><Routes><Route path="/*" element={<Harness seed={seed} />} /></Routes></HashRouter>);
}
void boot();
