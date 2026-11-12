/**
 * INERT CANDIDATE — awaiting Intuit clarification (case 00232331). Not imported by any Edge Function or page; nothing deploys it.
 * Design: release/candidates/qbo-realm-protection-r0/DESIGN.md.
 *
 * Application-level protection of a QuickBooks realmID, reusing the reviewed refresh-token envelope:
 *   · realm envelope  = sealSecret(realmId, current token key, realmBinding(company, environment))   — AES-256-GCM, "v1.<keyId>.<iv>.<ct>",
 *                       opened with openSecret and any configured token key (rotation as for tokens). Bound to the workspace and environment,
 *                       so a ciphertext copied to another workspace's row fails to open.
 *   · realm index     = "h1.<indexKeyId>.<HMAC-SHA256 hex>" over a domain-separated, length-prefixed (environment, realmId) — the equality
 *                       key the database needs for the one-live-connection uniqueness, the shared-realm check and the per-realm lock, without
 *                       holding the realm. Deliberately NOT bound to the workspace (shared-realm detection compares across workspaces). It uses
 *                       its OWN key (QBO_REALM_INDEX_KEY_ID / _B64): rotating the token key must not change equality; rotating the index key
 *                       is a full re-index.
 * Pure apart from WebCrypto. No storage, network or logging.
 */
import { openSecret, sealSecret, type EnvelopeBinding, type EnvelopeKey } from "../../../supabase/functions/_shared/qboTokenEnvelope.ts";

export type QboEnvironment = "production" | "sandbox";
const REALM = /^[0-9]{1,20}$/;
const KEY_ID = /^[a-z0-9-]{1,32}$/;
export const REALM_INDEX_SHAPE = /^h1\.[a-z0-9-]{1,32}\.[0-9a-f]{64}$/;

export class RealmProtectionError extends Error {
  constructor(message: string) { super(message); this.name = "RealmProtectionError"; }
}

/** The envelope binding of a realm: its workspace and environment, under a purpose no refresh token uses. */
export function realmBinding(companyId: string, environment: QboEnvironment): EnvelopeBinding {
  return { workspaceId: companyId, connectionId: environment, purpose: "qbo-realm-id" };
}

function checkRealm(realmId: string, environment: QboEnvironment): void {
  if (typeof realmId !== "string" || !REALM.test(realmId)) throw new RealmProtectionError("The QuickBooks company id is not valid.");
  if (environment !== "production" && environment !== "sandbox") throw new RealmProtectionError("The environment is not valid.");
}

export async function sealRealm(realmId: string, environment: QboEnvironment, companyId: string, key: EnvelopeKey): Promise<string> {
  checkRealm(realmId, environment);
  return sealSecret(realmId, key, realmBinding(companyId, environment));
}

/** Opens a realm envelope; the result must still be a well-formed realm id. Every failure is the same error. */
export async function openRealm(envelope: string, environment: QboEnvironment, companyId: string, keys: readonly EnvelopeKey[]): Promise<string> {
  const realm = await openSecret(envelope, keys, realmBinding(companyId, environment));
  if (!REALM.test(realm)) throw new RealmProtectionError("The stored QuickBooks company id could not be opened.");
  return realm;
}

/** The keyed equality index of (environment, realm). Same inputs and key: same index; nothing about the realm is recoverable without the key. */
export async function realmIndex(realmId: string, environment: QboEnvironment, indexKey: EnvelopeKey): Promise<string> {
  checkRealm(realmId, environment);
  if (!KEY_ID.test(indexKey.id) || indexKey.bytes.length !== 32) throw new RealmProtectionError("The index key is not valid.");
  const k = await crypto.subtle.importKey("raw", indexKey.bytes as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const parts = ["qbo-realm-index-v1", indexKey.id, environment, realmId];
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(parts.map((p) => `${p.length}:${p}`).join("|"))));
  return `h1.${indexKey.id}.${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * What the backfill submits for one existing connection. The caller verifies its own envelope opens back to the plaintext BEFORE submitting,
 * and the database refuses unless the plaintext equals the row's current realm_id (it cannot verify the envelope itself: it never holds a key).
 */
export async function protectExistingRealm(row: { id: string; company_id: string; realm_id: string; environment: QboEnvironment },
  key: EnvelopeKey, allKeys: readonly EnvelopeKey[], indexKey: EnvelopeKey): Promise<{ p_connection: string; p_realm_id: string; p_realm_envelope: string; p_realm_index: string }> {
  const envelope = await sealRealm(row.realm_id, row.environment, row.company_id, key);
  if ((await openRealm(envelope, row.environment, row.company_id, allKeys)) !== row.realm_id) throw new RealmProtectionError("Round trip failed.");
  return { p_connection: row.id, p_realm_id: row.realm_id, p_realm_envelope: envelope, p_realm_index: await realmIndex(row.realm_id, row.environment, indexKey) };
}
