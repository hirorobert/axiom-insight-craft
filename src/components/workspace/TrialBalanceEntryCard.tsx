/**
 * TrialBalanceEntryCard — the one way in while only one service exists (Phase 2 §5.1).
 *
 * It replaces "What would you like to complete?" and "Add financial data": the service is implied, and the upload page
 * is the entry point. One dominant action (WorkspaceOverview's single-CTA rule) and one quiet secondary link, "Start
 * without data", which opens the workspace empty. Both persist through the existing server authority (the idempotent
 * engagement setup and the recorded data start); a repeated click while saving is ignored.
 */
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { LAUNCH_COPY } from "@/lib/workspace/onboardingState";

export default function TrialBalanceEntryCard({
  canStart,
  onUpload,
  onStartEmpty,
}: {
  /** False when the signed-in user may not open work in this workspace: the card explains instead of offering actions. */
  canStart: boolean;
  onUpload: () => Promise<void>;
  /** Optional quiet secondary. The single-service journey omits it: an empty workspace offered nothing but the same upload. */
  onStartEmpty?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"upload" | "empty" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (which: "upload" | "empty", action: () => Promise<void>) => {
    if (busy) return;
    setBusy(which);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "This could not be saved. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SurfaceCard data-testid="trial-balance-entry">
      <h2 className="text-xl font-semibold text-foreground">{LAUNCH_COPY.entryHeading}</h2>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">{LAUNCH_COPY.entryDetail}</p>
      {canStart ? (
        <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <Button onClick={() => run("upload", onUpload)} disabled={busy !== null} data-testid="entry-upload">
            {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {LAUNCH_COPY.entryAction}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
          {onStartEmpty && <button
            type="button"
            onClick={() => run("empty", onStartEmpty)}
            disabled={busy !== null}
            className="text-[14px] font-medium text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            data-testid="entry-start-empty"
          >
            {busy === "empty" ? "Opening…" : LAUNCH_COPY.secondaryAction}
          </button>}
        </div>
      ) : (
        <p className="mt-6 text-[14px] text-muted-foreground" data-testid="entry-no-permission">
          You can view this workspace, but starting work in it needs a member who can manage it.
        </p>
      )}
      {error && <p role="alert" className="mt-4 text-[14px] text-destructive">{error}</p>}
    </SurfaceCard>
  );
}
