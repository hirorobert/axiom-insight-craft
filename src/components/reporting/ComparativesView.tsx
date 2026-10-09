/**
 * Financial Statements › Comparatives. The server's comparative state (approved, unapproved, approval out of date,
 * accounts not presented, unbalanced, different currency, reference only, missing, first-period exception) in words, and
 * the actions that move it: bridging a prior-year account to this year's, proposing a balanced restatement (decided by
 * someone other than the proposer, history kept), and approving the comparatives as they stand (a reviewer). Translation
 * of a different-currency prior year is not supported and is said so.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { ConfirmDialog } from "@/components/workbench/ConfirmDialog";
import { Link } from "react-router-dom";
import { COMPARATIVE_WORDS, FIRST_PERIOD_EVIDENCE, FIRST_PERIOD_OUTCOMES, type ComparativeStatus, type FirstPeriodEvidenceKind, type RestatementLine } from "@/lib/comparatives/comparatives";
import { blockerText } from "@/lib/reporting/blockers";
import { presentAmount } from "@/lib/presentation/amounts";
import type { Composition } from "@/lib/statements/composition";
import { signedMinor } from "./SchedulesView";
import { Notice, outcomeText, useAttempt, type PageProps } from "./shared";

interface Restatement { id: string; lines: RestatementLine[]; reason: string; reference: string; createdAt: string; state: "pending" | "approved" | "rejected" | "withdrawn" }

export function ComparativesView(p: PageProps) {
  const s = p.state.comparatives;
  const c = p.state.composition;
  if (!s || s.state !== "evaluated" || !c || c.state !== "composed") return <p role="status">Comparatives are not available{s ? ` (${s.state})` : ""}.</p>;
  return <Evaluated {...p} s={s as ComparativeStatus} c={c} />;
}

function Evaluated(p: PageProps & { s: ComparativeStatus; c: Composition }) {
  const cs = p.s.comparative;
  const words = COMPARATIVE_WORDS[cs.state];
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "approve" | "withdraw">(null);
  const [busy, setBusy] = useState(false);
  const attempt = useAttempt(p.newRequestId);
  const canReview = p.allowed.includes("review_close");
  const decide = async (approve: boolean, reason: string) => {
    setBusy(true);
    try {
      const r = await p.clients.comparatives.approve(p.companyId, p.periodYear, approve, reason, attempt.idFor(`a|${approve}|${reason}`));
      setNotice(r.outcome === "recorded" ? (approve ? "The comparatives are approved as they stand now." : "The approval is withdrawn; history is kept.") : outcomeText(r));
      if (r.outcome === "recorded") { attempt.done(); await p.refresh(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); setConfirm(null); }
  };
  return (
    <div className="space-y-6 text-sm">
      <section aria-labelledby="h-cs" data-testid="comparative-state" data-state={cs.state}>
        <h2 id="h-cs" className="text-base font-semibold">FY{p.c.comparative.periodYear ?? p.periodYear - 1}: {words.title}</h2>
        <p>{words.detail}</p>
        {cs.approval ? <p className="text-muted-foreground">Last decision: {cs.approval.action} on {cs.approval.at.slice(0, 10)}.</p> : null}
        {cs.blockers.length ? (
          <details className="mt-1 text-muted-foreground" data-testid="comparative-technical">
            <summary>Technical details</summary>
            <ul className="ml-4 list-disc">{cs.blockers.map((b) => <li key={b}>{blockerText(b)} <code className="text-xs">{b}</code></li>)}</ul>
          </details>
        ) : null}
        {canReview && (cs.state === "unapproved" || cs.state === "approval_stale") ? (
          <button type="button" className="mt-2 rounded-md bg-primary px-3 py-1 text-primary-foreground" onClick={() => setConfirm("approve")} data-testid="approve-comparatives">Approve the comparatives</button>
        ) : null}
        {canReview && cs.state === "approved" ? <button type="button" className="mt-2 rounded-md border border-input px-3 py-1" onClick={() => setConfirm("withdraw")}>Withdraw the approval</button> : null}
        {!canReview && (cs.state === "unapproved" || cs.state === "approval_stale") ? <p className="mt-1 text-muted-foreground">A reviewer approves the comparatives.</p> : null}
      </section>
      {cs.state === "missing" ? <MissingRecovery {...p} /> : null}
      <Bridges {...p} />
      <Restatements {...p} />
      <Notice text={notice} />
      <ConfirmDialog open={confirm !== null} title={confirm === "approve" ? "Approve the comparatives" : "Withdraw the approval"} period={`FY${p.periodYear} (comparative FY${p.c.comparative.periodYear ?? ""})`} version={null}
        consequences={confirm === "approve" ? "The prior-year figures shown, with any approved restatements and bridges, become the approved comparatives. Any later change to them makes this approval out of date." : "The comparatives stop counting as approved; sign-off is blocked until they are approved again."}
        reasonMinLength={3} reasonLabel="Reason" confirmLabel={confirm === "approve" ? "Approve" : "Withdraw"} busy={busy}
        onConfirm={(reason) => void decide(confirm === "approve", reason)} onCancel={() => setConfirm(null)} />
    </div>
  );
}

/**
 * Recovery when the prior year is missing. The comparative period is the reporting period the year before
 * (fs_reporting_input: period_year − 1). Either its trial balance is imported and reviewed (Trial Balance › Intake takes the
 * prior year's file, or one file with both years), or — only for a genuinely first reporting period — a member who
 * approves certifications records a first-period declaration with relevant evidence. The server refuses the declaration
 * when any earlier period has data; missing comparatives are never turned into an exception or into zero.
 */
