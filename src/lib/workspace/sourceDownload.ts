/**
 * sourceDownload — the ONE browser path for retrieving the original file of a trial balance.
 *
 * The bucket is private and no Storage policy lets a browser read workspace objects. The browser asks the
 * trial-balance-source-download Edge Function for an upload it names (with the company it believes owns it); the server
 * authenticates the caller, re-checks their authority on EVERY request and answers with a signed URL that expires within a
 * minute. The browser never chooses a bucket or a path.
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
  url?: string;
  file_name?: string;
  sha256?: string | null;
}

async function readFunctionOutcome(error: unknown): Promise<FunctionAnswer | null> {
  try {
    return ((await (error as { context?: { json?: () => Promise<unknown> } }).context?.json?.()) ?? null) as FunctionAnswer | null;
  } catch {
    return null;
  }
}

/** Where signed object URLs live. The function signs for the private trial-balance bucket only. */
export const SIGNED_OBJECT_PREFIX = "/storage/v1/object/sign/trial-balance-files/";

/**
 * The server signs against ITS OWN view of the project URL (inside a container or behind a proxy that can differ from the one the
 * browser reaches). The signed path and token are what matter, so the request is made against the API origin this app is configured
 * with. Anything that is not a signed object URL for the trial-balance bucket is refused rather than fetched.
 */
export function rebaseSignedUrl(raw: string, apiBase: string | undefined): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.pathname.startsWith(SIGNED_OBJECT_PREFIX) || !url.searchParams.get("token")) return null;
  // Inside the prefix: no dot segment, no encoded dot / slash / backslash. The object name is a plain path the server chose.
  const rest = url.pathname.slice(SIGNED_OBJECT_PREFIX.length);
  if (rest.length === 0 || /%2e|%2f|%5c|\\/i.test(rest) || rest.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  if (!apiBase) return url.toString();
  try { return `${new URL(apiBase).origin}${url.pathname}${url.search}`; } catch { return null; }
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Asks the server for a download of this upload's original file, fetches it and checks it against the recorded SHA-256. */
export async function fetchOriginalSource(companyId: string, uploadId: string, fetchImpl: typeof fetch = fetch, apiBase: string | undefined = import.meta.env.VITE_SUPABASE_URL): Promise<DownloadedSource> {
  const answered = await supabase.functions.invoke("trial-balance-source-download", { body: { upload_id: uploadId, company_id: companyId } });
  const body = (answered.error ? await readFunctionOutcome(answered.error) : answered.data) as FunctionAnswer | null;
  const outcome = body?.outcome;
  if (outcome === "forbidden") throw new SourceDownloadError(DOWNLOAD_NO_PERMISSION, "forbidden", false);
  if (outcome === "unauthenticated") throw new SourceDownloadError("Please sign in again to download this file.", "unauthenticated", false);
  if (outcome === "unavailable") throw new SourceDownloadError(DOWNLOAD_UNAVAILABLE, "unavailable", false);
  if (outcome !== "ready" || !body?.url) throw new SourceDownloadError("Could not prepare the download. Please try again.", "failed", true);

  const target = rebaseSignedUrl(body.url, apiBase);
  if (!target) throw new SourceDownloadError("Could not prepare the download. Please try again.", "failed", true);
  let response: Response;
  try {
    response = await fetchImpl(target);
  } catch {
    throw new SourceDownloadError("The file could not be downloaded. Please try again.", "failed", true);
  }
  if (!response.ok) throw new SourceDownloadError("The file could not be downloaded. Please try again.", "failed", true);
  const bytes = await response.arrayBuffer();

  const recorded = typeof body.sha256 === "string" && /^[0-9a-f]{64}$/i.test(body.sha256) ? body.sha256.toLowerCase() : null;
  if (recorded && (await sha256Hex(bytes)) !== recorded) throw new SourceDownloadError(DOWNLOAD_INTEGRITY_FAILED, "integrity", true);
  return { fileName: body.file_name || "trial-balance", blob: new Blob([bytes]), integrity: recorded ? "matched" : "not_recorded", size: bytes.byteLength };
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
