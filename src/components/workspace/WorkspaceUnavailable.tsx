/**
 * WorkspaceUnavailable — the neutral boundary for a workspace or route that is not available to customers
 * (src/lib/workspace/moduleAvailability.ts). Names no module, gives no reason and offers exactly one way out: the
 * account home (the hub, never an automatic re-entry into this workspace).
 *
 * One exception, `reportingPilot` (S2-C07): the reporting pages (ReportingAccessGate) are a pilot a company joins by
 * invitation (financial_statements_rollout_companies), so a customer who opens one is told so and how to ask, at the
 * published support address from the canonical contact module, instead of the neutral sentence.
 */

import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { channel, mailtoHref } from "@/lib/contact/contactChannels";

export const WORKSPACE_UNAVAILABLE_COPY = {
  headline: "This workspace is not currently available.",
  action: "Return to account home",
} as const;

export const REPORTING_PILOT_BOUNDARY_COPY = {
  headline: "Financial reporting is a pilot by invitation.",
  body: "It is not generally available. To ask about joining the pilot, or if your company was invited and you still see this page, write to",
  subject: "Financial reporting pilot",
} as const;

export default function WorkspaceUnavailable({ reportingPilot = false }: { reportingPilot?: boolean } = {}) {
  return (
    <section className="mx-auto max-w-xl border border-border bg-card px-6 py-10 text-center" role="status" data-testid="workspace-unavailable">
      <p className="text-[15px] font-medium text-foreground">{reportingPilot ? REPORTING_PILOT_BOUNDARY_COPY.headline : WORKSPACE_UNAVAILABLE_COPY.headline}</p>
      {reportingPilot && (
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground" data-testid="reporting-pilot-contact">
          {REPORTING_PILOT_BOUNDARY_COPY.body}{" "}
          <a href={mailtoHref("support", REPORTING_PILOT_BOUNDARY_COPY.subject)} className="font-medium text-foreground underline">{channel("support").address}</a>.
        </p>
      )}
      <Button asChild className="mt-6 h-10 rounded-none px-5 text-[13px] font-semibold shadow-none">
        <Link to="/dashboard" state={{ forceHub: true }} data-testid="workspace-unavailable-home">
          {WORKSPACE_UNAVAILABLE_COPY.action}
        </Link>
      </Button>
    </section>
  );
}
