import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lockedCopy } from "./paidActions";
import {
  WORKING_COPY_NOTICE, deliverOfficialPack, deliverWorkingCopy, type BuiltPack, type DeliveryOutcome, type OfficialIssue, type ReportingPackKind,
} from "./reportingPack";

/** The server generates, stores and seals the official document; the request carries only the issuance id. */
const issueOfficial: OfficialIssue = async (issuanceId) => {
  const { data, error } = await supabase.functions.invoke("seal-reporting-pack", { body: { action: "issue", issuance_id: issuanceId } });
  return { data, error };
};

/** Saves a blob as a file in the browser. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface PackRequest {
  readonly companyId: string | null | undefined;
  readonly periodYear: number | null | undefined;
  readonly kind: ReportingPackKind;
  /** The saved output / version the pack is issued for. */
  readonly outputRef: string | null | undefined;
  /** The file name, unless build returns its own. */
  readonly fileName?: string;
  /** Builds the working-copy bytes in the browser (the issue reference may be printed in them). */
  readonly build: (issuanceId: string) => BuiltPack | Promise<BuiltPack>;
}

const explain = (outcome: DeliveryOutcome) => {
  if (outcome === "locked") {
    const copy = lockedCopy("REPORTING_PACK_EXPORT");
    toast(copy.title, { description: `${copy.unavailable} ${copy.remains} ${copy.history}` });
  } else if (outcome === "not_permitted") {
    toast("Not permitted in this workspace", { description: "Issuing outputs needs the Issue Reporting Pack outputs capability here. Nothing was downloaded." });
  } else if (outcome === "not_final") {
    toast("Not FINAL yet", { description: "Only a FINAL statements version can be issued as an official Reporting Pack. Nothing was downloaded." });
  } else if (outcome === "failed") {
    toast.error("The file could not be issued. Nothing was downloaded; try again.");
  }
};

/**
 * Delivers one browser-rendered deliverable as a WORKING COPY: issued by the server (entitlement and capability), built,
 * then saved — never sealed, never official, and labelled so. A plan refusal is explained neutrally; any other failure
 * saves nothing.
 */
export async function deliverReportingPack(req: PackRequest): Promise<DeliveryOutcome> {
  if (!req.companyId || !req.periodYear || !req.outputRef) {
    toast.error("Open this from a workspace period to download it.");
    return "failed";
  }
  const outcome = await deliverWorkingCopy(
    (fn, args) => supabase.rpc(fn as never, args as never),
    { companyId: req.companyId, periodYear: req.periodYear, kind: req.kind, outputRef: req.outputRef },
    req.build,
    (blob, builtName) => saveBlob(blob, builtName ?? req.fileName ?? "reporting-pack"),
  );
  if (outcome === "delivered") toast("Downloaded as a working copy", { description: WORKING_COPY_NOTICE });
  explain(outcome);
  return outcome;
}

/**
 * Delivers the OFFICIAL Reporting Pack of a saved statements version: the server generates the document from the saved
 * version, stores and seals it, and the browser saves exactly the server's document.
 */
export async function deliverOfficialReportingPack(req: { readonly companyId: string | null | undefined; readonly periodYear: number | null | undefined; readonly outputRef: string | null | undefined }): Promise<DeliveryOutcome> {
  if (!req.companyId || !req.periodYear || !req.outputRef) {
    toast.error("Open this from a workspace period to download it.");
    return "failed";
  }
  const outcome = await deliverOfficialPack(
    (fn, args) => supabase.rpc(fn as never, args as never),
    issueOfficial,
    { companyId: req.companyId, periodYear: req.periodYear, kind: "financial_statements_data", outputRef: req.outputRef },
    (blob, fileName) => saveBlob(blob, fileName),
  );
  if (outcome === "delivered") toast.success("Official Reporting Pack issued and sealed by the server.");
  explain(outcome);
  return outcome;
}
