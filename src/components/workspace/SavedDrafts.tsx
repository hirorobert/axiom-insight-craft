/**
 * SavedDrafts — the signed-in person's saved (not yet checked) trial-balance files, from the server, each with an
 * explicit, confirmed "Remove". A file being checked cannot be removed. Used by the focused upload page (/upload).
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { listSavedDrafts, removeSavedDraft, type SavedDraft } from "@/lib/workspace/savedDrafts";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

const sizeWords = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function SavedDrafts({ rpc: call, onChanged }: { rpc: Rpc; onChanged?: () => void }) {
  const [drafts, setDrafts] = useState<SavedDraft[] | null | "unavailable">(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => { void listSavedDrafts(call).then((r) => setDrafts(r.kind === "ok" ? r.drafts : "unavailable")); }, [call]);
  useEffect(load, [load]);
  if (drafts === null) return null;
  if (drafts === "unavailable") return <p className="text-[13px] text-muted-foreground" data-testid="saved-drafts-unavailable">Saved uploads could not be loaded. Reload to try again.</p>;
  if (drafts.length === 0) return null;
  const remove = async (d: SavedDraft) => {
    const r = await removeSavedDraft(call, d.id);
    setConfirming(null);
    setMessage(r.message);
    load(); onChanged?.();
  };
  return (
    <section aria-labelledby="saved-drafts-title" className="mt-10" data-testid="saved-drafts">
      <h2 id="saved-drafts-title" className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Saved uploads</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">Files stored privately and not yet checked. Each is removed automatically when it expires.</p>
      <ul className="mt-3 divide-y divide-border border-y border-border">
        {drafts.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-[13px]" data-testid={`saved-draft-${d.id}`}>
            <span className="min-w-0">
              <span className="block truncate font-medium text-foreground">{d.fileName}</span>
              <span className="block text-[12px] text-muted-foreground">{sizeWords(d.fileSize)} · saved {when(d.createdAt)} · expires {when(d.expiresAt)}{d.stored ? "" : " · not stored yet"}</span>
            </span>
            {confirming === d.id ? (
              <span className="flex items-center gap-2" role="group" aria-label={`Remove ${d.fileName}?`}>
                <span>Remove this saved file?</span>
                <Button type="button" variant="outline" className="h-9 rounded-none" onClick={() => void remove(d)} data-testid={`saved-draft-confirm-${d.id}`}>Remove</Button>
                <Button type="button" variant="ghost" className="h-9 rounded-none" onClick={() => setConfirming(null)}>Keep</Button>
              </span>
            ) : d.state === "reserved" ? (
              <Button type="button" variant="ghost" className="h-9 rounded-none" onClick={() => setConfirming(d.id)} data-testid={`saved-draft-remove-${d.id}`}>
                Remove<span className="sr-only"> {d.fileName}</span></Button>
            ) : (
              <span className="text-[12px] text-muted-foreground">Being checked</span>
            )}
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="mt-2 text-[13px]" data-testid="saved-drafts-message">{message}</p>
    </section>
  );
}

