import { ManagementLink } from "@/components/account/ManagementNavigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildAiArgs, buildOpenArgs, buildReasonArgs, buildSyntheticArgs, describeWriteOutcome, parseOverview,
  selectableForOpening, usd, type AiForm, type BetaAction, type BetaOverview,
} from "@/lib/commercial/internalBetaActivation";

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<RpcResult>;
async function rpc(fn: string, args: Record<string, unknown> = {}): Promise<RpcResult> {
  const { supabase } = await import("@/integrations/supabase/client");
  return (supabase.rpc as unknown as Rpc)(fn, args);
}

const WRITE_FN: Record<BetaAction, string> = {
  open: "internal_beta_admin_open_reporting",
  close: "internal_beta_admin_close_reporting",
  synthetic: "internal_beta_admin_record_synthetic_context",
  stop_ai: "internal_beta_admin_stop_ai",
  enable_ai: "internal_beta_configure",
};
const EMPTY_AI: AiForm = { model: "", inputUsd: "", outputUsd: "", cacheWriteUsd: "", cacheReadUsd: "", creditsConfirmed: false, pricingConfirmed: false, reason: "" };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Internal beta activation. Every read and change is an audited database function under the administrator's own session;
 * after every write the state is re-read from the server and shown, whatever the write answered.
 */
