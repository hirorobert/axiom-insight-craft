import { PendingStatus } from "@/components/feedback/Activity";
import { useBusyState } from "@/hooks/useBusyState";
import { ActionButton } from "@/components/feedback/ActionButton";
/**
 * Next-period roll-forward (20261112100000), on the Comparatives page of the NEW period. Shows only what needs a renewed
 * decision or evidence: the prior year's wording and applicability decisions carried with provenance ("carried forward —
 * review required"), the evidence families still to supply for this period, the prior-FINAL reconciliation (the prior
 * year's issued figures against this year's comparatives, both values kept) and the reviewer's acceptance of exactly the
 * differences found. Nothing carried is current until the preparer confirms it; confirmation writes through the same
 * authorities the Notes page uses. Presentation assignments are company-level and carry inherently.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { presentAmount } from "@/lib/presentation/amounts";
import { blockerText } from "@/lib/reporting/blockers";
import { IFRS_FOR_SMES_2015 } from "@/lib/frameworkPacks/ifrsForSmes";
import { CARRY_STATUS_WORDS, type CarriedItem, type RollforwardWorklist } from "@/lib/reporting/reviewWorkflow";
import { Notice, useAttempt, type PageProps } from "./shared";

export function RollforwardPanel(p: PageProps) {
  const [w, setW] = useState<RollforwardWorklist | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useBusyState();
  const [reason, setReason] = useState("");
  const attempt = useAttempt(p.newRequestId);
  const ids = { reason: useId() };
  const load = useCallback(async () => setW(await p.clients.review.worklist(p.companyId, p.periodYear)), [p.clients, p.companyId, p.periodYear]);
  useEffect(() => { void load().catch((e) => setNotice((e as Error).message)); }, [load, p.state]);
  if (!w) return notice ? <p role="alert">The roll-forward status could not be read. <button type="button" className="underline" onClick={() => { setNotice(null); void load().catch((e) => setNotice((e as Error).message)); }}>Try again</button></p> : <PendingStatus label="Reading the prior-period status…" />;
  if (w.state !== "listed") return null;
  const pf = w.priorFinal;
  const carries = w.carries ?? [];
  const pending = carries.filter((c) => c.status === "carried");
  const canPrepare = p.allowed.includes("prepare_close"), canReview = p.allowed.includes("review_close");
  // Nothing to roll forward: no issued prior year and nothing carried — the panel stays out of the way.
  if ((!pf || pf.state === "no_prior_final") && carries.length === 0) return null;
  const exponent = p.state.composition?.state === "composed" ? p.state.composition.current.exponent : 2;
  const amt = (v: string | null | undefined) => (v && /^-?\d+$/.test(v) ? presentAmount({ kind: "amount", minor: BigInt(v), exponent }).text : "—");
  const run = async (key: string, f: (rid: string) => Promise<{ outcome: string; [k: string]: unknown }>, done: (r: { outcome: string; [k: string]: unknown }) => string) => {
    if (!setBusy(true)) return;
    try {
      const r = await f(attempt.idFor(key));
      setNotice(r.outcome === "recorded" ? done(r) : r.outcome === "forbidden" ? "Your role cannot do this; nothing was recorded." : `The server answered: ${r.outcome}.`);
      if (r.outcome === "recorded") { attempt.done(); setReason(""); await load(); await p.refresh(); }
    } catch (e) { setNotice(`Not recorded: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="h-rf" className="space-y-4" data-testid="rollforward" data-pending={pending.length} data-prior-final={pf?.state ?? "unknown"}>
      <h2 id="h-rf" className="text-base font-semibold">Roll-forward from FY{w.sourcePeriodYear}</h2>

      {pf && pf.state !== "no_prior_final" ? (
        <div data-testid="prior-final" data-state={pf.state}>
          <p className="font-medium">
            {pf.state === "reconciled" ? "The comparatives agree with the prior year's issued statements." : pf.state === "accepted_differences" ? "The comparatives differ from the prior year's issued statements; the differences are accepted by a reviewer."
              : pf.state === "differences" ? "The comparatives differ from the prior year's issued statements." : `Prior-year reconciliation: ${pf.state.replace(/_/g, " ")}.`}
            {pf.priorFinal ? <span className="text-muted-foreground"> Issued version {pf.priorFinal.reportVersion}, {pf.priorFinal.issuedAt.slice(0, 10)}.</span> : null}
          </p>
          {pf.differences && pf.differences.length ? (
            <table className="mt-1 w-full text-xs" data-testid="prior-final-differences">
              <thead><tr><th className="text-left">Line</th><th className="text-right">As issued</th><th className="text-right">Now reported</th><th className="text-right">Difference</th></tr></thead>
              <tbody>{pf.differences.map((d) => (
                <tr key={d.factId}><td>{d.factId.replace(/^fact:comparative:/, "").replace(/:/g, " · ").replace(/_/g, " ")}</td><td className="text-right tabular-nums">{amt(d.issuedMinor)}</td><td className="text-right tabular-nums">{amt(d.comparativeAsReportedMinor)}</td><td className="text-right tabular-nums">{amt(d.differenceMinor)}</td></tr>
              ))}</tbody>
            </table>
          ) : null}
          {pf.acceptance ? <p className="text-xs text-muted-foreground">Accepted {pf.acceptance.at.slice(0, 10)}: {pf.acceptance.reason}{pf.acceptance.inForce ? "" : " — no longer in force: the differences changed."}</p> : null}
          {pf.state === "differences" && canReview ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label htmlFor={ids.reason} className="block grow">Reason for accepting these differences (a prior-period adjustment approved after issue, a reclassification)
                <input id={ids.reason} className="mt-1 w-full rounded-md border border-input px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="accept-reason" /></label>
              <ActionButton busy={busy} type="button" className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={busy || reason.trim().length < 8}
                onClick={() => void run(`accept|${reason}`, (rid) => p.clients.review.acceptDifferences(p.companyId, p.periodYear, true, reason.trim(), rid), () => "The differences are accepted; the comparatives keep both figures.")} data-testid="accept-differences">
                Accept the differences
              </ActionButton>
            </div>
          ) : null}
          {pf.state === "differences" && !canReview ? <p className="text-xs text-muted-foreground">A reviewer accepts explained differences, or the prior year is re-issued.</p> : null}
          {pf.blockers && pf.blockers.length ? <ul className="mt-1 list-disc pl-5 text-xs">{pf.blockers.map((b) => <li key={b}>{blockerText(b)}</li>)}</ul> : null}
        </div>
      ) : null}

      <div data-testid="carries">
        <p className="font-medium">Decisions and wording from FY{w.sourcePeriodYear}: {carries.length === 0 ? "nothing carried yet" : `${pending.length} to review, ${carries.filter((c) => c.status === "confirmed").length} confirmed, ${carries.filter((c) => c.status === "withdrawn").length} withdrawn`}</p>
        {carries.length === 0 && canPrepare ? (
          <ActionButton busy={busy} type="button" className="mt-1 rounded-md border border-input px-3 py-1 disabled:opacity-50" disabled={busy}
            onClick={() => void run("carry", (rid) => p.clients.review.carry(p.companyId, p.periodYear, rid), (r) => `${r.carried ?? 0} item(s) carried forward for review${r.withdrawn ? `, ${r.withdrawn} withdrawn (the edition changed)` : ""}.`)} data-testid="carry-forward">
            Carry forward FY{w.sourcePeriodYear}'s decisions and wording for review
          </ActionButton>
        ) : null}
        {carries.length ? (
          <ul className="mt-1 divide-y divide-border border-y border-border text-sm" data-testid="carry-list">
            {carries.map((c) => <CarryRow key={c.carryId} {...p} c={c} busy={busy} run={run} />)}
          </ul>
        ) : null}
      </div>

      {w.evidence ? (
        <p className="text-sm" data-testid="evidence-to-supply">
          Evidence for FY{p.periodYear} is never carried: {w.evidence.filter((e) => !e.supplied).length === 0 ? "every family is supplied." : `${w.evidence.filter((e) => !e.supplied).map((e) => `${e.evidenceType.toLowerCase().replace(/_/g, " ")} (${e.periodRole.toLowerCase()})`).join(", ")} still to supply on Statements.`}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">Presentation assignments are company-level and carry inherently{w.presentation?.accountsNotPresented != null ? `; ${w.presentation.accountsNotPresented} account(s) of this year are not yet on a line` : ""}.</p>
      <Notice text={notice} />
    </section>
  );
}

function CarryRow(p: PageProps & { c: CarriedItem; busy: boolean; run: (key: string, f: (rid: string) => Promise<{ outcome: string; [k: string]: unknown }>, done: (r: { outcome: string; [k: string]: unknown }) => string) => Promise<void> }) {
  const [why, setWhy] = useState("");
  const id = useId();
  const canPrepare = p.allowed.includes("prepare_close");
  const c = p.c;
  const text = c.kind === "wording" ? String(c.payload.body ?? "") : `${String(c.payload.decision ?? "").replace(/_/g, " ")}${c.payload.reason ? ` — ${String(c.payload.reason)}` : ""}`;
  return (
    <li className="space-y-1 px-2 py-2" data-testid="carry" data-kind={c.kind} data-status={c.status} data-requirement={c.requirementId}>
      <p><span className="font-medium">{IFRS_FOR_SMES_2015.requirements.find((r) => r.id === c.requirementId)?.label ?? c.requirementId}</span> <span className="text-muted-foreground">({c.kind}; {CARRY_STATUS_WORDS[c.status]}{c.statusReason ? `: ${c.statusReason}` : ""}; from FY{c.sourcePeriodYear})</span></p>
      <p className="text-muted-foreground">{text}</p>
      {c.status === "carried" && canPrepare ? (
        <div className="flex flex-wrap items-end gap-2">
          <ActionButton busy={p.busy} type="button" className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={p.busy}
            onClick={() => void p.run(`confirm|${c.carryId}`, (rid) => p.clients.review.decideCarry(p.companyId, c.carryId, true, null, rid), () => "Confirmed for this period.")} data-testid="carry-confirm">Confirm for FY{p.periodYear}</ActionButton>
          <label htmlFor={id} className="block"><span className="sr-only">Reason to withdraw</span><input id={id} className="rounded-md border border-input px-2 py-1" placeholder="Reason to withdraw" value={why} onChange={(e) => setWhy(e.target.value)} data-testid="carry-withdraw-reason" /></label>
          <ActionButton busy={p.busy} type="button" className="rounded-md border border-input px-3 py-1 disabled:opacity-50" disabled={p.busy || why.trim().length < 3}
            onClick={() => void p.run(`withdraw|${c.carryId}|${why}`, (rid) => p.clients.review.decideCarry(p.companyId, c.carryId, false, why.trim(), rid), () => "Withdrawn; decide it afresh on the Notes page.")} data-testid="carry-withdraw">Withdraw</ActionButton>
        </div>
      ) : null}
    </li>
  );
}
