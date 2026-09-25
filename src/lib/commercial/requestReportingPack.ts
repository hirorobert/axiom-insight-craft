import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lockedCopy } from "./paidActions";
import { issueReportingPack, type ReportingPackKind } from "./reportingPack";

/**
 * Asks the server to issue one downloadable Reporting Pack deliverable before a component generates it. Returns the
 * issuance id, or null — in which case NOTHING may be generated or downloaded. A plan refusal is explained neutrally
 * (the locked copy, never an error styling); any other failure fails closed.
 */
export async function requestReportingPack(
  companyId: string | null | undefined, periodYear: number | null | undefined, kind: ReportingPackKind,
): Promise<string | null> {
  if (!companyId || !periodYear) {
    toast.error("Open this from a workspace period to download it.");
    return null;
  }
  const outcome = await issueReportingPack((fn, args) => supabase.rpc(fn as never, args as never), companyId, periodYear, kind);
  if (outcome.status === "issued") return outcome.issuanceId;
  if (outcome.status === "locked") {
    const copy = lockedCopy("REPORTING_PACK_EXPORT");
    toast(copy.title, { description: `${copy.unavailable} ${copy.remains} ${copy.history}` });
    return null;
  }
  toast.error("The file could not be issued. Try again.");
  return null;
}
