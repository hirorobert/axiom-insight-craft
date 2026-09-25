import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lockedCopy } from "./paidActions";
import { deliverOfficialPack, sealFormData, type BuiltPack, type DeliveryOutcome, type ReportingPackKind, type SealUpload } from "./reportingPack";

/** The exact bytes go to the server, which hashes and seals them (no client hash exists). */
const uploadForSeal: SealUpload = async (issuanceId, b, blob, fileName) => {
  const { data, error } = await supabase.functions.invoke("seal-reporting-pack", { body: sealFormData(issuanceId, b, blob, fileName) });
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
  /** Builds the exact bytes (the issuance id may be printed in them as the pack reference). */
  readonly build: (issuanceId: string) => BuiltPack | Promise<BuiltPack>;
}

/**
 * Delivers one OFFICIAL Reporting Pack file: issued by the server, built, sealed with its SHA-256, and only then
 * saved. A plan refusal is explained neutrally (the locked copy); any other failure saves nothing.
 */
export async function deliverReportingPack(req: PackRequest): Promise<DeliveryOutcome> {
  if (!req.companyId || !req.periodYear || !req.outputRef) {
    toast.error("Open this from a workspace period to download it.");
    return "failed";
  }
  const outcome = await deliverOfficialPack(
    (fn, args) => supabase.rpc(fn as never, args as never),
    uploadForSeal,
    { companyId: req.companyId, periodYear: req.periodYear, kind: req.kind, outputRef: req.outputRef },
    req.build,
    (blob, builtName) => saveBlob(blob, builtName ?? req.fileName ?? "reporting-pack"),
    req.fileName ?? "reporting-pack",
  );
  if (outcome === "locked") {
    const copy = lockedCopy("REPORTING_PACK_EXPORT");
    toast(copy.title, { description: `${copy.unavailable} ${copy.remains} ${copy.history}` });
  } else if (outcome === "not_permitted") {
    toast("Not permitted in this workspace", { description: "Issuing official outputs needs the Issue Reporting Pack outputs capability here. Nothing was downloaded." });
  } else if (outcome === "failed") {
    toast.error("The file could not be issued. Nothing was downloaded; try again.");
  }
  return outcome;
}
