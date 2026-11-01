/**
 * qboTokenEnvelope — authenticated encryption for third-party tokens at rest (plan §4.1).
 *
 * A QuickBooks refresh token is a long-lived key to a client's books (Intuit: 100-day rolling expiry, 5-year hard limit), so it
 * is never stored, logged or returned in clear text. AES-256-GCM through WebCrypto (available in Deno and Node 20+):
 *
 *   envelope = "v1.<keyId>.<iv>.<ciphertext+tag>"       (base64url, no padding)
 *
 *   · the key comes from a secret held by the Edge Function runtime, never from the database; a key id names it so keys can be
 *     rotated (new writes use the newest, old envelopes still open with the key they name);
 *   · the additional authenticated data (AAD) binds each envelope to its owner — workspace, connection and purpose — so a
 *     ciphertext copied to another row or purpose fails to open (a database reader cannot move a token between workspaces);
 *   · a fresh random 96-bit IV per encryption; any change to any part fails closed with a single, non-revealing error.
 *
 * Pure apart from the platform's random source. No storage, no network, no logging.
 */

const te = new TextEncoder();
const td = new TextDecoder();

export class TokenEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenEnvelopeError";
  }
}

export interface EnvelopeKey {
  /** Short public name for the key: [a-z0-9-], 1..32 characters. Stored inside the envelope. */
  id: string;
  /** Exactly 32 bytes. */
  bytes: Uint8Array;
}

export interface EnvelopeBinding {
  workspaceId: string;
  connectionId: string;
  /** What the secret is for, e.g. "qbo-refresh-token". */
  purpose: string;
}

const KEY_ID = /^[a-z0-9-]{1,32}$/;

/**
 * The binding of a connection's refresh token. The connection row's id is assigned by the database AFTER the token is sealed, so the binding
 * uses the identity that determines the one live connection (workspace + environment + QuickBooks company): a token sealed for one workspace,
 * environment or realm cannot be opened as another's.
 */
export function connectionBinding(companyId: string, realmId: string, environment: "production" | "sandbox"): EnvelopeBinding {
  return { workspaceId: companyId, connectionId: `${environment}:${realmId}`, purpose: "qbo-refresh-token" };
}

const b64u = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(text: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TokenEnvelopeError("The stored secret could not be opened.");
    const pad = "=".repeat((4 - (text.length % 4)) % 4);
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

function aad(b: EnvelopeBinding, keyId: string): Uint8Array {
  // Length-prefixed fields: no value can be shifted into its neighbour. The key id is bound too, so it cannot be relabelled.
  const parts = ["qbo-envelope-v1", keyId, b.workspaceId, b.connectionId, b.purpose];
  return te.encode(parts.map((p) => `${p.length}:${p}`).join("|"));
}

async function importKey(key: EnvelopeKey, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (!KEY_ID.test(key.id)) throw new TokenEnvelopeError("The key id is not valid.");
  if (key.bytes.length !== 32) throw new TokenEnvelopeError("The encryption key must be exactly 32 bytes.");
  return crypto.subtle.importKey("raw", key.bytes, { name: "AES-GCM" }, false, [usage]);
}

function checkBinding(b: EnvelopeBinding): void {
  for (const v of [b.workspaceId, b.connectionId, b.purpose]) {
    if (typeof v !== "string" || v === "") throw new TokenEnvelopeError("The binding (workspace, connection, purpose) is incomplete.");
  }
}

export async function sealSecret(plaintext: string, key: EnvelopeKey, binding: EnvelopeBinding): Promise<string> {
  if (typeof plaintext !== "string" || plaintext === "") throw new TokenEnvelopeError("There is no secret to seal.");
  checkBinding(binding);
  const k = await importKey(key, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(binding, key.id) }, k, te.encode(plaintext)));
  return ["v1", key.id, b64u.enc(iv), b64u.enc(ct)].join(".");
}

/** Opens an envelope with whichever of `keys` it names. Every failure is the same error: nothing says which part was wrong. */
export async function openSecret(envelope: string, keys: readonly EnvelopeKey[], binding: EnvelopeBinding): Promise<string> {
  const fail = () => new TokenEnvelopeError("The stored secret could not be opened.");
  checkBinding(binding);
  const parts = typeof envelope === "string" ? envelope.split(".") : [];
  if (parts.length !== 4 || parts[0] !== "v1" || !KEY_ID.test(parts[1])) throw fail();
  const key = keys.find((k) => k.id === parts[1]);
  if (!key) throw fail();
  try {
    const k = await importKey(key, "decrypt");
    const iv = b64u.dec(parts[2]);
    if (iv.length !== 12) throw fail();
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(binding, key.id) }, k, b64u.dec(parts[3]));
    return td.decode(pt);
  } catch {
    throw fail();
  }
}

/** Reads a key from a base64 secret (as an Edge Function secret would hold it). Refuses anything that is not exactly 32 bytes. */
export function keyFromBase64(id: string, base64: string): EnvelopeKey {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new TokenEnvelopeError("The encryption key is not valid base64.");
  }
  if (!KEY_ID.test(id)) throw new TokenEnvelopeError("The key id is not valid.");
  if (bytes.length !== 32) throw new TokenEnvelopeError("The encryption key must be exactly 32 bytes.");
  return { id, bytes };
}
