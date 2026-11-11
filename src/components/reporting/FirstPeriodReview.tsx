/**
 * Financial Statements › Comparatives › first-period review (20261223100000). When the comparatives are missing, the only
 * alternative to importing the prior year is a GOVERNED review: a preparer records the evidence revisions, the structured
 * facts and a written basis; a DIFFERENT partner or manager sees exactly what a decision binds (the company, its TIN, the
 * reporting dates the server reads from the reviewed trial balance, the cited revisions, the rule version) and verifies or
 * returns it with a reason. Once verified, the opening balances need their own support, reviewed the same way.
 *
 * Reads fs_first_period_status; writes ONLY through fs_record_first_period_evidence, fs_submit_first_period_claim,
 * fs_decide_first_period and fs_withdraw_first_period. Every state is the server's; an unrecognised one is "cannot confirm".
 * Controls follow the server-reported capabilities as hints; the server refuses every unauthorised write.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ActionButton } from "@/components/feedback/ActionButton";
import { PendingStatus } from "@/components/feedback/Activity";
import { ConfirmDialog } from "@/components/workbench/ConfirmDialog";
import { useBusyState } from "@/hooks/useBusyState";
import {
  BASIS_MAX, BASIS_MIN, CLAIM_OUTCOMES, DECISION_OUTCOMES, EVIDENCE_KINDS, EVIDENCE_OUTCOMES, basisOk, documentSha256, firstPeriodClient, firstPeriodFacts, outcomeWords, reviewView,
  type Abilities, type EvidenceKind, type EvidenceRevision, type FirstPeriodClient, type FirstPeriodFactsInput, type FirstPeriodStatus, type ParsedStatus, type ReviewView, type Subject, type SubjectStatus,
} from "@/lib/comparatives/firstPeriodReview";
import { presentAmount } from "@/lib/presentation/amounts";
import type { Composition } from "@/lib/statements/composition";
import { signedMinor } from "./SchedulesView";
import { Notice, useAttempt, type PageProps } from "./shared";

type P = PageProps & { c: Composition };
const SUBJECT_TITLE: Record<Subject, string> = { first_period: "First reporting period", opening_balances: "Opening balances" };
const field = "w-full rounded-md border border-input bg-background px-2 py-1";
const primaryBtn = "rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50";
const secondaryBtn = "rounded-md border border-input px-3 py-1";
const fingerprint = (h: string) => `${h.slice(0, 12)}…`;
const kindLabel = (k: string) => (EVIDENCE_KINDS as Record<string, { label: string }>)[k]?.label ?? k;

export function FirstPeriodReview(p: P) {
  const client = useMemo(() => firstPeriodClient(p.db), [p.db]);
  const [status, setStatus] = useState<ParsedStatus | null>(null);
  const load = useCallback(async () => { setStatus(await client.status(p.companyId, p.periodYear)); }, [client, p.companyId, p.periodYear]);
  useEffect(() => { void load(); }, [load, p.state]);
  const changed = useCallback(async () => { await Promise.all([load(), p.refresh()]); }, [load, p]);
  const a: Abilities = { canPrepare: p.allowed.includes("prepare_close"), canApprove: p.allowed.includes("approve_certification") };

  return (
    <section aria-labelledby="h-fp" className="space-y-3" data-testid="first-period-review">
      <h3 id="h-fp" className="font-semibold">Only if FY{p.periodYear} is the company's first reporting period: a first-period review</h3>
      <p className="text-muted-foreground">A preparer records the facts and cites the evidence; a different partner or manager verifies them. Until then the comparatives are required. A declaration on its own never replaces them.</p>
      {status === null ? <PendingStatus label="Reading the first-period review…" /> : status.state !== "evaluated" ? (
        <div role="status" data-testid="fp-first_period" data-state="cannot_confirm" className="border-l-[3px] border-[#5f6b7a] pl-2">
          <p className="font-medium">Cannot confirm the first-period review</p>
          <p>{status.state === "unavailable" ? "You cannot read this company's review." : "The server's answer could not be read, so nothing here is treated as approved. Reload the page; until it reads, the comparatives are still required."}</p>
          <button type="button" className={`mt-1 ${secondaryBtn}`} onClick={() => void load()}>Read again</button>
        </div>
      ) : <Evaluated p={p} s={status} a={a} client={client} changed={changed} />}
    </section>
  );
}

function Evaluated({ p, s, a, client, changed }: { p: P; s: FirstPeriodStatus; a: Abilities; client: FirstPeriodClient; changed: () => Promise<void> }) {
  const fp = reviewView(s.firstPeriod, "first_period", a);
  const showOpening = fp.kind === "approved" || s.openingBalances.claim !== null;
  return (
    <>
      {s.legacyDeclaration ? (
        <p className="text-muted-foreground" data-testid="fp-legacy">
          An earlier first-period declaration ({kindLabel(s.legacyDeclaration.evidenceKind ?? "")}{s.legacyDeclaration.evidenceRef ? `, "${s.legacyDeclaration.evidenceRef}"` : ""}{s.legacyDeclaration.evidenceDate ? `, dated ${s.legacyDeclaration.evidenceDate}` : ""}, recorded {s.legacyDeclaration.recordedAt.slice(0, 10)}) is kept as an unverified claim. It does not replace the comparatives.
        </p>
      ) : null}
      <SubjectBlock p={p} s={s} subject="first_period" view={fp} a={a} client={client} changed={changed} />
      {showOpening ? <SubjectBlock p={p} s={s} subject="opening_balances" view={reviewView(s.openingBalances, "opening_balances", a)} a={a} client={client} changed={changed} /> : null}
      <EvidenceRegister p={p} s={s} a={a} client={client} changed={changed} />
    </>
  );
}

function SubjectBlock({ p, s, subject, view, a, client, changed }: { p: P; s: FirstPeriodStatus; subject: Subject; view: ReviewView; a: Abilities; client: FirstPeriodClient; changed: () => Promise<void> }) {
  const st: SubjectStatus = subject === "first_period" ? s.firstPeriod : s.openingBalances;
  const [open, setOpen] = useState<null | "prepare" | "review">(null);
  const [withdraw, setWithdraw] = useState(false);
  const [busy, setBusy] = useBusyState();
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const tone = view.kind === "approved" ? "border-[#22663f]" : view.kind === "cannot_confirm" || view.kind === "not_applicable" ? "border-[#5f6b7a]" : "border-primary";
  const label = view.primary === "record_facts" ? (st.claim ? "Correct and re-submit the facts" : subject === "first_period" ? "Record the first-period facts" : "Record the opening-balance support")
    : view.primary === "review" ? (view.kind === "stale" ? "Review again" : "Review and decide") : null;
  const doWithdraw = async (reason: string) => {
    if (!setBusy(true)) return;
    try {
      const r = await client.withdraw(p.companyId, p.periodYear, subject, reason, attempt.idFor(`w|${subject}|${reason}`));
      setNotice(r.outcome === "recorded" ? "The approval is withdrawn; history is kept." : outcomeWords(DECISION_OUTCOMES, r));
      if (r.outcome === "recorded") { attempt.done(); await changed(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); setWithdraw(false); }
  };
  return (
    <div className={`space-y-2 border-l-[3px] pl-3 ${tone}`} data-testid={`fp-${subject}`} data-state={view.kind}>
      <h4 className="font-medium">{SUBJECT_TITLE[subject]}: {view.title}</h4>
      <p data-testid={`fp-${subject}-next`}>{view.nextAction}</p>
      {st.decision && st.decision.outcome !== "verified" && view.kind === "returned" ? <p className="text-muted-foreground">Reviewer's reason: {st.decision.reason}</p> : null}
      {st.decision && view.kind === "approved" ? <p className="text-muted-foreground">Decided {st.decision.decidedAt.slice(0, 10)} under {st.decision.ruleVersion}: {st.decision.reason}</p> : null}
      {view.note ? <p className="text-muted-foreground" data-testid={`fp-${subject}-note`}>{view.note}</p> : null}
      {view.codes.length ? (
        <details className="text-muted-foreground"><summary>Technical details</summary>
          <ul className="ml-4 list-disc">{st.items.map((i) => <li key={i.code}><code className="text-xs">{i.code}{i.detail ? `:${i.detail}` : ""}</code></li>)}</ul>
        </details>
      ) : null}
      {label && open === null ? (
        <button type="button" className={primaryBtn} data-testid={`fp-${subject}-primary`} onClick={() => { setNotice(null); setOpen(view.primary === "review" ? "review" : "prepare"); }}>{label}</button>
      ) : null}
      {view.kind === "approved" && a.canApprove ? <button type="button" className={secondaryBtn} onClick={() => setWithdraw(true)}>Withdraw the approval</button> : null}
      {open === "prepare" && view.primary === "record_facts" ? (subject === "first_period"
        ? <FirstPeriodForm p={p} s={s} client={client} onDone={async (t) => { setOpen(null); setNotice(t); await changed(); }} onCancel={() => setOpen(null)} />
        : <OpeningForm p={p} s={s} client={client} onDone={async (t) => { setOpen(null); setNotice(t); await changed(); }} onCancel={() => setOpen(null)} />) : null}
      {open === "review" && view.primary === "review" ? <DecideForm p={p} s={s} subject={subject} client={client} onDone={async (t, reload) => { if (reload) setOpen(null); setNotice(t); if (reload) await changed(); }} onCancel={() => setOpen(null)} /> : null}
      <Notice text={notice} />
      <ConfirmDialog open={withdraw} title={`Withdraw the ${SUBJECT_TITLE[subject].toLowerCase()} approval`} period={`FY${p.periodYear}`} version={null}
        consequences={subject === "first_period" ? "The first-period exception stops applying: the comparatives are required again until a partner or manager verifies the facts again." : "The opening balances stop counting as supported until they are verified again."}
        reasonMinLength={3} reasonLabel="Reason" confirmLabel="Withdraw" busy={busy} onConfirm={(r) => void doWithdraw(r)} onCancel={() => setWithdraw(false)} />
    </div>
  );
}

/** Character counter for the written basis: the server accepts 20 to 1,500 characters. */
function BasisField({ id, value, onChange, label }: { id: string; value: string; onChange: (v: string) => void; label: string }) {
  const n = value.trim().length;
  return (
    <>
      <label htmlFor={id} className="block font-medium">{label}</label>
      <textarea id={id} rows={3} maxLength={BASIS_MAX} className={field} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-count`} />
      <p id={`${id}-count`} className="text-xs text-muted-foreground" data-testid="basis-count">{n} / {BASIS_MAX} characters{n < BASIS_MIN ? ` (at least ${BASIS_MIN})` : ""}</p>
    </>
  );
}

/** The current revisions the preparer may cite: chosen from the server's list, never typed. */
function CiteEvidence({ s, kinds, chosen, onChange, legend }: { s: FirstPeriodStatus; kinds: readonly EvidenceKind[]; chosen: readonly string[]; onChange: (ids: string[]) => void; legend: string }) {
  const list = s.evidence.filter((e) => kinds.includes(e.kind));
  return (
    <fieldset className="space-y-1" data-testid="cite-evidence">
      <legend className="font-medium">{legend}</legend>
      {list.length === 0 ? <p className="text-muted-foreground">No evidence of these kinds is recorded yet. Record it under Evidence for the first-period review below.</p> : list.map((e) => (
        <label key={e.id} className="flex items-start gap-2">
          <input type="checkbox" checked={chosen.includes(e.id)} onChange={(x) => onChange(x.target.checked ? [...chosen, e.id] : chosen.filter((i) => i !== e.id))} />
          <span>{kindLabel(e.kind)}: {e.reference} (revision {e.revision}; establishes {e.assertedDate ?? "—"}; issued {e.issuedOn})</span>
        </label>
      ))}
    </fieldset>
  );
}

const FP_KINDS: readonly EvidenceKind[] = ["certificate_of_incorporation", "certificate_of_registration", "commencement_resolution", "regulatory_commencement_notice", "dormancy_confirmation", "prior_activity_record"];
const OPENING_KINDS: readonly EvidenceKind[] = ["opening_position_support", "pre_setup_activity_support", "prior_activity_record"];

function FirstPeriodForm({ p, s, client, onDone, onCancel }: { p: P; s: FirstPeriodStatus; client: FirstPeriodClient; onDone: (t: string) => Promise<void>; onCancel: () => void }) {
  const prev = (s.firstPeriod.claim?.facts ?? {}) as Record<string, unknown>;
  const str = (k: string, d = "") => (typeof prev[k] === "string" ? (prev[k] as string) : d);
  const [f, setF] = useState<FirstPeriodFactsInput>({
    legalName: str("legalName", s.entity.legalName ?? ""), registrationNumber: str("registrationNumber"), tin: str("tin", s.entity.tin ?? ""),
    basis: prev.basis === "commenced_after_dormancy" ? "commenced_after_dormancy" : "incorporated_in_period", registrationDate: str("registrationDate"), effectiveStart: str("effectiveStart"),
    priorStatementsPrepared: prev.priorStatementsPrepared === true, dormantFrom: str("dormantFrom"), dormantThrough: str("dormantThrough"),
  });
  const [basis, setBasis] = useState(s.firstPeriod.claim?.basisText ?? "");
  const current = new Set(s.evidence.map((e) => e.id));
  const [cited, setCited] = useState<string[]>((s.firstPeriod.claim?.evidenceIds ?? []).filter((i) => current.has(i)));
  const [busy, setBusy] = useBusyState();
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const id = useId();
  const set = <K extends keyof FirstPeriodFactsInput>(k: K, v: FirstPeriodFactsInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const period = s.period.reportingStart && s.period.reportingEnd ? { reportingStart: s.period.reportingStart, reportingEnd: s.period.reportingEnd } : null;
  const isDate = (d: string) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d);
  const ready = !!period && f.legalName.trim().length >= 3 && f.registrationNumber.trim().length >= 3 && isDate(f.registrationDate) && isDate(f.effectiveStart)
    && (f.basis === "incorporated_in_period" || (isDate(f.dormantFrom) && isDate(f.dormantThrough))) && basisOk(basis) && cited.length > 0;
  const submit = async () => {
    if (!period || !setBusy(true)) return;
    try {
      const facts = firstPeriodFacts(f, period);
      const r = await client.submitClaim(p.companyId, p.periodYear, "first_period", facts, basis.trim(), cited, attempt.idFor(JSON.stringify([facts, basis.trim(), [...cited].sort()])));
      if (r.outcome === "recorded" || r.outcome === "replay") { attempt.done(); await onDone("Submitted. A partner or manager other than you must now review the facts."); }
      else setNotice(outcomeWords(CLAIM_OUTCOMES, r));
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };
  return (
    <form className="space-y-2 rounded-md border border-border p-3" aria-label="First-period facts" data-testid="fp-first_period-form" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}>
      <p className="text-muted-foreground" data-testid="fp-server-dates">Reporting period (from the reviewed trial balance): {period ? `${period.reportingStart} to ${period.reportingEnd}` : "not available - review and certify this period's trial balance first"}. Company in this workspace: {s.entity.legalName ?? "—"}{s.entity.tin ? `, TIN ${s.entity.tin}` : ""}.</p>
      <label htmlFor={`${id}-name`} className="block font-medium">Legal name (as on the certificate)</label>
      <input id={`${id}-name`} className={field} maxLength={200} value={f.legalName} onChange={(e) => set("legalName", e.target.value)} />
      <label htmlFor={`${id}-reg`} className="block font-medium">Registration number</label>
      <input id={`${id}-reg`} className={field} maxLength={60} value={f.registrationNumber} onChange={(e) => set("registrationNumber", e.target.value)} />
      <label htmlFor={`${id}-tin`} className="block font-medium">Tax identifier (TIN), if the company has one</label>
      <input id={`${id}-tin`} className={field} inputMode="numeric" maxLength={12} value={f.tin} onChange={(e) => set("tin", e.target.value)} />
      <fieldset className="space-y-1">
        <legend className="font-medium">Why this is the first reporting period</legend>
        <label className="flex gap-2"><input type="radio" name={`${id}-basis`} checked={f.basis === "incorporated_in_period"} onChange={() => set("basis", "incorporated_in_period")} />The company was registered during this period</label>
        <label className="flex gap-2"><input type="radio" name={`${id}-basis`} checked={f.basis === "commenced_after_dormancy"} onChange={() => set("basis", "commenced_after_dormancy")} />It was registered earlier, was dormant, and started trading in this period</label>
      </fieldset>
      <label htmlFor={`${id}-rd`} className="block font-medium">Registration date</label>
      <input id={`${id}-rd`} type="date" className="rounded-md border border-input bg-background px-2 py-1" value={f.registrationDate} onChange={(e) => set("registrationDate", e.target.value)} />
      <label htmlFor={`${id}-es`} className="block font-medium">Effective start date (first day of trading or operations)</label>
      <input id={`${id}-es`} type="date" className="rounded-md border border-input bg-background px-2 py-1" value={f.effectiveStart} onChange={(e) => set("effectiveStart", e.target.value)} />
      {f.basis === "commenced_after_dormancy" ? (
        <>
          <label htmlFor={`${id}-df`} className="block font-medium">Dormant from</label>
          <input id={`${id}-df`} type="date" className="rounded-md border border-input bg-background px-2 py-1" value={f.dormantFrom} onChange={(e) => set("dormantFrom", e.target.value)} />
          <label htmlFor={`${id}-dt`} className="block font-medium">Dormant through</label>
          <input id={`${id}-dt`} type="date" className="rounded-md border border-input bg-background px-2 py-1" value={f.dormantThrough} onChange={(e) => set("dormantThrough", e.target.value)} />
        </>
      ) : null}
      <label className="flex gap-2"><input type="checkbox" checked={f.priorStatementsPrepared} onChange={(e) => set("priorStatementsPrepared", e.target.checked)} />Financial statements were prepared for an earlier period</label>
      <CiteEvidence s={s} kinds={FP_KINDS} chosen={cited} onChange={setCited} legend="Evidence cited (current revisions)" />
      <BasisField id={`${id}-basis-text`} value={basis} onChange={setBasis} label="Written basis for the judgment" />
      <div className="flex flex-wrap gap-2">
        <ActionButton busy={busy} type="submit" className={primaryBtn} disabled={!ready || busy} data-testid="fp-submit">{busy ? "Submitting…" : "Submit for approval"}</ActionButton>
        <button type="button" className={secondaryBtn} onClick={onCancel}>Cancel</button>
      </div>
      <Notice text={notice} />
    </form>
  );
}

interface Item { description: string; date: string; amount: string; evidenceId: string }
function OpeningForm({ p, s, client, onDone, onCancel }: { p: P; s: FirstPeriodStatus; client: FirstPeriodClient; onDone: (t: string) => Promise<void>; onCancel: () => void }) {
  const ex = p.c.current.exponent;
  const prev = (s.openingBalances.claim?.facts ?? {}) as Record<string, unknown>;
  const [basisKind, setBasisKind] = useState<"nil_opening" | "reconciled_pre_setup_activity">(prev.basis === "reconciled_pre_setup_activity" ? "reconciled_pre_setup_activity" : "nil_opening");
  const [bookkeepingStart, setBk] = useState(typeof prev.bookkeepingStart === "string" ? prev.bookkeepingStart : "");
  const [net, setNet] = useState("");
  const [items, setItems] = useState<Item[]>([{ description: "", date: "", amount: "", evidenceId: "" }]);
  const [basis, setBasis] = useState(s.openingBalances.claim?.basisText ?? "");
  const current = new Set(s.evidence.map((e) => e.id));
  const [cited, setCited] = useState<string[]>((s.openingBalances.claim?.evidenceIds ?? []).filter((i) => current.has(i)));
  const [busy, setBusy] = useBusyState();
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const id = useId();
  const itemEvidence = s.evidence.filter((e) => e.kind === "pre_setup_activity_support" || e.kind === "prior_activity_record");
  const isDate = (d: string) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d);
  const built = items.map((i) => ({ description: i.description.trim(), date: i.date, amountMinor: signedMinor(i.amount, ex), evidenceId: i.evidenceId }));
  const netMinor = signedMinor(net, ex);
  const reconciled = basisKind === "reconciled_pre_setup_activity";
  const ready = isDate(bookkeepingStart) && basisOk(basis) && (reconciled
    ? netMinor !== null && built.length > 0 && built.every((b) => b.description.length >= 3 && isDate(b.date) && b.amountMinor !== null && b.evidenceId)
    : cited.length > 0);
  const submit = async () => {
    if (!setBusy(true)) return;
    try {
      const facts = reconciled
        ? { basis: basisKind, bookkeepingStart, preSetupNetMinor: netMinor, items: built.map((b) => ({ ...b, amountMinor: b.amountMinor })) }
        : { basis: basisKind, bookkeepingStart };
      const ids = [...new Set([...cited, ...(reconciled ? built.map((b) => b.evidenceId) : [])])];
      const r = await client.submitClaim(p.companyId, p.periodYear, "opening_balances", facts, basis.trim(), ids, attempt.idFor(JSON.stringify([facts, basis.trim(), [...ids].sort()])));
      if (r.outcome === "recorded" || r.outcome === "replay") { attempt.done(); await onDone("Submitted. A partner or manager other than you must now review the opening-balance support."); }
      else setNotice(outcomeWords(CLAIM_OUTCOMES, r));
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };
  const setItem = (n: number, k: keyof Item, v: string) => setItems((xs) => xs.map((x, i) => (i === n ? { ...x, [k]: v } : x)));
  return (
    <form className="space-y-2 rounded-md border border-border p-3" aria-label="Opening-balance support" data-testid="fp-opening_balances-form" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}>
      <fieldset className="space-y-1">
        <legend className="font-medium">The position when the company started</legend>
        <label className="flex gap-2"><input type="radio" name={`${id}-ob`} checked={!reconciled} onChange={() => setBasisKind("nil_opening")} />There were no balances: bookkeeping began on or before the effective start date</label>
        <label className="flex gap-2"><input type="radio" name={`${id}-ob`} checked={reconciled} onChange={() => setBasisKind("reconciled_pre_setup_activity")} />Activity happened before bookkeeping began; each item is listed with its evidence</label>
      </fieldset>
      <label htmlFor={`${id}-bk`} className="block font-medium">Bookkeeping start date</label>
      <input id={`${id}-bk`} type="date" className="rounded-md border border-input bg-background px-2 py-1" value={bookkeepingStart} onChange={(e) => setBk(e.target.value)} />
      {reconciled ? (
        <>
          <label htmlFor={`${id}-net`} className="block font-medium">Opening position stated (net; a negative amount is a net outflow)</label>
          <input id={`${id}-net`} inputMode="decimal" className="w-40 rounded-md border border-input bg-background px-2 py-1 text-right" value={net} onChange={(e) => setNet(e.target.value)} />
          <fieldset className="space-y-2"><legend className="font-medium">Items before bookkeeping began</legend>
            {items.map((it, n) => (
              <div key={n} className="flex flex-wrap items-end gap-2" data-testid="opening-item">
                <label className="block">Description<input className={`ml-1 ${field} sm:w-48`} value={it.description} onChange={(e) => setItem(n, "description", e.target.value)} /></label>
                <label className="block">Date<input type="date" className="ml-1 rounded-md border border-input bg-background px-2 py-1" value={it.date} onChange={(e) => setItem(n, "date", e.target.value)} /></label>
                <label className="block">Amount<input inputMode="decimal" className="ml-1 w-32 rounded-md border border-input bg-background px-2 py-1 text-right" value={it.amount} onChange={(e) => setItem(n, "amount", e.target.value)} /></label>
                <label className="block">Evidence<select className="ml-1 rounded-md border border-input bg-background px-2 py-1" value={it.evidenceId} onChange={(e) => setItem(n, "evidenceId", e.target.value)}>
                  <option value="">Choose…</option>{itemEvidence.map((e) => <option key={e.id} value={e.id}>{e.reference} (revision {e.revision}, {e.assertedDate})</option>)}
                </select></label>
                {items.length > 1 ? <button type="button" className={secondaryBtn} onClick={() => setItems((xs) => xs.filter((_, i) => i !== n))}>Remove</button> : null}
              </div>
            ))}
            <button type="button" className={secondaryBtn} onClick={() => setItems((xs) => [...xs, { description: "", date: "", amount: "", evidenceId: "" }])}>Add an item</button>
          </fieldset>
        </>
      ) : null}
      <CiteEvidence s={s} kinds={OPENING_KINDS} chosen={cited} onChange={setCited} legend={reconciled ? "Further evidence cited (each item's evidence is cited with it)" : "Evidence cited (current revisions)"} />
      <BasisField id={`${id}-basis-text`} value={basis} onChange={setBasis} label="Written basis for the judgment" />
      <div className="flex flex-wrap gap-2">
        <ActionButton busy={busy} type="submit" className={primaryBtn} disabled={!ready || busy} data-testid="ob-submit">{busy ? "Submitting…" : "Submit for approval"}</ActionButton>
        <button type="button" className={secondaryBtn} onClick={onCancel}>Cancel</button>
      </div>
      <Notice text={notice} />
    </form>
  );
}

const FACT_LABELS: Record<string, string> = {
  legalName: "Legal name stated", registrationNumber: "Registration number", tin: "TIN stated", basis: "Basis", registrationDate: "Registration date", effectiveStart: "Effective start",
  reportingStart: "Reporting period start stated", reportingEnd: "Reporting period end stated", priorStatementsPrepared: "Statements prepared for an earlier period",
  dormantFrom: "Dormant from", dormantThrough: "Dormant through", bookkeepingStart: "Bookkeeping start", preSetupNetMinor: "Opening position stated",
};
const BASIS_WORDS: Record<string, string> = {
  incorporated_in_period: "Registered during this period", commenced_after_dormancy: "Registered earlier, dormant, started trading in this period",
  nil_opening: "No balances at the start", reconciled_pre_setup_activity: "Activity before bookkeeping began, item by item",
};

/** The approver's form: exactly what a decision binds, then ONE decision with its reason. */
function DecideForm({ p, s, subject, client, onDone, onCancel }: { p: P; s: FirstPeriodStatus; subject: Subject; client: FirstPeriodClient; onDone: (t: string, reload: boolean) => Promise<void>; onCancel: () => void }) {
  const st = subject === "first_period" ? s.firstPeriod : s.openingBalances;
  const [verify, setVerify] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useBusyState();
  const attempt = useAttempt(p.newRequestId);
  const id = useId();
  const ex = p.c.current.exponent;
  const facts = (st.claim?.facts ?? {}) as Record<string, unknown>;
  const show = (k: string, v: unknown): string => {
    if (k === "basis") return BASIS_WORDS[String(v)] ?? String(v);
    if (k === "priorStatementsPrepared") return v === true ? "Yes" : v === false ? "No" : "—";
    if (k === "preSetupNetMinor" && typeof v === "string" && /^-?[0-9]+$/.test(v)) return presentAmount({ kind: "amount", minor: BigInt(v), exponent: ex }).text;
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  const ready = verify !== null && reason.trim().length >= 3 && reason.trim().length <= 1500;
  const submit = async () => {
    if (verify === null || !setBusy(true)) return;
    try {
      const r = await client.decide(p.companyId, p.periodYear, subject, verify, reason.trim(), attempt.idFor(`d|${subject}|${verify}|${reason.trim()}|${st.binding}`), st.binding);
      if (r.outcome === "recorded" || r.outcome === "replay") { attempt.done(); await onDone(verify ? "Verified. The decision is bound to what was shown; any later change makes it out of date." : "Returned to the preparer with your reason.", true); }
      else await onDone(outcomeWords(DECISION_OUTCOMES, r), r.outcome === "changed_since_viewed");
    } catch (e) { await onDone(e instanceof Error ? e.message : "Nothing was recorded.", false); }
    finally { setBusy(false); }
  };
  return (
    <form className="space-y-2 rounded-md border border-border p-3" aria-label={`Decide the ${SUBJECT_TITLE[subject].toLowerCase()} review`} data-testid={`fp-${subject}-decide`} onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}>
      <p className="font-medium">What your decision binds</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[14rem_1fr]" data-testid="fp-bound">
        <dt className="text-muted-foreground">Company in this workspace</dt><dd data-testid="bound-entity">{s.entity.legalName ?? "—"}</dd>
        <dt className="text-muted-foreground">Company TIN</dt><dd data-testid="bound-tin">{s.entity.tin ?? "Not recorded"}</dd>
        <dt className="text-muted-foreground">Reporting period (from the reviewed trial balance)</dt><dd data-testid="bound-period">{s.period.reportingStart ?? "—"} to {s.period.reportingEnd ?? "—"}</dd>
        <dt className="text-muted-foreground">Rules</dt><dd data-testid="bound-rules">{st.rules}</dd>
        <dt className="text-muted-foreground">Recorded</dt><dd>{st.claim ? `${st.claim.recordedAt.slice(0, 10)} by ${st.claim.recordedByYou ? "you" : "another member"}` : "—"}</dd>
        {Object.entries(facts).filter(([k]) => k !== "items").map(([k, v]) => <FactRow key={k} k={FACT_LABELS[k] ?? k} v={show(k, v)} />)}
      </dl>
      {Array.isArray(facts.items) ? (
        <ul className="ml-4 list-disc" data-testid="bound-items">{(facts.items as Record<string, string>[]).map((i, n) => <li key={n}>{i.date}: {i.description}, {/^-?[0-9]+$/.test(i.amountMinor ?? "") ? presentAmount({ kind: "amount", minor: BigInt(i.amountMinor), exponent: ex }).text : i.amountMinor}</li>)}</ul>
      ) : null}
      <p className="font-medium">Written basis</p>
      <p className="whitespace-pre-wrap" data-testid="bound-basis">{st.claim?.basisText}</p>
      <p className="font-medium">Cited evidence revisions</p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-xs" data-testid="bound-cited">
          <thead><tr><th scope="col" className="pr-2">Kind</th><th scope="col" className="pr-2">Reference</th><th scope="col" className="pr-2">Revision</th><th scope="col" className="pr-2">Establishes</th><th scope="col" className="pr-2">Issued</th><th scope="col" className="pr-2">Fingerprint</th><th scope="col">Current</th></tr></thead>
          <tbody>{st.cited.map((e) => <tr key={e.id}><td className="pr-2">{kindLabel(e.kind)}</td><td className="pr-2">{e.reference}</td><td className="pr-2">{e.revision}</td><td className="pr-2">{e.assertedDate ?? "—"}</td><td className="pr-2">{e.issuedOn}</td><td className="pr-2"><code title={e.documentSha256}>{fingerprint(e.documentSha256)}</code></td><td>{e.current ? "Yes" : "No - replaced or retracted"}</td></tr>)}</tbody>
        </table>
      </div>
      <fieldset className="space-y-1">
        <legend className="font-medium">Your decision</legend>
        <label className="flex gap-2"><input type="radio" name={`${id}-d`} checked={verify === true} onChange={() => setVerify(true)} />Verify: the cited evidence supports these facts</label>
        <label className="flex gap-2"><input type="radio" name={`${id}-d`} checked={verify === false} onChange={() => setVerify(false)} />Return to the preparer</label>
      </fieldset>
      <label htmlFor={`${id}-reason`} className="block font-medium">Reason</label>
      <textarea id={`${id}-reason`} rows={2} maxLength={1500} className={field} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <ActionButton busy={busy} type="submit" className={primaryBtn} disabled={!ready || busy} data-testid={`fp-${subject}-record-decision`}>{busy ? "Recording…" : "Record the decision"}</ActionButton>
        <button type="button" className={secondaryBtn} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
function FactRow({ k, v }: { k: string; v: string }) { return <><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></>; }

/** Evidence revisions of the period: listed for everyone who can read the review; recorded and retracted by a preparer. */
function EvidenceRegister({ p, s, a, client, changed }: { p: P; s: FirstPeriodStatus; a: Abilities; client: FirstPeriodClient; changed: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [retract, setRetract] = useState<EvidenceRevision | null>(null);
  const [busy, setBusy] = useBusyState();
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const doRetract = async (reason: string) => {
    const e = retract;
    if (!e || !setBusy(true)) return;
    try {
      const r = await client.recordEvidence(p.companyId, p.periodYear, { kind: e.kind, reference: e.reference, issuedOn: e.issuedOn, assertedDate: null, documentSha256: e.documentSha256, note: reason.slice(0, 500), retract: true },
        attempt.idFor(`r|${e.id}|${reason}`));
      setNotice(r.outcome === "recorded" ? `Retracted (revision ${String(r.revision)}). Facts that cite it must be recorded again.` : outcomeWords(EVIDENCE_OUTCOMES, r));
      if (r.outcome === "recorded") { attempt.done(); await changed(); }
    } catch (x) { setNotice(x instanceof Error ? x.message : "Nothing was recorded."); }
    finally { setBusy(false); setRetract(null); }
  };
  return (
    <div className="space-y-2" data-testid="fp-evidence">
      <h4 className="font-medium">Evidence for the first-period review</h4>
      <p className="text-muted-foreground">Each document is identified by its fingerprint (SHA-256), worked out in your browser; the file itself is not uploaded and stays in the firm's own records. A later version of the same reference is a new revision, and any new revision makes an earlier approval out of date.</p>
      {s.evidence.length === 0 ? <p className="text-muted-foreground">No evidence recorded.</p> : (
        <ul className="space-y-1">{s.evidence.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2" data-testid="fp-evidence-row">
            <span>{kindLabel(e.kind)}: {e.reference} · revision {e.revision} · establishes {e.assertedDate ?? "—"} · issued {e.issuedOn} · <code title={e.documentSha256}>{fingerprint(e.documentSha256)}</code></span>
            {a.canPrepare ? <button type="button" className="rounded-md border border-input px-2 py-0.5" onClick={() => setRetract(e)}>Retract</button> : null}
          </li>
        ))}</ul>
      )}
      {a.canPrepare ? (adding ? <EvidenceForm p={p} client={client} onDone={async (t) => { setAdding(false); setNotice(t); await changed(); }} onCancel={() => setAdding(false)} />
        : <button type="button" className={secondaryBtn} onClick={() => { setNotice(null); setAdding(true); }} data-testid="fp-add-evidence">Record evidence</button>) : null}
      <Notice text={notice} />
      <ConfirmDialog open={retract !== null} title="Retract this evidence revision" period={`FY${p.periodYear}`} version={null}
        consequences="The revision stays in the history but no longer counts. Facts that cite it must be recorded again, and an approval that rested on it goes out of date."
        reasonMinLength={3} reasonLabel="Why it is retracted" confirmLabel="Retract" busy={busy} onConfirm={(r) => void doRetract(r)} onCancel={() => setRetract(null)} />
    </div>
  );
}

function EvidenceForm({ p, client, onDone, onCancel }: { p: P; client: FirstPeriodClient; onDone: (t: string) => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<EvidenceKind>("certificate_of_incorporation");
  const [reference, setReference] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [asserted, setAsserted] = useState("");
  const [doc, setDoc] = useState<{ name: string; sha: string } | null>(null);
  const [hashing, setHashing] = useState(false);
  const [busy, setBusy] = useBusyState();
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const id = useId();
  const isDate = (d: string) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d);
  const ready = reference.trim().length >= 3 && isDate(issuedOn) && isDate(asserted) && !!doc;
  const pick = async (file: File | undefined) => {
    setDoc(null);
    if (!file) return;
    setHashing(true);
    try { setDoc({ name: file.name, sha: await documentSha256(await file.arrayBuffer()) }); }
    catch { setNotice("The document could not be read; nothing was recorded."); }
    finally { setHashing(false); }
  };
  const submit = async () => {
    if (!doc || !setBusy(true)) return;
    try {
      const input = { kind, reference: reference.trim(), issuedOn, assertedDate: asserted, documentSha256: doc.sha, note: null, retract: false };
      const r = await client.recordEvidence(p.companyId, p.periodYear, input, attempt.idFor(JSON.stringify(input)));
      if (r.outcome === "recorded" || r.outcome === "replay") { attempt.done(); await onDone(`Recorded as revision ${String(r.revision)}.`); }
      else setNotice(outcomeWords(EVIDENCE_OUTCOMES, r));
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };
  return (
    <form className="space-y-2 rounded-md border border-border p-3" aria-label="Record evidence" data-testid="fp-evidence-form" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}>
      <label htmlFor={`${id}-kind`} className="block font-medium">Kind of document</label>
      <select id={`${id}-kind`} className="rounded-md border border-input bg-background px-2 py-1" value={kind} onChange={(e) => setKind(e.target.value as EvidenceKind)}>
        {Object.entries(EVIDENCE_KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>
      <label htmlFor={`${id}-ref`} className="block font-medium">Reference (for example the certificate number)</label>
      <input id={`${id}-ref`} className={field} maxLength={300} value={reference} onChange={(e) => setReference(e.target.value)} />
      <label htmlFor={`${id}-iss`} className="block font-medium">Issue date</label>
      <input id={`${id}-iss`} type="date" className="rounded-md border border-input bg-background px-2 py-1" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
      <label htmlFor={`${id}-as`} className="block font-medium">{EVIDENCE_KINDS[kind].dateLabel}</label>
      <input id={`${id}-as`} type="date" className="rounded-md border border-input bg-background px-2 py-1" value={asserted} onChange={(e) => setAsserted(e.target.value)} />
      <label htmlFor={`${id}-file`} className="block font-medium">Document (read in your browser to take its fingerprint; not uploaded)</label>
      <input id={`${id}-file`} type="file" className="block" onChange={(e) => void pick(e.target.files?.[0])} data-testid="fp-evidence-file" />
      {hashing ? <PendingStatus label="Reading the document…" /> : doc ? <p className="text-xs text-muted-foreground" data-testid="fp-evidence-fingerprint">{doc.name}: fingerprint <code>{fingerprint(doc.sha)}</code></p> : null}
      <div className="flex flex-wrap gap-2">
        <ActionButton busy={busy} type="submit" className={primaryBtn} disabled={!ready || busy} data-testid="fp-evidence-submit">{busy ? "Recording…" : "Record the evidence"}</ActionButton>
        <button type="button" className={secondaryBtn} onClick={onCancel}>Cancel</button>
      </div>
      <Notice text={notice} />
    </form>
  );
}
