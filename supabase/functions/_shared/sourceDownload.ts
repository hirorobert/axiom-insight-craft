// Authorized retrieval of a trial balance's ORIGINAL uploaded file.
//
// Pure orchestration with injected dependencies. It is unit-tested in Node (src/lib/workspace/sourceDownload.test.ts)
// and runs unchanged in the trial-balance-source-download Edge Function. It is the counterpart of sourceUpload.ts: the
// bucket stays private and no client Storage policy is widened; the server authorizes each request and then issues a
// very short-lived signed URL for exactly one object. The rules:
//   * The request carries exactly two things: an upload id and the company id the caller believes it belongs to. A bucket,
//     path, user or any other key in the body is refused, never read.
//   * The caller is authenticated from their JWT. The object path is resolved server-side from the upload row; the caller
//     can neither name nor influence it.
//   * Binding: the company named in the request must be the upload's own company. A mismatch is answered exactly like an
//     unknown upload or a missing right ("forbidden"), so the response never reveals whether an upload id exists.
//   * Authority is re-checked on EVERY request: can_user_act_on_workspace(user, company, 'manage_source_files') -
//     the workspace owner (with a current plan) or an explicit, active grant; never a title or a firm membership. A
//     revocation therefore takes effect on the next request. (A URL already issued stays valid until it expires; that
//     window is DOWNLOAD_EXPIRY_SECONDS and is the only residual access after a revocation.)
//   * The object path must have the canonical shape for this upload: workspaces/<company>/... or, for a legacy upload,
//     <uploader>/... , and be well formed. Anything else is a server-side invariant failure, not a download.
//   * The response carries the upload's server-recorded SHA-256 (null until processing recorded it) so the client can
//     prove the bytes it received are the bytes the server fingerprinted.

import { isWellFormedSourcePath } from "./sourcePath.ts";

export const DOWNLOAD_CAPABILITY = "manage_source_files";
/** How long an issued URL works. Short on purpose: it is the only access that outlives a revocation. */
export const DOWNLOAD_EXPIRY_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SourceDownloadOutcome = "ready" | "forbidden" | "unauthenticated" | "invalid_request" | "unavailable" | "signing_failed";

/** The columns of trial_balance_uploads this function reads (service role); nothing else is selected. */
export interface UploadTarget {
  id: string;
  company_id: string | null;
  user_id: string | null;
  file_path: string | null;
  file_name: string | null;
  file_size: number | null;
  source_file_hash: string | null;
}

export type SignResult = { url: string } | { missing: true } | null;

export interface SourceDownloadDeps {
  authenticate(): Promise<string | null>;
  resolveUpload(uploadId: string): Promise<UploadTarget | null>;
  canDownload(userId: string, companyId: string): Promise<boolean>;
  /** Service-role createSignedUrl for exactly this path, valid for `seconds`, saved under `downloadName`. */
  sign(path: string, seconds: number, downloadName: string): Promise<SignResult>;
}

export interface SourceDownloadResult {
  status: number;
  outcome: SourceDownloadOutcome;
  url?: string;
  expires_in?: number;
  file_name?: string;
  sha256?: string | null;
  size?: number | null;
}

export function parseSourceDownloadRequest(body: unknown): { uploadId: string; companyId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "company_id" || keys[1] !== "upload_id") return null;
  const { upload_id: u, company_id: c } = record;
  return typeof u === "string" && UUID.test(u) && typeof c === "string" && UUID.test(c) ? { uploadId: u, companyId: c } : null;
}

/** The name the saved file gets: the original name reduced to a conservative set (the stored object keeps its own). */
export function safeDownloadName(name: string | null | undefined): string {
  const cleaned = String(name ?? "").replace(/[^A-Za-z0-9._ -]/g, "_").replace(/[.]{2,}/g, ".").replace(/^[.\s]+/, "").slice(0, 120).trim();
  return cleaned.length > 0 ? cleaned : "trial-balance";
}

function canonicalPath(target: UploadTarget, companyId: string): string | null {
  const p = target.file_path;
  if (typeof p !== "string" || !isWellFormedSourcePath(p)) return null;
  if (p.startsWith(`workspaces/${companyId}/`)) return p;
  // A legacy upload lives in its uploader's personal folder: <uploader id>/<name>. Only that exact shape is accepted.
  if (target.user_id && UUID.test(target.user_id) && p.startsWith(`${target.user_id}/`) && !p.startsWith("workspaces/")) return p;
  return null;
}

export async function runSourceDownload(deps: SourceDownloadDeps, request: { uploadId: string; companyId: string }): Promise<SourceDownloadResult> {
  const userId = await deps.authenticate();
  if (!userId) return { status: 401, outcome: "unauthenticated" };

  const target = await deps.resolveUpload(request.uploadId);
  // Unknown upload, another company's upload and a missing right are one answer.
  if (!target || !target.company_id || target.company_id !== request.companyId) return { status: 403, outcome: "forbidden" };
  if (!(await deps.canDownload(userId, target.company_id))) return { status: 403, outcome: "forbidden" };

  if (target.file_path === null) return { status: 404, outcome: "unavailable" };
  const path = canonicalPath(target, target.company_id);
  if (!path) return { status: 500, outcome: "signing_failed" };

  const name = safeDownloadName(target.file_name);
  const signed = await deps.sign(path, DOWNLOAD_EXPIRY_SECONDS, name);
  if (signed && "missing" in signed) return { status: 404, outcome: "unavailable" };
  if (!signed || !signed.url) return { status: 502, outcome: "signing_failed" };
  return {
    status: 200, outcome: "ready", url: signed.url, expires_in: DOWNLOAD_EXPIRY_SECONDS, file_name: name,
    sha256: target.source_file_hash ?? null, size: typeof target.file_size === "number" ? target.file_size : null,
  };
}