export function InternalBetaActivationPanel() {
  const [state, setState] = useState<BetaOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState<BetaAction | null>(null);
  const [synthCompany, setSynthCompany] = useState("");
  const [synthYear, setSynthYear] = useState("");
  const [ai, setAi] = useState<AiForm>(EMPTY_AI);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  /** Returns true only when the authoritative state was read and shown. */
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const { data, error } = await rpc("internal_beta_admin_overview");
      if (error) {
        setState(null);
        setLoadError(error.code === "42501" ? "Your account is not an active commercial administrator."
          : error.code === "PGRST202" ? "The activation controls are not installed on the server yet (migration 20261203100000)."
          : "The internal beta state could not be read. Refresh to try again.");
        return false;
      }
      const parsed = parseOverview(data);
      if (!parsed) { setState(null); setLoadError("The internal beta state could not be read. Refresh to try again."); return false; }
      setLoadError(null); setState(parsed);
      // The default choice is what is open now (only companies that can be opened).
      setSelected((prev) => prev ?? selectableForOpening(parsed).filter((c) => c.allowlisted).map((c) => c.companyId));
      return true;
    } catch {
      setState(null); setLoadError("The internal beta state could not be read. Refresh to try again."); return false;
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async (action: BetaAction) => {
    if (!state || inFlight.current) return;
    const built = action === "open" ? buildOpenArgs(state, selected ?? [], reason)
      : action === "synthetic" ? buildSyntheticArgs(state, synthCompany, synthYear, reason)
      : action === "enable_ai" ? buildAiArgs(state, ai, new Date().toISOString())
      : buildReasonArgs(reason);
    if ("error" in built) { setMessage({ ok: false, text: built.error }); setConfirming(null); return; }
    inFlight.current = true; setBusy(true); setMessage(null); setConfirming(null);
    try {
      let write: { error: { code?: string } | null } | "thrown";
      try { const r = await rpc(WRITE_FN[action], built.args); write = { error: r.error }; }
      catch { write = "thrown"; }
      const readBack = await load();
      const outcome = describeWriteOutcome(action, write, readBack);
      if (outcome.ok) { setReason(""); if (action === "enable_ai") setAi(EMPTY_AI); }
      setMessage(outcome);
    } finally {
      inFlight.current = false; setBusy(false);
    }
  };

  if (loadError) return (
    <div className="space-y-2 text-sm">
      {message && <p role="alert" className={message.ok ? "" : "text-destructive"}>{message.text}</p>}
      <p role="alert" className="text-destructive" data-testid="beta-load-error">{loadError}</p>
      <Button size="sm" variant="outline" onClick={() => { load(); }}>Refresh</Button>
    </div>
  );
  if (!state) return <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />;

  const offered = selectableForOpening(state);
  const chosen = selected ?? [];
  const toggle = (id: string) => setSelected((prev) => ((prev ?? []).includes(id) ? (prev ?? []).filter((x) => x !== id) : [...(prev ?? []), id]));
  const anythingOpen = !state.masterSwitchEngaged || state.reportingEnabled || state.companies.some((c) => c.allowlisted);
  const nameOf = (id: string) => state.companies.find((c) => c.companyId === id)?.name ?? id;
  const aiPreview = buildAiArgs(state, { ...ai, reason: ai.reason || "preview only — not sent" }, new Date().toISOString());

  return (
    <section className="max-w-3xl space-y-6" aria-labelledby="beta-activation" data-testid="beta-activation">
      <div className="space-y-1">
        <h2 id="beta-activation" className="text-lg font-medium">Internal beta</h2>
        <p className="text-sm text-muted-foreground">
          Opens reporting to the members enrolled in the chosen companies. Existing permissions, review separation and approval
          rules are unchanged. Every change is recorded with your account and reason.
        </p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="beta-state">
        <dt className="text-muted-foreground">Reporting</dt>
        <dd><Badge variant={state.reportingOpen ? "default" : "secondary"}>{state.reportingOpen ? "Open to enrolled members" : "Closed"}</Badge></dd>
        <dt className="text-muted-foreground">Master switch</dt><dd>{state.masterSwitchEngaged ? "Engaged (reporting closed for everyone)" : "Released"}</dd>
        <dt className="text-muted-foreground">Assistant spending</dt><dd>{state.aiEnabled ? `On (${state.model ?? "—"})` : "Off"}</dd>
        <dt className="text-muted-foreground">Assistant allowance left</dt>
        <dd>{usd(state.remainingMicros)} of {usd(state.totalBudgetMicros)} ({usd(state.priorUsageReservedMicros)} already used before the beta; {usd(state.spentMicros)} in the beta)</dd>
        <dt className="text-muted-foreground">Settings revision</dt><dd>{state.revision}</dd>
      </dl>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Companies</h3>
        <p className="text-xs text-muted-foreground">Only companies with at least one enrolled member can be opened. Opening makes the open list exactly your choice.</p>
        <ul className="divide-y rounded-md border text-sm" data-testid="beta-companies">
          {state.companies.map((c) => {
            const canOpen = offered.some((o) => o.companyId === c.companyId);
            return (
              <li key={c.companyId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <input type="checkbox" aria-label={`Open ${c.name}`} disabled={!canOpen || busy}
                  checked={chosen.includes(c.companyId)} onChange={() => toggle(c.companyId)} />
                <span className="min-w-40 font-medium">{c.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{c.companyId}</span>
                {c.allowlisted && <Badge variant="outline">Open list</Badge>}
                <span className="text-xs text-muted-foreground">{c.enrolledMembers} enrolled</span>
                {c.enrolledMembers === 0 && <ManagementLink className="text-sm underline" to={`/settings?section=firm&company=${encodeURIComponent(c.companyId)}`}>Enroll an accepted owner or team member</ManagementLink>}
                {c.syntheticScopes.length > 0 && <span className="text-xs text-muted-foreground">synthetic data: {c.syntheticScopes.map((s) => s.periodYear).join(", ")}</span>}
              </li>
            );
          })}
        </ul>
      </div>

      <label className="block space-y-1 text-sm">
        <span>Reason (required, recorded with every change)</span>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="beta-reason" />
      </label>

      {message && <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm" : "text-sm text-destructive"} data-testid="beta-outcome">{message.text}</p>}

      <div className="space-y-3">
        {confirming === "open" ? (
          <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="beta-confirm-open">
            <p>Open internal reporting for: <strong>{chosen.map(nameOf).join(", ") || "—"}</strong>.</p>
            <p className="text-muted-foreground">Every other company leaves the open list. The master switch is released last, in the same step.</p>
            <div className="flex gap-2">
              <Button onClick={() => submit("open")} disabled={busy} data-testid="beta-open-confirm">
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Confirm and open
              </Button>
              <Button variant="outline" onClick={() => setConfirming(null)} disabled={busy}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setConfirming("open")} disabled={busy || chosen.length === 0} data-testid="beta-open">
            {state.reportingOpen ? "Update the open list" : "Open internal reporting"}
          </Button>
        )}
        {anythingOpen && (
          <div>
            <Button variant="destructive" onClick={() => submit("close")} disabled={busy} data-testid="beta-close">
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Close reporting now
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">Engages the master switch first. Stops access; it does not undo records already made.</p>
          </div>
        )}
      </div>

      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">Assistant (Ask CFOClose)</h3>
        {state.aiEnabled ? (
          <Button variant="destructive" onClick={() => submit("stop_ai")} disabled={busy} data-testid="beta-stop-ai">Stop assistant spending</Button>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              The assistant only answers about synthetic data whose identity is recorded here, within the remaining allowance.
              Record the synthetic data first; then switch spending on.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-sm"><span>Company</span>
                <select className="block h-9 rounded-md border bg-background px-2 text-sm" value={synthCompany} onChange={(e) => setSynthCompany(e.target.value)} data-testid="beta-synthetic-company">
                  <option value="">Choose an open company</option>
                  {state.companies.filter((c) => c.allowlisted).map((c) => <option key={c.companyId} value={c.companyId}>{c.name}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm"><span>Period year</span>
                <Input value={synthYear} onChange={(e) => setSynthYear(e.target.value)} className="w-24" inputMode="numeric" data-testid="beta-synthetic-year" /></label>
              <Button variant="outline" onClick={() => submit("synthetic")} disabled={busy} data-testid="beta-synthetic">Record as synthetic data</Button>
            </div>
            <fieldset className="space-y-2 rounded-md border p-3 text-sm" data-testid="beta-ai-form">
              <legend className="px-1 text-sm">Switch assistant spending on</legend>
              <label className="block space-y-1"><span>Model identifier (exactly as the provider lists it)</span>
                <Input value={ai.model} onChange={(e) => setAi({ ...ai, model: e.target.value })} className="font-mono text-xs" /></label>
              <div className="grid grid-cols-2 gap-2">
                {([["inputUsd", "Input"], ["outputUsd", "Output"], ["cacheWriteUsd", "Cache write"], ["cacheReadUsd", "Cache read"]] as const).map(([k, label]) => (
                  <label key={k} className="space-y-1"><span>{label} (USD per million tokens)</span>
                    <Input value={ai[k]} onChange={(e) => setAi({ ...ai, [k]: e.target.value })} inputMode="decimal" /></label>
                ))}
              </div>
              <label className="flex items-start gap-2"><input type="checkbox" checked={ai.pricingConfirmed} onChange={(e) => setAi({ ...ai, pricingConfirmed: e.target.checked })} />
                <span>I checked these prices on the provider's current price list today.</span></label>
              <label className="flex items-start gap-2"><input type="checkbox" checked={ai.creditsConfirmed} onChange={(e) => setAi({ ...ai, creditsConfirmed: e.target.checked })} />
                <span>I checked the provider account's remaining credit today.</span></label>
              <label className="block space-y-1"><span>Reason (recorded)</span>
                <Input value={ai.reason} onChange={(e) => setAi({ ...ai, reason: e.target.value })} maxLength={300} /></label>
              <p className="text-xs text-muted-foreground" data-testid="beta-ai-preview">
                {"error" in aiPreview ? aiPreview.error : `Each request reserves ${usd(aiPreview.reservationMicros)}; at most ${Math.floor(state.remainingMicros / aiPreview.reservationMicros)} requests fit the remaining ${usd(state.remainingMicros)}. An unknown cost keeps its full reservation.`}
              </p>
              <Button onClick={() => submit("enable_ai")} disabled={busy} data-testid="beta-enable-ai">Switch assistant spending on</Button>
            </fieldset>
          </>
        )}
      </div>

      {state.events.length > 0 && (
        <div className="space-y-1 border-t pt-4">
          <h3 className="text-sm font-medium">Recent changes</h3>
          <ul className="space-y-1 text-xs text-muted-foreground" data-testid="beta-events">
            {state.events.slice(0, 10).map((e, i) => <li key={`${e.at}-${i}`}>{when(e.at)} · {e.action} · {e.reason}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
