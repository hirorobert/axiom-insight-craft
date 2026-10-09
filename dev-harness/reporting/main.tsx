// NON-PRODUCTION HARNESS. Renders the real reporting workbench (five-group navigation, the six reporting pages) against
// a DISPOSABLE PostgreSQL through the loopback bridge of scripts/db-proof/serveReporting.mjs.
//
//   ?bridge=http://127.0.0.1:54998&as=preparer   (as: owner | preparer | partner | viewer | outsider — a SIMULATED
//                                                 identity named to the bridge, not GoTrue authentication)
//   #/statements/notes?v=2                       (the workbench route and the selected report version)
//
// Isolation: outside src/, reachable only through the Vite dev server, refuses to run in a production build, refuses a
// non-loopback bridge, and nothing under src/ imports it. The navigation shows every reporting page here; in the product
// only RELEASED_WORKBENCH_PAGES are reachable (that release is a separate, reviewed gate change).
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import "../../src/index.css";
import { WorkbenchNav } from "../../src/components/workbench/WorkbenchNav";
import { ReportingWorkbench } from "../../src/components/reporting/ReportingWorkbench";
import type { ReportingPage } from "../../src/components/reporting/shared";
import { activeWorkbenchPage, deriveWorkbenchNavigation, WORKBENCH_GROUPS, type WorkbenchPageId } from "../../src/lib/workbench/routes";
import { parseReportVersion, withContext } from "../../src/lib/workbench/context";
import { loadAllowed, loadReportingSeed, reportingBridgeDb } from "./bridgeDb";
import type { NavItem } from "../../src/lib/workspace/navigation";

if (!import.meta.env.DEV) throw new Error("dev-harness is a non-production tool and cannot run in a production build.");

const q = new URLSearchParams(window.location.search);
const bridge = q.get("bridge") ?? "http://127.0.0.1:54998";
const simUser = q.get("as") ?? "preparer";
const db = reportingBridgeDb(bridge, simUser);

const REPORTING = new Set<WorkbenchPageId>(["fs-statements", "fs-notes", "fs-schedules", "fs-comparatives", "signoff", "exports"]);
const ALL_PAGES = new Set<WorkbenchPageId>(WORKBENCH_GROUPS.flatMap((g) => g.pages.map((p) => p.id)));
const SEGMENT = Object.fromEntries(WORKBENCH_GROUPS.flatMap((g) => g.pages.map((p) => [p.id, p.segment]))) as Record<string, string>;
const ITEMS: NavItem[] = (["overview", "prepare", "statements"] as const).map((id) => ({ id, label: id, href: "/", disabled: false }));

function Harness({ seed }: { seed: { companyId: string; periodYear: number } }) {
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
        {page && REPORTING.has(page) ? (
          <ReportingWorkbench key={`${page}`} page={page as ReportingPage} companyId={seed.companyId} periodYear={seed.periodYear} legalName="Synthetic SME Limited" db={db}
            allowed={allowed} reportVersion={version} hrefFor={(p, v) => withContext(`/${SEGMENT[p]}`, { reportVersion: v })} />
        ) : <p className="p-4 text-sm">This harness renders the reporting pages only. Open <a className="text-primary underline" href="#/statements">Statements</a>.</p>}
      </main>
    </div>
  );
}

async function boot() {
  const seed = await loadReportingSeed(bridge, simUser);
  createRoot(document.getElementById("root")!).render(
    <HashRouter><Routes><Route path="/*" element={<Harness seed={seed} />} /></Routes></HashRouter>,
  );
}
void boot();
