/**
 * Webhook authenticity (Gate A) for the two implemented providers. Pure Web Crypto: runs unchanged in Deno and in the
 * Vitest suite (src/lib/commercial/payments/__tests__/providerAdapters.test.ts).
 *
 *   Snippe   HMAC-SHA256 over `${X-Webhook-Timestamp}.${raw body}` with the signing key, hex, in X-Webhook-Signature.
 *   Polar    Standard Webhooks: HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${raw body}` with the base64 key
 *            after `whsec_`; webhook-signature carries one or more space-separated `v1,<base64>` entries.
 *
 * Both reject a timestamp more than TOLERANCE_SECONDS from now (either direction) — a replayed capture is refused even
 * with a valid signature. Comparison is constant-time over equal-length byte strings. Secrets are never logged.
 */

export const TOLERANCE_SECONDS = 300;
const enc = new TextEncoder();

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  // A copy backed by a plain ArrayBuffer (Web Crypto's BufferSource excludes SharedArrayBuffer-backed views).
  const raw = new Uint8Array(new ArrayBuffer(key.byteLength));
  raw.set(key);
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function fresh(timestamp: string | null, nowSeconds: number): boolean {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(nowSeconds - Number(timestamp)) <= TOLERANCE_SECONDS;
}

export type SignatureVerdict = { authentic: true } | { authentic: false; reason: 'INVALID_SIGNATURE' | 'STALE_TIMESTAMP' };

export async function verifySnippeSignature(rawBody: string, headers: Headers, secret: string, nowSeconds: number): Promise<SignatureVerdict> {
  const timestamp = headers.get('x-webhook-timestamp');
  const signature = (headers.get('x-webhook-signature') ?? '').trim().toLowerCase();
  if (!secret || !/^[0-9a-f]{64}$/.test(signature) || !timestamp) return { authentic: false, reason: 'INVALID_SIGNATURE' };
  const expected = toHex(await hmacSha256(enc.encode(secret), `${timestamp}.${rawBody}`));
  if (!constantTimeEqual(enc.encode(expected), enc.encode(signature))) return { authentic: false, reason: 'INVALID_SIGNATURE' };
  return fresh(timestamp, nowSeconds) ? { authentic: true } : { authentic: false, reason: 'STALE_TIMESTAMP' };
}

export async function verifyStandardWebhook(rawBody: string, headers: Headers, secret: string, nowSeconds: number): Promise<SignatureVerdict> {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const header = headers.get('webhook-signature') ?? '';
  const key = secret.startsWith('whsec_') ? fromBase64(secret.slice('whsec_'.length)) : null;
  if (!key || key.length < 16 || !id || !timestamp || !header) return { authentic: false, reason: 'INVALID_SIGNATURE' };
  const expected = await hmacSha256(key, `${id}.${timestamp}.${rawBody}`);
  const matches = header.split(' ').some((entry) => {
    const [version, sig] = entry.split(',', 2);
    const bytes = version === 'v1' && sig ? fromBase64(sig) : null;
    return bytes !== null && constantTimeEqual(bytes, expected);
  });
  if (!matches) return { authentic: false, reason: 'INVALID_SIGNATURE' };
  return fresh(timestamp, nowSeconds) ? { authentic: true } : { authentic: false, reason: 'STALE_TIMESTAMP' };
}
