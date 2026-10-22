import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { buildControlArgs, describeControlError, describeSubmitOutcome, OUTCOME_UNCONFIRMED, parseControl, RELEASE_FLOOR, type ControlOperation, type ProcessingControl } from "@/lib/commercial/processingControl";

/** Trial balance processing control. Every read and change is the server's audited admin RPC under the admin's own session. */
export function ProcessingControlPanel() {
  const [state, setState] = useState<ProcessingControl | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [canaryId, setCanaryId] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  /** Returns true only when the authoritative state was read and shown. */
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const { data, error } = await supabase.rpc("admin_get_processing_control");
      if (error) { setState(null); setLoadError(describeControlError(error).replace(OUTCOME_UNCONFIRMED, "The control could not be read.")); return false; }
      const parsed = parseControl(data);
      if (!parsed) { setState(null); setLoadError("The control could not be read."); return false; }
      setLoadError(null); setState(parsed); return true;
    } catch {
      setState(null); setLoadError("The control could not be read. Refresh to try again."); return false;
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async (op: ControlOperation) => {
    if (!state || inFlight.current) return;
    const built = buildControlArgs(op, state, reason, canaryId);
    if ("error" in built) { setMessage({ ok: false, text: built.error }); return; }
    inFlight.current = true; setBusy(true); setMessage(null);
    try {
      let write: { error: { message?: string; code?: string } | null } | "thrown";
      try { const r = await supabase.rpc("admin_set_processing_control", built.args); write = { error: r.error }; }
      catch { write = "thrown"; }
      const readBack = await load();
      const outcome = describeSubmitOutcome(write, readBack);
      if (outcome.ok) setReason("");
      setMessage(outcome);
    } finally {
      inFlight.current = false; setBusy(false);
    }
  };

  if (loadError) return (
    <div className="space-y-2 text-sm">
      {message && <p role="alert" className={message.ok ? "" : "text-destructive"} data-testid="processing-outcome">{message.text}</p>}
      <p role="alert" className="text-destructive">{loadError}</p>
      <Button size="sm" variant="outline" onClick={() => { load(); }}>Refresh</Button>
    </div>
  );
  if (!state) return <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />;

  const floor = state.min_engine_generation ?? 0;
  return (
    <section className="max-w-2xl space-y-4" aria-labelledby="processing-control">
      <h2 id="processing-control" className="text-lg font-medium">Trial balance processing</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="processing-state">
        <dt className="text-muted-foreground">Status</dt><dd><Badge variant={state.hold ? "destructive" : "secondary"}>{state.hold ? "Paused" : "Running"}</Badge></dd>
        <dt className="text-muted-foreground">Canary companies</dt><dd className="font-mono text-xs">{state.canary_company_ids.length ? state.canary_company_ids.join(", ") : "None"}</dd>
        <dt className="text-muted-foreground">Engine floor</dt><dd>{state.min_engine_generation ?? "—"}</dd>
        <dt className="text-muted-foreground">Last reason</dt><dd>{state.reason ?? "—"}</dd>
        <dt className="text-muted-foreground">Version</dt><dd>{state.version}</dd>
      </dl>
      <label className="block space-y-1 text-sm">
        <span>Reason (required, recorded)</span>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="processing-reason" />
      </label>
      {message && <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm" : "text-sm text-destructive"}>{message.text}</p>}
      <div className="space-y-3">
        {!state.hold && (
          <Button onClick={() => submit("pause")} disabled={busy} data-testid="processing-pause">
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Pause processing
          </Button>
        )}
        {state.hold && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-sm"><span>Canary company ID</span>
              <Input value={canaryId} onChange={(e) => setCanaryId(e.target.value)} className="w-96 font-mono text-xs" /></label>
            <Button variant="outline" onClick={() => submit("canary")} disabled={busy}>Admit only this canary (floor {Math.max(floor, RELEASE_FLOOR)})</Button>
          </div>
        )}
        {state.hold && floor >= RELEASE_FLOOR && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Resume only after the generation-{RELEASE_FLOOR} canary and the recorded release checks have passed.</p>
            <Button variant="outline" onClick={() => submit("resume")} disabled={busy}>Resume processing for everyone</Button>
          </div>
        )}
      </div>
    </section>
  );
}
