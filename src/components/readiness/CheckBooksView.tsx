/**
 * Close Review › Check my books. One page, one path: import the frozen exports and the documents, see exactly what is wrong or
 * missing, review a correction the evidence supports, and read the status of each check. The engine runs on the server; this page
 * reads its result and writes only evidence and proposals through server functions. Drafting is never blocked by anything here.
 *
 * Exactly one dominant action: "Check my books". Every other control is secondary.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ActionButton } from "@/components/feedback/ActionButton";
import { PendingStatus } from "@/components/feedback/Activity";
import { useBusyState } from "@/hooks/useBusyState";
import {
  CHECK_WORDS, PRIOR_PACK_WORDS, PROPOSE_CORRECTION_WORDS, REGISTER_WORDS, type CorrectionProposal, type ReadinessClient, type ReadinessStatus,
} from "@/lib/readiness/client";
import { buildRegistrations, parseSettings, type CheckSettings, type WorkspaceAccount } from "@/lib/readiness/importFiles";
import { presentIssues, type CorrectionView, type Issue } from "@/lib/readiness/present";
import type { ScopeFacts } from "../../../supabase/functions/_shared/readiness/types";

const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const readText = (f: File | undefined | null) => (f ? f.text().then((text) => ({ name: f.name, text })) : Promise.resolve(undefined));

const primary = "rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground";
const secondary = "rounded border px-3 py-1.5 text-sm";

export function CheckBooksView(p: {
  companyId: string; periodYear: number; client: ReadinessClient; allowed: readonly string[];
  newRequestId?: () => string;
}) {
  const ids = { banks: useId(), lines: useId(), gl: useId(), bank: useId(), approved: useId(), evidence: useId(), settings: useId(), bankId: useId(), from: useId(), to: useId(), pages: useId() };
  const [status, setStatus] = useState<ReadinessStatus | null>(null);
  const [accounts, setAccounts] = useState<WorkspaceAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useBusyState("Working…");
  const [settings, setSettings] = useState<CheckSettings | null>(null);
  const files = useRef<{ gl?: File; bank?: File; approved?: File; evidence?: File; settings?: File }>({});
  const [bankMeta, setBankMeta] = useState({ bankId: "", from: "", to: "", pagesTotal: "1" });
  const [facts, setFacts] = useState({ banks: "", lines: "", payables: true, liabilities: true });
  const pending = useRef(new Map<string, string>());
  const seq = useRef(0);
  const newId = p.newRequestId ?? (() => crypto.randomUUID());
  const requestFor = (key: string) => { let id = pending.current.get(key); if (!id) { id = newId(); pending.current.set(key, id); } return id; };
  const canPrepare = p.allowed.includes("prepare_close");

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [s, a] = await Promise.all([p.client.status(p.companyId, p.periodYear), p.client.accounts(p.companyId, p.periodYear)]);
      if (mine === seq.current) { setStatus(s); setAccounts(a); setError(null); }
    } catch { if (mine === seq.current) setError("The status could not be read. Nothing was changed."); }
  }, [p.client, p.companyId, p.periodYear]);
  useEffect(() => { void load(); }, [load]);

  const issues: Issue[] = useMemo(() => {
    const result = status?.run?.result;
    const period = status?.period;
    if (!result || !period) return [];
    const names = Object.fromEntries(accounts.map((a) => [a.key, a.name]));
    return presentIssues(result, { currency: period.currency, exponent: period.exponent, accountNames: names, doubleCharge: settings?.doubleCharge, periodEnd: period.end });
  }, [status, accounts, settings]);

  if (error) return <p role="alert">{error} <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>;
  if (!status) return <PendingStatus label="Reading the status…" skeleton />;
  if (status.state === "unavailable") return <p role="status">Close Review is not enabled for this workspace.</p>;
  if (status.state === "no_authority") return <p role="status">There is no reviewed trial balance for this period yet. Review the trial balance first; then you can check your books.</p>;
  if (status.state === "period_unknown" || !status.period) return <p role="status">The reporting period of the trial balance is not known, so the books cannot be checked yet.</p>;
  const period = status.period;

  const act = async (fn: () => Promise<void>) => {
    if (!setBusy(true)) return;
    setNotice(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "That could not be completed. Nothing was recorded."); } finally { setBusy(false); }
  };

  const start = () => act(async () => {
    const f: ScopeFacts = {
      banks: split(facts.banks), opening_lines: split(facts.lines), ...(facts.payables ? { payables_settlement: true } : {}), ...(facts.liabilities ? { liabilities_completeness: true } : {}),
    };
    const r = await p.client.start(p.companyId, p.periodYear, f);
    if (r.outcome !== "recorded" && r.outcome !== "unchanged") { setNotice(r.outcome === "forbidden" ? "Starting needs Prepare in this workspace." : "Checking could not be started. Nothing was recorded."); return; }
    setNotice("Checking started for this period."); await load();
  });

  const importFiles = () => act(async () => {
    const cfg = files.current.settings ? parseSettings((await readText(files.current.settings))!.text) : (settings ?? { scopeFacts: status.scope?.facts ?? {} });
    setSettings(cfg);
    const [gl, bank, approved, evidence] = await Promise.all([readText(files.current.gl), readText(files.current.bank), readText(files.current.approved), readText(files.current.evidence)]);
    const regs = buildRegistrations({
      gl, approved, evidence, settings: cfg, period, accounts,
      bank: bank ? { ...bank, bankId: bankMeta.bankId.trim() || cfg.bank?.id || "", from: bankMeta.from || period.start, to: bankMeta.to || period.end, pagesTotal: Number(bankMeta.pagesTotal) } : undefined,
    });
    if (regs.length === 0) { setNotice("Choose at least one file to import."); return; }
    let recorded = 0, unchanged = 0;
    for (const r of regs) {
      const out = await p.client.register(p.companyId, p.periodYear, r.family, r.key, r.payload, r.file_sha256, requestFor(`reg|${r.family}|${r.key}|${r.file_sha256}`));
      if (out.outcome === "recorded") recorded++; else if (out.outcome === "unchanged") unchanged++;
      else { setNotice(REGISTER_WORDS[out.outcome]); return; }
    }
    setNotice(`Imported ${recorded} item${recorded === 1 ? "" : "s"}${unchanged ? `; ${unchanged} already held` : ""}. Now check your books.`);
    await load();
  });

  const readPriorPack = () => act(async () => {
    const out = await p.client.importPriorPack(p.companyId, p.periodYear, requestFor("prior-pack"));
    if (out.outcome !== "recorded" && out.outcome !== "unchanged") { setNotice(PRIOR_PACK_WORDS[out.outcome]); return; }
    setNotice(out.outcome === "unchanged" ? "Last year's FINAL pack was already read." : `Read last year's approved position from its FINAL pack (version ${out.priorReportVersion}): ${out.lines} lines, ${out.classified} explained by the pack's own approved adjustments. Now check your books.`);
    await load();
  });

  const check = () => act(async () => {
    const out = await p.client.check(p.companyId, p.periodYear);
    if (out !== "recorded") { setNotice(CHECK_WORDS[out]); return; }
    await load();
  });

  const proposalsOf = (issue: Issue): CorrectionProposal[] => {
    const all: CorrectionView[] = [...issue.relatedCorrections, ...(issue.correction ? [issue.correction] : [])];
    const dc = settings?.doubleCharge;
    const bundle = all.length > 1 ? `bundle:${(issue.correction ?? all[0]).id.replace(/^corr:/, "")}` : null;
    return all.map((c) => ({
      correctionId: c.id, scope: c.id.startsWith("corr:opening:") ? `opening:${c.id.replace("corr:opening:", "")}` : issue.scope,
      anchor: dc && (c.id === dc.correction_id || c.id.startsWith("corr:opening:")) ? [dc.bill, dc.cheque] : [c.id],
      bundle, reason: c.effectInWords.slice(0, 1000), evidenceRef: "Check my books",
      lines: c.lines.map((l) => ({ accountKey: l.account, debitMinor: l.amount.startsWith("-") ? "0" : l.amount, creditMinor: l.amount.startsWith("-") ? l.amount.slice(1) : "0" })),
    }));
  };
  const propose = (issue: Issue) => act(async () => {
    let n = 0;
    for (const c of proposalsOf(issue)) {
      const out = await p.client.propose(p.companyId, p.periodYear, c, requestFor(`prop|${c.correctionId}|${JSON.stringify(c.lines)}`));
      if (out.outcome === "proposed" || out.outcome === "already_proposed") n++; else { setNotice(PROPOSE_CORRECTION_WORDS[out.outcome]); return; }
    }
    setNotice(`${n} correction${n === 1 ? "" : "s"} proposed. A second person approves ${n === 1 ? "it" : "them"} in Adjustments; then check your books again.`);
    await load();
  });

  const run = status.run;
  const stateLine = status.state === "not_enabled" ? "Not started for this period."
    : status.state === "not_evaluated" ? "Not checked yet."
      : status.state === "stale" ? "Your books changed since the last check. Check again before you rely on it." : `Last checked ${new Date(run!.at).toLocaleString()}.`;
  const result = run?.result;
  const ready = status.state === "current" && result && !result.finalization.held && run!.balancesAgree;

  return (
    <section aria-labelledby={`${ids.gl}-h`} className="space-y-6">
      <header>
        <h2 id={`${ids.gl}-h`} className="text-base font-semibold">Check my books</h2>
        <p className="text-sm text-muted-foreground">Import your exports and documents, see exactly what is wrong or missing, and review the corrections the evidence supports. You can keep drafting while checks are open.</p>
        <p role="status" className="mt-1 text-sm">{stateLine}</p>
      </header>
      {notice && <p role="status" className="rounded border p-2 text-sm">{notice}</p>}

      {status.state === "not_enabled" ? (
        <form className="space-y-3 rounded border p-4" onSubmit={(e) => { e.preventDefault(); void start(); }}>
          <h3 className="font-medium">What should be checked?</h3>
          <label className="block text-sm" htmlFor={ids.banks}>Bank accounts (comma separated)</label>
          <input id={ids.banks} className="w-full rounded border px-2 py-1" value={facts.banks} onChange={(e) => setFacts({ ...facts, banks: e.target.value })} />
          <label className="block text-sm" htmlFor={ids.lines}>Opening balance lines to agree to last year's approved figures (comma separated)</label>
          <input id={ids.lines} className="w-full rounded border px-2 py-1" value={facts.lines} onChange={(e) => setFacts({ ...facts, lines: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={facts.payables} onChange={(e) => setFacts({ ...facts, payables: e.target.checked })} /> Check whether a payment settled an opening payable and was charged to expense</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={facts.liabilities} onChange={(e) => setFacts({ ...facts, liabilities: e.target.checked })} /> Search for goods received before year end and invoiced after it</label>
          <ActionButton type="submit" className={primary} disabled={!canPrepare} busy={busy} busyLabel="Starting…">Start checking this period</ActionButton>
          {!canPrepare && <p className="text-sm">Starting needs Prepare in this workspace.</p>}
        </form>
      ) : (
        <>
          <form className="space-y-3 rounded border p-4" onSubmit={(e) => { e.preventDefault(); void importFiles(); }}>
            <h3 className="font-medium">Import your exports and documents</h3>
            <p className="text-sm text-muted-foreground">Files are read exactly as exported; anything that cannot be read exactly is refused and named, never repaired.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm" htmlFor={ids.gl}>General Ledger export (CSV)<input id={ids.gl} type="file" accept=".csv" className="block" onChange={(e) => { files.current.gl = e.target.files?.[0]; }} /></label>
              <label className="text-sm" htmlFor={ids.approved}>Approved prior-year figures (CSV)<input id={ids.approved} type="file" accept=".csv" className="block" onChange={(e) => { files.current.approved = e.target.files?.[0]; }} /></label>
              <label className="text-sm" htmlFor={ids.evidence}>Evidence register (JSON)<input id={ids.evidence} type="file" accept=".json" className="block" onChange={(e) => { files.current.evidence = e.target.files?.[0]; }} /></label>
              <label className="text-sm" htmlFor={ids.settings}>Settings for this check (JSON)<input id={ids.settings} type="file" accept=".json" className="block" onChange={(e) => { files.current.settings = e.target.files?.[0]; }} /></label>
              <label className="text-sm" htmlFor={ids.bank}>Bank statement (CSV)<input id={ids.bank} type="file" accept=".csv" className="block" onChange={(e) => { files.current.bank = e.target.files?.[0]; }} /></label>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <label htmlFor={ids.bankId}>Bank account<input id={ids.bankId} className="w-full rounded border px-2 py-1" value={bankMeta.bankId} onChange={(e) => setBankMeta({ ...bankMeta, bankId: e.target.value })} /></label>
                <label htmlFor={ids.pages}>Printed pages<input id={ids.pages} inputMode="numeric" className="w-full rounded border px-2 py-1" value={bankMeta.pagesTotal} onChange={(e) => setBankMeta({ ...bankMeta, pagesTotal: e.target.value })} /></label>
                <label htmlFor={ids.from}>Statement from<input id={ids.from} className="w-full rounded border px-2 py-1" value={bankMeta.from} onChange={(e) => setBankMeta({ ...bankMeta, from: e.target.value })} /></label>
                <label htmlFor={ids.to}>Statement to<input id={ids.to} className="w-full rounded border px-2 py-1" value={bankMeta.to} onChange={(e) => setBankMeta({ ...bankMeta, to: e.target.value })} /></label>
              </div>
            </div>
            <ActionButton type="submit" className={secondary} disabled={!canPrepare} busy={busy} busyLabel="Importing…">Import the files</ActionButton>
            <ActionButton type="button" className={secondary} disabled={!canPrepare} busy={busy} busyLabel="Reading…" onClick={() => void readPriorPack()} data-testid="use-prior-pack">Use last year's FINAL pack as the approved opening position</ActionButton>
          </form>

          <div>
            <ActionButton type="button" className={primary} disabled={!canPrepare} busy={busy} busyLabel="Checking…" onClick={() => void check()}>Check my books</ActionButton>
          </div>
        </>
      )}

      {result && (
        <>
          <div aria-live="polite">
            {ready ? (
              <p className="rounded border border-green-600 p-3 text-sm">Every required check is ready. The reviewed adjusted trial balance feeds <a className="underline" href={`/workspace/${p.companyId}/${p.periodYear}/statements`}>Financial Statements</a>. The pack is issued only after a reviewer marks it reviewed and an approver finalizes it; the server repeats this check at that moment.</p>
            ) : (
              <p className="text-sm">{issues.length} {issues.length === 1 ? "check needs" : "checks need"} attention. Nothing here stops you drafting; the pack cannot be finalized until every required check is ready.</p>
            )}
          </div>
          {!run!.balancesAgree && <p role="alert" className="text-sm">The adjusted trial balance does not equal the corrections counted here. Withdraw or reverse the duplicate adjustment.</p>}
          <ul className="space-y-3">
            {issues.map((issue) => (
              <li key={issue.scope}>
                <article className="space-y-2 rounded border p-4" aria-label={`${issue.group}: ${issue.scope}`}>
                  <h3 className="font-medium">{issue.group}</h3>
                  <p className="text-sm">{issue.headline}</p>
                  {issue.evidenceHeld.length > 0 && (<><p className="text-sm font-medium">What we already hold</p><ul className="list-disc pl-5 text-sm">{issue.evidenceHeld.map((e) => <li key={e}>{e}</li>)}</ul></>)}
                  {issue.missing.length > 0 && (<><p className="text-sm font-medium">Still needed</p><ul className="list-disc pl-5 text-sm">{issue.missing.map((m) => <li key={m}>{m}</li>)}</ul></>)}
                  {[...issue.relatedCorrections, ...(issue.correction ? [issue.correction] : [])].map((c) => (
                    <div key={c.id} className="rounded bg-muted p-2 text-sm"><p>{c.effectInWords}</p><p className="text-muted-foreground">{c.summary}</p></div>
                  ))}
                  <p className="text-sm"><span className="font-medium">Next:</span> {issue.nextAction.label}. {issue.nextAction.request}</p>
                  {issue.nextAction.kind === "review_correction" && issue.correction && (
                    <ActionButton type="button" className={secondary} disabled={!canPrepare} busy={busy} busyLabel="Proposing…" onClick={() => void propose(issue)}>Propose for review</ActionButton>
                  )}
                </article>
              </li>
            ))}
          </ul>
          <section aria-label="Status of each check">
            <h3 className="font-medium">Status of each check</h3>
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {result.required_scopes.map((s) => <li key={s}><span className="font-mono">{s}</span>: {result.scopes[s] === "READY" ? "Ready" : "Needs attention"}</li>)}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
