/**
 * QuickBooksImport — "Import from QuickBooks" on the trial balance upload page (charter B9). It sits BESIDE the file upload, never in place of it, and offers
 * exactly one action at a time: Connect (or Reconnect), or Import. Everything it starts is done by an Edge Function that judges the person's right itself;
 * the page only asks, shows the plain-language answer, and then starts the same check a file upload starts.
 *
 * Hidden unless the customer release flag or the owner-only Sandbox rehearsal admits this tab, and unless the
 * connection status can be read. A QuickBooks password, token or response body is never shown, stored or logged here.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useQboSandboxAccess } from "@/hooks/useQboSandboxAccess";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { invokeProcessing, type FunctionsClient } from "@/lib/workspace/processingInvoke";
import {
  QBO_CONNECTOR_ENABLED, QBO_ENVIRONMENT, disconnectQuickBooks, RECORD_PENDING_NOTE, connectionState, fetchConnections, finishConnect, pullFromQuickBooks, readHandoff, startConnect,
  type QboConnectionState,
} from "@/lib/workspace/qboConnectorClient";

export type ReturnedStatus = "connected" | "denied" | "failed";
const RETURNED_COPY: Record<ReturnedStatus, { tone: "ok" | "info" | "bad"; text: string }> = {
  connected: { tone: "ok", text: "QuickBooks is connected. You can import this period's trial balance now." },
  denied: { tone: "info", text: "You chose not to connect QuickBooks. Nothing was shared." },
  failed: { tone: "bad", text: "QuickBooks could not be connected. Please try again." },
};

export interface PeriodDates { start: string | null; end: string | null }
export interface QuickBooksImportViewProps {
  state: QboConnectionState | "checking";
  environment: "sandbox" | "production";
  period: PeriodDates | "loading";
  busy: "connect" | "finish" | "import" | "disconnect" | null;
  /** The status word the OAuth redirect came back with (or "connected" once the finish step succeeded), shown once. */
  returned: ReturnedStatus | null;
  /** The result of the last import attempt (a plain sentence) and whether it succeeded. */
  result: { ok: boolean; text: string; detail?: string } | null;
  onConnect(): void;
  onImport(): void;
  onDisconnect?(): void;
  revocationPending?: boolean;
}

/** Pure view: no data access, no effects. What it shows is decided by its props, so every state is testable. */
export function QuickBooksImportView(p: QuickBooksImportViewProps): JSX.Element | null {
  if (p.state !== "checking" && p.state.kind === "unavailable") return null;
  const test = p.environment === "sandbox" ? " (a test company)" : "";
  const hasDates = p.period !== "loading" && !!p.period.start && !!p.period.end;
  const action = p.revocationPending || p.state === "checking" ? null
    : p.state.kind === "none" ? { id: "connect" as const, label: "Connect QuickBooks" }
    : p.state.kind === "reconnect" ? { id: "connect" as const, label: "Reconnect QuickBooks" }
    : p.state.kind === "connected" && hasDates ? { id: "import" as const, label: "Import from QuickBooks" } : null;
  const kind = p.state === "checking" ? "checking" : p.state.kind;
  return (
    <section className="space-y-3 border border-border bg-card px-4 py-4" aria-label="Import from QuickBooks" data-testid="quickbooks-import" data-state={kind}>
      <div className="flex items-start gap-3">
        <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-foreground">Import from QuickBooks</h3>
          {kind === "checking" && <p className="mt-1 text-[13px] text-muted-foreground">Checking the QuickBooks connection…</p>}
          {kind === "none" && (
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Bring this period's trial balance in straight from QuickBooks instead of exporting a file. You sign in at QuickBooks, so we never see your password, and access is used only to read the trial balance report and verify fiscal settings.
            </p>
          )}
          {kind === "connected" && p.state !== "checking" && p.state.kind === "connected" && (
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Connected to QuickBooks company {p.state.realmId}{test}.{" "}
              {hasDates && p.period !== "loading" ? <>As of {p.period.end}, on QuickBooks fiscal year-to-date basis. Its verified fiscal start must match this saved period’s start, {p.period.start}.</> : p.period === "loading" ? "Reading this period's dates…" : "Set this period's start and end dates first; the import uses them."}
            </p>
          )}
          {kind === "reconnect" && (
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">The QuickBooks connection has expired or was removed. Connect again to continue.</p>
          )}
        </div>
      </div>

      {p.returned && (
        <p role="status" className={`border px-3 py-2 text-[13px] ${RETURNED_COPY[p.returned].tone === "bad" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-border bg-muted/40 text-foreground"}`} data-testid="quickbooks-returned">
          {RETURNED_COPY[p.returned].text}
        </p>
      )}
      {p.result && (
        <div role={p.result.ok ? "status" : "alert"} className={`border px-3 py-2 text-[13px] ${p.result.ok ? "border-border bg-muted/40 text-foreground" : "border-destructive/30 bg-destructive/5 text-destructive"}`} data-testid="quickbooks-result">
          <p className="flex items-start gap-2">{p.result.ok && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />}<span>{p.result.text}</span></p>
          {p.result.detail && <p className="mt-1 text-[12px] opacity-80">{p.result.detail}</p>}
        </div>
      )}

      {(kind === "connected" || p.revocationPending) && p.onDisconnect && <Button type="button" variant="ghost" disabled={p.busy !== null} onClick={p.onDisconnect}>{p.revocationPending ? "Retry QuickBooks disconnect" : "Disconnect QuickBooks"}</Button>}
      {action && (
        <Button type="button" variant="outline" size="sm" onClick={action.id === "connect" ? p.onConnect : p.onImport} disabled={p.busy !== null}
          className="h-auto min-h-10 w-full rounded-none px-4 py-2 text-[13px] font-semibold shadow-none sm:w-auto" data-testid="quickbooks-action" data-action={action.id}>
          {p.busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {p.busy === "connect" ? "Opening QuickBooks…" : p.busy === "finish" ? "Finishing the QuickBooks connection…" : p.busy === "import" ? "Importing…" : action.label}
        </Button>
      )}
    </section>
  );
}

export interface QuickBooksImportProps {
  companyId: string;
  periodYear: number;
  periodId: string | null;
  engagementId: string | null;
  /** Called after an import has been saved and its check started, so the page can show the result. */
  onImported?: () => void;
  /** Explicit test override; ordinary use follows the customer flag or the restricted platform-owner Sandbox opt-in. */
  enabled?: boolean;
}

/** Only a decline or a failure travels as a word in the address. "Connected" is never taken from the address: it is said only after the finish step answers. */
function returnedFromAddress(): ReturnedStatus | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("qbo");
  return v === "denied" || v === "failed" ? v : null;
}
const handoffFromAddress = (): string | null => (typeof window === "undefined" ? null : readHandoff(window.location.hash));

