/**
 * PeriodCurrencyCorrection — the recovery for a trial balance refused because its amounts are labelled in another
 * currency than the period's (CURRENCY_MISMATCH). Rendered inside the blocked card (CurrentTrialBalanceCard.resolution).
 *
 * Everything shown comes from the server: the check's recorded labels (processing_result.ingestion) and the period's
 * correction eligibility (get_period_currency_correction). The page offers exactly what the server will accept:
 *   · a correction to the ONE currency the file names, confirmed explicitly with a reason (correct_period_currency;
 *     amounts are never converted; one request id per confirmation, so repeated clicks are one correction);
 *   · then the file is re-checked through the normal path with the server's deterministic re-check id;
 *   · if the re-check did not start, the saved currency and a "Re-check now" that reuses that same id;
 *   · where the server refuses a correction, the record that prevents it and the route that still works — no control.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import type { ReprocessClient } from "@/lib/workspace/requestReprocess";
import {
  correctPeriodCurrency, decideCorrectionView, getCorrectionEligibility, readCurrencyMismatch, runRechecks,
  explainBlock, type Eligibility, type Recheck,
} from "@/lib/workspace/periodCurrency";

type Rpc = Parameters<typeof getCorrectionEligibility>[0];
const rpc: Rpc = (fn, args) => (supabase.rpc as unknown as (f: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>)(fn, args);

type Step =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "saving" }
  | { kind: "rechecking"; currency: string }
  | { kind: "done"; currency: string }
  | { kind: "recheck_failed"; currency: string; message: string; recheck: Recheck }
  | { kind: "error"; message: string };

export function PeriodCurrencyCorrection({ periodId, uploadId, processingResult, ensureFreshSession, onChanged, onLeadsChange }: {
  periodId: string;
  uploadId: string;
  processingResult: unknown;
  ensureFreshSession: () => Promise<unknown>;
  /** The upload and readiness should be read again (a correction or a re-check started). */
  onChanged: () => void;
  /** Whether this panel currently holds the card's leading action (so the card's own action steps back: one CTA). */
  onLeadsChange?: (leads: boolean) => void;
}) {
  const mismatch = readCurrencyMismatch(processingResult);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [reason, setReason] = useState("");
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);
  // A re-check without a recorded id (the period was set to this currency some other way): one id for this panel.
  const fallbackRecheck = useRef<Recheck | null>(null);
  const reasonId = useId();
  const reasonHelpId = useId();

  const load = useCallback(async () => {
    setEligibility(await getCorrectionEligibility(rpc, periodId).catch(() => ({ kind: "unavailable" as const, reason: "error" as const })));
  }, [periodId]);
  useEffect(() => { if (mismatch) void load(); }, [load, mismatch?.checkedAgainst, mismatch?.fileCodes.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = decideCorrectionView(mismatch, eligibility, uploadId);
  const leads = view.kind === "offer" || view.kind === "recheck" || step.kind === "recheck_failed";
  useEffect(() => { onLeadsChange?.(leads); }, [leads, onLeadsChange]);
  useEffect(() => () => onLeadsChange?.(false), [onLeadsChange]);
  if (!mismatch) return null;

  const recheck = async (r: Recheck, currency: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStep({ kind: "rechecking", currency });
    try {
      const [out] = await runRechecks(supabase as unknown as ReprocessClient, [r], ensureFreshSession);
      if (out && out.ok === false) setStep({ kind: "recheck_failed", currency, message: out.message, recheck: r });
      else setStep({ kind: "done", currency });
    } finally {
      inFlight.current = false;
      onChanged();
    }
  };

  const recheckFor = (r: Recheck | null): Recheck => r ?? (fallbackRecheck.current ??= { uploadId, operationId: crypto.randomUUID() });

  const confirm = async (from: string, to: string) => {
    if (inFlight.current) return;
    const trimmed = reason.trim();
    if (trimmed.length < 3) return;
    inFlight.current = true;
    requestId.current ??= crypto.randomUUID();
    setStep({ kind: "saving" });
    let rechecks: Recheck[] = [];
    try {
      await ensureFreshSession();
      const result = await correctPeriodCurrency(rpc, { periodId, from, to, reason: trimmed, requestId: requestId.current });
      if (result.kind === "corrected") {
        rechecks = result.rechecks.filter((r) => r.uploadId === uploadId);
      } else if (result.kind === "busy") {
        // Nothing changed; the same request id is kept, so trying again can never make a second change.
        setStep({ kind: "error", message: "Other work in this workspace was being saved at that moment, so nothing was changed. Try again." });
        inFlight.current = false;
        return;
      } else {
        requestId.current = null;
        const message = result.kind === "stale" ? `The period's currency was changed meanwhile; it now reports in ${result.currency}.`
          : result.kind === "unchanged" ? `The period already reports in ${result.currency}.`
          : result.kind === "not_eligible" ? `${explainBlock(result.block, result.currency).reason} ${explainBlock(result.block, result.currency).route}`
          : "You cannot change this period's currency: it needs someone who can prepare this workspace's close.";
        setStep({ kind: "error", message });
        await load();
        return;
      }
    } catch {
      // Not answered: the same request id is kept, so trying again can never make a second change.
      setStep({ kind: "error", message: "The currency was not changed: the request did not reach the server. Check your connection and try again." });
      inFlight.current = false;
      return;
    }
    inFlight.current = false;
    await load();
    await recheck(recheckFor(rechecks[0] ?? null), to);
  };

  const shell = (children: ReactNode, tone: "info" | "alert" = "info") => (
    <div role={tone === "alert" ? "alert" : "region"} aria-label="Reporting currency" data-testid="currency-correction"
      data-view={view.kind} data-step={step.kind} className="space-y-3 text-[13px] text-foreground">
      {children}
    </div>
  );

  // Outcomes of this panel's own actions take precedence over the read (the read is refreshed meanwhile).
  if (step.kind === "rechecking") return shell(
    <p className="flex items-center gap-2" data-testid="currency-correction-rechecking"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      The period now reports in {step.currency}. Checking the trial balance again…</p>);
  if (step.kind === "done") return shell(
    <p className="flex items-start gap-2" data-testid="currency-correction-done"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
      The period now reports in {step.currency}. The trial balance is being checked again; the result appears on this page.</p>);
  if (step.kind === "recheck_failed") return shell(<>
    <p className="flex items-start gap-2" data-testid="currency-correction-recheck-failed"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <span>The period now reports in <strong>{step.currency}</strong> (saved). The trial balance was not checked again: {step.message}</span></p>
    <Button type="button" variant="default" className="h-10 rounded-none" onClick={() => void recheck(step.recheck, step.currency)} data-testid="currency-correction-recheck">
      <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />Re-check now</Button>
  </>, "alert");

  if (eligibility === null) return shell(
    <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Checking whether the period's currency can be changed…</p>);

  switch (view.kind) {
    case "none":
      return null;
    case "recheck":
      return shell(<>
        <p data-testid="currency-correction-recheck-needed">The period now reports in <strong>{view.currency}</strong>, but this result was checked against {view.checkedAgainst}. Check the trial balance again to use {view.currency}.</p>
        <Button type="button" className="h-10 rounded-none" onClick={() => void recheck(recheckFor(view.recheck), view.currency)} data-testid="currency-correction-recheck">
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />Re-check now</Button>
      </>);
    case "mixed":
      return shell(
        <p data-testid="currency-correction-mixed">The file labels its amounts in more than one currency ({view.codes.join(", ")}). A trial balance has one currency, so changing the period's currency cannot fix this. Correct the labels in the file so every amount is in one currency, then replace the file.</p>);
    case "blocked":
      return shell(<>
        <p data-testid="currency-correction-blocked">The file's amounts are labelled {view.to}; the period reports in {view.currency}. {view.reason}</p>
        <p className="font-medium" data-testid="currency-correction-route">{view.route}</p>
      </>);
    case "offer": {
      const saving = step.kind === "saving";
      if (step.kind === "idle") return shell(<>
        <p data-testid="currency-correction-offer">The file's amounts are labelled <strong>{view.to}</strong>; the period reports in <strong>{view.from}</strong>. If the amounts really are in {view.to}, change the period's currency. If they are in {view.from}, replace the file.</p>
        <Button type="button" className="h-10 rounded-none" onClick={() => setStep({ kind: "confirming" })} data-testid="currency-correction-start">
          Change the period's currency to {view.to}</Button>
      </>);
      return shell(<>
        <p className="font-medium">Change this period's reporting currency from {view.from} to {view.to}?</p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>No amount is converted: the file's figures are read as {view.to}.</li>
          <li>The change is recorded with your name, the reason and the time.</li>
          <li>The trial balance is then checked again in {view.to}.</li>
        </ul>
        <div className="space-y-1">
          <label htmlFor={reasonId} className="block font-medium">Reason</label>
          <textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} disabled={saving}
            aria-describedby={reasonHelpId} data-testid="currency-correction-reason"
            className="w-full rounded-none border border-input bg-background px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <p id={reasonHelpId} className="text-muted-foreground">For example: “The ledger is kept in {view.to}; {view.from} was chosen by mistake.”</p>
        </div>
        {step.kind === "error" && <p role="alert" className="flex items-start gap-2" data-testid="currency-correction-error"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />{step.message}</p>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" className="h-10 rounded-none" disabled={saving || reason.trim().length < 3}
            onClick={() => void confirm(view.from, view.to)} data-testid="currency-correction-confirm">
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}Change to {view.to}</Button>
          <Button type="button" variant="outline" className="h-10 rounded-none" disabled={saving}
            onClick={() => { requestId.current = null; setStep({ kind: "idle" }); }} data-testid="currency-correction-cancel">Cancel</Button>
        </div>
      </>);
    }
  }
}
