/**
 * UploadHistory — every trial balance uploaded for this period, read-only. Each row states its lifecycle (Current,
 * Replaced, Removed from active use) and its recorded result, and can be opened. There is no delete or retry here:
 * history is evidence. The current trial balance is managed from its own card.
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lifecycleLabel, resultLabel } from "@/lib/workspace/trialBalanceVerdict";

import type { HistoryUpload } from "@/lib/workspace/trialBalanceVerdict";

export function UploadHistory({ uploads, currentId, viewingId, onOpen }: {
  uploads: HistoryUpload[];
  currentId: string | null;
  /** The upload on screen (may be an earlier one opened from here). */
  viewingId: string | null;
  onOpen: (u: HistoryUpload) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = [...uploads].sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1));
  return (
    <section className="border border-border bg-card" data-testid="upload-history">
      <Button type="button" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="h-auto w-full justify-between rounded-none px-5 py-3.5 sm:px-7">
        <span className="text-[13px] font-semibold text-foreground">Upload history <span className="font-normal text-muted-foreground">· {rows.length}</span></span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </Button>
      {open && (
        <ul className="border-t border-border">
          {rows.map((u) => {
            const d = new Date(u.uploaded_at);
            const when = Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
            const lifecycle = lifecycleLabel(u, currentId);
            return (
              <li key={u.id} className="flex flex-col gap-2 border-t border-border px-5 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:px-7" data-testid={`history-${u.id}`}>
                <div className="min-w-0">
                  <p className="break-all text-[13px] font-medium text-foreground">{u.file_name}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{when} · {resultLabel(u.status)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`text-[12px] ${lifecycle === "Current" ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{lifecycle}</span>
                  {u.id === viewingId ? (
                    <span className="text-[12px] text-muted-foreground">On screen</span>
                  ) : (
                    <Button variant="outline" size="sm" className="rounded-none" onClick={() => onOpen(u)}>View</Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
