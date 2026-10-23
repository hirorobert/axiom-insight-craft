/** One explicit start when no service engagement exists. Starting uses the idempotent server command.
 * An already-open engagement bypasses this card and opens the actual Trial Balance workspace.
 */
import { useBusyState } from "@/hooks/useBusyState";
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { LAUNCH_COPY } from "@/lib/workspace/onboardingState";

export default function TrialBalanceEntryCard({
  canStart,
  onUpload,
}: {
  /** False when the signed-in user may not open work in this workspace: the card explains instead of offering actions. */
  canStart: boolean;
  onUpload: () => Promise<void>;
}) {
  const [busy, setBusy] = useBusyState("Starting trial balance review…");
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!setBusy(true)) return;
    setError(null);
    try {
      await onUpload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "This could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SurfaceCard data-testid="trial-balance-entry">
      <h2 className="text-xl font-semibold text-foreground">{LAUNCH_COPY.entryHeading}</h2>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">Open this company’s review workspace and upload its trial balance. You can leave and return to saved work at any time.</p>
      {canStart ? (
        <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <Button pending={busy} onClick={run} disabled={busy} data-testid="entry-upload">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Start trial balance review
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>

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
