// process-trial-balance: the source-download failure path (findings L-1 / L-2). Pure; unit-tested in Node
// (src/lib/workspace/processingSource.test.ts).
//
// L-2  A download failure is classified from STRUCTURED fields only (never message text): "missing" only for a
//      confirmed object-not-found (HTTP 404 / Storage statusCode "404" / error "not_found"); everything else — network
//      failure, timeout, outage, permission or configuration failure, an unknown error, no data — is "unavailable".
// L-1  The upload's status is restored with a CHECKED write before answering:
//        restored        → the classified answer: 409 source_missing, or 503 processing_unavailable;
//        refused (PT402) → the plan ended concurrently: the controlled 402 entitlement refusal (fail closed; the
//                          original classification is kept only in the server log);
//        other failure   → 503 processing_unavailable.
//      A response never contains a raw Storage or database message, a bucket name, a path or a token, and never claims
//      a restoration that did not happen. The log carries codes and statuses only.

export type DownloadFailure = "missing" | "unavailable";

export const PROCESSING_UNAVAILABLE = {
  status: "processing_unavailable", error: "Processing Unavailable",
  message: "The trial balance could not be processed right now. Nothing was changed; try again.",
} as const;
export const SOURCE_MISSING = {
  status: "source_missing", error: "Source File Missing",
  message: "The uploaded source file could not be found. Upload the trial balance again.",
} as const;
const ENTITLEMENT_REQUIRED = {
  status: "entitlement_required", error: "Entitlement Required", capability: "CLOSE_ASSURANCE", required_plan: "SOLO",
  message: "Preparing and validating a close needs a current plan. Existing records remain readable.",
} as const;

const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);

/** Confirmed object-not-found only; anything else (including no error object at all) is "unavailable". */
export function classifyDownloadFailure(error: unknown): DownloadFailure {
  const statuses = [field(error, "status"), field(error, "statusCode"), field(field(error, "originalError"), "status")].map((v) => String(v ?? ""));
  const code = String(field(error, "error") ?? "").toLowerCase();
  return statuses.includes("404") || code === "not_found" ? "missing" : "unavailable";
}

export interface SourceFailureOutcome {
  readonly httpStatus: 402 | 409 | 503;
  readonly body: Record<string, string>;
  /** Server-side diagnosis: codes and statuses only, never raw messages. */
  readonly log: Record<string, string | null>;
}

/** The answer after the CHECKED restoration of the upload's previous status. */
export function sourceFailureOutcome(classification: DownloadFailure, restoreError: unknown, downloadError: unknown): SourceFailureOutcome {
  const log = {
    classification,
    storage_status: String(field(downloadError, "statusCode") ?? field(downloadError, "status") ?? "none"),
    restore: restoreError ? "failed" : "restored",
    restore_sqlstate: restoreError ? String(field(restoreError, "code") ?? "unknown") : null,
  };
  if (restoreError) {
    if (field(restoreError, "code") === "PT402") return { httpStatus: 402, body: { ...ENTITLEMENT_REQUIRED }, log };
    return { httpStatus: 503, body: { ...PROCESSING_UNAVAILABLE }, log };
  }
  return classification === "missing"
    ? { httpStatus: 409, body: { ...SOURCE_MISSING }, log }
    : { httpStatus: 503, body: { ...PROCESSING_UNAVAILABLE }, log };
}
