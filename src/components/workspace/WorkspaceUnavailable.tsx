/**
 * WorkspaceUnavailable — the neutral boundary for a workspace or route that is not available to customers
 * (src/lib/workspace/moduleAvailability.ts). Names no module, gives no reason and offers exactly one way out: the
 * account home (the hub, never an automatic re-entry into this workspace).
 */

import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export const WORKSPACE_UNAVAILABLE_COPY = {
  headline: "This workspace is not currently available.",
  action: "Return to account home",
} as const;

export default function WorkspaceUnavailable() {
  return (
    <section className="mx-auto max-w-xl border border-border bg-card px-6 py-10 text-center" role="status" data-testid="workspace-unavailable">
      <p className="text-[15px] font-medium text-foreground">{WORKSPACE_UNAVAILABLE_COPY.headline}</p>
      <Button asChild className="mt-6 h-10 rounded-none px-5 text-[13px] font-semibold shadow-none">
        <Link to="/dashboard" state={{ forceHub: true }} data-testid="workspace-unavailable-home">
          {WORKSPACE_UNAVAILABLE_COPY.action}
        </Link>
      </Button>
    </section>
  );
}
