// Official Reporting Pack issuance — the bytes come from the DATABASE, never from a caller (security correction N-1,
// 20260925140000).
//
// Hashing uploaded bytes on the server proves only that they were not changed later, not that they are the saved
// output. So no request can carry the document at all. For an issuance whose format the server can generate
// (financial_statements_data from a saved statements version, fs-report:<id>:v<n>), this handler:
//   1. asks prepare_official_reporting_pack (service role) for the canonical document the database renders from the
//      authoritative saved output — the same checks as sealing (user, expiry, closed output reference, format,
//      entitlement, capability), nothing changed;
//   2. confirms the UTF-8 bytes hash to the database's canonical hash (no silent re-encoding);
//   3. stores exactly those bytes in the private reporting-packs bucket at <company>/<issuance>.json, never overwriting
//      (an object already there is reused only when it is exactly those bytes);
//   4. re-reads the stored object and confirms it is exactly those bytes BEFORE anything is sealed;
//   5. calls seal_reporting_pack_server, which takes NO hash and NO bytes: the database regenerates the document,
//      hashes it itself and seals that hash with the storage path and size.
// Issuance NEVER deletes or overwrites a stored object (it has no remove dependency at all). A delete decided by an
// earlier "is it still unsealed?" check cannot be made atomic with a concurrent seal, which commits under the issuance
// row lock in the database: such a delete removed a pack another request had just sealed (reproduced in #156). So bytes
// at the issuance's path that are not exactly the canonical document are refused (object_conflict, nothing deleted,
// nothing sealed); the caller recovers through the existing authorised
// path — a NEW issuance (a new request id, a new path); the conflicting issuance stays as history and expires unsealed.
// Unsealed objects are never official; removing them is the expiry-gated orphan sweep's job, never issuance's.
// parseSealRequest refuses every request that carries anything but { action, issuance_id } as JSON: document bytes,
// a hash, a file name or any other field never reach the database.
// Every other format is refused (official_sealing_unavailable): it can only be a working copy, never official.
// verifyStoredPack re-hashes the stored object AND compares the seal with the canonical hash re-derived from the source.
//
// Plain JavaScript (types in reportingPackSeal.d.mts) so the SAME module runs in the Edge Function (Deno), in the unit
// tests (src/lib/commercial/reportingPackSeal.test.ts) and against real PostgreSQL (scripts/db-proof/billingSuspension.mjs).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
export const OFFICIAL_CONTENT_TYPE = "application/json";

const STATUS = {
  sealed: 200, invalid_request: 400, not_found: 404, binding_mismatch: 409, already_sealed: 409, expired: 410,
  entitlement_required: 402, capability_required: 403, workspace_access_denied: 403, unauthenticated: 401,
  official_sealing_unavailable: 422, object_missing: 409, object_conflict: 409, seal_failed: 500,
  // 20261123100000: a later FINAL of the lineage supersedes the version; no new official pack of it is issued or sealed.
  superseded_final_version: 409,
};
const refuse = (outcome) => ({ httpStatus: STATUS[outcome] ?? 500, body: { outcome } });

/**
 * The only accepted request: a JSON object with exactly { action: "issue" | "verify" | "retrieve", issuance_id }. Anything else — a
 * multipart upload, raw bytes, a hash or any extra field — is refused (null) before the database is called.
 * @param {string | null} contentType @param {unknown} body
 */
export function parseSealRequest(contentType, body) {
  if (!String(contentType ?? "").startsWith("application/json")) return null;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "action,issuance_id") return null;
  if (body.action !== "issue" && body.action !== "verify" && body.action !== "retrieve") return null;
  if (typeof body.issuance_id !== "string" || !UUID.test(body.issuance_id)) return null;
  return { action: body.action, issuanceId: body.issuance_id };
}
const obj = (data) => (data && typeof data === "object" ? data : null);

/** @param {import("./reportingPackSeal.d.mts").SealDeps} deps @param {{ userId: string, issuanceId: string }} input */
export async function issueOfficialPack(deps, input) {
  if (!UUID.test(input?.userId ?? "") || !UUID.test(input?.issuanceId ?? "")) return refuse("invalid_request");
  const prep = await deps.rpc("prepare_official_reporting_pack", { p_user: input.userId, p_issuance_id: input.issuanceId });
  const p = prep.error ? null : obj(prep.data);
  if (!p || p.outcome !== "ready") return refuse(typeof p?.outcome === "string" ? p.outcome : "seal_failed");
  const path = typeof p.storage_path === "string" ? p.storage_path : "";
  if (typeof p.document !== "string" || !SHA.test(String(p.content_sha256)) || !path.endsWith(`/${input.issuanceId}.json`) || typeof p.file_name !== "string") {
    return refuse("seal_failed");
  }
  const bytes = new TextEncoder().encode(p.document);
  if ((await deps.sha256Hex(bytes)) !== p.content_sha256) return refuse("seal_failed");
  const stored = await deps.put(path, bytes, OFFICIAL_CONTENT_TYPE);
  // Whatever is at this issuance's own path now (no overwrite: ours, a concurrent request's or an interrupted one's) is
  // used only if it is exactly the canonical bytes. Nothing readable there: storage did not answer — seal_failed, retry.
  // Other bytes: object_conflict, refused and left untouched (a NEW issuance recovers; nothing here deletes).
  const found = await deps.get(path);
  if (!found) return refuse("seal_failed");
  if ((await deps.sha256Hex(found)) !== p.content_sha256) return refuse(stored.error ? "object_conflict" : "seal_failed");
  const sealed = await deps.rpc("seal_reporting_pack_server", { p_user: input.userId, p_issuance_id: input.issuanceId, p_storage_path: path });
  const s = sealed.error ? null : obj(sealed.data);
  const outcome = typeof s?.outcome === "string" ? s.outcome : "seal_failed";
  // A refused or failed seal leaves the object where it is: a concurrent request may be committing its own seal of it.
  // Unsealed canonical bytes are a listed orphan (reporting_pack_storage_orphans), never official, reused by a retry.
  if (outcome !== "sealed") return refuse(outcome);
  // The database hashed its own regeneration; it must be the document that was stored (the source is immutable).
  if (s.content_sha256 !== p.content_sha256) return refuse("seal_failed");
  return { httpStatus: 200, body: { outcome: "sealed", issuance_id: input.issuanceId, content_sha256: s.content_sha256, document: p.document, file_name: p.file_name } };
}

