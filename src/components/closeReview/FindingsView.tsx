import { useBusyState } from "@/hooks/useBusyState";
import { ActionButton } from "@/components/feedback/ActionButton";
import { PendingStatus } from "@/components/feedback/Activity";
/**
 * Close Review › Findings (I2). One dominant action at a time: when there is no current run, "Check for findings";
 * otherwise the next open item. Findings come from the authoritative trial balance only; every action is decided by the
 * server. Rules that were not evaluated are listed with their reason — never shown as passed.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { presentAmount } from "@/lib/presentation/amounts";
import {
  ACTION_REFUSALS, KIND_WORDS, offeredActions, findingResolved, findingStatus, REFRESH_WORDS, RESOLUTION_WORDS, RULE_STATUS_WORDS, RULE_WORDS, STATUS_WORDS,
  type FindingAction, type FindingRow, type FindingsClient, type FindingStatus, type FindingsSummary,
} from "@/lib/closeReview/findings";
import type { TimelineClient, TimelineEventRow } from "@/lib/closeReview/timeline";
import { DISPOSITION_LIMITS, findingGuidance } from "@/lib/workspace/correctionGuidance";
import { ReviewTimeline } from "./ReviewTimeline";

const ACTION_LABEL: Record<FindingAction, string> = { explain: "Record explanation", accept: "Accept", not_applicable: "Mark not applicable", reopen: "Reopen" };
/** What each decision does, in the words the page shows beside it. The database still decides each one. */
const ACTION_EFFECT: Record<FindingAction, (f: Pick<FindingRow, "severity" | "required_resolution">) => string> = {
  explain: (f) => f.required_resolution === "evidence"
    ? "records your explanation with the workpaper reference; with the reference, the finding counts as resolved under the current rules (status Explained)."
    : f.severity === "warning"
      ? "records your reasoning; the finding counts as resolved under the current rules (status Explained). It is not a correction — the classification and the balance stay as they are — and it does not prove the balance is right."
      : "records your reasoning (status Explained). It does not resolve this blocking finding, which needs its required correction.",
  accept: () => "a reviewer accepts the finding as it stands, without a correction or an explanation (status Accepted). A review judgement recorded under your name, not a fix.",
  not_applicable: () => "a reviewer records, with the reason, that this check does not apply to this account (status Not applicable). Not a way past an unresolved issue: the reason is on the record.",
  reopen: () => "sets the finding back to Open; the earlier decision stays in the history.",
};

function Amount({ minor, exponent }: { minor: string | null; exponent: number }) {
  if (minor === null) return <span>—</span>;
  const a = presentAmount({ kind: "amount", minor: BigInt(minor), exponent });
  return <span className="tabular-nums">{a.text}</span>;
}

export interface FindingsViewProps {
  companyId: string;
  periodYear: number;
  client: FindingsClient;
  timeline: TimelineClient;
  allowed: readonly string[];
  currentUserId: string | null;
  reviewHref: string;
  /** Where a finding about one account's classification opens that account (null: not offered for this finding). */
  correctionHref?: (f: FindingRow) => string | null;
  /** A finding to open on arrival (from a link back to it); said when the current check no longer raises it. */
  focusFindingKey?: string | null;
  /** Reports the opened finding, so the page can keep it in its address (Back and reload return to it). */
  onSelectFinding?: (findingKey: string | null) => void;
  newRequestId?: () => string;
}

/**
 * Re-keyed by the SCOPE (workspace, year, signed-in actor): another workspace, year or person starts from a clean view,
 * and nothing an earlier scope started (a read, a check, a decision) can reach it — the same ownership rule as the account
 * correction (AccountCorrection.tsx).
 */
export function FindingsView(p: FindingsViewProps) {
  return <ScopedFindingsView key={JSON.stringify([p.companyId, p.periodYear, p.currentUserId ?? ""])} {...p} />;
}

