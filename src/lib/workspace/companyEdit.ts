/**
 * companyEdit — one save of the company edit form: the reporting framework (through the audited function) and the other
 * company details (the direct, RLS-authorised update) are two separate writes, so a save can end in four ways and each
 * is reported as exactly what is known. Pure orchestration with injected writes; CompanyManager supplies them.
 *
 *   saved                  everything requested is in force.
 *   framework_not_saved    the server refused the framework change; NOTHING was written (the details are not attempted).
 *   framework_uncertain    no definite answer for the framework change; the details are not attempted. The caller keeps
 *                          the same request id and re-reads the company before the next save.
 *   partial                the framework change is in force but the details were not (or could not be confirmed as)
 *                          saved. The caller re-reads the company, so the next save sends only the details.
 *   details_not_confirmed  no framework change was requested; the details update failed or could not be confirmed.
 *                          Resending the same values is safe.
 */
import { frameworkChangeCommitted, frameworkChangeMessage, type FrameworkChangeResult, type ReportingFramework } from "@/lib/workspace/companyFramework";
import { FRAMEWORK_OPTIONS } from "@/lib/workspace/frameworkOptions";

export type CompanyEditOutcome =
  | { kind: "saved"; frameworkChange: FrameworkChangeResult | null }
  | { kind: "framework_not_saved"; frameworkChange: FrameworkChangeResult; message: string }
  | { kind: "framework_uncertain"; frameworkChange: FrameworkChangeResult; message: string }
  | { kind: "partial"; frameworkChange: FrameworkChangeResult; message: string }
  | { kind: "details_not_confirmed"; message: string };

export interface CompanyEditWrites {
  /** Only called when a framework change is requested. */
  changeFramework: () => Promise<FrameworkChangeResult>;
  /** The direct update of the other company details; `error` non-null when it did not (or may not have) succeeded. */
  updateDetails: () => Promise<{ error: unknown }>;
}

const label = (v: ReportingFramework) => FRAMEWORK_OPTIONS.find((o) => o.value === v)?.label ?? v;

export async function saveCompanyEdit(writes: CompanyEditWrites, req: { frameworkTo: ReportingFramework | null }): Promise<CompanyEditOutcome> {
  let frameworkChange: FrameworkChangeResult | null = null;
  if (req.frameworkTo) {
    frameworkChange = await writes.changeFramework();
    if (frameworkChange.kind === "uncertain") {
      return { kind: "framework_uncertain", frameworkChange, message: frameworkChangeMessage(frameworkChange) as string };
    }
    if (!frameworkChangeCommitted(frameworkChange)) {
      return { kind: "framework_not_saved", frameworkChange, message: `${frameworkChangeMessage(frameworkChange)} No company details were saved.` };
    }
  }
  let error: unknown = null;
  try { ({ error } = await writes.updateDetails()); } catch (e) { error = e ?? new Error("details update failed"); }
  if (error) {
    if (frameworkChange && req.frameworkTo) {
      return { kind: "partial", frameworkChange,
        message: `The reporting framework is saved as ${label(req.frameworkTo)}. The other company details could not be confirmed as saved; the company has been reloaded — review them and save again.` };
    }
    return { kind: "details_not_confirmed", message: "Could not confirm the company save. Your entries are kept; check the company, then save again (resending the same values is safe)." };
  }
  return { kind: "saved", frameworkChange };
}
