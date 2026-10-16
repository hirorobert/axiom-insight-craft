// Trial balance drafts: sign a draft upload, commit a draft to an entity, cancel a commit (20261106100000, Phase 2 P2-2).
//
// Pure orchestration with injected dependencies. It is unit-tested in Node (src/lib/workspace/draftUpload.test.ts) and
// runs unchanged in the trial-balance-draft Edge Function. The rules:
//   * The caller is authenticated from their JWT; no user, owner, path or bucket is ever read from the request.
//   * sign: only the caller's own reserved, unexpired draft, not yet stored, is signed (a single object, no overwrite).
//   * commit is a RECOVERY PROTOCOL, not a distributed transaction. Every call first re-checks the caller's CURRENT
//     authority over the target entity (can_user_act_on_workspace … manage_source_files) — a replay included — and then
//     resumes from what the database recorded:
//       begin (binds draft + content hash + entity + period + confirmed context to the commit key)
//       → read the draft back: size and SHA-256 must equal what it was reserved with (else the draft is rejected)
//       → workspace reservation, AS THE USER (reserve_trial_balance_source decides the entity's authority), recorded
//       → service-role copy to the workspace object, read back, size and SHA-256 verified, recorded
//       → register, AS THE USER (register_trial_balance_upload: the reservation is consumed with the upload row in one
//         transaction, so registration happens at most once; a repeat answers already_registered with the same upload)
//       → finish (the upload must be exactly the one registered from this reservation, with the bound period).
//     A crash, a lost response or a failed step leaves a recorded state the next call resumes from. Steps are idempotent:
//     an existing verified copy is not copied again; a consumed reservation is not registered again.
//   * Missing database functions (an interrupted rollout: function deployed before its migration) are answered
//     'drafts_unavailable' (503) — never a false success.

export const DRAFT_CAPABILITY = "manage_source_files";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
// PostgREST "function not found" / Postgres undefined function / undefined table: the migration is not applied.
const NOT_DEPLOYED = new Set(["PGRST202", "PGRST205", "42883", "42P01"]);

export type DraftOutcome =
  | "signed" | "already_stored" | "committed" | "cancelled" | "already_cancelled"
  | "unauthenticated" | "forbidden" | "invalid_request" | "not_found" | "expired" | "not_eligible"
  | "commit_conflict" | "draft_not_stored" | "content_mismatch" | "active_upload_exists" | "registration_refused" | "replace_conflict"
  | "retry" | "storage_unavailable" | "copy_integrity_failed" | "commit_failed" | "drafts_unavailable" | "signing_failed";

export interface Confirmation { entity: string; period: string; currency: string }

export type DraftRequest =
  | { action: "sign"; draftId: string }
  | { action: "commit"; draftId: string; commitKey: string; companyId: string; periodYear: number; periodId: string | null; engagementId: string | null; confirmation: Confirmation;
      /** A replacement of this active upload (bound to the commit), at the version the user saw (a concurrency token). */
      replaces?: { uploadId: string; expectedVersion: number } | null }
  | { action: "cancel"; commitId: string };

export interface BeginResult {
  outcome: string;
  commit_id: string | null;
  object_path: string | null;
  file_name: string | null;
  file_size: number | string | null;
  content_sha256: string | null;
  reservation_id: string | null;
  reservation_state: "none" | "live" | "expired" | "consumed" | null;
  copy_verified: boolean | null;
  upload_id: string | null;
}

