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
import { compositionClient } from "@/lib/statements/composition";
import { notesClient } from "@/lib/notes/notesStatus";
import { comparativesClient } from "@/lib/comparatives/comparatives";
import { signoffClient, type SavedVersion } from "@/lib/reporting/signoff";
import { nextReportingAction, type NextAction } from "@/lib/reporting/nextAction";
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
  const clients = useMemo(() => ({ composition: compositionClient(p.db), notes: notesClient(p.db), comparatives: comparativesClient(p.db), signoff: signoffClient(p.db) }), [p.db]);
  const [state, setState] = useState<ReportingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    try {
      const [composition, notes, comparatives, versions] = await Promise.all([
        clients.composition.compose(p.companyId, p.periodYear), clients.notes.status(p.companyId, p.periodYear),
        clients.comparatives.status(p.companyId, p.periodYear), clients.signoff.versions(p.companyId, p.periodYear).catch(() => [] as SavedVersion[]),
      ]);
      const last = [...versions].filter((v) => v.isLatest).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
      const r = last ? await clients.signoff.readiness(p.companyId, last.reportId, last.reportVersion) : null;
      if (mine === seq.current) setState({ composition, notes, comparatives, versions, latest: last && r ? { version: last, blockers: r.blockers, ready: r.ready } : null });
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : "The reporting state could not be read.");
    }
  }, [clients, p.companyId, p.periodYear]);
  useEffect(() => { void load(); }, [load]);

  const next: NextAction | null = state ? nextReportingAction({
    composition: state.composition, notes: state.notes, comparatives: state.comparatives, allowed: p.allowed,
    latest: state.latest ? { reportVersion: state.latest.version.reportVersion, state: state.latest.version.state, blockers: state.latest.blockers } : null,
  }) : null;

  return (
    <div className="space-y-4 p-4" data-testid="reporting-workbench">
      <h1 className="text-lg font-semibold">{TITLES[p.page]} · FY{p.periodYear}</h1>
      {error ? (
        <p role="alert" className="text-sm">The reporting state could not be read: {error}{" "}
          <button type="button" className="rounded-md border border-input px-2 py-0.5" onClick={() => void load()}>Try again</button></p>
      ) : !state ? <p role="status" className="text-sm text-muted-foreground">Reading the statements, notes and comparatives…</p> : (
        <>
          {next ? <NextActionBar action={next} current={p.page} href={p.hrefFor(next.page as ReportingPage, p.reportVersion)} /> : null}
          <Page {...p} state={state} clients={clients} refresh={load} />
        </>
      )}
    </div>
  );
}

/** The one dominant next action: a link to the page that owns it, or the plain statement when it is on this page. */
function NextActionBar({ action, current, href }: { action: NextAction; current: ReportingPage; href: string }) {
  const tone = action.tone === "done" ? "border-[#22663f] bg-[#eef7f1]" : action.tone === "blocked" ? "border-[#5f6b7a] bg-muted/40" : "border-primary bg-[#eef3fb]";
  return (
    <section aria-label="Next action" data-testid="next-action" data-tone={action.tone} className={`border-l-[3px] px-3 py-2 text-sm ${tone}`}>
      <p className="font-semibold">{action.page === current ? action.title : <Link to={href} className="text-primary underline">{action.title} →</Link>}</p>
      <p className="text-muted-foreground">{action.detail}</p>
    </section>
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

