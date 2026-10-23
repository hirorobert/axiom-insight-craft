/**
 * EngagementContextPanel — the engagement, stated once, at the top of the workspace's left rail: entity, period,
 * currency and framework, and the engagement's settings in one place (never in the middle of a task page).
 *
 *   Settings here: the reporting period and currency (Trial balance › Intake), the company's details (Settings), and the
 *   review policy for clearing and in-transit balances — a review indicator by default; someone with review authority may
 *   require an explanation with evidence (set_tb_finding_policy: reason required, recorded, version-checked). Changing it
 *   makes results evaluated under the old policy a re-check, which the panel says before saving.
 *
 * Reads only, except the explicit policy change; every value comes from the workspace's own reads or the server.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { FRAMEWORK_NOT_SELECTED, formatEntityContextSuggestion } from "@/components/workspace/EntityContextSuggestion";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PeriodSetup } from "@/components/workbench/intake/PeriodSetup";
import { useEngagement } from "@/contexts/EngagementContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { RpcClient } from "@/lib/workspace/workspaceSetupClient";
import { readClearingPolicy, setClearingPolicy, type ClearingPolicy } from "@/lib/workspace/findingDecisions";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
const rpc: Rpc = (fn, args) => (supabase.rpc as unknown as Rpc)(fn, args);

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null);

export function EngagementContextPanel({ companyId, periodYear, companyName, framework, companyCreatedAt, fiscalPeriodId, prepareOnly }: {
  companyId: string;
  periodYear: number;
  companyName: string | null;
  framework: string | null | undefined;
  companyCreatedAt: string | null | undefined;
  fiscalPeriodId: string | null;
  /** A Prepare-only grant sees the context but not the engagement's settings (they belong to other authorities). */
  prepareOnly: boolean;
}) {
  const ids = { reason: useId(), heading: useId() };
  const [period, setPeriod] = useState<{ start: string | null; end: string | null; currency: string | null } | null>(null);
  const [policy, setPolicy] = useState<ClearingPolicy | null>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  // Period and currency are edited in a dialog over the current task (never a page change). It closes only on a
  // confirmed save, refuses dismissal while the save is in flight, and Radix restores focus to the opener.
  const [periodOpen, setPeriodOpen] = useState(false);
  const [periodBusy, setPeriodBusy] = useState(false);
  const [periodReload, setPeriodReload] = useState(0);
  const engagementApi = useEngagement();
  const workspace = useWorkspace();

  useEffect(() => {
    let live = true;
    if (!fiscalPeriodId) { setPeriod(null); return; }
    void (supabase as unknown as { from(t: "fiscal_periods"): { select(c: string): { eq(c: "id", v: string): { maybeSingle(): PromiseLike<{ data: { reporting_start: string | null; reporting_end: string | null; reporting_currency: string | null } | null }> } } } })
      .from("fiscal_periods").select("reporting_start, reporting_end, reporting_currency").eq("id", fiscalPeriodId).maybeSingle()
      .then(({ data }) => { if (live) setPeriod(data ? { start: data.reporting_start, end: data.reporting_end, currency: data.reporting_currency } : null); });
    return () => { live = false; };
  }, [fiscalPeriodId, periodReload]);
  useEffect(() => {
    let live = true;
    if (prepareOnly) return;
    void readClearingPolicy(rpc, companyId).then((p) => { if (live) setPolicy(p); });
    return () => { live = false; };
  }, [companyId, prepareOnly]);

  const fw = formatEntityContextSuggestion(framework, companyCreatedAt);
  const periodText = period?.start && period?.end ? `${fmtDate(period.start)} – ${fmtDate(period.end)}` : `FY${periodYear}`;
  const nextMode = policy?.mode === "require_decision" ? "review" : "require_decision";

  const save = async () => {
    if (!policy || reason.trim().length < 3) return;
    setSaving(true);
    const r = await setClearingPolicy(rpc, companyId, nextMode, reason.trim(), policy.revision, requestId.current);
    setSaving(false);
    if (r.ok) {
      setPolicy({ ...policy, mode: nextMode, revision: r.revision, reason: reason.trim() });
      setEditing(false); setReason(""); requestId.current = crypto.randomUUID();
      setMessage("Saved. Trial balance results checked under the previous policy will need a re-check.");
    } else { setMessage("message" in r ? r.message : "The policy was not changed."); requestId.current = crypto.randomUUID(); }
  };

  return (
    <section aria-labelledby={ids.heading} className="mb-3 border-b border-border px-2 pb-3 text-[13px]" data-testid="engagement-context">
      <h2 id={ids.heading} className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Engagement</h2>
      <p className="mt-1 font-semibold text-foreground" data-testid="engagement-context-entity">{companyName ?? "Entity"}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px]">
        <dt className="text-muted-foreground">Period</dt><dd data-testid="engagement-context-period">{periodText}</dd>
        <dt className="text-muted-foreground">Currency</dt><dd data-testid="engagement-context-currency">{period?.currency ?? "Not set"}</dd>
        {/* The framework prompt belongs to the engagement's owners and members, not to a Prepare-only grant. */}
        {!prepareOnly && <><dt className="text-muted-foreground">Framework</dt><dd data-testid="engagement-context-framework">{fw ? fw.text.replace(/^Reporting framework: /, "") : FRAMEWORK_NOT_SELECTED}</dd></>}
      </dl>
      {!prepareOnly && (
        <details className="mt-3" data-testid="engagement-settings">
          <summary className="cursor-pointer text-[12px] font-medium text-foreground">Engagement settings</summary>
          <ul className="mt-2 space-y-1.5 text-[12px]">
            <li><button type="button" onClick={() => setPeriodOpen(true)} className="underline underline-offset-4" data-testid="open-period-settings">Reporting period and currency</button></li>
            <li><Link to="/settings" className="underline underline-offset-4">Company details</Link></li>
            {policy && (
              <li data-testid="clearing-policy">
                <span className="block text-muted-foreground">Clearing and in-transit balances</span>
                <span className="block" data-testid="clearing-policy-mode">{policy.mode === "require_decision" ? "An explanation with evidence is required" : "Review note (default)"}</span>
                {policy.mayChange && !editing && (
                  <button type="button" className="underline underline-offset-4" onClick={() => { setEditing(true); setMessage(null); }} data-testid="clearing-policy-change">
                    {policy.mode === "require_decision" ? "Make it a review note" : "Require an explanation"}
                  </button>
                )}
                {editing && (
                  <div className="mt-2 space-y-2">
                    <p className="text-muted-foreground">Results checked under the current policy will need a re-check.</p>
                    <label htmlFor={ids.reason} className="block font-medium">Reason</label>
                    <textarea id={ids.reason} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)}
                      className="w-full border border-input bg-background p-2" data-testid="clearing-policy-reason" />
                    <div className="flex gap-2">
                      <Button type="button" className="h-9 rounded-none" disabled={saving || reason.trim().length < 3} onClick={() => void save()} data-testid="clearing-policy-save">
                        {saving ? "Saving…" : "Save"}</Button>
                      <Button type="button" variant="outline" className="h-9 rounded-none" onClick={() => { setEditing(false); setReason(""); }}>Cancel</Button>
                    </div>
                  </div>
                )}
              </li>
            )}
          </ul>
          <p aria-live="polite" className="mt-2 text-[12px]" data-testid="clearing-policy-message">{message}</p>
        </details>
      )}
      <Dialog open={periodOpen} onOpenChange={(v) => { if (!v && periodBusy) return; setPeriodOpen(v); }}>
        <DialogContent className="max-w-xl" data-testid="period-settings-dialog"
          onEscapeKeyDown={(e) => { if (periodBusy) e.preventDefault(); }}
          onInteractOutside={(e) => { if (periodBusy) e.preventDefault(); }}>
          <DialogHeader>
            <DialogTitle>Reporting period and currency</DialogTitle>
            <DialogDescription>Saved for {companyName ?? "this entity"}. You stay on the page you were working on.</DialogDescription>
          </DialogHeader>
          <PeriodSetup client={supabase as unknown as RpcClient} companyId={companyId} periodYear={periodYear} onBusyChange={setPeriodBusy}
            onOpened={() => { setPeriodReload((n) => n + 1); engagementApi.refresh(); workspace.refreshUpload(); setPeriodOpen(false); }} />
        </DialogContent>
      </Dialog>
    </section>
  );
}
