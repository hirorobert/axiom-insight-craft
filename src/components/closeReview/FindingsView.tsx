/**
 * Close Review › Findings (I2). One dominant action at a time: when there is no current run, "Check for findings";
 * otherwise the next open item. Findings come from the authoritative trial balance only; every action is decided by the
 * server. Rules that were not evaluated are listed with their reason — never shown as passed.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { presentAmount } from "@/lib/presentation/amounts";
import {
  ACTION_REFUSALS, KIND_WORDS, offeredActions, findingResolved, findingStatus, REFRESH_WORDS, RESOLUTION_WORDS, RULE_STATUS_WORDS, RULE_WORDS, STATUS_WORDS,
  type FindingAction, type FindingRow, type FindingsClient, type FindingStatus, type FindingsSummary,
} from "@/lib/closeReview/findings";
import type { TimelineClient, TimelineEventRow } from "@/lib/closeReview/timeline";
import { ReviewTimeline } from "./ReviewTimeline";

const ACTION_LABEL: Record<FindingAction, string> = { explain: "Record explanation", accept: "Accept", not_applicable: "Mark not applicable", reopen: "Reopen" };

function Amount({ minor, exponent }: { minor: string | null; exponent: number }) {
  if (minor === null) return <span>—</span>;
  const a = presentAmount({ kind: "amount", minor: BigInt(minor), exponent });
  return <span className="tabular-nums">{a.text}</span>;
}

export function FindingsView(p: {
  companyId: string;
  periodYear: number;
  client: FindingsClient;
  timeline: TimelineClient;
  allowed: readonly string[];
  currentUserId: string | null;
  reviewHref: string;
  newRequestId?: () => string;
}) {
  const ids = { table: useId(), text: useId(), evidence: useId() };
  const [summary, setSummary] = useState<FindingsSummary | null>(null);
  const [rows, setRows] = useState<FindingRow[]>([]);
  const [events, setEvents] = useState<(TimelineEventRow & { subject_id: string })[]>([]);
  // The database decides status and resolution (an adjustment contract needs the adjusted layer); the browser only shows it.
  const [serverStates, setServerStates] = useState<Map<string, { status: FindingStatus; resolved: boolean }>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [evidence, setEvidence] = useState("");
  const pending = useRef<{ key: string; id: string } | null>(null);
  const seq = useRef(0);
  const newId = p.newRequestId ?? (() => crypto.randomUUID());

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const s = await p.client.summary(p.companyId, p.periodYear);
      let r: FindingRow[] = []; let e: (TimelineEventRow & { subject_id: string })[] = [];
      let st: { finding_id: string; status: FindingStatus; resolved: boolean }[] = [];
      if (s.state === "current") { r = await p.client.list(s.runId); e = await p.client.events(r.map((x) => x.id)); st = await p.client.states(p.companyId, p.periodYear); }
      if (mine !== seq.current) return;
      setSummary(s); setRows(r); setEvents(e); setServerStates(new Map(st.map((x) => [x.finding_id, { status: x.status, resolved: x.resolved }]))); setError(null);
    } catch {
      if (mine === seq.current) setError("The findings could not be read. Nothing was changed.");
    }
  }, [p.client, p.companyId, p.periodYear]);
  useEffect(() => { void load(); }, [load]);

  const evOf = (id: string) => events.filter((e) => e.subject_id === id);
  const statusOf = (r: FindingRow): FindingStatus => serverStates.get(r.id)?.status ?? findingStatus(evOf(r.id));
  const resolvedOf = (r: FindingRow): boolean => serverStates.get(r.id)?.resolved ?? findingResolved(r, evOf(r.id));
  const refresh = async () => {
    setBusy(true);
    try { const r = await p.client.refresh(p.companyId, p.periodYear); setNotice(REFRESH_WORDS[r.outcome]); await load(); }
    catch { setNotice("The check could not be started. Nothing was recorded."); }
    finally { setBusy(false); }
  };
  const act = async (f: FindingRow, action: FindingAction) => {
    const key = `${f.id}|${action}|${text}|${evidence}`;
    if (!pending.current || pending.current.key !== key) pending.current = { key, id: newId() };
    setBusy(true);
    try {
      const r = await p.client.act(f.id, action, text.trim(), evidence.trim() || null, pending.current.id);
      if (r.outcome === "recorded") { pending.current = null; setText(""); setEvidence(""); setNotice(`${STATUS_WORDS[r.status ?? "open"]} — recorded.`); await load(); }
      else setNotice(ACTION_REFUSALS[r.outcome]);
    } catch { setNotice("The action could not be sent. Nothing was recorded."); }
    finally { setBusy(false); }
  };

  if (error) return <p role="alert">{error} <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>;
  if (!summary) return <p role="status">Reading the findings…</p>;
  if (summary.state === "unavailable") return <p role="status">Close Review is not enabled for this workspace.</p>;
  if (summary.state === "no_authority") {
    return <p role="status">Findings are checked on a reviewed trial balance. <a className="underline" href={p.reviewHref}>Finish the trial balance review</a> first.</p>;
  }
  const canGenerate = p.allowed.includes("prepare_close");
  if (summary.state !== "current") {
    return (
      <section className="space-y-2">
        <p role="status">{summary.state === "stale" ? "The trial balance changed since the last check: these findings are out of date." : "No findings check has run on the current reviewed trial balance."}</p>
        {canGenerate ? <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" disabled={busy} onClick={() => void refresh()}>{busy ? "Checking…" : "Check for findings"}</button>
          : <p className="text-sm text-muted-foreground">Checking for findings needs Prepare in this workspace.</p>}
        <p role="status" aria-live="polite" className="text-sm">{notice ?? ""}</p>
      </section>
    );
  }

  const sel = rows.find((r) => r.id === selected) ?? null;
  const notEvaluated = Object.entries(summary.ruleStatus).filter(([, s]) => !s.evaluated);
  const nextOpen = rows.find((r) => !resolvedOf(r));
  return (
    <section className="space-y-4" aria-labelledby={`${ids.table}-h`}>
      <h2 id={`${ids.table}-h`} className="text-base font-semibold">Findings</h2>
      <p className="text-sm" data-testid="findings-counts">
        {summary.total === 0 ? "No findings on the current reviewed trial balance." : `${summary.unresolved} of ${summary.total} unresolved · ${summary.unresolvedBlocking} blocking`}
      </p>
      {nextOpen ? <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => setSelected(nextOpen.id)}>Next open item</button> : null}
      {rows.length > 0 ? (
        <table className="w-full text-sm" aria-label="Findings">
          <thead><tr><th scope="col" className="text-left">Finding</th><th scope="col" className="text-left">Type</th><th scope="col" className="text-left">Account</th><th scope="col" className="text-right">Debit</th><th scope="col" className="text-right">Credit</th><th scope="col" className="text-left">Severity</th><th scope="col" className="text-left">Status</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const st = statusOf(r);
              return (
                <tr key={r.id} data-testid={`finding-${r.finding_key}`}>
                  <td>{RULE_WORDS[r.rule_id]?.title ?? r.rule_id}</td>
                  <td>{KIND_WORDS[r.kind] ?? r.kind}</td>
                  <td>{r.account_code ? `${r.account_code} ` : ""}{r.account_name ?? "—"}</td>
                  <td className="text-right"><Amount minor={r.debit_minor} exponent={summary.exponent} /></td>
                  <td className="text-right"><Amount minor={r.credit_minor} exponent={summary.exponent} /></td>
                  <td>{r.severity === "blocking" ? (r.mandatory ? "Blocking · mandatory" : "Blocking") : "Warning"}</td>
                  <td>{STATUS_WORDS[st]}{resolvedOf(r) ? "" : st === "open" ? "" : " · not yet resolved"}</td>
                  <td><button type="button" className="underline" onClick={() => setSelected(r.id)} aria-label={`Open ${RULE_WORDS[r.rule_id]?.title ?? r.rule_id}${r.account_name ? ` for ${r.account_name}` : ""}`}>Open</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {notEvaluated.length > 0 ? (
        <details className="text-sm" data-testid="not-evaluated">
          <summary>Checks not run on this trial balance ({notEvaluated.length}) — never shown as passed</summary>
          <ul className="ml-4 list-disc">{notEvaluated.map(([k, s]) => <li key={k}>{RULE_WORDS[k]?.title ?? k} — {s.status ? RULE_STATUS_WORDS[s.status] : "Not evaluated"}: {s.reason}</li>)}</ul>
        </details>
      ) : null}
      {sel ? (
        <section aria-label="Selected finding" className="space-y-2 rounded-md border border-input p-3" data-testid="finding-detail">
          <h3 className="text-sm font-semibold">{RULE_WORDS[sel.rule_id]?.title}</h3>
          <p className="text-sm">{RULE_WORDS[sel.rule_id]?.explain}</p>
          <p className="text-sm">{RESOLUTION_WORDS[sel.required_resolution]}{sel.mandatory ? " — mandatory: it cannot be accepted or marked not applicable." : ""}</p>
          {(() => {
            const st = statusOf(sel);
            const offered = offeredActions(sel, st, p.allowed);
            if (offered.length === 0) return <p className="text-xs text-muted-foreground">No action available to you on this finding.</p>;
            return (
              <div className="space-y-1">
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
                    <button key={a} type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm" disabled={busy || text.trim().length < 3} onClick={() => void act(sel, a)}>{ACTION_LABEL[a]}</button>
                  ))}
                </div>
              </div>
            );
          })()}
          <ReviewTimeline client={p.timeline} companyId={p.companyId} subjectKind="finding" subjectId={sel.id}
            canComment={p.allowed.includes("prepare_close") || p.allowed.includes("review_close")} currentUserId={p.currentUserId} />
        </section>
      ) : null}
      {canGenerate ? <button type="button" className="text-sm underline" disabled={busy} onClick={() => void refresh()}>Check again</button> : null}
      <p role="status" aria-live="polite" className="text-sm">{notice ?? ""}</p>
    </section>
  );
}