function ScopedFindingsView(p: FindingsViewProps) {
  const ids = { table: useId(), text: useId(), evidence: useId() };
  const [summary, setSummary] = useState<FindingsSummary | null>(null);
  const [rows, setRows] = useState<FindingRow[]>([]);
  const [events, setEvents] = useState<(TimelineEventRow & { subject_id: string })[]>([]);
  // The database decides status and resolution (an adjustment contract needs the adjusted layer); the browser only shows it.
  const [serverStates, setServerStates] = useState<Map<string, { status: FindingStatus; resolved: boolean }>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // Every notice names the finding it is about (or none) and the run it was read from, so it can never describe another.
  const [notice, setNotice] = useState<{ words: string; findingKey: string | null; runId: string | null } | null>(null);
  const [busy, setBusy] = useBusyState();
  // The opened finding is remembered by its KEY (rule + account), which survives a new check; a finding's id belongs to one run.
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [evidence, setEvidence] = useState("");
  const pending = useRef<{ key: string; id: string } | null>(null);
  const seq = useRef(0);
  // This instance owns one scope: once it is gone, no asynchronous completion may update, clear, navigate or read again.
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // Ownership of the SELECTED finding is separate from ownership of the list: every change of selection starts a new
  // epoch, and work begun under an earlier epoch may refresh the list (the run is what it is) but may not clear the
  // selection, the typed text or the evidence, nor move the address.
  const epoch = useRef(0);
  // Reviewing a finding moves focus to its detail (keyboard and screen-reader users land where the work is).
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const newId = p.newRequestId ?? (() => crypto.randomUUID());

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const s = await p.client.summary(p.companyId, p.periodYear);
      let r: FindingRow[] = []; let e: (TimelineEventRow & { subject_id: string })[] = [];
      let st: { finding_id: string; status: FindingStatus; resolved: boolean }[] = [];
      if (s.state === "current") { r = await p.client.list(s.runId); e = await p.client.events(r.map((x) => x.id)); st = await p.client.states(p.companyId, p.periodYear); }
      if (!live.current || mine !== seq.current) return;
      setSummary(s); setRows(r); setEvents(e); setServerStates(new Map(st.map((x) => [x.finding_id, { status: x.status, resolved: x.resolved }]))); setError(null);
    } catch {
      if (live.current && mine === seq.current) setError("The findings could not be read. Nothing was changed.");
    }
  }, [p.client, p.companyId, p.periodYear]);
  useEffect(() => { void load(); }, [load]);
  // Open the finding named by the address once the current run is read (once per key); say so when it is not raised.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    const k = p.focusFindingKey ?? null;
    if (!k || focused.current === k || !summary) return;
    if (summary.state !== "current") return;
    focused.current = k;
    const row = rows.find((r) => r.finding_key === k);
    if (row) { epoch.current++; setSelected(row.finding_key); }
    else setNotice({ words: `The current check of the reviewed trial balance no longer raises ${findingWords(k)}.`, findingKey: k, runId: summary.runId });
  }, [p.focusFindingKey, summary, rows]);
  const select = (r: FindingRow) => { epoch.current++; setNotice(null); setText(""); setEvidence(""); setSelected(r.finding_key); p.onSelectFinding?.(r.finding_key); };
  useEffect(() => { if (selected) { detailHeading.current?.focus(); detailHeading.current?.scrollIntoView?.({ block: "nearest" }); } }, [selected]);

  const evOf = (id: string) => events.filter((e) => e.subject_id === id);
  const statusOf = (r: FindingRow): FindingStatus => serverStates.get(r.id)?.status ?? findingStatus(evOf(r.id));
  const resolvedOf = (r: FindingRow): boolean => serverStates.get(r.id)?.resolved ?? findingResolved(r, evOf(r.id));
  const refresh = async () => {
    if (!setBusy(true)) return;
    const mine = epoch.current;
    const opened = selected;
    try {
      const r = await p.client.refresh(p.companyId, p.periodYear);
      if (!live.current) return;
      const s = await p.client.summary(p.companyId, p.periodYear);
      if (!live.current) return;
      const runId = s.state === "current" ? s.runId : null;
      // The finding that was open when the check started is re-read from the new run by its key.
      const stillRaised = opened && runId ? (await p.client.list(runId)).some((x) => x.finding_key === opened) : null;
      if (!live.current) return;
      if (opened && runId && !stillRaised) {
        // Said, and tied to that finding and run. The selection is cleared only while it is still that finding's
        // (same epoch): a finding the person opened meanwhile, and anything typed for it, is theirs to keep.
        setNotice({ words: `${REFRESH_WORDS[r.outcome]} The current check no longer raises ${findingWords(opened)}.`, findingKey: opened, runId });
        if (mine === epoch.current) { setSelected(null); setText(""); setEvidence(""); p.onSelectFinding?.(null); }
      } else setNotice({ words: REFRESH_WORDS[r.outcome], findingKey: null, runId });
      await load();
    }
    // The request may have reached the server (a check writes a run), so nothing is claimed either way.
    catch { if (live.current) setNotice({ words: "We could not confirm whether the check ran. Reload to see the current findings.", findingKey: null, runId: null }); }
    finally { if (live.current) setBusy(false); }
  };
  const act = async (f: FindingRow, action: FindingAction) => {
    const key = `${f.id}|${action}|${text}|${evidence}`;
    if (!pending.current || pending.current.key !== key) pending.current = { key, id: newId() };
    if (!setBusy(true)) return;
    const mine = epoch.current;
    try {
      const r = await p.client.act(f.id, action, text.trim(), evidence.trim() || null, pending.current.id);
      if (!live.current) return;
      if (r.outcome === "recorded") {
        pending.current = null;
        // The text box is cleared only while it still holds this decision's text (same epoch); text typed since for
        // another finding is never touched. The notice names the finding it is about.
        if (mine === epoch.current) { setText(""); setEvidence(""); }
        setNotice({ words: `${STATUS_WORDS[r.status ?? "open"]} — recorded for ${findingWords(f.finding_key)}.`, findingKey: f.finding_key, runId: f.run_id });
        await load();
      } else setNotice({ words: ACTION_REFUSALS[r.outcome], findingKey: f.finding_key, runId: f.run_id });
    } catch { if (live.current) setNotice({ words: "Could not confirm the decision. Your text is kept. Check the finding’s recorded status before retrying.", findingKey: f.finding_key, runId: f.run_id }); }
    finally { if (live.current) setBusy(false); }
  };

  if (error) return <p role="alert">{error} <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>;
  if (!summary) return <PendingStatus label="Reading the findings…" skeleton />;
  if (summary.state === "unavailable") return <p role="status">Close Review is not enabled for this workspace.</p>;
  if (summary.state === "no_authority") {
    return <p role="status">Findings are checked on a reviewed trial balance. <a className="underline" href={p.reviewHref}>Finish the trial balance review</a> first.</p>;
  }
  const canGenerate = p.allowed.includes("prepare_close");
  if (summary.state !== "current") {
    return (
      <section className="space-y-2">
        <p role="status">{summary.state === "stale" ? "The trial balance changed since the last check: these findings are out of date." : "No findings check has run on the current reviewed trial balance."}</p>
        {canGenerate ? <ActionButton busy={busy} type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" disabled={busy} onClick={() => void refresh()}>{busy ? "Checking…" : "Check for findings"}</ActionButton>
          : <p className="text-sm text-muted-foreground">Checking for findings needs Prepare in this workspace.</p>}
        <p role="status" aria-live="polite" className="text-sm">{notice?.words ?? ""}</p>
      </section>
    );
  }

  const sel = rows.find((r) => r.finding_key === selected) ?? null;
  const TH = "px-2 py-1.5 text-left font-medium";
  const TD = "px-2 py-1.5 align-top";
  const notEvaluated = Object.entries(summary.ruleStatus).filter(([, s]) => !s.evaluated);
  const nextOpen = rows.find((r) => !resolvedOf(r));
  return (
    <section className="space-y-4" aria-labelledby={`${ids.table}-h`}>
      <h2 id={`${ids.table}-h`} className="text-base font-semibold">Findings</h2>
      <p className="text-sm" data-testid="findings-counts">
        {summary.total === 0 ? "No findings on the current reviewed trial balance." : `${summary.unresolved} of ${summary.total} unresolved · ${summary.unresolvedBlocking} blocking`}
      </p>
      {nextOpen ? <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => select(nextOpen)}>Next open item</button> : null}
      {rows.length > 0 ? (
        <div className="relative w-full max-w-full overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm" aria-label="Findings">
          <thead className="bg-muted/40"><tr>
            <th scope="col" className={TH}>Finding</th><th scope="col" className={TH}>Type</th><th scope="col" className={TH}>Account</th>
            <th scope="col" className={`${TH} text-right`}>Debit</th><th scope="col" className={`${TH} text-right`}>Credit</th>
            <th scope="col" className={TH}>Severity</th><th scope="col" className={TH}>Status</th><th scope="col" className={TH}><span className="sr-only">Action</span></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const st = statusOf(r);
              const isSel = r.finding_key === selected;
              return (
                <tr key={r.id} data-testid={`finding-${r.finding_key}`} className={`border-t border-border ${isSel ? "bg-[#eef3fb]" : ""}`}>
                  <td className={`${TD} font-medium`}>{RULE_WORDS[r.rule_id]?.title ?? r.rule_id}</td>
                  <td className={`${TD} text-muted-foreground`}>{KIND_WORDS[r.kind] ?? r.kind}</td>
                  <td className={`${TD} break-words`}>{r.account_code ? <span className="tabular-nums">{r.account_code} </span> : null}{r.account_name ?? "—"}</td>
                  <td className={`${TD} whitespace-nowrap text-right tabular-nums`}><Amount minor={r.debit_minor} exponent={summary.exponent} /></td>
                  <td className={`${TD} whitespace-nowrap text-right tabular-nums`}><Amount minor={r.credit_minor} exponent={summary.exponent} /></td>
                  <td className={`${TD} whitespace-nowrap`}>{r.severity === "blocking" ? (r.mandatory ? "Blocking · mandatory" : "Blocking") : "Warning"}</td>
                  <td className={TD}>{STATUS_WORDS[st]}{resolvedOf(r) ? "" : st === "open" ? "" : " · not yet resolved"}</td>
                  <td className={`${TD} whitespace-nowrap`}><button type="button" className="rounded-md border border-input bg-background px-2 py-1 text-xs font-medium hover:bg-muted" onClick={() => select(r)} aria-pressed={isSel}
                    aria-label={`Open ${RULE_WORDS[r.rule_id]?.title ?? r.rule_id}${r.account_name ? ` for ${r.account_name}` : ""}`}>Review finding</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      ) : null}
      {notEvaluated.length > 0 ? (
        <details className="text-sm" data-testid="not-evaluated">
          <summary>Checks not run on this trial balance ({notEvaluated.length}) — never shown as passed</summary>
          <ul className="ml-4 list-disc">{notEvaluated.map(([k, s]) => <li key={k}>{RULE_WORDS[k]?.title ?? k} — {s.status ? RULE_STATUS_WORDS[s.status] : "Not evaluated"}: {s.reason}</li>)}</ul>
        </details>
      ) : null}
      {sel ? (
        <section aria-label="Selected finding" className="space-y-2 rounded-md border border-input p-3" data-testid="finding-detail">
          <h3 className="text-sm font-semibold" tabIndex={-1} ref={detailHeading}>{RULE_WORDS[sel.rule_id]?.title}{sel.account_name ? ` — ${sel.account_code ? `${sel.account_code} ` : ""}${sel.account_name}` : ""}</h3>
          <p className="text-sm">{RULE_WORDS[sel.rule_id]?.explain}</p>
          <p className="text-sm">{RESOLUTION_WORDS[sel.required_resolution]}{sel.mandatory ? " — mandatory: it cannot be accepted or marked not applicable." : ""}</p>
          {(() => {
            const href = p.correctionHref?.(sel) ?? null;
            if (!href) return null;
            const st = statusOf(sel);
            const guide = findingGuidance(sel, null);
            const mayCorrect = p.allowed.includes("prepare_close");
            return (
              <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm" data-testid="finding-guidance">
                <p><strong>What the check found.</strong> {guide.found}</p>
                <details className="text-muted-foreground">
                  <summary className="cursor-pointer text-foreground underline-offset-4 hover:underline">More: when this could be legitimate, and what decides it</summary>
                  <div className="mt-1 space-y-1">
                    {guide.legitimateIf ? <p><strong className="text-foreground">When this could be legitimate.</strong> {guide.legitimateIf}</p> : null}
                    <p><strong className="text-foreground">What decides it.</strong> {guide.decides}</p>
                    {guide.explanationRemains ? <p>{DISPOSITION_LIMITS}</p> : null}
                  </div>
                </details>
                {st === "open" ? (
                  mayCorrect ? (
                    <p>
                      <Link to={href} className="inline-flex rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground" data-testid="finding-correct-account">Review this account&rsquo;s classification</Link>
                      <span className="text-muted-foreground"> — opens the account on the trial balance page with the classification the check used and the latest saved one. {guide.correctionEffect}</span>
                    </p>
                  ) : (
                    <p className="text-muted-foreground" data-testid="finding-correct-account-readonly">
                      <Link to={href} className="underline underline-offset-4">Open this account</Link> to see the classification the check used and the latest saved one. Correcting it needs Prepare in this workspace.
                    </p>
                  )
                ) : <p className="text-muted-foreground">This finding is {STATUS_WORDS[st].toLowerCase()}. A classification correction is still possible from the trial balance page; it applies to the next check.</p>}
              </div>
            );
          })()}
          {(() => {
            const st = statusOf(sel);
            const offered = offeredActions(sel, st, p.allowed);
            if (offered.length === 0) return <p className="text-xs text-muted-foreground" data-testid="finding-no-action">No action available to you on this finding.{p.allowed.includes("prepare_close") || p.allowed.includes("review_close") ? "" : " A decision needs Prepare or Review in this workspace."} Comments below are discussion only and do not change its status.</p>;
            return (
              <div className="space-y-1">
                <p className="text-sm font-medium">Record a decision on this finding</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground" data-testid="finding-action-effects">
                  {offered.map((a) => <li key={a}><strong className="text-foreground">{ACTION_LABEL[a]}</strong> — {ACTION_EFFECT[a](sel)}</li>)}
                  <li>None of these changes the account&rsquo;s classification or the uploaded amount, records a contra-account treatment, or replaces required evidence or independent review. Comments in the history below are discussion only: they do not change the status.</li>
                </ul>
                <label htmlFor={ids.text} className="block text-sm font-medium">{st === "open" ? "Explanation or reason" : "Reason for reopening"}</label>
                <textarea id={ids.text} rows={3} maxLength={4000} className="w-full rounded-md border border-input bg-background p-2 text-sm" value={text} onChange={(e) => setText(e.target.value)} />
                {sel.required_resolution === "evidence" && st === "open" ? (
                  <>
                    <label htmlFor={ids.evidence} className="block text-sm font-medium">Workpaper reference (document name and version, or its fingerprint)</label>
                    <input id={ids.evidence} className="w-full rounded-md border border-input bg-background p-2 text-sm" maxLength={300} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
                  </>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {offered.map((a) => (
                    <ActionButton busy={busy} key={a} type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm" disabled={busy || text.trim().length < 3} onClick={() => void act(sel, a)}>{ACTION_LABEL[a]}</ActionButton>
                  ))}
                </div>
              </div>
            );
          })()}
          <ReviewTimeline client={p.timeline} companyId={p.companyId} subjectKind="finding" subjectId={sel.id}
            canComment={p.allowed.includes("prepare_close") || p.allowed.includes("review_close")} currentUserId={p.currentUserId} />
        </section>
      ) : null}
      {canGenerate ? <ActionButton busy={busy} type="button" className="text-sm underline" disabled={busy} onClick={() => void refresh()}>Check again</ActionButton> : null}
      <p role="status" aria-live="polite" className="text-sm" data-testid="findings-notice" data-finding-key={notice?.findingKey ?? undefined} data-run-id={notice?.runId ?? undefined}>{notice?.words ?? ""}</p>
    </section>
  );
}

/** A finding named by its key, in words (rule title and account), for notices. */
function findingWords(key: string): string {
  const [rule, account] = [key.slice(0, 3), key.slice(4)];
  const title = RULE_WORDS[rule]?.title ?? rule;
  return account && key[3] === ":" ? `“${title}” for account ${account}` : `“${title}”`;
}
