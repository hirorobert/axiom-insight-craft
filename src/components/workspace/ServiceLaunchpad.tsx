/**
 * ServiceLaunchpad — "What would you like to complete?"
 *
 * The one decision on a workspace that has no services in scope. Cards come from the canonical registry
 * (CAPABILITY_OUTCOMES); there is no second catalogue. Nothing is pre-selected. Continuing persists the selection
 * through the idempotent engagement setup, so a repeated click or a refresh cannot duplicate or lose it.
 */

import { useState } from "react";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { CAPABILITY_OUTCOMES, type EngagementCapability } from "@/lib/workspace/mandate";
import { serviceAvailability } from "@/lib/jurisdiction/registry";
import FilingJurisdictionSetting from "@/components/jurisdiction/FilingJurisdictionSetting";
import { LAUNCH_COPY } from "@/lib/workspace/onboardingState";

export default function ServiceLaunchpad({
  canChoose,
  companyId,
  jurisdiction,
  onConfirm,
}: {
  canChoose: boolean;
  companyId: string;
  jurisdiction: string | null;
  onConfirm: (selected: EngagementCapability[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<EngagementCapability[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (cap: EngagementCapability) => setSelected((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]));
  // A service that needs a filing jurisdiction cannot be chosen while none (or none with a pack) is selected — and a
  // selection made before the jurisdiction changed is dropped, so the server is never asked for an unavailable service.
  const usable = selected.filter((c) => serviceAvailability(c, jurisdiction).available);

  const confirm = async () => {
    if (saving || usable.length === 0) return; // a repeated click while saving is ignored
    setSaving(true);
    setError(null);
    try {
      await onConfirm(usable);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The services could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SurfaceCard className="px-5 py-8 sm:px-8 sm:py-10">
      <h2 className="text-2xl sm:text-[2rem] font-semibold tracking-tight text-foreground leading-[1.2] max-w-xl mb-2" data-testid="launchpad-heading">
        {LAUNCH_COPY.launchpadHeading}
      </h2>
      <p className="text-[13px] text-muted-foreground mb-6 max-w-xl">Choose one or more. You can add or change services later.</p>

      <ul className="grid gap-3 sm:grid-cols-2" data-testid="service-cards">
        {CAPABILITY_OUTCOMES.map((o) => {
          const avail = serviceAvailability(o.capability, jurisdiction);
          const on = avail.available && selected.includes(o.capability);
          return (
            <li key={o.capability}>
              <button
                type="button"
                onClick={() => toggle(o.capability)}
                aria-pressed={on}
                disabled={!canChoose || saving || !avail.available}
                data-testid={`service-${o.capability}`}
                className={[
                  "w-full h-full text-left p-4 border transition-colors flex items-start gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60",
                  on ? "border-primary bg-primary/5" : "border-border hover:border-primary/60",
                ].join(" ")}
              >
                <span className={["mt-0.5 w-4 h-4 shrink-0 border flex items-center justify-center", on ? "bg-primary border-primary text-primary-foreground" : "border-border"].join(" ")}>
                  {on && <Check className="w-3 h-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-foreground">{o.title}</span>
                  <span className="block text-[12px] text-muted-foreground leading-snug mt-0.5">{o.description}</span>
                  {!avail.available && (
                    <span className="block text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-1" data-testid={`service-unavailable-${o.capability}`}>
                      {(avail as { message: string }).message}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 border-t border-border pt-5 max-w-xl">
        <FilingJurisdictionSetting companyId={companyId} jurisdiction={jurisdiction} canChange={canChoose} />
      </div>

      {!canChoose && (
        <p className="mt-5 text-[13px] text-muted-foreground" data-testid="launchpad-readonly">
          Only an owner, partner or manager can choose the services for this workspace.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="mt-8">
        <Button
          size="lg"
          onClick={confirm}
          disabled={!canChoose || saving || usable.length === 0}
          data-testid="primary-cta"
          className="h-12 w-full sm:w-auto px-6 text-[14px] font-semibold rounded-none shadow-none"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
          <span className="mx-2">{saving ? "Saving…" : "Continue"}</span>
        </Button>
      </div>
    </SurfaceCard>
  );
}
