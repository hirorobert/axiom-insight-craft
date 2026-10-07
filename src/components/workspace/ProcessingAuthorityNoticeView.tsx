/**
 * ProcessingAuthorityNoticeView — what the database says about this upload's result beyond the verdict (F2): "Needs re-check",
 * "Processing stopped", "Checking", "New check requested", with at most one action, and the processing history.
 *
 * Reads only (tb_upload_authority, tb_upload_attempts; S2, 20261008100000). The action is the page's own reprocess handler
 * (tbu_request_reprocess, the one browser path) — never a write from here. Nothing is shown for a current result or for a
 * state the verdict already explains.
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown, Clock, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ACTION_LABEL, attemptLabel, authorityNotice, parseAttemptHistory, parseUploadAuthority,
  type AttemptHistoryEntry, type AuthorityNotice, type UploadAuthority,
} from "@/lib/workspace/uploadAuthority";

export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export interface UploadAuthorityState {
  loaded: boolean;
  authority: UploadAuthority | null;
  attempts: AttemptHistoryEntry[] | null;
}

/** Reads both answers; an error or an unreadable answer is "unknown" (never current). */
export async function loadUploadAuthority(rpc: Rpc, uploadId: string): Promise<UploadAuthorityState> {
  const [a, h] = await Promise.all([rpc("tb_upload_authority", { p_upload_id: uploadId }), rpc("tb_upload_attempts", { p_upload_id: uploadId })]);
  return {
    loaded: true,
    authority: a.error ? null : parseUploadAuthority(a.data),
    attempts: h.error ? null : parseAttemptHistory(h.data),
  };
}

const TONE: Record<AuthorityNotice["tone"], string> = {
  neutral: "border-border bg-muted/30 text-foreground",
  warning: "border-amber-500/40 bg-amber-500/10 text-foreground",
  error: "border-destructive/40 bg-destructive/5 text-foreground",
};

export function ProcessingAuthorityNoticeView({ state, busy, canAct, onAction }: {
  state: UploadAuthorityState;
  busy: boolean;
  canAct: boolean;
  onAction: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!state.loaded) return null;
  const notice = authorityNotice(state.authority);
  const attempts = state.attempts ?? [];
  if (!notice && attempts.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="processing-authority">
      {notice && (
        <div className={`flex flex-col gap-3 border px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${TONE[notice.tone]}`}
             data-testid="processing-authority-notice" data-tone={notice.tone}>
          <div className="flex items-start gap-2">
            {notice.tone === "neutral" ? <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
            <p className="text-sm"><span className="font-semibold">{notice.label}.</span> {notice.detail}</p>
          </div>
          {notice.action && canAct && (
            <Button size="sm" variant="outline" onClick={onAction} disabled={busy} data-testid={`processing-authority-${notice.action}`}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {ACTION_LABEL[notice.action]}
            </Button>
          )}
        </div>
      )}
      {attempts.length > 0 && (
        <div>
          <button type="button" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                  onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="processing-history-toggle">
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
            Processing history ({attempts.length})
          </button>
          {open && (
            <ol className="mt-2 space-y-1 text-[12px] text-muted-foreground" data-testid="processing-history">
              {attempts.map((e) => (
                <li key={e.attemptNo}>
                  {attemptLabel(e)} · {new Date(e.startedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
