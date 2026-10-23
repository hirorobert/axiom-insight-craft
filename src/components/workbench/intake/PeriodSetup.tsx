import { useBusyState } from "@/hooks/useBusyState";
import { ActionButton } from "@/components/feedback/ActionButton";
import { useEffect, useId, useRef, useState } from "react";
import { CURRENCY_REGISTRY, CURRENCY_REGISTRY_VERSION } from "@/lib/currency/registry";
import { CurrencySelect } from "@/components/currency/CurrencySelect";
import { isoCurrencyOptions } from "@/lib/currency/currencyOptions";
import { periodFormProblems } from "@/lib/workbench/intake/periodForm";
import {
  SetupFeatureUnavailable, WorkspaceSetupError, openEngagementWithPeriod, type PeriodOpenResult, type RpcClient,
} from "@/lib/workspace/workspaceSetupClient";
import { explainBlock, getCorrectionEligibility, type Eligibility } from "@/lib/workspace/periodCurrency";

const OPTIONS = isoCurrencyOptions(Object.keys(CURRENCY_REGISTRY).sort());
/**
 * Trial balance › Intake: the reporting period with explicit start and end dates (any length up to the technical
 * ceiling, calendar or not) and an explicit reporting currency — no default currency, no default dates. The prior
 * period is optional and must end the day before this one starts (the server checks it). Refusals are shown in plain
 * words; a backend without this option leaves the existing setup in place.
 */
