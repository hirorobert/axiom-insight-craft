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
//     window is DOWNLOAD_EXPIRY_SECONDS and is the only residual access after a revocation.) Removing a team member also
//     revokes that person's explicit grants in the same transaction (migration 20261211100000), so "Remove member ...
//     access ends immediately" is true for file access too; a collaborator who was never a member keeps the grants the
//     owner gave them, which is the supported grant-only collaborator path.
//   * The object path must have the canonical shape for this upload: workspaces/<company>/... or, for a legacy upload,
//     <uploader>/... , and be well formed. Anything else is a server-side invariant failure, not a download.
//   * The response carries the upload's server-recorded SHA-256 (null until processing recorded it) so the client can
//     prove the bytes it received are the bytes the server fingerprinted.
//
// ORDERING CONTRACT (independent review of #229, finding 3). Authority is read twice, around the one asynchronous step that
// cannot be made transactional with the database (asking Storage to sign):
//     authorise (read 1) -> sign -> authorise again (read 2, the LINEARIZATION POINT) -> durable record -> return the link.
//   * A link is returned only if read 2 still grants the right. A withdrawal that committed before read 2 therefore prevents any
//     link from being returned (the signed token may have been minted by Storage, but it is discarded unseen and never logged).
//   * A withdrawal that commits after read 2 is ordered after the issuance: the returned link stays usable until it expires
//     (DOWNLOAD_EXPIRY_SECONDS). A signed URL is a bearer credential and cannot be revoked individually; that window is the only
//     residual access. This is NOT atomic revocation: a second check narrows the window, it does not close it.
//   * The record is written BEFORE the link is returned, and a link is never returned if the record could not be written.
//
// AUDIT SEMANTICS. The durable record (trial_balance_source_download_events) is a record of link-issuance DECISIONS by this function:
//   issued (a link was returned), denied (an authenticated caller naming a real upload of a real company lacked the right) and
//   withdrawn_before_issue (the right was withdrawn while signing). It stores who, which company and upload, the outcome, the link's
//   expiry and the recorded fingerprint - never a URL, token or path. It does NOT establish that the file was transferred: the bytes
//   travel from Storage to the browser, which this function cannot observe, and a browser report would be a claim, not evidence.
//   Unauthenticated calls and requests whose upload does not exist or does not belong to the named company are not recorded (they
//   name nothing real, and recording them would let anyone write to the table).

import { isWellFormedSourcePath } from "./sourcePath.ts";

export const DOWNLOAD_CAPABILITY = "manage_source_files";
/** How long an issued URL works. Short on purpose: it is the only access that outlives a revocation. */
export const DOWNLOAD_EXPIRY_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SourceDownloadOutcome = "ready" | "forbidden" | "unauthenticated" | "invalid_request" | "unavailable" | "signing_failed" | "audit_unavailable";

/** What a decision record says; see AUDIT SEMANTICS above. */
export type DownloadDecision = "issued" | "denied" | "withdrawn_before_issue";
export interface DownloadDecisionEvent {
  outcome: DownloadDecision;
  userId: string;
  companyId: string;
  uploadId: string;
  /** When the issued link stops working (ISO-8601); null for a decision that issued nothing. */
  expiresAt: string | null;
  /** The upload's server-recorded SHA-256 at the time of the decision. */
  sha256: string | null;
}

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
  /** Durable record of one decision; resolves true only when it was stored. Never receives the URL. */
  record(event: DownloadDecisionEvent): Promise<boolean>;
  /** Clock for the recorded expiry (injectable for tests). */
  now?(): number;
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
  const decision = (outcome: DownloadDecision, expiresAt: string | null): DownloadDecisionEvent =>
    ({ outcome, userId, companyId: target.company_id as string, uploadId: target.id, expiresAt, sha256: target.source_file_hash ?? null });
  // A refusal is answered whether or not it could be recorded; only an ISSUED link depends on its record.
  const recordBestEffort = async (e: DownloadDecisionEvent) => { try { await deps.record(e); } catch { /* the refusal stands */ } };

  if (!(await deps.canDownload(userId, target.company_id))) { await recordBestEffort(decision("denied", null)); return { status: 403, outcome: "forbidden" }; }

  if (target.file_path === null) return { status: 404, outcome: "unavailable" };
  const path = canonicalPath(target, target.company_id);
  if (!path) return { status: 500, outcome: "signing_failed" };

  const name = safeDownloadName(target.file_name);
  const signed = await deps.sign(path, DOWNLOAD_EXPIRY_SECONDS, name);
  if (signed && "missing" in signed) return { status: 404, outcome: "unavailable" };
  if (!signed || !signed.url) return { status: 502, outcome: "signing_failed" };

  // LINEARIZATION POINT: authority is read again AFTER signing. If it was withdrawn meanwhile, the minted link is discarded unseen.
  if (!(await deps.canDownload(userId, target.company_id))) { await recordBestEffort(decision("withdrawn_before_issue", null)); return { status: 403, outcome: "forbidden" }; }

  const expiresAt = new Date((deps.now?.() ?? Date.now()) + DOWNLOAD_EXPIRY_SECONDS * 1000).toISOString();
  let recorded = false;
  try { recorded = await deps.record(decision("issued", expiresAt)); } catch { recorded = false; }
  if (!recorded) return { status: 503, outcome: "audit_unavailable" };   // no record, no link

  return {
    status: 200, outcome: "ready", url: signed.url, expires_in: DOWNLOAD_EXPIRY_SECONDS, file_name: name,
    sha256: target.source_file_hash ?? null, size: typeof target.file_size === "number" ? target.file_size : null,
  };
}
