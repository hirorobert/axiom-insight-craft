import { useEffect, useId, useRef, useState } from "react";
import { trapTab, useFocusReturn } from "./useFocusReturn";

/**
 * Confirmation for MATERIAL actions only (replace/remove a source, approve, self-approve, reverse, finalise, seal).
 * Reading, filtering and opening evidence never use it. It always states the affected period and version and the
 * consequences; a reason and/or an acknowledgement are required when the record needs them. The server still decides:
 * confirming only sends the request.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  period: string;
  version: string | null;
  consequences: string;
  /** Minimum reason length when a reason is required (omit for none). */
  reasonMinLength?: number;
  reasonLabel?: string;
  /** Acknowledgement text that must be ticked (omit for none). */
  acknowledgement?: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function ConfirmDialog(p: ConfirmDialogProps) {
  if (!p.open) return null;
  return <ConfirmDialogOpen {...p} />;
}

function ConfirmDialogOpen(p: ConfirmDialogProps) {
  const titleId = useId();
  const descId = useId();
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLTextAreaElement | HTMLButtonElement | null>(null);
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  useFocusReturn(true);
  useEffect(() => { first.current?.focus(); }, []);
  const needReason = typeof p.reasonMinLength === "number";
  const ready = (!needReason || reason.trim().length >= (p.reasonMinLength ?? 0)) && (!p.acknowledgement || ack) && !p.busy;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/30 p-4">
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="w-full max-w-lg rounded-lg bg-background p-6 shadow-lg"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); p.onCancel(); } trapTab(e, box.current); }}
      >
        <h2 id={titleId} className="text-base font-semibold">{p.title}</h2>
        <div id={descId} className="mt-3 rounded-md bg-muted/60 p-3 text-sm">
          <div><span className="font-medium">Period</span> {p.period}{p.version ? <> · <span className="font-medium">Version</span> {p.version}</> : null}</div>
          <p className="mt-1">{p.consequences}</p>
        </div>
        {needReason && (
          <label className="mt-3 block text-sm">
            {p.reasonLabel ?? "Reason"} <span className="text-muted-foreground">(required)</span>
            <textarea
              ref={(el) => { if (el) first.current = el; }}
              className="mt-1 w-full rounded-md border border-input p-2"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-required="true"
            />
          </label>
        )}
        {p.acknowledgement && (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>{p.acknowledgement}</span>
          </label>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            ref={(el) => { if (el && !needReason) first.current = el; }}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            disabled={!ready}
            onClick={() => p.onConfirm(reason.trim())}
          >
            {p.confirmLabel}
          </button>
          <button type="button" className="rounded-md border border-input px-3 py-1.5 text-sm" onClick={p.onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