export function PeriodSetup({ client, companyId, periodYear, onOpened }: { client: RpcClient; companyId: string; periodYear?: number; onOpened?: (r: Extract<PeriodOpenResult, { outcome: "opened" }>) => void }) {
  const id = useId();
  const [f, setF] = useState({ start: "", end: "", currency: "", withPrior: false, priorStart: "", priorEnd: "", priorCurrency: "" });
  // The period this workspace already has (recorded dates and currency), stated and prefilled — so its prior period can be
  // added without re-entering it, and nothing is presented as "not set up" when it is.
  const [existing, setExisting] = useState<{ id: string; start: string; end: string; currency: string; hasPrior: boolean } | null>(null);
  // An existing period's currency is never an editable field here: the server refuses a different currency for an
  // existing period. Whether it can be corrected, and if not which record prevents it, is the server's answer.
  const [currencyRule, setCurrencyRule] = useState<Eligibility | null>(null);
  useEffect(() => {
    if (!periodYear) return;
    let live = true;
    const reader = client as unknown as { from?: (t: "fiscal_periods") => { select(c: string): { eq(c: "company_id", v: string): PromiseLike<{ data: { id: string; reporting_start: string | null; reporting_end: string | null; fiscal_year_end: string; reporting_currency: string | null; prior_period_id: string | null }[] | null }> } } };
    if (!reader.from) return;
    void reader.from("fiscal_periods").select("id, reporting_start, reporting_end, fiscal_year_end, reporting_currency, prior_period_id").eq("company_id", companyId).then(({ data }) => {
      const row = (data ?? []).find((r) => Number(String(r.reporting_end ?? r.fiscal_year_end).slice(0, 4)) === periodYear);
      if (!live || !row?.reporting_start || !row.reporting_end || !row.reporting_currency) return;
      const e = { id: row.id, start: row.reporting_start.slice(0, 10), end: row.reporting_end.slice(0, 10), currency: row.reporting_currency, hasPrior: !!row.prior_period_id };
      setExisting(e);
      setF((x) => (x.start || x.end ? x : { ...x, start: e.start, end: e.end, currency: e.currency }));
    }, () => { /* the form stays as it is */ });
    return () => { live = false; };
  }, [client, companyId, periodYear]);
  useEffect(() => {
    if (!existing) return;
    let live = true;
    const rpc = (fn: string, args: Record<string, unknown>) => (client as unknown as { rpc(f: string, a: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }).rpc(fn, args);
    void getCorrectionEligibility(rpc, existing.id).then((r) => { if (live) setCurrencyRule(r); }, () => { if (live) setCurrencyRule({ kind: "unavailable", reason: "error" }); });
    return () => { live = false; };
  }, [client, existing]);
  const [busy, setBusy] = useBusyState();
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const msgRef = useRef<HTMLParagraphElement>(null);
  const problems = periodFormProblems(f);
  const set = (k: keyof typeof f, v: string | boolean) => { setF({ ...f, [k]: v }); setMessage(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problems.length > 0 || busy) return;
    if (!setBusy(true)) return;
    try {
      const r = await openEngagementWithPeriod(client, {
        companyId, periodStart: f.start, periodEnd: f.end, reportingCurrency: f.currency, capabilities: ["FINANCIAL_STATEMENTS"],
        prior: f.withPrior ? { start: f.priorStart, end: f.priorEnd, ...(f.priorCurrency ? { currency: f.priorCurrency } : {}) } : undefined,
      });
      if (r.outcome === "refused") setMessage({ tone: "error", text: r.message });
      else {
        const prior = f.withPrior && r.priorPeriodId ? ` The prior period ${f.priorStart} to ${f.priorEnd} is set up and linked for comparatives.` : "";
        setMessage({ tone: "info", text: (r.created ? `Reporting period ${f.start} to ${f.end} (${f.currency}) is set up.` : `Reporting period ${f.start} to ${f.end} (${f.currency}) is ready.`) + prior });
        onOpened?.(r);
      }
    } catch (err) {
      if (err instanceof SetupFeatureUnavailable) setUnavailable(true);
      else setMessage({ tone: "error", text: err instanceof WorkspaceSetupError ? err.message : "The period could not be set up right now. Nothing was changed." });
    } finally {
      setBusy(false);
      setTimeout(() => msgRef.current?.focus(), 0);
    }
  };

  if (unavailable) return <p role="status" className="text-sm text-muted-foreground">Setting up a period with explicit dates is not available yet. The existing period setup is unchanged.</p>;
  const input = "mt-1 rounded-md border border-input bg-background px-2 py-1 text-sm";
  return (
    <form onSubmit={submit} aria-labelledby={`${id}-h`} className="space-y-3">
      <h2 id={`${id}-h`} className="text-base font-semibold">Reporting period</h2>
      {existing ? (
        <p className="text-sm text-muted-foreground" data-testid="period-existing">
          This workspace's period: {existing.start} to {existing.end} ({existing.currency}).{existing.hasPrior ? " Its prior period is linked." : " Add the prior period below for comparatives."}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <div><label htmlFor={`${id}-s`} className="block text-sm">Start date</label><input id={`${id}-s`} type="date" required className={input} value={f.start} onChange={(e) => set("start", e.target.value)} /></div>
        <div><label htmlFor={`${id}-e`} className="block text-sm">End date</label><input id={`${id}-e`} type="date" required className={input} value={f.end} onChange={(e) => set("end", e.target.value)} /></div>
        <div className="w-full sm:w-72">
          {existing ? (
            <>
              <p className="block text-sm">Reporting currency</p>
              <p className="mt-1 text-sm font-medium" data-testid="period-currency-readonly">{existing.currency}</p>
              <p className="text-xs text-muted-foreground" data-testid="period-currency-rule">{currencyRuleText(currencyRule, existing.currency)}</p>
            </>
          ) : (
            <>
              <label htmlFor={`${id}-c`} className="block text-sm">Reporting currency</label>
              <CurrencySelect id={`${id}-c`} value={f.currency} onChange={(c) => set("currency", c)} options={OPTIONS} describedBy={`${id}-cv`} required className="mt-1" />
              <p id={`${id}-cv`} className="text-xs text-muted-foreground">ISO 4217 monetary currencies ({CURRENCY_REGISTRY_VERSION}).</p>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <input id={`${id}-p`} type="checkbox" checked={f.withPrior} onChange={(e) => set("withPrior", e.target.checked)} />
        <label htmlFor={`${id}-p`}>Also set up the prior period (for comparatives)</label>
      </div>
      {f.withPrior ? (
        <div className="flex flex-wrap gap-3">
          <div><label htmlFor={`${id}-ps`} className="block text-sm">Prior start date</label><input id={`${id}-ps`} type="date" className={input} value={f.priorStart} onChange={(e) => set("priorStart", e.target.value)} /></div>
          <div><label htmlFor={`${id}-pe`} className="block text-sm">Prior end date</label><input id={`${id}-pe`} type="date" className={input} value={f.priorEnd} onChange={(e) => set("priorEnd", e.target.value)} /></div>
          <div className="w-full sm:w-72">
            <label htmlFor={`${id}-pc`} className="block text-sm">Prior currency (if different)</label>
            <CurrencySelect id={`${id}-pc`} value={f.priorCurrency} onChange={(c) => set("priorCurrency", c)} options={OPTIONS} noneOption="Same as this period" className="mt-1" />
          </div>
        </div>
      ) : null}
      {problems.length > 0 ? <ul aria-label="Still needed" className="list-disc pl-5 text-sm text-muted-foreground">{problems.map((x) => <li key={x}>{x}</li>)}</ul> : null}
      <p ref={msgRef} tabIndex={-1} role={message?.tone === "error" ? "alert" : "status"} className="text-sm">{message?.text ?? ""}</p>
      <ActionButton busy={busy} type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" disabled={problems.length > 0 || busy}>
        {busy ? "Setting up…" : "Set up the period"}
      </ActionButton>
    </form>
  );
}

/** The server's rule for an existing period's currency, in words (never a control here). */
function currencyRuleText(rule: Eligibility | null, currency: string): string {
  if (!rule) return "Checking whether this currency can still change…";
  if (rule.kind === "eligible") return `Nothing has been accepted in ${currency} yet. If the trial balance check finds the file is labelled in another currency, the Trial balance page offers to change the period's currency (recorded, no amounts converted).`;
  if (rule.kind === "not_eligible") { const e = explainBlock(rule.block, rule.currency); return `${e.reason} ${e.route}`; }
  return rule.reason === "not_authorised"
    ? "The period's currency is set. Only someone who can prepare this workspace's close can change it, from the Trial balance page."
    : "The period's currency is set. Whether it can still change could not be read right now.";
}
