/**
 * DataChoiceCard — "Add financial data". Asked ONCE, only after a service that needs accounting data was selected.
 *
 * Two genuinely different actions, both persisted before anything else happens:
 *   - Import trial balance → records "import" and routes to the single canonical upload surface (Prepare Data).
 *   - Start without data   → records "empty" and stays on the Overview, which then renders the genuine empty workspace.
 * "Start without data" never navigates to the upload surface.
 */

import { useState } from "react";
import { ArrowRight, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { LAUNCH_COPY } from "@/lib/workspace/onboardingState";

export default function DataChoiceCard({
  onImport,
  onStartEmpty,
}: {
  onImport: () => Promise<void>;
  onStartEmpty: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"import" | "empty" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: "import" | "empty", fn: () => Promise<void>) => {
    if (busy) return; // repeated clicks are ignored while a choice is being recorded
    setBusy(which);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Your choice could not be saved. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SurfaceCard className="px-5 py-8 sm:px-8 sm:py-10">
      <h2 className="text-2xl sm:text-[2rem] font-semibold tracking-tight text-foreground leading-[1.2] max-w-xl mb-2" data-testid="data-choice-heading">
        {LAUNCH_COPY.dataChoiceHeading}
      </h2>
      <p className="text-[13px] text-muted-foreground mb-6 max-w-xl">Upload a CSV or XLSX trial balance now, or open the workspace without data and add it later.</p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          size="lg"
          onClick={() => run("import", onImport)}
          disabled={!!busy}
          data-testid="primary-cta"
          className="h-12 w-full sm:w-auto px-6 text-[14px] font-semibold rounded-none shadow-none"
        >
          {busy === "import" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          <span className="mx-2">{LAUNCH_COPY.primaryAction}</span>
        </Button>
        <Button
          size="lg"
          variant="outline"
          onClick={() => run("empty", onStartEmpty)}
          disabled={!!busy}
          data-testid="start-without-data"
          className="h-12 w-full sm:w-auto px-6 text-[14px] font-semibold rounded-none shadow-none"
        >
          {busy === "empty" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
          <span className="mx-2">{LAUNCH_COPY.secondaryAction}</span>
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-[13px] text-destructive">
          {error}
        </p>
      )}
    </SurfaceCard>
  );
}
