// Authorized retrieval of a trial balance's ORIGINAL uploaded file.
//
// Pure orchestration with injected dependencies. It is unit-tested in Node (src/lib/workspace/sourceDownload.test.ts) and runs unchanged in the
// trial-balance-source-download Edge Function. It is the counterpart of sourceUpload.ts: the bucket stays private and no client Storage policy is widened; the
// server authorizes each request and then issues a very short-lived signed URL for exactly one object. The rules:
//   * The request carries exactly two things: an upload id and the company id the caller believes it belongs to. A bucket, path, user or any other key in the
//     body is refused, never read.
//   * The caller is authenticated from their JWT. The object path is resolved server-side from the upload row; the caller can neither name nor influence it.
//   * Binding: the company named in the request must be the upload's own company. A mismatch is answered exactly like an unknown upload or a missing right
//     ("forbidden"), so the response never reveals whether an upload id exists.
//   * Authority is re-judged on EVERY request (workspace_authority_basis, capability manage_source_files): the workspace owner with a current plan, or an
//     explicit active grant; never a title. Removing a team member also revokes that person's explicit grants in the same transaction (migration
//     20261211100000); a collaborator who was never a member keeps the grants the owner gave them (the supported grant-only path).
//   * The object path must have the canonical shape for this upload: workspaces/<company>/... or, for a legacy upload, <uploader>/... , and be well formed.
//   * The response carries the upload's server-recorded SHA-256 (null until processing recorded it) so the client can prove the bytes it received are the bytes
//     the server fingerprinted.
//
// ORDERING CONTRACT. Signing is an external call to Storage and cannot share a database transaction, so it is never held inside one. The sequence is:
//     precheck (an ordinary read: it only avoids signing for a caller who plainly lacks the right; it orders nothing)
//       -> sign (outside any transaction)
//       -> DECIDE: one database transaction that takes the locks of every writer of the authority inputs, re-judges authority, judges freshness as late as
//          practical (immediately before the insert) and inserts the decision record -> its COMMIT is the ordering point
//       -> FRESHNESS AGAIN on this function's clock, after the commit and before the response is built
//       -> return the link, only if the decision committed as 'issued' AND the link still has the required margin.
//   * Withdrawal commits before the decision: the decision sees it, records 'withdrawn_before_issue', and no link is returned (the minted link is discarded
//     unseen and never logged).
//   * The decision commits first: a withdrawal must wait for its locks, so it is ordered AFTER the issuance; the link may still be delivered afterwards, and
//     it remains a bearer credential until its own expiry. Storage cannot revoke one signed URL: that remaining lifetime is a separate, documented limit.
//   * An unauthorised signed URL is never returned: there is no code path to the link except the 'issued' decision. If the decision cannot be taken or
//     stored (database error, a lock not obtained in time, or the workspace changed owner while it was being taken), no link is returned.
//   * Writers, the lock protocol and the owner-identity rule are documented in supabase/migrations/20261211100000_source_access_authority_repairs.sql, where
//     the decision lives.
//
// FOUR DIFFERENT FACTS, never promoted to one another: (1) the authorization/issuance DECISION (recorded, immutable); (2) the FRESHNESS EVALUATION (when the
// database judged the link, recorded with the remaining life it found; it proves the link had that much life THEN, not at commit, because a transaction can
// pause after its last check); (3) TRANSACTION COMPLETION (not recorded: unknowable inside the transaction); (4) RESPONSE DELIVERY (not recorded and not
// observable here: the bytes travel from Storage to the browser, and a browser report would be a claim, not evidence). A decision may exist without a
// delivered response - the second freshness check below can withhold a link whose decision was already committed - and nothing rewrites the row.
// Unauthenticated calls and requests naming an unknown upload or another company's are not recorded. No URL, token or path is ever stored.
//
// EXPIRY IS THE SIGNER'S OWN, OR NOTHING IS ISSUED. The link's `exp` is read from the token Storage signed. If it cannot be read the link is refused
// (signing_failed) and nothing is recorded: there is no estimated-expiry fallback. Storage may truncate the signing instant to a whole second, so the real exp
// can be up to a second earlier than "signing start + lifetime"; an estimate built from the signing interval is therefore not reliably conservative once
// timestamp resolution and clock differences are counted, and no tolerance is added to make it so. DOWNLOAD_MIN_REMAINING_SECONDS is a POLICY margin
// (response transit, modest clock differences between Storage and the database); it is not derived from a measured skew and no skew bound is claimed.

