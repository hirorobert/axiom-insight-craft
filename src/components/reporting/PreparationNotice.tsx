import { Link } from "react-router-dom";
import { presentationPending } from "@/lib/reporting/preparationGuidance";
import type { PageProps } from "./shared";

/** An explanatory prerequisite, not a new authorization or readiness gate. */
export function PreparationNotice(p: PageProps) {
  if (!presentationPending(p.state.composition)) return null;
  return <section aria-label="Statement preparation prerequisite" className="border-l-4 border-primary bg-muted/40 p-3 text-sm" data-testid="preparation-prerequisite">
    <h2 className="font-semibold">Complete statement presentation first</h2>
    <p>Statement presentation is incomplete or unavailable. Amount-based applicability and comparative presentation cannot yet be treated as final. You can still prepare wording from confirmed policies and evidence.</p>
    <Link className="mt-2 inline-block font-medium text-primary underline" to={p.hrefFor("fs-statements", p.reportVersion)}>Review statement assignments and blockers →</Link>
    {!p.allowed.includes("prepare_close") && <p className="mt-1 text-muted-foreground">A member with preparation permission must correct the assignments.</p>}
  </section>;
}
