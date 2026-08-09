/**
 * EngagementScopeBoundary — what an out-of-mandate stage URL renders.
 *
 * The route still exists and RLS still governs the data. Hiding is never the
 * control: this page states the contractual position plainly and offers the
 * only legitimate way forward — amending the engagement, if authorised.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import EngagementScopeDialog from "@/components/workspace/EngagementScopeDialog";
import { useEngagement } from "@/contexts/EngagementContext";
import { capabilityTitle, owningCapability } from "@/lib/workspace/mandate";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import type { WorkspaceMission } from "@/lib/workspace/types";
import { FileLock2 } from "lucide-react";

export default function EngagementScopeBoundary({
  stage,
  overviewHref,
}: {
  stage: WorkspaceMission;
  overviewHref: string;
}) {
  const { canAmend, engagement } = useEngagement();
  const [open, setOpen] = useState(false);

  const cap = owningCapability(stage);
  const outcome = cap ? capabilityTitle(cap) : STAGE_CONFIGS[stage].label;

  return (
    <div className="max-w-2xl">
      <SurfaceCard className="px-6 py-8 sm:px-8 sm:py-10">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground mb-5">
          Engagement scope
        </p>
        <h1 className="flex items-start gap-3 text-xl sm:text-2xl font-semibold tracking-tight text-foreground leading-snug">
          <FileLock2 className="w-5 h-5 mt-1 shrink-0 text-muted-foreground/70" />
          <span>{outcome} is not included in this engagement.</span>
        </h1>
        <p className="mt-4 text-[14px] text-muted-foreground leading-relaxed">
          Nothing is wrong with the file. This stage is outside what the firm was
          engaged to perform for this period, so it is not part of the active path.
        </p>

        <div className="mt-8 flex flex-wrap gap-2">
          {canAmend && engagement && (
            <Button onClick={() => setOpen(true)} className="rounded-none h-11 px-5">
              Amend engagement scope
            </Button>
          )}
          <Button asChild variant="outline" className="rounded-none h-11 px-5">
            <Link to={overviewHref}>Back to the active path</Link>
          </Button>
        </div>

        {!canAmend && (
          <p className="mt-5 text-[12px] text-muted-foreground/80">
            Only an owner, partner or manager can amend the scope of an engagement.
          </p>
        )}
      </SurfaceCard>

      <EngagementScopeDialog open={open} onOpenChange={setOpen} mode="amend" />
    </div>
  );
}