/**
 * THE official-verification route (security correction X-3): the only answer that may say official = true, because it
 * downloads the stored bytes and re-hashes them. The caller must have access to the workspace (also after its plan
 * ended); anyone else learns nothing (not_found). official is true only for "intact".
 * @param {import("./reportingPackSeal.d.mts").SealDeps} deps @param {string} userId @param {string} issuanceId
 */
/**
 * retrieve: the stored official bytes AGAIN, with the sealed digest, for a workspace member — only when the stored object
 * is intact (verify's own gate); never a regenerated document. { outcome: "retrieved", document, content_sha256, file_name }
 * or verify's refusal outcome.
 * @param {import("./reportingPackSeal.d.mts").SealDeps} deps @param {string} userId @param {string} issuanceId
 */
export async function retrieveOfficialPack(deps, userId, issuanceId) {
  const v = await verifyOfficialPack(deps, userId, issuanceId);
  if (v.outcome !== "intact") return { outcome: v.outcome, official: false, superseded: v.superseded };
  const { data } = await deps.rpc("reporting_pack_sealed_object", { p_issuance_id: issuanceId });
  const row = obj(data);
  const bytes = row?.storage_path ? await deps.get(row.storage_path) : null;
  if (!bytes || (await deps.sha256Hex(bytes)) !== row.content_sha256) return { outcome: "substituted", official: false, superseded: v.superseded };
  // superseded (20261123100000): a later FINAL of the lineage exists; the bytes are still the official pack of the version they name.
  return { outcome: "retrieved", official: true, superseded: v.superseded, content_sha256: row.content_sha256, document: new TextDecoder().decode(bytes), file_name: `official-reporting-pack-${issuanceId}.json` };
}

export async function verifyOfficialPack(deps, userId, issuanceId) {
  if (!UUID.test(userId ?? "")) return { outcome: "not_found", official: false, superseded: false };
  const r = await verifyStoredPack(deps, issuanceId);
  if (!r.company_id) return { outcome: "not_found", official: false, superseded: false };
  const { data } = await deps.rpc("authorize_paid_action_for_user", { p_user: userId, p_company_id: r.company_id, p_capability: "CLOSE_ASSURANCE" });
  const code = obj(data)?.code;
  if (!code || code === "WORKSPACE_ACCESS_DENIED" || code === "UNAUTHENTICATED") return { outcome: "not_found", official: false, superseded: false };
  // superseded is DISCLOSURE, never a change of official status: an intact pack is the official pack of the version it names.
  return { outcome: r.outcome, official: r.outcome === "intact", superseded: r.superseded === true };
}

/**
 * intact        the stored object is the sealed bytes, and the seal is the canonical document of its source
 * substituted   the stored object is not the sealed bytes
 * not_canonical the seal's hash is not the canonical hash re-derived from the authoritative source (never official)
 * missing | not_found
 * @param {import("./reportingPackSeal.d.mts").SealDeps} deps @param {string} issuanceId
 */
export async function verifyStoredPack(deps, issuanceId) {
  if (!UUID.test(issuanceId ?? "")) return { outcome: "not_found" };
  const { data, error } = await deps.rpc("reporting_pack_sealed_object", { p_issuance_id: issuanceId });
  const row = error ? null : obj(data);
  if (!row?.storage_path || !row.content_sha256) return { outcome: "not_found" };
  // superseded (20261123100000, reporting_pack_sealed_object v2): a later version of the lineage is FINAL. Absent on an
  // older database, which reads as not superseded.
  const superseded = row.superseded === true;
  if (row.canonical_sha256 !== row.content_sha256) return { outcome: "not_canonical", company_id: row.company_id, superseded };
  const bytes = await deps.get(row.storage_path);
  if (!bytes) return { outcome: "missing", company_id: row.company_id, superseded };
  return { outcome: (await deps.sha256Hex(bytes)) === row.content_sha256 ? "intact" : "substituted", company_id: row.company_id, superseded };
}
