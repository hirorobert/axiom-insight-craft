import { Link } from "react-router-dom";
import { ArrowRight, Lock } from "lucide-react";
import type { LockedCopy } from "@/lib/commercial/paidActions";
import { activationRequestHref, MANUAL_ACTIVATION_NOTE, REQUEST_ACTIVATION_LABEL } from "@/lib/commercial/offerings";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

/**
 * Explains a paid action that is not available on the workspace's plan: what is unavailable, which plan enables it,
 * what remains available and that history is kept. Neutral styling (never a success colour or check mark), no
 * checkout: it links to the plan comparison and to the activation request (subscriptions are activated by our team).
 */
export function PaidActionNotice({ copy, compact = false, testId }: { copy: LockedCopy; compact?: boolean; testId?: string }) {
  return (
    <div
      role="note"
      data-testid={testId ?? "paid-action-notice"}
      className={`min-w-0 border border-border bg-muted/30 ${compact ? "px-3 py-2" : "px-4 py-3"}`}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>{copy.title}</span>
      </p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.unavailable}</p>
      {!compact && <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.remains} {copy.history}</p>}
      <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <Link to="/pricing" className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline">
          Compare plans <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
        {SERVICE_ENQUIRY_SURFACES.contactRoute && (
          <Link to={activationRequestHref("plan_wall")} className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline" data-testid="wall-request-activation">
            {REQUEST_ACTIVATION_LABEL} <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </span>
      <span className="mt-1 block text-[11px] text-muted-foreground">{MANUAL_ACTIVATION_NOTE}</span>
    </div>
  );
}