import { isWellFormedSourcePath } from "./sourcePath.ts";

export const DOWNLOAD_CAPABILITY = "manage_source_files";
/** The lifetime requested from Storage for a signed URL. Short on purpose: it is the only access that outlives a revocation. */
export const DOWNLOAD_EXPIRY_SECONDS = 60;
/** How far a signer-reported expiry may exceed signing completion + lifetime before the link is refused as having an unexpected lifetime. */
export const SIGNER_EXPIRY_TOLERANCE_SECONDS = 30;
/** The remaining life a link must have, at the database's freshness evaluation and again before the response is built. A policy margin, not a measured bound. */
export const DOWNLOAD_MIN_REMAINING_SECONDS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SourceDownloadOutcome =
  | "ready" | "forbidden" | "unauthenticated" | "invalid_request" | "unavailable" | "signing_failed" | "audit_unavailable" | "link_expired" | "decision_unavailable";

/** What the database decided; 'unavailable' means a lock was not obtained in time or the owner changed (nothing recorded, safe to retry). */
export type IssuanceDecision = "issued" | "withdrawn_before_issue" | "expired_before_issue" | "unavailable";

/** The input of the atomic decision. Never contains the URL or token. */
export interface IssuanceRequest {
  userId: string;
  companyId: string;
  uploadId: string;
  /** Function-host clock readings (ISO-8601) around the signing call (recorded for audit; not used to estimate an expiry). */
  signingStartedAt: string;
  signingCompletedAt: string;
  /** The lifetime that was requested from Storage. */
  linkLifetimeSeconds: number;
  /** The signer's own expiry (ISO-8601): always present, because a link without a readable exp is never submitted for a decision. */
  linkExpiryExactAt: string;
  /** The remaining life the database must find at its freshness evaluation. */
  minRemainingSeconds: number;
  /** The upload's server-recorded SHA-256 at the time of the decision. */
  sha256: string | null;
}

export interface DenialRecord { userId: string; companyId: string; uploadId: string; sha256: string | null }

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

/** `expiresAtMs` is the signer's own expiry (epoch milliseconds) read from the signed link; the link itself is never stored. */
export type SignResult = { url: string; expiresAtMs?: number | null } | { missing: true } | null;

export interface SourceDownloadDeps {
  authenticate(): Promise<string | null>;
  resolveUpload(uploadId: string): Promise<UploadTarget | null>;
  /** An ordinary authority read. A PRECHECK only: it is not the ordering point and nothing may rely on it for safety. */
  canDownload(userId: string, companyId: string): Promise<boolean>;
  /** Service-role createSignedUrl for exactly this path, valid for `seconds`, saved under `downloadName`. Outside any database transaction. */
  sign(path: string, seconds: number, downloadName: string): Promise<SignResult>;
  /** The atomic issuance decision (one database transaction: locks, authority, freshness, record). Throws when it could not be taken or stored. */
  decide(request: IssuanceRequest): Promise<IssuanceDecision>;
  /** Best-effort record of a precheck refusal. A refusal stands whether or not this succeeds. */
  recordDenial(event: DenialRecord): Promise<void>;
  /** Clock in epoch milliseconds (injectable for tests). */
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
  const clock = () => deps.now?.() ?? Date.now();
  const marginMs = DOWNLOAD_MIN_REMAINING_SECONDS * 1000;
  const userId = await deps.authenticate();
  if (!userId) return { status: 401, outcome: "unauthenticated" };

  const target = await deps.resolveUpload(request.uploadId);
  // Unknown upload, another company's upload and a missing right are one answer.
  if (!target || !target.company_id || target.company_id !== request.companyId) return { status: 403, outcome: "forbidden" };
  const companyId = target.company_id;

