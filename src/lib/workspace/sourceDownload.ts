/**
 * sourceDownload — the ONE browser path for retrieving the original file of a trial balance.
 *
 * The bucket is private and no Storage policy lets a browser read workspace objects. The browser asks the
 * trial-balance-source-download Edge Function for an upload it names (with the company it believes owns it); the server
 * authenticates the caller, re-checks their authority on EVERY request, issues a signed URL that expires within a minute, and
 * (proxied delivery) serves the object's bytes itself with Cache-Control: no-cache, no-store. The browser never chooses a bucket
 * or a path, and never receives the signed URL.
 *
 * Integrity: when the server has recorded the file's SHA-256 (it does so while processing), the received bytes are hashed
 * here and compared before anything is offered to the user. A mismatch discards the bytes and says so; it is never saved.
 */

import { supabase } from "@/integrations/supabase/client";

export type SourceDownloadFailure = "forbidden" | "unauthenticated" | "unavailable" | "integrity" | "failed";

export class SourceDownloadError extends Error {
  readonly code: SourceDownloadFailure;
  readonly retryable: boolean;
  constructor(message: string, code: SourceDownloadFailure, retryable: boolean) {
    super(message);
    this.name = "SourceDownloadError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const DOWNLOAD_NO_PERMISSION = "You don't have permission to download this workspace's source files.";
export const DOWNLOAD_UNAVAILABLE = "The original file is no longer in storage.";
export const DOWNLOAD_INTEGRITY_FAILED = "The downloaded file does not match the fingerprint the server recorded when it was checked, so it was not saved. Please try again.";

export interface DownloadedSource {
  fileName: string;
  blob: Blob;
  /** "matched": hashed here and equal to the server's recorded SHA-256. "not_recorded": the server has no fingerprint yet. */
  integrity: "matched" | "not_recorded";
  size: number;
}

interface FunctionAnswer {
  outcome?: string;
}

async function readFunctionOutcome(error: unknown): Promise<FunctionAnswer | null> {
  try {
    return ((await (error as { context?: { json?: () => Promise<unknown> } }).context?.json?.()) ?? null) as FunctionAnswer | null;
  } catch {
    return null;
  }
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Asks the server for this upload's original file and checks it against the recorded SHA-256.
 *
 * The app asks for PROXIED delivery: the function authorizes and records exactly as before, then serves the bytes itself with
 * Cache-Control: no-cache, no-store. Storage's own signed-object response carries no Cache-Control (measured 2026-11-06), so the
 * browser never fetches the object from Storage on this path. Requires the trial-balance-source-download version that understands
 * { delivery: "proxied" } to be deployed BEFORE this frontend is published (docs/release/intuit-security-r1/RECORD.md).
 */
export async function fetchOriginalSource(companyId: string, uploadId: string): Promise<DownloadedSource> {
  const answered = await supabase.functions.invoke("trial-balance-source-download", { body: { upload_id: uploadId, company_id: companyId, delivery: "proxied" } });
  if (answered.error) {
    const outcome = (await readFunctionOutcome(answered.error))?.outcome;
    if (outcome === "forbidden") throw new SourceDownloadError(DOWNLOAD_NO_PERMISSION, "forbidden", false);
    if (outcome === "unauthenticated") throw new SourceDownloadError("Please sign in again to download this file.", "unauthenticated", false);
    if (outcome === "unavailable") throw new SourceDownloadError(DOWNLOAD_UNAVAILABLE, "unavailable", false);
    throw new SourceDownloadError("The file could not be downloaded. Please try again.", "failed", true);
  }
  // A served file is a Blob (application/octet-stream). Anything else (for example a link answer from an older function) is not saved.
  const headers = (answered as { response?: Response }).response?.headers;
  const served = answered.data as Blob | null;
  if (!headers || !served || typeof served.arrayBuffer !== "function" || typeof (served as { size?: unknown }).size !== "number") {
    throw new SourceDownloadError("The file could not be downloaded. Please try again.", "failed", true);
  }
  const bytes = await served.arrayBuffer();

  const header = headers.get("X-Source-Sha256");
  const recorded = header && /^[0-9a-f]{64}$/i.test(header) ? header.toLowerCase() : null;
  if (recorded && (await sha256Hex(bytes)) !== recorded) throw new SourceDownloadError(DOWNLOAD_INTEGRITY_FAILED, "integrity", true);
  return { fileName: headers.get("X-Source-File-Name") || "trial-balance", blob: new Blob([bytes]), integrity: recorded ? "matched" : "not_recorded", size: bytes.byteLength };
}

/** Hands a verified download to the browser as a file save. */
export function saveDownloadedSource(file: DownloadedSource): void {
  const href = URL.createObjectURL(file.blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = file.fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export async function downloadOriginalSource(companyId: string, uploadId: string): Promise<DownloadedSource> {
  const file = await fetchOriginalSource(companyId, uploadId);
  saveDownloadedSource(file);
  return file;
}
