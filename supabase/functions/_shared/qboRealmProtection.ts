/**
 * qboRealmProtection — application-level protection of a QuickBooks realmID (Intuit support case 00232331, answer of 9 Nov 2026:
 * "Refresh tokens and realmID must both be encrypted in persistent storage (AES preferred), with the key in separate server-side
 * configuration. Host encryption at rest is not enough for realmID if the app stores it in the clear.").
 * Design and phases: docs/release/qbo-realm-protection-r1/README.md (promoted from the inert r0 candidate design).
 *
 *   · realm envelope = sealSecret(realmId, current token key, binding) — the reviewed AES-256-GCM refresh-token envelope
 *                      ("v1.<keyId>.<iv>.<ct>"), opened with any configured token key (rotation as for tokens), purpose "qbo-realm-id".
 *                      Stored rows (connections, disconnect operations, import intents and pulls) are bound to the workspace and the
 *                      environment, so a ciphertext copied to another workspace's row fails to open. A realm PARKED by the OAuth callback
 *                      (before the workspace is known) is bound to the one-time handoff's hash, exactly like the parked authorisation code.
 *   · realm index    = "h1.<indexKeyId>.<HMAC-SHA256 hex>" over a domain-separated, length-prefixed (environment, realmId): the equality key
 *                      the database needs for one live connection per realm, the shared-realm check and the per-realm lock, without
 *                      holding the realm. Deliberately NOT bound to the workspace (shared-realm detection compares across workspaces). It
 *                      uses its OWN key (QBO_REALM_INDEX_KEY_ID / QBO_REALM_INDEX_KEY_B64): rotating the token key never changes equality;
 *                      rotating the index key is a full re-index.
 * Pure apart from WebCrypto. No storage, no network, no logging: nothing here ever writes a realm, a key or an envelope anywhere.
 */
import { openSecret, sealSecret, type EnvelopeBinding, type EnvelopeKey } from "./qboTokenEnvelope.ts";

export type QboEnvironment = "production" | "sandbox";
export const REALM_ID_SHAPE = /^[0-9]{1,20}$/;
export const REALM_ENVELOPE_SHAPE = /^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const REALM_INDEX_SHAPE = /^h1\.[a-z0-9-]{1,32}\.[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9-]{1,32}$/;
const HASH = /^[0-9a-f]{64}$/;

export class RealmProtectionError extends Error {
  constructor(message: string) { super(message); this.name = "RealmProtectionError"; }
}

/**
 * The token key ring (envelopes) and the separate index key, all from Edge Function secrets, never from the database. `index` computes every
 * new index; `indexAll` (index-key rotation, 20261230500000) also holds the retiring index key, used ONLY to recognise an index it made
 * (an index names its key: "h1.<keyId>.…"). Absent, it is just `[index]`.
 */
export interface RealmKeys { current: EnvelopeKey; all: readonly EnvelopeKey[]; index: EnvelopeKey; indexAll?: readonly EnvelopeKey[] }

/**
 * Key versions (Phase C v2): a token key id is "k<N>" and an index key id is "idx<N>", N = 1 … 999999999. A key is moved onto only a strictly
 * higher version of the same kind; anything unversioned, of the other kind, or equal or lower is refused (no downgrade, no same-key "move").
 * The database enforces the same rule (public.qbo_key_version); this is the application-side half.
 */
const VERSIONED = /^(k|idx)([1-9][0-9]{0,8})$/;
export function keyVersion(id: string): { kind: "k" | "idx"; version: number } | null {
  const m = VERSIONED.exec(id);
  return m ? { kind: m[1] as "k" | "idx", version: Number(m[2]) } : null;
}
export function isUpgrade(fromId: string, toId: string): boolean {
  const a = keyVersion(fromId), b = keyVersion(toId);
  return a !== null && b !== null && a.kind === b.kind && b.version > a.version;
}

/** The index key that made a stored index (by the key id the index names), or null when no configured index key has that id. */
export function indexKeyFor(storedIndex: string, keys: RealmKeys): EnvelopeKey | null {
  if (!REALM_INDEX_SHAPE.test(storedIndex)) return null;
  const id = storedIndex.split(".")[1];
  return (keys.indexAll ?? [keys.index]).find((k) => k.id === id) ?? null;
}

/** The binding of a STORED realm: its workspace and environment, under a purpose no refresh token or code uses. */
export function realmBinding(companyId: string, environment: QboEnvironment): EnvelopeBinding {
  return { workspaceId: companyId, connectionId: environment, purpose: "qbo-realm-id" };
}

