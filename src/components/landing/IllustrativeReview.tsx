/**
 * IllustrativeReview (id="sample") — the sample review on invented data, opened by the hero's primary action.
 *
 *  - A compact summary: "Balanced · N accounts need your review." with the invented-data label, two actions, and the checks
 *    and account list behind native disclosures.
 *  - "View completed example" (#completed-example): a read-only view of the decisions SUPPLIED with the example — who, when,
 *    on what invented basis — and the remaining limitations. It holds no recording control and never changes the visitor's
 *    decisions.
 *  - "Try the two decisions" (optional): selecting records nothing; only "Record decision" records, as "Sample reviewer".
 *    Each held account carries the label "Guided example—not automated evidence checking." The statement equation stays
 *    pending until every account has a category.
 *
 * All logic is in ./illustrativeReviewModel (pure, deterministic). This component reads no clock, storage or network; the
 * only browser state it touches is location.hash, to switch between the sample and the completed example.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LANDING_SAMPLE_COPY as C } from "@/content/landing/landingContent";
import {
  SAMPLE_COMPANY,
  SAMPLE_HELD_ACCOUNTS,
  SAMPLE_MAPPED_ACCOUNTS,
  SAMPLE_SUPPLIED_DECISIONS,
} from "@/content/landing/illustrativeReview";
import {
  INITIAL_VISITOR_STATE,
  currentDecision,
  decisionStanding,
  formatMinor,
  isReady,
  suppliedEquation,
  undecidedCount,
  unsupportedCount,
  visitorEquation,
  visitorReducer,
  type StatementEquation,
} from "./illustrativeReviewModel";

const COMPLETED_HASH = "#completed-example";
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function equationLine(eq: StatementEquation): string {
  return `Assets ${formatMinor(eq.assetsMinor)} = liabilities ${formatMinor(eq.liabilitiesMinor)} + equity ${formatMinor(eq.equityMinor)} + period result ${formatMinor(eq.resultMinor)}.`;
}

function Disclosure({ title, summary, testId, children }: { title: string; summary: string; testId: string; children: React.ReactNode }) {
  return (
    <details className="group border-t border-border" data-testid={testId}>
      <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-[15px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-6 [&::-webkit-details-marker]:hidden">
        {title}
        <span className="font-normal text-muted-foreground">{summary}</span>
        <span className="ml-auto text-sm font-normal text-muted-foreground group-open:hidden" aria-hidden="true">Show</span>
        <span className="ml-auto hidden text-sm font-normal text-muted-foreground group-open:inline" aria-hidden="true">Hide</span>
      </summary>
      <div className="px-4 pb-5 sm:px-6">{children}</div>
    </details>
  );
}

function SampleHead() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
      <p className="text-sm">
        <span className="font-semibold text-foreground">{SAMPLE_COMPANY.name}</span>{" "}
        <span className="text-muted-foreground">· {SAMPLE_COMPANY.period} · {SAMPLE_COMPANY.accountCount} accounts · {SAMPLE_COMPANY.currency}</span>
      </p>
      <span className="border-2 border-dashed border-muted-foreground px-2.5 py-1 text-xs font-bold text-foreground" data-testid="sample-label">{C.label}</span>
    </div>
  );
}

export function IllustrativeReview() {
  const [state, dispatch] = useReducer(visitorReducer, INITIAL_VISITOR_STATE);
  const [tryOpen, setTryOpen] = useState(false);
  const [view, setView] = useState<"sample" | "completed">("sample");
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const completedHeading = useRef<HTMLHeadingElement>(null);
  const sampleSection = useRef<HTMLElement>(null);
  const tryHeading = useRef<HTMLHeadingElement>(null);
  const completedSection = useRef<HTMLElement>(null);
  // A request to bring the current view into place, honoured only after React has rendered that view (an element still
  // carrying `hidden` can be neither scrolled to nor focused). Counted, so a repeated request for the same view still runs.
  const [arrival, setArrival] = useState(0);
  const pendingArrival = useRef<string | null>(null);

  // The completed example is an in-page view keyed on the URL hash, so it can be linked to, loaded directly and left with
  // Back/Forward. #completed-example shows it; any other fragment (or none) shows the sample.
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash;
      setView(hash === COMPLETED_HASH ? "completed" : "sample");
      if (hash) {
        pendingArrival.current = hash;
        setArrival((n) => n + 1);
      }
    };
    // The page mounts after the browser's own fragment scroll has already missed (the section did not exist yet), and
    // switching views moves everything below this section, so the fragment is brought into place again after rendering.
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    const hash = pendingArrival.current;
    if (!hash) return;
    // Wait for the render that shows the view the fragment asks for (on mount, this effect first runs with the initial view).
    if ((hash === COMPLETED_HASH ? "completed" : "sample") !== view) return;
    pendingArrival.current = null;
    if (hash === COMPLETED_HASH || hash === "#sample") {
      (view === "completed" ? completedSection.current : sampleSection.current)?.scrollIntoView({ block: "start" });
      (view === "completed" ? completedHeading.current : sampleSection.current)?.focus({ preventScroll: true });
      return;
    }
    // Another section of the page (#plans, #faq…): scroll only; focus stays with the browser. Unknown or hidden targets
    // are left alone, and the sample stays shown.
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (target && !target.closest("[hidden]")) target.scrollIntoView({ block: "start" });
  }, [arrival, view]);

  useEffect(() => {
    if (tryOpen) tryHeading.current?.focus();
  }, [tryOpen]);

  const undecided = undecidedCount(state);
  const unsupported = unsupportedCount(state);
  const ready = isReady(state);
  const eq = visitorEquation(state);
  const supplied = suppliedEquation();
  const nameOf = (code: string) => SAMPLE_HELD_ACCOUNTS.find((a) => a.code === code)?.name ?? code;

  const lead = ready
    ? "reviewed in your sample (illustrative)."
    : undecided
      ? `${undecided} ${plural(undecided, "account needs", "accounts need")} your review.`
      : `${unsupported} ${plural(unsupported, "decision", "decisions")} not supported by the invented evidence.`;
  const pill = ready
    ? "Both recorded decisions match the invented evidence."
    : undecided
      ? `${undecided} held ${plural(undecided, "account needs", "accounts need")} a decision`
      : `${unsupported} recorded ${plural(unsupported, "decision does", "decisions do")} not match the invented evidence`;

  const record = (code: string) => {
    if (!state.selected[code]) {
      setPrompts((p) => ({ ...p, [code]: C.selectFirst }));
      return;
    }
    setPrompts((p) => ({ ...p, [code]: "" }));
    dispatch({ type: "record", code });
  };

  const outcome = (code: string) => {
    const d = currentDecision(state, code);
    const selected = state.selected[code];
    if (prompts[code]) return { tone: "text-warning", text: prompts[code] };
    if (selected && selected !== d) return { tone: "text-warning", text: `Selected: ${selected}. Not recorded until you choose ${C.record}.` };
    if (!d) return { tone: "text-warning", text: C.noDecision };
    return decisionStanding(state, code) === "supported"
      ? { tone: "text-success", text: `Recorded: ${d}. ${C.supported}` }
      : { tone: "text-destructive", text: `Recorded: ${d}. ${C.unsupported}` };
  };

  return (
    <>
      <section
        id="sample"
        ref={sampleSection}
        tabIndex={-1}
        hidden={view === "completed"}
        aria-labelledby="sample-title"
        className="scroll-mt-20 border-b border-border bg-muted/20 focus:outline-none"
      >
        <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6 lg:py-20">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-muted-foreground">{C.eyebrow}</p>
          <h2 id="sample-title" className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-[2rem]">{C.heading}</h2>

          <div className="mt-6 border border-border bg-background">
            <SampleHead />
            <p className="px-4 pb-1 pt-5 text-xl font-bold tracking-[-0.01em] text-foreground sm:px-6 sm:text-2xl" data-testid="lead-status" aria-live="polite">
              {C.leadBalanced} <span className="font-normal text-muted-foreground">·</span> {lead}
            </p>
            <div className="flex flex-col gap-2.5 px-4 pb-5 pt-3 sm:flex-row sm:px-6">
              <Button asChild size="lg" className="rounded-sm">
                <a href={COMPLETED_HASH} data-testid="view-completed">{C.viewCompleted}</a>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="rounded-sm"
                aria-expanded={tryOpen}
                aria-controls="try-region"
                onClick={() => setTryOpen((o) => !o)}
                data-testid="try-toggle"
              >
                {tryOpen ? C.tryClose : C.tryOpen}
              </Button>
            </div>

            <Disclosure title={C.checksTitle} summary={C.checksSummary} testId="checks-disclosure">
              <h3 className="mb-2 mt-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{C.arithmeticHeading}</h3>
              <ul className="mb-4 border border-border">
                {C.arithmeticChecks.map((c) => (
                  <li key={c.name} className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-2.5 last:border-b-0">
                    <span className="text-sm font-semibold text-foreground">
                      {c.name}
                      {c.detail && <span className="block text-[13px] font-normal text-muted-foreground">{c.detail}</span>}
                    </span>
                    <span className="text-[13px] font-semibold text-success">✓ Passed</span>
                  </li>
                ))}
              </ul>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{C.classificationHeading}</h3>
              <ul className="border border-border">
                <li className="flex flex-wrap justify-between gap-x-3 gap-y-1 px-3 py-2.5" data-testid="equation-check">
                  <span className="text-sm font-semibold text-foreground">
                    {C.equationName}
                    <span className="block text-[13px] font-normal text-muted-foreground" data-testid="equation-detail">
                      {eq ? `${equationLine(eq)} ${C.equationNote}` : `Pending until every account has a category. ${undecided} ${plural(undecided, "account is", "accounts are")} still held.`}
                    </span>
                  </span>
                  <span className={`text-[13px] font-semibold ${eq ? "text-success" : "text-warning"}`} data-testid="equation-state">
                    {eq ? C.equationHoldsState : C.equationPendingState}
                  </span>
                </li>
              </ul>
            </Disclosure>

            <Disclosure title={C.accountsTitle} summary={C.accountsSummary} testId="accounts-disclosure">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Accounts in the illustrative trial balance</caption>
                <thead className="max-sm:sr-only">
                  <tr className="border-b border-border text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-semibold">Account</th>
                    <th scope="col" className="py-2 pr-3 text-right font-semibold">Balance</th>
                    <th scope="col" className="py-2 font-semibold">Category</th>
                  </tr>
                </thead>
                <tbody>
                  {[...SAMPLE_MAPPED_ACCOUNTS.map((a) => ({ ...a, held: false })), ...SAMPLE_HELD_ACCOUNTS.map((a) => ({ ...a, held: true }))]
                    .sort((a, b) => (a.code < b.code ? -1 : 1))
                    .map((a) => {
                      const d = a.held ? currentDecision(state, a.code) : undefined;
                      return (
                        <tr key={a.code} className={`border-b border-border max-sm:block max-sm:py-1.5 ${a.held ? "bg-warning/10" : ""}`}>
                          <td className="py-2 pr-3 max-sm:block max-sm:py-0.5">
                            {a.name} <span className="block font-mono text-[13px] text-muted-foreground">{a.code}</span>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums max-sm:block max-sm:py-0.5 max-sm:text-left">{formatMinor(a.balanceMinor)}</td>
                          <td className="py-2 max-sm:block max-sm:py-0.5">
                            {a.held
                              ? <span className="font-semibold text-warning">{d ? `${d} (your recorded decision)` : C.heldForReview}</span>
                              : "category" in a && a.category}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </Disclosure>

            <div id="try-region" hidden={!tryOpen} className="border-t border-border px-4 py-5 sm:px-6" data-testid="try-region" aria-labelledby="try-title">
              <h3 id="try-title" ref={tryHeading} tabIndex={-1} className="text-[17px] font-semibold text-foreground focus:outline-none">{C.tryHeading}</h3>
              <p className="mb-4 mt-1 max-w-2xl text-sm text-muted-foreground">{C.tryIntro}</p>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
                <p role="status" aria-live="polite" data-testid="pending-status"
                  className={`border px-2.5 py-1.5 text-sm font-semibold ${ready ? "border-success text-success" : "border-warning/60 bg-warning/10 text-warning"}`}>
                  {pill}
                </p>
                <Button type="button" variant="outline" className="rounded-sm" data-testid="reset"
                  onClick={() => { dispatch({ type: "reset" }); setPrompts({}); }}>
                  {C.reset}
                </Button>
              </div>

              {SAMPLE_HELD_ACCOUNTS.map((a) => {
                const standing = decisionStanding(state, a.code);
                const out = outcome(a.code);
                return (
                  <article key={a.code} aria-labelledby={`held-${a.code}`} data-testid={`held-${a.code}`}
                    className={`mb-3 border p-3.5 ${standing === "supported" ? "border-success bg-success/10" : standing === "unsupported" ? "border-destructive/60 bg-destructive/10" : "border-warning/60 bg-warning/10"}`}>
                    <h4 id={`held-${a.code}`} className="text-base font-semibold text-foreground">{a.name}</h4>
                    <p className="text-[13px] text-muted-foreground">{a.code} · {formatMinor(a.balanceMinor)} credit</p>
                    <p className="mt-1.5 text-sm text-foreground" data-testid={`why-${a.code}`}>{a.why}</p>
                    <p className="mt-2 border border-dashed border-muted-foreground bg-background px-2.5 py-2 text-sm text-foreground">
                      <span className="mr-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{C.invented}</span>
                      {a.evidence}
                    </p>
                    <fieldset className="mt-2.5 min-w-0">
                      <legend className="text-sm font-semibold text-foreground">{C.decisionLegend}</legend>
                      <span className="mb-0.5 mt-1 inline-block border border-muted-foreground bg-background px-2 py-0.5 text-xs font-bold text-foreground" data-testid={`guided-label-${a.code}`}>
                        {C.guidedLabel}
                      </span>
                      {a.options.map((o) => (
                        <label key={o.category} className="mt-1.5 flex min-h-11 cursor-pointer items-start gap-2.5 border border-border bg-background px-2.5 py-2 text-sm">
                          <input
                            type="radio"
                            name={`decision-${a.code}`}
                            value={o.category}
                            checked={state.selected[a.code] === o.category}
                            onChange={() => { setPrompts((p) => ({ ...p, [a.code]: "" })); dispatch({ type: "select", code: a.code, category: o.category }); }}
                            className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[hsl(var(--primary))]"
                          />
                          <span>
                            {o.category}
                            <span className="block text-[13px] text-muted-foreground">{o.hint}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                    <Button type="button" variant="outline" className="mt-2.5 rounded-sm" onClick={() => record(a.code)} data-testid={`record-${a.code}`}>
                      {C.record}
                    </Button>
                    <p className={`mt-2 text-sm font-semibold ${out.tone}`} aria-live="polite" data-testid={`outcome-${a.code}`}>{out.text}</p>
                  </article>
                );
              })}

              <p hidden={!ready} className="mb-3 inline-block border border-success px-2.5 py-1.5 text-sm font-semibold text-success" data-testid="ready-state">
                {C.readyState}
              </p>
              <details className="group border border-border" data-testid="visitor-log">
                <summary className="flex min-h-11 cursor-pointer list-none items-baseline gap-3 px-3 py-2.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  {C.visitorLogTitle}
                  <span className="font-normal text-muted-foreground">{state.recorded.length ? `${state.recorded.length} recorded` : "none yet"}</span>
                </summary>
                <ol className="border-t border-border text-sm" data-testid="decision-log">
                  {state.recorded.map((r, i) => (
                    <li key={i} className="flex flex-wrap justify-between gap-x-3 border-b border-border px-3 py-2 last:border-b-0">
                      <span>{i + 1}. {nameOf(r.code)} → <strong>{r.category}</strong></span>
                      <span className="text-[13px] text-muted-foreground">{C.visitorName}</span>
                    </li>
                  ))}
                </ol>
              </details>
            </div>

            <p className="border-t border-border px-4 py-3.5 text-sm text-foreground sm:px-6" data-testid="limit-note">
              <strong>What "reviewed" means:</strong> {C.limit}
            </p>
          </div>
        </div>
      </section>

      <section
        id="completed-example"
        ref={completedSection}
        hidden={view !== "completed"}
        aria-labelledby="completed-title"
        className="scroll-mt-20 border-b border-border bg-muted/20"
        data-testid="completed-example"
      >
        <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6 lg:py-20">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-muted-foreground">{C.completedEyebrow}</p>
          <h2 id="completed-title" ref={completedHeading} tabIndex={-1}
            className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-[2rem]">
            {C.completedHeading}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{C.completedIntro}</p>
          <div className="mt-6 border border-border bg-background">
            <SampleHead />
            <p className="px-4 pb-1 pt-5 text-xl font-bold text-foreground sm:px-6 sm:text-2xl" data-testid="completed-status">
              {C.leadBalanced} <span className="font-normal text-muted-foreground">·</span> {C.completedStatus}
            </p>
            <div className="px-4 pb-5 pt-3 sm:px-6">
              <h3 className="mb-2 text-[15px] font-semibold text-foreground">{C.suppliedHeading}</h3>
              <table className="w-full border-collapse text-sm" data-testid="supplied-decisions">
                <caption className="sr-only">Decisions supplied with the example, who recorded them and on what invented basis</caption>
                <thead className="max-sm:sr-only">
                  <tr className="border-b border-border text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-semibold">Account</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">Recorded decision</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">Recorded by</th>
                    <th scope="col" className="py-2 font-semibold">Invented basis</th>
                  </tr>
                </thead>
                <tbody>
                  {SAMPLE_SUPPLIED_DECISIONS.map((d) => (
                    <tr key={d.code} className="border-b border-border max-sm:block max-sm:py-1.5">
                      <td className="py-2 pr-3 max-sm:block max-sm:py-0.5">{nameOf(d.code)} <span className="block font-mono text-[13px] text-muted-foreground">{d.code}</span></td>
                      <td className="py-2 pr-3 max-sm:block max-sm:py-0.5">{d.category}</td>
                      <td className="py-2 pr-3 max-sm:block max-sm:py-0.5">{d.recordedBy} · {d.recordedAt}</td>
                      <td className="py-2 max-sm:block max-sm:py-0.5">{d.basis}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 className="mb-2 mt-5 text-[15px] font-semibold text-foreground">{C.equationHeading}</h3>
              <p className="text-sm text-foreground">{supplied ? `${equationLine(supplied)} ${C.completedEquationNote}` : ""}</p>
              <h3 className="mb-2 mt-5 text-[15px] font-semibold text-foreground">{C.limitationsHeading}</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-foreground" data-testid="limitations">
                {C.limitations.map((l) => <li key={l}>{l}</li>)}
              </ul>
              <Button asChild variant="outline" size="lg" className="mt-5 rounded-sm">
                <a href="#sample" data-testid="back-to-sample">{C.backToSample}</a>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
