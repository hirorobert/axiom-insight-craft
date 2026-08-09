/**
 * PreviousEngagementWork — read-only by construction.
 *
 * When an outcome is withdrawn after work has been performed, the work is not
 * deleted and not hidden. It is presented here as evidence: what was done, the
 * status it had reached, and the amendment that ended the active mandate.
 *
 * This is deliberately NOT a stage component with disabled buttons. It exposes
 * no mutation affordance at all.
 */

import { SurfaceCard, SurfaceCardHeader } from "@/components/workspace/ui/Surface";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { WorkspaceMissionView } from "@/lib/workspace/mandate";
import { owningCapability } from "@/lib/workspace/mandate";
import type { MandateEventRow } from "@/hooks/useEngagementMandate";

const STATUS_WORD: Record<string, string> = {
  in_progress: "In progress when the mandate ended",
  review_required: "Review outstanding when the mandate ended",
  passed: "Completed",
  signed: "Signed off",
};

function fmt(date: string): string {
  const d = new Date(date);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default function PreviousEngagementWork({
  views,
  events,
}: {
  views: WorkspaceMissionView[];
  events: MandateEventRow[];
}) {
  const retained = views.filter((v) => v.retainedWork);
  if (retained.length === 0) return null;

  return (
    <section className="mt-12" aria-label="Previous engagement work">
      <SurfaceCard>
        <SurfaceCardHeader
          label="Previous engagement work"
          meta="Read-only record"
        />
        <ul className="divide-y divide-border">
          {retained.map((v) => {
            const cap = owningCapability(v.stage);
            const ended = events.find((e) => e.capability === cap && e.action === "REVOKE");
            return (
              <li key={v.stage} className="px-5 py-4">
                <p className="text-[14px] font-medium text-foreground">
                  {STAGE_CONFIGS[v.stage].label}
                </p>
                <p className="mt-1 text-[12px] text-muted-foreground leading-snug">
                  {STATUS_WORD[v.workflowStatus] ?? "Work recorded"}
                </p>
                {ended && (
                  <p className="mt-2 text-[12px] text-muted-foreground/80 leading-snug">
                    Withdrawn from the active mandate on {fmt(ended.occurred_at)}
                    {ended.reason ? ` — ${ended.reason}` : ""}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </SurfaceCard>
    </section>
  );
}