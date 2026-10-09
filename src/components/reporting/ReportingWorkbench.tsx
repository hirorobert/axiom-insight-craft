/**
 * The reporting workbench (Financial Statements › Statements, Notes, Schedules, Comparatives; Sign-off & Exports ›
 * Sign-off, Exports). One container reads every server state the pages share — composition, notes, comparatives, saved
 * versions and the latest version's readiness — derives the ONE next action from them, and renders the requested page.
 *
 * Reads only. Every write is a server function called from the page that owns it; after a write the container re-reads
 * everything (nothing is patched locally). Responses that arrive after the context changed are discarded.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { NextAction } from "@/lib/reporting/nextAction";
import { nextActionFor, readReportingSnapshot, reportingClients } from "@/lib/reporting/reportingState";
import type { PageProps, ReportingPage, ReportingProps, ReportingState } from "./shared";
import { StatementsView } from "./StatementsView";
import { NotesView } from "./NotesView";
import { SchedulesView } from "./SchedulesView";
import { ComparativesView } from "./ComparativesView";
import { SignoffView } from "./SignoffView";
import { ExportsView } from "./ExportsView";

const TITLES: Record<ReportingPage, string> = {
  "fs-statements": "Statements", "fs-notes": "Notes", "fs-schedules": "Schedules", "fs-comparatives": "Comparatives", signoff: "Sign-off", exports: "Exports",
};

export function ReportingWorkbench(p: ReportingProps) {
  const clients = useMemo(() => reportingClients(p.db), [p.db]);
  const [state, setState] = useState<ReportingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    try {
      const s = await readReportingSnapshot(p.db, clients, p.companyId, p.periodYear);
      if (mine === seq.current) setState(s);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : "The reporting state could not be read.");
    }
  }, [clients, p.db, p.companyId, p.periodYear]);
  useEffect(() => { void load(); }, [load]);

  const next: NextAction | null = state ? nextActionFor(state, p.allowed) : null;

  return (
    <div className="space-y-4 p-4" data-testid="reporting-workbench">
      <h1 className="text-lg font-semibold">{TITLES[p.page]} · FY{p.periodYear}</h1>
      {error ? (
        <p role="alert" className="text-sm">The reporting state could not be read: {error}{" "}
          <button type="button" className="rounded-md border border-input px-2 py-0.5" onClick={() => void load()}>Try again</button></p>
      ) : !state ? <p role="status" className="text-sm text-muted-foreground">Reading the statements, notes and comparatives…</p> : (
        <>
          {/* The page's own task leads. The report's next action is the dominant bar only on the page that owns it;
              elsewhere it is one quiet line, so (for example) open notes never dominate Schedules or Sign-off. */}
          {next && next.page === p.page ? <NextActionBar action={next} /> : null}
          {next && next.page !== p.page ? <NextElsewhere action={next} href={p.hrefFor(next.page as ReportingPage, p.reportVersion)} /> : null}
          <Page {...p} state={state} clients={clients} refresh={load} />
        </>
      )}
    </div>
  );
}

/** The one dominant next action, on the page that owns it. */
function NextActionBar({ action }: { action: NextAction }) {
  const tone = action.tone === "done" ? "border-[#22663f] bg-[#eef7f1]" : action.tone === "blocked" ? "border-[#5f6b7a] bg-muted/40" : "border-primary bg-[#eef3fb]";
  return (
    <section aria-label="Next action" data-testid="next-action" data-tone={action.tone} className={`border-l-[3px] px-3 py-2 text-sm ${tone}`}>
      <p className="font-semibold">{action.title}</p>
      <p className="text-muted-foreground">{action.detail}</p>
    </section>
  );
}

/** The report's next action when another page owns it: one line, a link, no detail. */
function NextElsewhere({ action, href }: { action: NextAction; href: string }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid="next-action" data-tone={action.tone} data-elsewhere="true">
      Next for this report: <Link to={href} className="text-primary underline">{action.title} →</Link>
    </p>
  );
}

function Page(p: PageProps) {
  switch (p.page) {
    case "fs-statements": return <StatementsView {...p} />;
    case "fs-notes": return <NotesView {...p} />;
    case "fs-schedules": return <SchedulesView {...p} />;
    case "fs-comparatives": return <ComparativesView {...p} />;
    case "signoff": return <SignoffView {...p} />;
    case "exports": return <ExportsView {...p} />;
  }
}