/** The binding of a realm PARKED by the OAuth callback: the hash of the one-time handoff names the one state row it may live in. */
export function oauthRealmBinding(handoffHash: string): EnvelopeBinding {
  if (!HASH.test(handoffHash)) throw new RealmProtectionError("The handoff is not valid.");
  return { workspaceId: "qbo-oauth-return", connectionId: handoffHash, purpose: "qbo-realm-id" };
}

function checkRealm(realmId: string): void {
  if (typeof realmId !== "string" || !REALM_ID_SHAPE.test(realmId)) throw new RealmProtectionError("The QuickBooks company id is not valid.");
}
function checkEnvironment(environment: QboEnvironment): void {
  if (environment !== "production" && environment !== "sandbox") throw new RealmProtectionError("The environment is not valid.");
}

async function sealWith(realmId: string, binding: EnvelopeBinding, key: EnvelopeKey): Promise<string> {
  checkRealm(realmId);
  return sealSecret(realmId, key, binding);
}
/** Opens an envelope; the result must still be a well-formed realm id. Every failure is the same error. */
async function openWith(envelope: string, binding: EnvelopeBinding, keys: readonly EnvelopeKey[]): Promise<string> {
  let realm: string;
  try { realm = await openSecret(envelope, keys, binding); } catch { throw new RealmProtectionError("The stored QuickBooks company id could not be opened."); }
  if (!REALM_ID_SHAPE.test(realm)) throw new RealmProtectionError("The stored QuickBooks company id could not be opened.");
  return realm;
}

export async function sealRealm(realmId: string, environment: QboEnvironment, companyId: string, key: EnvelopeKey): Promise<string> {
  checkEnvironment(environment);
  return sealWith(realmId, realmBinding(companyId, environment), key);
}
export async function openRealm(envelope: string, environment: QboEnvironment, companyId: string, keys: readonly EnvelopeKey[]): Promise<string> {
  checkEnvironment(environment);
  return openWith(envelope, realmBinding(companyId, environment), keys);
}
export const sealParkedRealm = (realmId: string, handoffHash: string, key: EnvelopeKey): Promise<string> => sealWith(realmId, oauthRealmBinding(handoffHash), key);
export const openParkedRealm = (envelope: string, handoffHash: string, keys: readonly EnvelopeKey[]): Promise<string> => openWith(envelope, oauthRealmBinding(handoffHash), keys);

