/**
 * QuickBooksImport — "Import from QuickBooks" on the trial balance upload page (charter B9). It sits BESIDE the file upload, never in place of it, and offers
 * exactly one action at a time: Connect (or Reconnect), or Import. Everything it starts is done by an Edge Function that judges the person's right itself;
 * the page only asks, shows the plain-language answer, and then starts the same check a file upload starts.
 *
 * Hidden entirely unless QBO_CONNECTOR_ENABLED (a reviewed source constant, false until the backend is applied, deployed and configured) and unless the
 * connection status can be read. A QuickBooks password, token or response body is never shown, stored or logged here.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { invokeProcessing, type FunctionsClient } from "@/lib/workspace/processingInvoke";
import {
  QBO_CONNECTOR_ENABLED, QBO_ENVIRONMENT, RECORD_PENDING_NOTE, connectionState, fetchConnections, pullFromQuickBooks, startConnect,
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
  busy: "connect" | "import" | null;
  /** The status word the OAuth redirect came back with, shown once. */
  returned: ReturnedStatus | null;
  /** The result of the last import attempt (a plain sentence) and whether it succeeded. */
  result: { ok: boolean; text: string; detail?: string } | null;
  onConnect(): void;
  onImport(): void;
}

/** Pure view: no data access, no effects. What it shows is decided by its props, so every state is testable. */
export function QuickBooksImportView(p: QuickBooksImportViewProps): JSX.Element | null {
  if (p.state !== "checking" && p.state.kind === "unavailable") return null;
  const test = p.environment === "sandbox" ? " (a test company)" : "";
  const hasDates = p.period !== "loading" && !!p.period.start && !!p.period.end;
  const action = p.state === "checking" ? null
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
              Bring this period's trial balance in straight from QuickBooks instead of exporting a file. You sign in at QuickBooks, so we never see your password, and access is used to read the trial balance report only.
            </p>
          )}
          {kind === "connected" && p.state !== "checking" && p.state.kind === "connected" && (
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Connected to QuickBooks company {p.state.realmId}{test}.{" "}
              {hasDates && p.period !== "loading" ? <>It will import {p.period.start} to {p.period.end}, the dates of this period.</> : p.period === "loading" ? "Reading this period's dates…" : "Set this period's start and end dates first; the import uses them."}
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

      {action && (
        <Button type="button" variant="outline" size="sm" onClick={action.id === "connect" ? p.onConnect : p.onImport} disabled={p.busy !== null}
          className="h-auto min-h-10 w-full rounded-none px-4 py-2 text-[13px] font-semibold shadow-none sm:w-auto" data-testid="quickbooks-action" data-action={action.id}>
          {p.busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {p.busy === "connect" ? "Opening QuickBooks…" : p.busy === "import" ? "Importing…" : action.label}
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
  /** Tests and storybook only: defaults to the reviewed constant. */
  enabled?: boolean;
}

function returnedFromAddress(): ReturnedStatus | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("qbo");
  return v === "connected" || v === "denied" || v === "failed" ? v : null;
}

export function QuickBooksImport({ companyId, periodYear, periodId, engagementId, onImported, enabled = QBO_CONNECTOR_ENABLED }: QuickBooksImportProps): JSX.Element | null {
  const [state, setState] = useState<QboConnectionState | "checking">("checking");
  const [period, setPeriod] = useState<PeriodDates | "loading">(periodId ? "loading" : { start: null, end: null });
  const [busy, setBusy] = useState<"connect" | "import" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string; detail?: string } | null>(null);
  const [returned] = useState<ReturnedStatus | null>(returnedFromAddress);
  const working = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
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

  if (!enabled) return null;
  return <QuickBooksImportView state={state} environment={QBO_ENVIRONMENT} period={period} busy={busy} returned={returned} result={result} onConnect={() => void connect()} onImport={() => void importNow()} />;
}