export function QuickBooksImport(props: QuickBooksImportProps): JSX.Element | null {
  const sandbox = useQboSandboxAccess(props, props.enabled === undefined && !QBO_CONNECTOR_ENABLED);
  const enabled = props.enabled ?? (QBO_CONNECTOR_ENABLED || sandbox);
  return enabled ? <>
    {sandbox && <p role="status" className="border border-border bg-muted/40 p-3 text-sm">Sandbox rehearsal: sample QuickBooks data only. Customer connections remain unavailable.</p>}
    <QuickBooksImportSession key={`${props.companyId}:${props.periodYear}:${props.periodId}:${props.engagementId}`} {...props} enabled />
  </> : null;
}

function QuickBooksImportSession({ companyId, periodYear, periodId, engagementId, onImported, enabled = QBO_CONNECTOR_ENABLED }: QuickBooksImportProps): JSX.Element | null {
  const [state, setState] = useState<QboConnectionState | "checking">("checking");
  const [period, setPeriod] = useState<PeriodDates | "loading">(periodId ? "loading" : { start: null, end: null });
  const [handoff] = useState<string | null>(handoffFromAddress);
  const [busy, setBusy] = useState<"connect" | "finish" | "import" | "disconnect" | null>(handoff ? "finish" : null);
  const [result, setResult] = useState<{ ok: boolean; text: string; detail?: string } | null>(null);
  const [returned, setReturned] = useState<ReturnedStatus | null>(returnedFromAddress);
  const working = useRef(false);
  const finished = useRef(false);
  const disconnectRequest = useRef<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<{ connectionId: string; requestId: string } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void (supabase as unknown as { rpc(n: string, a: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }).rpc("qbo_pending_disconnect", { p_company: companyId }).then(({ data, error }) => {
      if (!live || error || !data || typeof data !== "object") return;
      const p = data as Record<string, unknown>;
      if (typeof p.connectionId === "string" && typeof p.requestId === "string") { setPendingDisconnect({ connectionId: p.connectionId, requestId: p.requestId }); disconnectRequest.current = p.requestId; }
    });
    void fetchConnections(supabase as never, companyId).then((rows) => { if (live) setState(connectionState(rows, QBO_ENVIRONMENT)); });
    return () => { live = false; };
  }, [enabled, companyId]);

  useEffect(() => {
    if (!enabled || !periodId) return;
    let live = true;
    void (supabase.from("fiscal_periods") as unknown as {
      select(c: string): { eq(c: "id", v: string): { maybeSingle(): PromiseLike<{ data: { reporting_start: string | null; reporting_end: string | null } | null }> } };
    }).select("reporting_start, reporting_end").eq("id", periodId).maybeSingle()
      .then(({ data }) => { if (live) setPeriod({ start: data?.reporting_start ?? null, end: data?.reporting_end ?? null }); });
    return () => { live = false; };
  }, [enabled, periodId]);

  // Back from QuickBooks with a handoff: take it out of the address FIRST (no refresh, bookmark or shared link can carry it), then finish, once.
  // The function decides from the login whether this person started the connection; anyone else is told so and nothing is saved.
  useEffect(() => {
    if (!enabled || !handoff || finished.current) return;
    finished.current = true; working.current = true;
    if (typeof window !== "undefined") { const u = new URL(window.location.href); u.hash = ""; window.history.replaceState(null, "", u.toString()); }
    void (async () => {
      const r = await finishConnect(supabase as never, handoff);
      if (r.kind === "connected") {
        setReturned("connected");
        setState(connectionState(await fetchConnections(supabase as never, companyId), QBO_ENVIRONMENT));
      } else {
        setResult({ ok: false, text: r.message });
      }
      setBusy(null); working.current = false;
    })();
  }, [enabled, handoff, companyId]);

  // The status word is shown once: take it out of the address so a refresh does not repeat it.
  useEffect(() => {
    if (returned && typeof window !== "undefined") {
      const u = new URL(window.location.href); u.searchParams.delete("qbo"); window.history.replaceState(null, "", u.toString());
    }
  }, [returned]);

  const connect = useCallback(async () => {
    if (working.current) return;
    working.current = true; setBusy("connect"); setResult(null);
    const r = await startConnect(supabase as never, { companyId, periodYear, environment: QBO_ENVIRONMENT });
    if (r.kind === "redirect") { window.location.assign(r.url); return; }   // the page leaves; the busy state stays until it does
    setResult({ ok: false, text: r.message }); setBusy(null); working.current = false;
  }, [companyId, periodYear]);

  const importNow = useCallback(async () => {
    if (working.current || state === "checking" || state.kind !== "connected" || period === "loading" || !period.start || !period.end) return;
    working.current = true; setBusy("import"); setResult(null);
    try {
      const r = await pullFromQuickBooks(supabase as never, { companyId, environment: QBO_ENVIRONMENT, realmId: state.realmId, startDate: period.start, endDate: period.end, periodYear, periodId, engagementId });
      if (r.kind === "failed") {
        if (r.outcome === "reconnect_needed") setState({ kind: "reconnect", realmId: state.realmId });
        setResult({ ok: false, text: r.message, detail: r.detail });
        return;
      }
      // The same check a file upload starts: the server's check decides; this page only starts it.
      await ensureFreshSession();
      const check = await invokeProcessing(supabase as unknown as FunctionsClient, { uploadId: r.uploadId, clientRequestId: crypto.randomUUID() });
      const base = check.error
        ? `Imported ${r.accountCount} accounts (${r.currency}). The check did not finish; open the trial balance below and check again.`
        : `Imported ${r.accountCount} accounts (${r.currency}). The check has started and its result appears below.`;
      setResult({ ok: true, text: r.recordPending ? `${base} ${RECORD_PENDING_NOTE}` : base });
      onImported?.();
    } finally {
      setBusy(null); working.current = false;
    }
  }, [companyId, engagementId, onImported, period, periodId, periodYear, state]);

  const disconnect = async () => {
    const connectionId = pendingDisconnect?.connectionId ?? (state !== "checking" && state.kind === "connected" ? state.connectionId : null);
    if (working.current || !connectionId) return;
    if (!disconnectRequest.current && !window.confirm("Disconnect QuickBooks? Saved imports remain unchanged. New imports stop and QuickBooks access will be revoked.")) return;
    const request = disconnectRequest.current ?? crypto.randomUUID(); disconnectRequest.current = request;
    working.current = true; setBusy("disconnect");
    try {
      const answer = await disconnectQuickBooks(supabase as never, connectionId, request);
      setResult({ ok: answer.confirmed, text: answer.confirmed ? "QuickBooks disconnected. Saved imports are unchanged." : answer.outcome === "busy" ? "An import is running. Wait until it finishes before disconnecting." : answer.outcome === "revocation_pending" || answer.outcome === "local_only" ? "New imports are stopped. QuickBooks revocation is not confirmed; retry this same disconnect request." : "Disconnect could not be confirmed. Refresh the connection before retrying." });
      if (answer.outcome === "revocation_pending") setPendingDisconnect({ connectionId, requestId: request });
      if (answer.confirmed) { setPendingDisconnect(null); disconnectRequest.current = null; setState(connectionState(await fetchConnections(supabase as never, companyId), QBO_ENVIRONMENT)); }
    } finally { working.current = false; setBusy(null); }
  };
  if (!enabled) return null;
  return <QuickBooksImportView state={state} environment={QBO_ENVIRONMENT} period={period} busy={busy} returned={returned} result={result} onConnect={() => void connect()} onImport={() => void importNow()} onDisconnect={() => void disconnect()} revocationPending={pendingDisconnect !== null} />;
}