export interface DraftDeps {
  authenticate(): Promise<string | null>;
  signTarget(draftId: string, userId: string): Promise<{ object_path: string; signable: boolean; stored: boolean } | null>;
  signUpload(path: string): Promise<{ path: string; token: string } | null>;
  canManage(userId: string, companyId: string): Promise<boolean>;
  beginCommit(userId: string, r: Extract<DraftRequest, { action: "commit" }>): Promise<BeginResult>;
  /** AS THE USER: reserve_trial_balance_source(company, name). */
  reserveSource(companyId: string, fileName: string): Promise<{ outcome: string; reservation_id: string | null; object_path: string | null }>;
  recordReservation(commitId: string, userId: string, reservationId: string): Promise<string>;
  /** Service role: tbu_source_reservation_target (the reserved object path). */
  reservationPath(reservationId: string): Promise<string | null>;
  /** Service-role Storage read of exactly this object; null when it is absent. Throws when Storage cannot be read. */
  readObject(path: string): Promise<Uint8Array | null>;
  /** Service-role Storage copy (never overwrites). */
  copyObject(from: string, to: string): Promise<boolean>;
  /** Service-role Storage removal of an UNCONSUMED reservation's object whose bytes failed verification. */
  removeObject(path: string): Promise<boolean>;
  sha256(bytes: Uint8Array): Promise<string>;
  recordCopyVerified(commitId: string, userId: string, sha: string, size: number): Promise<string>;
  /** AS THE USER: retire_trial_balance_upload(old, expected version, reservation, size, reason) — atomic; keeps the old one on failure. */
  retire(oldUploadId: string, expectedVersion: number, reservationId: string, size: number): Promise<{ outcome: string; new_upload_id: string | null; detail: string | null }>;
  /** AS THE USER: register_trial_balance_upload(reservation, size, year, period, engagement). */
  register(reservationId: string, size: number, periodYear: number, periodId: string | null, engagementId: string | null): Promise<{ outcome: string; upload_id: string | null; detail: string | null }>;
  finish(commitId: string, userId: string, uploadId: string): Promise<string>;
  rejectDraft(draftId: string, userId: string): Promise<string>;
  cancelCommit(commitId: string, userId: string): Promise<string>;
}

export interface DraftResult {
  status: number;
  outcome: DraftOutcome;
  /** True when the same request may simply be sent again. */
  retryable?: boolean;
  path?: string;
  token?: string;
  commit_id?: string;
  upload_id?: string;
  replayed?: boolean;
  detail?: string;
}

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

export function parseDraftRequest(body: unknown): DraftRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.action === "sign") {
    return onlyKeys(b, ["action", "draft_id"]) && isUuid(b.draft_id) ? { action: "sign", draftId: b.draft_id } : null;
  }
  if (b.action === "cancel") {
    return onlyKeys(b, ["action", "commit_id"]) && isUuid(b.commit_id) ? { action: "cancel", commitId: b.commit_id } : null;
  }
  if (b.action !== "commit") return null;
  if (!onlyKeys(b, ["action", "draft_id", "commit_key", "company_id", "period_year", "period_id", "engagement_id", "confirmation", "replaces_upload_id", "expected_version"])) return null;
  const replacing = b.replaces_upload_id != null || b.expected_version != null;
  if (replacing && (!isUuid(b.replaces_upload_id) || !Number.isInteger(b.expected_version) || (b.expected_version as number) < 0)) return null;
  const c = b.confirmation as Record<string, unknown> | null;
  const okText = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 200;
  if (!isUuid(b.draft_id) || typeof b.commit_key !== "string" || !KEY.test(b.commit_key) || !isUuid(b.company_id)
    || !Number.isInteger(b.period_year) || (b.period_year as number) < 1900 || (b.period_year as number) > 2200
    || !(b.period_id == null || isUuid(b.period_id)) || !(b.engagement_id == null || isUuid(b.engagement_id))
    || !c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).sort().join() !== "currency,entity,period"
    || !okText(c.entity) || !okText(c.period) || !okText(c.currency)) return null;
  return {
    action: "commit", draftId: b.draft_id, commitKey: b.commit_key, companyId: b.company_id, periodYear: b.period_year as number,
    periodId: (b.period_id as string | null | undefined) ?? null, engagementId: (b.engagement_id as string | null | undefined) ?? null,
    confirmation: { entity: c.entity as string, period: c.period as string, currency: c.currency as string },
    replaces: replacing ? { uploadId: b.replaces_upload_id as string, expectedVersion: b.expected_version as number } : null,
  };
}

function errorCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return undefined;
}

export async function runDraftRequest(deps: DraftDeps, req: DraftRequest): Promise<DraftResult> {
  try {
    const userId = await deps.authenticate();
    if (!userId) return { status: 401, outcome: "unauthenticated" };
    if (req.action === "sign") return await sign(deps, userId, req.draftId);
    if (req.action === "cancel") return await cancel(deps, userId, req.commitId);
    return await commit(deps, userId, req);
  } catch (e) {
    if (NOT_DEPLOYED.has(errorCode(e) ?? "")) return { status: 503, outcome: "drafts_unavailable", retryable: false };
    return { status: 500, outcome: "commit_failed", retryable: true };
  }
}

