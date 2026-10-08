/**
 * Financial Statements › Comparatives. The server's comparative state (approved, unapproved, approval out of date,
 * accounts not presented, unbalanced, different currency, reference only, missing, first-period exception) in words, and
 * the actions that move it: bridging a prior-year account to this year's, proposing a balanced restatement (decided by
 * someone other than the proposer, history kept), and approving the comparatives as they stand (a reviewer). Translation
 * of a different-currency prior year is not supported and is said so.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { ConfirmDialog } from "@/components/workbench/ConfirmDialog";
import { COMPARATIVE_WORDS, type ComparativeStatus, type RestatementLine } from "@/lib/comparatives/comparatives";
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
        {cs.blockers.length ? <p className="text-muted-foreground">Server reasons: {cs.blockers.join("; ")}</p> : null}
        {canReview && (cs.state === "unapproved" || cs.state === "approval_stale") ? (
          <button type="button" className="mt-2 rounded-md bg-primary px-3 py-1 text-primary-foreground" onClick={() => setConfirm("approve")} data-testid="approve-comparatives">Approve the comparatives</button>
        ) : null}
        {canReview && cs.state === "approved" ? <button type="button" className="mt-2 rounded-md border border-input px-3 py-1" onClick={() => setConfirm("withdraw")}>Withdraw the approval</button> : null}
        {!canReview && (cs.state === "unapproved" || cs.state === "approval_stale") ? <p className="mt-1 text-muted-foreground">A reviewer approves the comparatives.</p> : null}
      </section>
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