  // PRECHECK (not the ordering point): refuse early so nothing is signed for a caller who plainly lacks the right. A refusal stands whether or not it was recorded.
  if (!(await deps.canDownload(userId, companyId))) {
    try { await deps.recordDenial({ userId, companyId, uploadId: target.id, sha256: target.source_file_hash ?? null }); } catch { /* the refusal stands */ }
    return { status: 403, outcome: "forbidden" };
  }

  if (target.file_path === null) return { status: 404, outcome: "unavailable" };
  const path = canonicalPath(target, companyId);
  if (!path) return { status: 500, outcome: "signing_failed" };

  const name = safeDownloadName(target.file_name);
  const signingStartedMs = clock();
  const signed = await deps.sign(path, DOWNLOAD_EXPIRY_SECONDS, name);
  const signingCompletedMs = clock();
  if (signed && "missing" in signed) return { status: 404, outcome: "unavailable" };
  if (!signed || !signed.url) return { status: 502, outcome: "signing_failed" };

  // The signer's own expiry, or nothing: a link whose exp cannot be read is discarded unissued and unrecorded (no estimate is made). A link that would outlive
  // the requested lifetime by more than the tolerance has an unexpected lifetime and is discarded too.
  const exactMs = signed.expiresAtMs;
  if (typeof exactMs !== "number" || !Number.isFinite(exactMs)) return { status: 502, outcome: "signing_failed" };
  if (exactMs > signingCompletedMs + DOWNLOAD_EXPIRY_SECONDS * 1000 + SIGNER_EXPIRY_TOLERANCE_SECONDS * 1000) return { status: 502, outcome: "signing_failed" };
  // A link that has already run out (a slow signature) is not worth a decision: no lock is taken for it.
  if (exactMs - clock() < marginMs) return { status: 503, outcome: "link_expired" };

  // THE DECISION: locks + authority + freshness (as late as practical) + record in one transaction. Only an 'issued' commit leads to the link.
  let decision: IssuanceDecision;
  try {
    decision = await deps.decide({
      userId, companyId, uploadId: target.id,
      signingStartedAt: new Date(signingStartedMs).toISOString(), signingCompletedAt: new Date(signingCompletedMs).toISOString(),
      linkLifetimeSeconds: DOWNLOAD_EXPIRY_SECONDS, linkExpiryExactAt: new Date(exactMs).toISOString(), minRemainingSeconds: DOWNLOAD_MIN_REMAINING_SECONDS,
      sha256: target.source_file_hash ?? null,
    });
  } catch { return { status: 503, outcome: "audit_unavailable" }; }   // no decision, no link
  if (decision === "withdrawn_before_issue") return { status: 403, outcome: "forbidden" };
  if (decision === "expired_before_issue") return { status: 503, outcome: "link_expired" };
  if (decision === "unavailable") return { status: 503, outcome: "decision_unavailable" };
  if (decision !== "issued") return { status: 503, outcome: "audit_unavailable" };

  // FRESHNESS AGAIN, after the commit and before the response is built. The decision stays recorded as it was committed; the link is withheld, never returned
  // with no time left. This does not prove the link will still be valid when the caller uses it; the margin is a policy allowance.
  const remainingMs = exactMs - clock();
  if (remainingMs < marginMs) return { status: 503, outcome: "link_expired" };

  return {
    status: 200, outcome: "ready", url: signed.url, expires_in: Math.min(DOWNLOAD_EXPIRY_SECONDS, Math.floor(remainingMs / 1000)), file_name: name,
    sha256: target.source_file_hash ?? null, size: typeof target.file_size === "number" ? target.file_size : null,
  };
}

/** Whether a Storage error message says the object is not there (an object removed after upload is "unavailable", not a signing failure). */
export function storageErrorIsMissingObject(message: unknown): boolean {
  return /not\s*found/i.test(String(message ?? ""));
}

/**
 * The signer's own expiry (epoch milliseconds) read from the `exp` claim of the signed link's token, or null when the link carries no readable one. This only
 * READS the claim, to learn when the link stops working; the token is not verified here (Storage verifies it on use), is never stored and never logged.
 */
export function signedUrlExpiryMs(signedUrl: string): number | null {
  try {
    const token = new URL(signedUrl, "http://placeholder.invalid").searchParams.get("token");
    const payload = token?.split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const exp = (JSON.parse(atob(b64)) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch { return null; }
}