async function sign(deps: DraftDeps, userId: string, draftId: string): Promise<DraftResult> {
  const t = await deps.signTarget(draftId, userId);
  if (!t) return { status: 404, outcome: "not_found" };
  if (t.stored) return { status: 409, outcome: "already_stored" };
  if (!t.signable) return { status: 410, outcome: "expired" };
  if (!t.object_path.startsWith(`drafts/${userId}/${draftId}/`)) return { status: 500, outcome: "signing_failed" };
  const s = await deps.signUpload(t.object_path);
  if (!s || s.path !== t.object_path) return { status: 502, outcome: "signing_failed", retryable: true };
  return { status: 200, outcome: "signed", path: s.path, token: s.token };
}

async function cancel(deps: DraftDeps, userId: string, commitId: string): Promise<DraftResult> {
  const r = await deps.cancelCommit(commitId, userId);
  if (r === "cancelled" || r === "already_cancelled") return { status: 200, outcome: r, commit_id: commitId };
  if (r === "not_eligible") return { status: 409, outcome: "not_eligible", detail: "This file was already added to the entity." };
  return { status: 404, outcome: "not_found" };
}

const REGISTER_REFUSAL: Record<string, DraftResult> = {
  forbidden: { status: 403, outcome: "forbidden" },
  active_upload_exists: { status: 409, outcome: "active_upload_exists", detail: "A trial balance is already active for this period. Replace it from the trial balance page, or choose another period." },
  rejected: { status: 422, outcome: "registration_refused" },
  object_missing: { status: 503, outcome: "storage_unavailable", retryable: true },
  expired: { status: 409, outcome: "retry", retryable: true },
  stale_reservation: { status: 409, outcome: "retry", retryable: true },
  invalid_request: { status: 400, outcome: "invalid_request" },
};

async function commit(deps: DraftDeps, userId: string, r: Extract<DraftRequest, { action: "commit" }>): Promise<DraftResult> {
  // Current authority, on every call (a replay of a finished commit included).
  if (!(await deps.canManage(userId, r.companyId))) return { status: 403, outcome: "forbidden" };

  const b = await deps.beginCommit(userId, r);
  switch (b.outcome) {
    case "started": case "resume": break;
    case "already_committed": return { status: 200, outcome: "committed", commit_id: b.commit_id ?? undefined, upload_id: b.upload_id ?? undefined, replayed: true };
    case "invalid_request": return { status: 400, outcome: "invalid_request" };
    case "not_found": return { status: 404, outcome: "not_found" };
    case "conflict": return { status: 409, outcome: "commit_conflict", detail: "This request does not match the one first sent with this key, or the file was already added elsewhere." };
    case "expired": return { status: 410, outcome: "expired" };
    case "object_missing": return { status: 409, outcome: "draft_not_stored" };
    default: return { status: 409, outcome: "not_eligible" };
  }
  const commitId = b.commit_id!, draftPath = b.object_path!, size = Number(b.file_size), sha = b.content_sha256!;
  const fileName = b.file_name!;

  // A registered reservation: only the record of it may be missing (the response was lost, or the worker stopped).
  if (b.reservation_state === "consumed") {
    if (!b.copy_verified) {
      // Registered outside this function (the user holds the reservation): verify the registered object before finishing.
      const p = await deps.reservationPath(b.reservation_id!);
      const copy = p ? await deps.readObject(p) : null;
      if (!copy) return { status: 503, outcome: "storage_unavailable", retryable: true };
      const copySha = await deps.sha256(copy);
      if (copy.byteLength !== size || copySha !== sha) return { status: 500, outcome: "copy_integrity_failed", retryable: false };
      await deps.recordCopyVerified(commitId, userId, copySha, copy.byteLength);
    }
    return await registerAndFinish(deps, userId, commitId, b.reservation_id!, size, r);
  }

  // The draft's bytes must be exactly what was reserved (size and SHA-256), read back by the server.
  if (!b.copy_verified) {
    const draft = await deps.readObject(draftPath);
    if (!draft) return { status: 503, outcome: "storage_unavailable", retryable: true };
    if (draft.byteLength !== size || (await deps.sha256(draft)) !== sha) {
      await deps.rejectDraft(r.draftId, userId);
      return { status: 422, outcome: "content_mismatch", detail: "The stored file is not the file that was checked. Upload it again." };
    }
  }

  // The workspace reservation, reserved AS THE USER (the entity's authority is decided there), recorded once.
  let reservationId = b.reservation_id;
  let workspacePath: string | null = null;
  if (!reservationId || b.reservation_state !== "live") {
    const res = await deps.reserveSource(r.companyId, fileName);
    if (res.outcome === "forbidden") return { status: 403, outcome: "forbidden" };
    if (res.outcome !== "reserved" || !res.reservation_id || !res.object_path) return { status: 500, outcome: "commit_failed", retryable: true };
    const rec = await deps.recordReservation(commitId, userId, res.reservation_id);
    if (rec === "conflict") return { status: 409, outcome: "commit_conflict" };
    if (rec !== "recorded" && rec !== "already_recorded") return { status: 409, outcome: "retry", retryable: true };
    reservationId = res.reservation_id;
    workspacePath = res.object_path;
  } else {
    workspacePath = await deps.reservationPath(reservationId);
    if (!workspacePath) return { status: 409, outcome: "retry", retryable: true };
  }
  if (!workspacePath.startsWith(`workspaces/${r.companyId}/`)) return { status: 500, outcome: "commit_failed" };

  // The workspace copy: made once, read back and verified, recorded. A copy that fails verification is removed (its
  // reservation is unconsumed, so nothing references it) and the call is retryable.
  if (!(b.copy_verified && reservationId === b.reservation_id)) {
    let copy = await deps.readObject(workspacePath);
    if (!copy) {
      if (!(await deps.copyObject(draftPath, workspacePath))) return { status: 503, outcome: "storage_unavailable", retryable: true };
      copy = await deps.readObject(workspacePath);
      if (!copy) return { status: 503, outcome: "storage_unavailable", retryable: true };
    }
    const copySha = await deps.sha256(copy);
    if (copy.byteLength !== size || copySha !== sha) {
      await deps.removeObject(workspacePath);
      return { status: 500, outcome: "copy_integrity_failed", retryable: true };
    }
    const v = await deps.recordCopyVerified(commitId, userId, copySha, copy.byteLength);
    if (v !== "verified" && v !== "already_verified") return { status: 409, outcome: "retry", retryable: true };
  }

  return await registerAndFinish(deps, userId, commitId, reservationId, size, r);
}

