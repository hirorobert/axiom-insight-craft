/**
 * Close Review › Adjustments (I3). Propose an exact, balanced journal on the current reviewed trial balance; approve,
 * reject or withdraw (server-authorized; self-approval only under the workspace policy, acknowledged and disclosed);
 * reverse an approved adjustment with a new one; see the adjusted trial balance as a layer over the certified one.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { presentAmount } from "@/lib/presentation/amounts";
import {
  checkDraft, DECIDE_WORDS, PROPOSE_WORDS, type AdjustedRow, type AdjustmentsClient, type AdjustmentsSummary, type AdjustmentView, type DraftLine,
} from "@/lib/closeReview/adjustments";

const STATUS: Record<AdjustmentView["status"], string> = { proposed: "Awaiting approval", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn" };
const amt = (minor: string, exponent: number) => presentAmount({ kind: "amount", minor: BigInt(minor), exponent }).text;
const emptyLine = (): DraftLine => ({ accountKey: "", side: "debit", amount: "", memo: "" });

export function AdjustmentsView(p: {
  companyId: string; periodYear: number; client: AdjustmentsClient; allowed: readonly string[]; currentUserId: string | null; newRequestId?: () => string;
}) {
  const ids = { reason: useId(), evidence: useId(), decision: useId() };
  const [summary, setSummary] = useState<AdjustmentsSummary | null>(null);
  const [rows, setRows] = useState<AdjustedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), { ...emptyLine(), side: "credit" }]);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [decisionReason, setDecisionReason] = useState("");
  const [ack, setAck] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const seq = useRef(0);
  const newId = p.newRequestId ?? (() => crypto.randomUUID());
  const requestFor = (key: string) => { if (!pending.current || pending.current.key !== key) pending.current = { key, id: newId() }; return pending.current.id; };

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const s = await p.client.summary(p.companyId, p.periodYear);
      const r = s.state === "current" ? await p.client.adjusted(p.companyId, p.periodYear) : [];
      if (mine === seq.current) { setSummary(s); setRows(r ?? []); setError(null); }
    } catch { if (mine === seq.current) setError("The adjustments could not be read. Nothing was changed."); }
  }, [p.client, p.companyId, p.periodYear]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <p role="alert">{error} <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>;
  if (!summary) return <p role="status">Reading the adjustments…</p>;
  if (summary.state === "unavailable") return <p role="status">Close Review is not enabled for this workspace.</p>;
  const exponent = summary.exponent ?? 2;
  const canPropose = summary.state === "current" && p.allowed.includes("prepare_close") && summary.exponent !== null;
  const draft = checkDraft(lines, exponent);

  const propose = async () => {
    if (!draft.ok) return;
    setBusy(true);
    try {
      const r = await p.client.propose(p.companyId, p.periodYear, reason.trim(), evidence.trim() || null, draft.lines, [], requestFor(`p|${JSON.stringify(draft.lines)}|${reason}|${evidence}`));
      if (r.outcome === "proposed") { pending.current = null; setLines([emptyLine(), { ...emptyLine(), side: "credit" }]); setReason(""); setEvidence(""); setNotice(`Adjustment ${r.number} proposed. It applies once it is approved.`); await load(); }
      else setNotice(PROPOSE_WORDS[r.outcome]);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };
  const decide = async (a: AdjustmentView, decision: "approve" | "reject" | "withdraw") => {
    setBusy(true);
    try {
      const self = decision === "approve" && a.proposer === p.currentUserId;
      const r = await p.client.decide(a.id, decision, decisionReason.trim(), self && ack, requestFor(`d|${a.id}|${decision}|${decisionReason}|${ack}`));
      if (r.outcome === "recorded") { pending.current = null; setDecisionReason(""); setAck(false); setNotice(`Adjustment ${a.number}: ${STATUS[r.status as AdjustmentView["status"]] ?? r.status}${r.selfApproved ? " (self-approved — disclosed in the sign-off pack)" : ""}.`); await load(); }
      else setNotice(DECIDE_WORDS[r.outcome]);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };
  const reverse = async (a: AdjustmentView) => {
    setBusy(true);
    try {
      const r = await p.client.propose(p.companyId, p.periodYear, decisionReason.trim() || `Reversal of adjustment ${a.number}`, null, [], [], requestFor(`r|${a.id}`), a.id);
      setNotice(r.outcome === "proposed" ? `Reversal proposed as adjustment ${r.number}. It applies once it is approved.` : PROPOSE_WORDS[r.outcome]);
      if (r.outcome === "proposed") { pending.current = null; await load(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };

  const accounts = rows.map((r) => ({ key: r.account_key, label: `${r.account_code ? `${r.account_code} ` : ""}${r.account_name}` }));
  const adjusted = rows.filter((r) => r.adjustment_debit_minor !== "0" || r.adjustment_credit_minor !== "0");
  return (
    <section className="space-y-5">
      <p className="text-sm" data-testid="approval-policy">
        Approval: {summary.policy === "two_person" ? "another member approves each adjustment" : "self-approval allowed under the workspace policy"}
        {summary.policy === "owner_self_approval" && !summary.selfApprovalAvailable ? " — not available while more than one member can approve" : ""}.
      </p>
      {summary.state === "no_authority" ? <p role="status">There is no reviewed trial balance for this period: adjustments cannot be proposed, and earlier ones no longer apply.</p> : null}

      <section aria-label="Adjustments" className="space-y-2">
        <h2 className="text-base font-semibold">Adjustments</h2>
        {summary.adjustments.length === 0 ? <p className="text-sm text-muted-foreground">No adjustments yet.</p> : (
          <ol className="space-y-2">
            {summary.adjustments.map((a) => {
              const mine = a.proposer === p.currentUserId;
              const canApprove = a.status === "proposed" && a.current && (mine ? summary.selfApprovalAvailable && p.allowed.includes("approve_certification") : p.allowed.includes("review_close"));
              return (
                <li key={a.id} className="rounded-md border border-input p-2 text-sm" data-testid={`adjustment-${a.number}`}>
                  <p className="font-medium">
                    {a.kind === "reversal" ? "Reversal" : "Adjustment"} {a.number} · {STATUS[a.status]}{a.selfApproved ? " · self-approved (disclosed)" : ""}{a.reversedBy ? " · reversed" : ""}
                    {!a.current ? " · on an earlier trial balance — not applied" : ""}
                  </p>
                  <p>{a.reason}{a.evidenceRef ? ` — evidence: ${a.evidenceRef}` : ""}</p>
                  <table className="w-full text-sm" aria-label={`Lines of adjustment ${a.number}`}>
                    <thead><tr><th scope="col" className="text-left">Account</th><th scope="col" className="text-right">Debit</th><th scope="col" className="text-right">Credit</th></tr></thead>
                    <tbody>{a.lines.map((l) => (
                      <tr key={l.lineNo}><td>{l.accountCode ? `${l.accountCode} ` : ""}{l.accountName}{l.memo ? ` — ${l.memo}` : ""}</td>
                        <td className="text-right tabular-nums">{l.debitMinor === "0" ? "" : amt(l.debitMinor, exponent)}</td>
                        <td className="text-right tabular-nums">{l.creditMinor === "0" ? "" : amt(l.creditMinor, exponent)}</td></tr>
                    ))}</tbody>
                  </table>
                  {a.status === "proposed" && a.current ? (
                    <div className="mt-2 space-y-1">
                      <label htmlFor={`${ids.decision}-${a.id}`} className="block text-xs font-medium">Reason for your decision</label>
                      <input id={`${ids.decision}-${a.id}`} className="w-full rounded-md border border-input bg-background p-1 text-sm" value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} />
                      {canApprove && mine ? (
                        <div className="flex items-start gap-2 text-xs">
                          <input id={`${ids.decision}-ack-${a.id}`} type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                          <label htmlFor={`${ids.decision}-ack-${a.id}`}>I am approving my own adjustment. It will be disclosed as self-approved in the sign-off pack and the export audit appendix.</label>
                        </div>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        {canApprove ? <button type="button" className="rounded-md border border-input px-2 py-1" disabled={busy || decisionReason.trim().length < 3 || (mine && !ack)} onClick={() => void decide(a, "approve")}>Approve</button> : null}
                        {!mine && p.allowed.includes("review_close") ? <button type="button" className="rounded-md border border-input px-2 py-1" disabled={busy || decisionReason.trim().length < 3} onClick={() => void decide(a, "reject")}>Reject</button> : null}
                        {mine ? <button type="button" className="rounded-md border border-input px-2 py-1" disabled={busy || decisionReason.trim().length < 3} onClick={() => void decide(a, "withdraw")}>Withdraw</button> : null}
                      </div>
                    </div>
                  ) : null}
                  {a.status === "approved" && a.kind === "adjustment" && a.current && !a.reversedBy && p.allowed.includes("prepare_close") ? (
                    <button type="button" className="mt-1 text-xs underline" disabled={busy} onClick={() => void reverse(a)}>Propose a reversal</button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {canPropose ? (
        <section aria-label="Propose an adjustment" className="space-y-2">
          <h2 className="text-base font-semibold">Propose an adjustment</h2>
          {lines.map((l, i) => (
            <fieldset key={i} className="flex flex-wrap items-end gap-2" aria-label={`Line ${i + 1}`}>
              <label className="text-xs">Account
                <select className="ml-1 rounded-md border border-input bg-background p-1 text-sm" value={l.accountKey} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, accountKey: e.target.value } : x))}>
                  <option value="">Choose…</option>
                  {accounts.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
                </select>
              </label>
              <label className="text-xs">Side
                <select className="ml-1 rounded-md border border-input bg-background p-1 text-sm" value={l.side} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, side: e.target.value as DraftLine["side"] } : x))}>
                  <option value="debit">Debit</option><option value="credit">Credit</option>
                </select>
              </label>
              <label className="text-xs">Amount ({summary.currency})
                <input inputMode="decimal" className="ml-1 w-32 rounded-md border border-input bg-background p-1 text-right text-sm tabular-nums" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
              </label>
              <label className="text-xs">Memo
                <input className="ml-1 rounded-md border border-input bg-background p-1 text-sm" maxLength={300} value={l.memo} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, memo: e.target.value } : x))} />
              </label>
              {lines.length > 2 ? <button type="button" className="text-xs underline" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove line {i + 1}</button> : null}
            </fieldset>
          ))}
          <button type="button" className="text-sm underline" onClick={() => setLines([...lines, emptyLine()])}>Add a line</button>
          <p className="text-sm tabular-nums" data-testid="draft-totals">Debits {amt(draft.debitMinor.toString(), exponent)} · Credits {amt(draft.creditMinor.toString(), exponent)}</p>
          {!draft.ok ? <ul className="text-xs" data-testid="draft-problems">{draft.problems.map((x) => <li key={x}>{x}</li>)}</ul> : null}
          <label htmlFor={ids.reason} className="block text-sm font-medium">Reason</label>
          <textarea id={ids.reason} rows={2} maxLength={2000} className="w-full rounded-md border border-input bg-background p-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
          <label htmlFor={ids.evidence} className="block text-sm font-medium">Evidence reference (optional)</label>
          <input id={ids.evidence} maxLength={300} className="w-full rounded-md border border-input bg-background p-2 text-sm" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" disabled={busy || !draft.ok || reason.trim().length < 3} onClick={() => void propose()}>Propose adjustment</button>
        </section>
      ) : null}

      {adjusted.length > 0 ? (
        <section aria-label="Adjusted trial balance" className="space-y-1">
          <h2 className="text-base font-semibold">Adjusted accounts</h2>
          <p className="text-xs text-muted-foreground">The reviewed trial balance never changes: approved adjustments are applied on top of it.</p>
          <table className="w-full text-sm" aria-label="Adjusted accounts">
            <thead><tr><th scope="col" className="text-left">Account</th><th scope="col" className="text-right">Reviewed (net)</th><th scope="col" className="text-right">Adjustments (net)</th><th scope="col" className="text-right">Adjusted (net)</th></tr></thead>
            <tbody>{adjusted.map((r) => (
              <tr key={r.account_key}><td>{r.account_code ? `${r.account_code} ` : ""}{r.account_name}</td>
                <td className="text-right tabular-nums">{amt((BigInt(r.certified_debit_minor) - BigInt(r.certified_credit_minor)).toString(), exponent)}</td>
                <td className="text-right tabular-nums">{amt((BigInt(r.adjustment_debit_minor) - BigInt(r.adjustment_credit_minor)).toString(), exponent)}</td>
                <td className="text-right tabular-nums">{amt((BigInt(r.adjusted_debit_minor) - BigInt(r.adjusted_credit_minor)).toString(), exponent)}</td></tr>
            ))}</tbody>
          </table>
        </section>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm">{notice ?? ""}</p>
    </section>
  );
}