/** The keyed equality index of (environment, realm). Same inputs and key: same index; nothing about the realm is recoverable without the key. */
export async function realmIndex(realmId: string, environment: QboEnvironment, indexKey: EnvelopeKey): Promise<string> {
  checkRealm(realmId);
  checkEnvironment(environment);
  if (!KEY_ID.test(indexKey.id) || indexKey.bytes.length !== 32) throw new RealmProtectionError("The index key is not valid.");
  const k = await crypto.subtle.importKey("raw", indexKey.bytes as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const parts = ["qbo-realm-index-v1", indexKey.id, environment, realmId];
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(parts.map((p) => `${p.length}:${p}`).join("|")) as unknown as BufferSource));
  return `h1.${indexKey.id}.${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface ProtectedRealm { envelope: string; index: string }

/** Seals a realm for a stored row, proves the envelope opens back to it with the key ring, and computes its index. */
export async function protectRealm(realmId: string, environment: QboEnvironment, companyId: string, keys: RealmKeys): Promise<ProtectedRealm> {
  const envelope = await sealRealm(realmId, environment, companyId, keys.current);
  if ((await openRealm(envelope, environment, companyId, keys.all)) !== realmId) throw new RealmProtectionError("Round trip failed.");
  return { envelope, index: await realmIndex(realmId, environment, keys.index) };
}

/**
 * What the OAuth callback parks: the realm sealed to the handoff, and its index for BOTH environments — the callback does not know the
 * attempt's environment until the database consumes the state, and consuming and parking are one database step, so the database keeps the
 * one that matches the state's environment and discards the other.
 */
export async function protectParkedRealm(realmId: string, handoffHash: string, keys: RealmKeys): Promise<{ envelope: string; indexSandbox: string; indexProduction: string }> {
  const envelope = await sealParkedRealm(realmId, handoffHash, keys.current);
  if ((await openParkedRealm(envelope, handoffHash, keys.all)) !== realmId) throw new RealmProtectionError("Round trip failed.");
  return { envelope, indexSandbox: await realmIndex(realmId, "sandbox", keys.index), indexProduction: await realmIndex(realmId, "production", keys.index) };
}

/** The realm columns of a stored row (a connection or a disconnect operation): plaintext while it exists, and the protection. */
export interface StoredRealm {
  company_id: string;
  environment: QboEnvironment;
  realm_id: string | null;
  realm_envelope: string | null;
  realm_index: string | null;
}
export type RealmResolution =
  | { ok: true; realmId: string; protected: boolean }
  | { ok: false; reason: "unprotected" | "unreadable" | "mismatch" };

/**
 * The realm of a stored row, read by OPENING its envelope. The envelope must open for the row's own workspace and environment; where the
 * plaintext still exists (before the cutover) it must equal what opened; the stored index must equal the index recomputed with the index key
 * it names (the current one, or during an index-key rotation the retiring one; an index naming no configured key is a mismatch). A row without an envelope resolves to its plaintext only when `allowPlaintext` (the dual-write phase, before the backfill has
 * reached it); otherwise it is refused. Nothing here says WHICH realm a failure concerned.
 */
export async function resolveStoredRealm(row: StoredRealm, keys: RealmKeys, opts: { allowPlaintext: boolean }): Promise<RealmResolution> {
  if (row.realm_envelope === null || row.realm_envelope === undefined) {
    if (opts.allowPlaintext && typeof row.realm_id === "string" && REALM_ID_SHAPE.test(row.realm_id)) return { ok: true, realmId: row.realm_id, protected: false };
    return { ok: false, reason: "unprotected" };
  }
  let opened: string;
  try { opened = await openRealm(row.realm_envelope, row.environment, row.company_id, keys.all); } catch { return { ok: false, reason: "unreadable" }; }
  if (row.realm_id !== null && row.realm_id !== undefined && row.realm_id !== opened) return { ok: false, reason: "mismatch" };
  // The stored index must be the one its own (named) index key makes for what opened: the current key, or the retiring one during a rotation.
  const indexKey = row.realm_index === null || row.realm_index === undefined ? null : indexKeyFor(row.realm_index, keys);
  if (indexKey === null || row.realm_index !== await realmIndex(opened, row.environment, indexKey)) return { ok: false, reason: "mismatch" };
  return { ok: true, realmId: opened, protected: true };
}

/** The arguments of qbo_protect_connection_realm / qbo_protect_disconnect_realm for one existing row (plaintext still present). */
export interface ProtectArgs { p_connection: string; p_realm_id: string; p_realm_envelope: string; p_realm_index: string }

/**
 * What the backfill submits for one existing row whose plaintext still exists. The envelope is verified to open back to the plaintext BEFORE
 * it is submitted; the database refuses unless the plaintext equals the row's current realm_id (it cannot verify the envelope: it never holds
 * a key), never overwrites a protected row and never touches a terminal connection.
 */
export async function protectExistingRealm(row: StoredRealm & { id: string }, keys: RealmKeys): Promise<ProtectArgs> {
  if (typeof row.realm_id !== "string") throw new RealmProtectionError("There is no QuickBooks company id to protect.");
  const p = await protectRealm(row.realm_id, row.environment, row.company_id, keys);
  return { p_connection: row.id, p_realm_id: row.realm_id, p_realm_envelope: p.envelope, p_realm_index: p.index };
}

/** The database's answers to a protect call that leave the row protected with exactly the submitted index. */
export const PROTECTED_OUTCOMES: ReadonlySet<string> = new Set(["protected", "already_protected"]);

/**
 * The realm of a live connection for an operation that is about to write (an import): opened from the envelope; a connection the backfill has
 * not reached yet (no envelope, plaintext present) is protected FIRST through `submit` (the service-only qbo_protect_connection_realm), so the
 * operation's own writes carry the protection too. `submit` absent (after the cutover) means an unprotected row is refused.
 */
export async function realmForOperation(row: StoredRealm & { id: string }, keys: RealmKeys, submit: ((args: ProtectArgs) => Promise<string>) | null): Promise<RealmResolution> {
  if (row.realm_envelope) return resolveStoredRealm(row, keys, { allowPlaintext: false });
  if (!submit || typeof row.realm_id !== "string" || !REALM_ID_SHAPE.test(row.realm_id)) return { ok: false, reason: "unprotected" };
  let args: ProtectArgs;
  try { args = await protectExistingRealm(row, keys); } catch { return { ok: false, reason: "unreadable" }; }
  let outcome: string;
  try { outcome = await submit(args); } catch { return { ok: false, reason: "unprotected" }; }
  return PROTECTED_OUTCOMES.has(outcome) ? { ok: true, realmId: row.realm_id, protected: true } : { ok: false, reason: "mismatch" };
}