const RETIRE_REFUSAL: Record<string, DraftResult> = {
  forbidden: { status: 403, outcome: "forbidden" },
  stale_version: { status: 409, outcome: "replace_conflict", detail: "The current trial balance changed since you chose to replace it. Look at it again, then replace it." },
  already_discarded: { status: 409, outcome: "replace_conflict", detail: "The trial balance you chose to replace is no longer active. Look at the period again." },
};

async function registerAndFinish(deps: DraftDeps, userId: string, commitId: string, reservationId: string, size: number,
  r: Extract<DraftRequest, { action: "commit" }>): Promise<DraftResult> {
  if (r.replaces) {
    // Replacement: one transaction demotes the old upload and creates the new one, or changes nothing. A retry with the
    // same reservation answers the same new upload ('replaced'); the old one is never lost.
    const x = await deps.retire(r.replaces.uploadId, r.replaces.expectedVersion, reservationId, size);
    if (x.outcome !== "replaced" || !x.new_upload_id) {
      const refusal = RETIRE_REFUSAL[x.outcome] ?? { status: 500, outcome: "commit_failed" as const, retryable: true };
      return { ...refusal, commit_id: commitId, detail: refusal.detail ?? x.detail ?? undefined };
    }
    const f = await deps.finish(commitId, userId, x.new_upload_id);
    if (f === "committed" || f === "already_committed") return { status: 200, outcome: "committed", commit_id: commitId, upload_id: x.new_upload_id, replayed: f === "already_committed" };
    return { status: 500, outcome: "commit_failed", retryable: f === "not_verified", commit_id: commitId };
  }
  const g = await deps.register(reservationId, size, r.periodYear, r.periodId, r.engagementId);
  if (g.outcome !== "registered" && g.outcome !== "already_registered") {
    const refusal = REGISTER_REFUSAL[g.outcome] ?? { status: 500, outcome: "commit_failed" as const, retryable: true };
    return { ...refusal, commit_id: commitId, detail: refusal.detail ?? g.detail ?? undefined };
  }
  if (!g.upload_id) return { status: 500, outcome: "commit_failed", retryable: true };
  const f = await deps.finish(commitId, userId, g.upload_id);
  if (f === "committed" || f === "already_committed") {
    return { status: 200, outcome: "committed", commit_id: commitId, upload_id: g.upload_id, replayed: g.outcome === "already_registered" || f === "already_committed" };
  }
  return { status: 500, outcome: "commit_failed", retryable: f === "not_verified", commit_id: commitId };
}