function MissingRecovery(p: PageProps & { c: Composition }) {
  const prior = p.c.comparative.periodYear ?? p.periodYear - 1;
  const canDeclare = p.allowed.includes("approve_certification");
  const [kind, setKind] = useState<FirstPeriodEvidenceKind>("certificate_of_incorporation");
  const [ref, setRef] = useState("");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ids = { kind: useId(), ref: useId(), date: useId(), reason: useId() };
  const intakeHref = `/workspace/${p.companyId}/${p.periodYear}/trial-balance/intake`;
  const declare = async () => {
    setBusy(true);
    try {
      const r = await p.clients.comparatives.declareFirstPeriod(p.companyId, p.periodYear, reason.trim(), kind, ref.trim(), date);
      setNotice(FIRST_PERIOD_OUTCOMES[r.outcome] ?? outcomeText(r));
      if (r.outcome === "recorded") { setOpen(false); await p.refresh(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };
  const ready = reason.trim().length >= 3 && ref.trim().length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return (
    <section aria-labelledby="h-recover" className="space-y-3 rounded-md border border-border p-3" data-testid="comparative-recovery">
      <h2 id="h-recover" className="text-base font-semibold">Establish the comparatives for FY{prior}</h2>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <span className="font-medium">Import the FY{prior} trial balance.</span> Use the prior year's own file, or one file with both years, in{" "}
          <Link className="text-primary underline" to={intakeHref} data-testid="recover-intake">Trial Balance › Intake</Link>; once reviewed, its figures appear here for approval.
        </li>
        <li>
          <span className="font-medium">Or, only if FY{p.periodYear} is the company's first reporting period:</span> record a first-period declaration with the evidence that establishes it.
          {canDeclare ? (
            open ? null : <button type="button" className="ml-2 rounded-md border border-input px-2 py-0.5" onClick={() => setOpen(true)} data-testid="open-first-period">Declare a first reporting period</button>
          ) : <span className="block text-muted-foreground">A member who approves certifications records it.</span>}
        </li>
      </ol>
      {open ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void declare(); }} aria-label="First-period declaration">
          <label htmlFor={ids.kind} className="block font-medium">Evidence</label>
          <select id={ids.kind} className="rounded-md border border-input bg-background px-2 py-1" value={kind} onChange={(e) => setKind(e.target.value as FirstPeriodEvidenceKind)}>
            {Object.entries(FIRST_PERIOD_EVIDENCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <label htmlFor={ids.ref} className="block font-medium">Evidence reference</label>
          <input id={ids.ref} className="w-full rounded-md border border-input bg-background px-2 py-1" maxLength={300} value={ref} onChange={(e) => setRef(e.target.value)} />
          <label htmlFor={ids.date} className="block font-medium">Issue date</label>
          <input id={ids.date} type="date" className="rounded-md border border-input bg-background px-2 py-1" value={date} onChange={(e) => setDate(e.target.value)} />
          <label htmlFor={ids.reason} className="block font-medium">Reason</label>
          <textarea id={ids.reason} rows={2} maxLength={2000} className="w-full rounded-md border border-input bg-background p-2" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <button type="submit" className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={!ready || busy} data-testid="record-first-period">{busy ? "Recording…" : "Record the declaration"}</button>
            <button type="button" className="rounded-md border border-input px-3 py-1" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : null}
      <Notice text={notice} />
    </section>
  );
}

function Bridges(p: PageProps & { c: Composition }) {
  const prior = p.c.accountsNotPresented.filter((a) => a.period === "comparative");
  const current = [...new Map(p.c.lines.flatMap((l) => l.lineage.filter((x) => x.period === "current" && x.kind === "account").map((x) => [x.accountKey, `${x.accountCode ?? x.accountKey} ${x.accountName}`] as const))).entries()];
  const [to, setTo] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const reasonId = useId();
  if (prior.length === 0) return null;
  const bridge = async (key: string) => {
    try {
      const r = await p.clients.comparatives.bridge(p.companyId, p.periodYear, key, to[key] || null, reason.trim(), attempt.idFor(`b|${key}|${to[key]}|${reason}`));
      setNotice(r.outcome === "recorded" ? `Prior-year account ${key} is presented with ${to[key]}.` : outcomeText(r));
      if (r.outcome === "recorded") { attempt.done(); await p.refresh(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
  };
  return (
    <section aria-labelledby="h-br" data-testid="bridges">
      <h2 id="h-br" className="text-base font-semibold">Prior-year accounts not presented ({prior.length})</h2>
      <p className="text-muted-foreground">Bridge each to the account of this year it continues; the prior-year amount is then presented on that account's line.</p>
      <label htmlFor={reasonId} className="mt-2 block">Reason<input id={reasonId} className="ml-2 rounded-md border border-input px-2 py-0.5" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <ul className="mt-2 space-y-1">
        {prior.map((a) => (
          <li key={a.accountKey} className="flex flex-wrap items-center gap-2">
            <span className="min-w-[14rem]">{a.accountCode ?? a.accountKey} {a.accountName}</span>
            {p.allowed.includes("prepare_close") ? (
              <>
                <select aria-label={`This year's account for ${a.accountName}`} className="rounded-md border border-input px-2 py-0.5" value={to[a.accountKey] ?? ""} onChange={(e) => setTo((t) => ({ ...t, [a.accountKey]: e.target.value }))}>
                  <option value="">Choose…</option>
                  {current.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                <button type="button" className="rounded-md border border-input px-2 py-0.5 disabled:opacity-50" disabled={!to[a.accountKey] || reason.trim().length < 3} onClick={() => void bridge(a.accountKey)}>Bridge</button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <Notice text={notice} />
    </section>
  );
}

function Restatements(p: PageProps & { c: Composition }) {
  const [list, setList] = useState<Restatement[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const exponent = p.c.current.exponent;
  const load = useCallback(async () => {
    const rows = ((await p.db.select("fs_comparative_restatements", { company_id: p.companyId, period_year: p.periodYear })).data ?? []) as Record<string, unknown>[];
    const out: Restatement[] = [];
    for (const r of rows) {
      const ds = ((await p.db.select("fs_comparative_restatement_decisions", { restatement_id: String(r.id) })).data ?? []) as Record<string, unknown>[];
      const last = ds.sort((a, b) => Number(b.seq) - Number(a.seq))[0];
      out.push({ id: String(r.id), lines: r.lines as RestatementLine[], reason: String(r.reason), reference: String(r.reference), createdAt: String(r.created_at), state: last ? (String(last.decision) as Restatement["state"]) : "pending" });
    }
    setList(out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)));
  }, [p.db, p.companyId, p.periodYear]);
  useEffect(() => { void load(); }, [load, p.state]);
  const decide = async (id: string, decision: "approved" | "rejected" | "withdrawn") => {
    try {
      const r = await p.clients.comparatives.decideRestatement(id, decision, `Restatement ${decision} in the workbench`, attempt.idFor(`d|${id}|${decision}`));
      setNotice(r.outcome === "recorded" ? `Restatement ${decision}.` : outcomeText(r));
      if (r.outcome === "recorded") { attempt.done(); await p.refresh(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
  };
  return (
    <section aria-labelledby="h-rs" data-testid="restatements">
      <h2 id="h-rs" className="text-base font-semibold">Restatements of the comparative</h2>
      {list === null ? <p role="status">Reading restatements…</p> : list.length === 0 ? <p className="text-muted-foreground">None proposed.</p> : (
        <ul className="space-y-2">
          {list.map((r) => (
            <li key={r.id} className="border-l-2 border-border pl-2">
              <p><strong>{r.state === "pending" ? "Awaiting decision" : r.state[0].toUpperCase() + r.state.slice(1)}</strong> — {r.reason} <span className="text-muted-foreground">({r.reference})</span></p>
              <ul className="text-xs">{r.lines.map((l, i) => <li key={i}>{l.section} · {l.lineId}: {presentAmount({ kind: "amount", minor: BigInt(l.deltaMinor), exponent }).text}</li>)}</ul>
              {r.state === "pending" ? (
                <div className="mt-1 flex gap-2">
                  {p.allowed.includes("review_close") ? <>
                    <button type="button" className="rounded-md border border-input px-2 py-0.5" onClick={() => void decide(r.id, "approved")}>Approve</button>
                    <button type="button" className="rounded-md border border-input px-2 py-0.5" onClick={() => void decide(r.id, "rejected")}>Reject</button>
                  </> : null}
                  <button type="button" className="rounded-md border border-input px-2 py-0.5" onClick={() => void decide(r.id, "withdrawn")}>Withdraw</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {p.allowed.includes("prepare_close") && p.c.comparative.state === "available" ? <Propose {...p} onSaved={async (t) => { setNotice(t); await p.refresh(); }} /> : null}
      <Notice text={notice} />
    </section>
  );
}

function Propose(p: PageProps & { c: Composition; onSaved: (text: string) => Promise<void> }) {
  const lines = p.c.lines.filter((l) => l.comparative);
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const ex = p.c.current.exponent;
  const built = lines.filter((l) => (deltas[`${l.section}|${l.lineId}`] ?? "").trim() !== "").map((l) => ({ lineId: l.lineId, section: l.section, deltaMinor: signedMinor(deltas[`${l.section}|${l.lineId}`], ex) }));
  const ok = built.length >= 2 && built.every((b) => b.deltaMinor !== null && b.deltaMinor !== "0") && reason.trim().length >= 3 && reference.trim().length >= 3;
  const propose = async () => {
    try {
      const ls = built.map((b) => ({ ...b, deltaMinor: b.deltaMinor! }));
      const r = await p.clients.comparatives.proposeRestatement(p.companyId, p.periodYear, ls, reason.trim(), reference.trim(), attempt.idFor(JSON.stringify([ls, reason, reference])));
      if (r.outcome === "recorded") { attempt.done(); setDeltas({}); setReason(""); setReference(""); await p.onSaved("Restatement proposed; someone other than you decides it."); }
      else setNotice(outcomeText(r));
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
  };
  return (
    <details className="mt-3">
      <summary className="cursor-pointer">Propose a restatement</summary>
      <p className="mt-1 text-muted-foreground">Enter the change to each affected comparative line in the direction the line is presented (a positive amount increases the line). The changes must keep the prior-year position balanced; the server refuses one that does not.</p>
      <ul className="mt-2 space-y-1">
        {lines.map((l) => (
          <li key={`${l.section}|${l.lineId}`}><label>{l.label} <span className="text-muted-foreground">({l.section})</span>
            <input inputMode="decimal" className="ml-2 w-32 rounded-md border border-input px-2 py-0.5 text-right" value={deltas[`${l.section}|${l.lineId}`] ?? ""} onChange={(e) => setDeltas((d) => ({ ...d, [`${l.section}|${l.lineId}`]: e.target.value }))} /></label></li>
        ))}
      </ul>
      <label className="mt-2 block">Reason<input className="ml-2 rounded-md border border-input px-2 py-0.5" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <label className="block">Reference (Section 10 basis, working paper)<input className="ml-2 rounded-md border border-input px-2 py-0.5" value={reference} onChange={(e) => setReference(e.target.value)} /></label>
      <button type="button" className="mt-2 rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={!ok} onClick={() => void propose()}>Propose</button>
      <Notice text={notice} />
    </details>
  );
}
