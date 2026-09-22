// First-party browser attestation — the SECOND, independent leg of the anonymous enquiry challenge boundary.
//
// Why it exists: Cloudflare Turnstile is a third party on the critical path of the only public entry point this product has.
// When a visitor's network cannot reach challenges.cloudflare.com (corporate filtering, an ISP block, a provider incident) the
// widget renders "Unable to connect to website" and the enquiry can never be sent. That is an availability failure, and the
// correct engineering answer is a SECOND server-verified proof, not a weaker one.
//
// What it proves: this browser fetched a challenge minted by THIS server moments ago, and spent real CPU on it. The work is a
// SHA-256 partial pre-image (proof of work). It is not a human test — it is a cost floor that makes bulk automated submission
// expensive while a real visitor waits well under a second.
//
// Guarantees (each has a test):
//   * the browser can never mint a challenge: the payload is HMAC-signed with a server-only secret (ENQUIRY_ATTESTATION_SECRET);
//   * the signature is compared in constant time, so a wrong signature leaks nothing;
//   * an expired, future-dated, over-long-lived, under-worked or malformed attestation is REJECTED — never a pass;
//   * a missing secret makes this leg "unavailable" (not_configured), which is a refusal, exactly like the Turnstile leg;
//   * nothing here is trusted from the browser: the counter it supplies is re-hashed and re-checked server-side.
//
// Honest limitation: verification is stateless, so a single attestation could in principle be replayed until it expires
// (ATTESTATION_TTL_MS). Replay is bounded by that short window and is additionally constrained by the handler's rate-limit
// buckets and duplicate-submission prevention, which run on the same request. This is documented rather than hidden.

import type { ChallengeVerdict, ChallengeVerifier } from "./serviceEnquiryChallenge.ts";

export const ATTESTATION_PREFIX = "cfoclose1";
/** Leading zero bits required of the SHA-256 digest. 15 bits ≈ 32k hashes: fractions of a second in a browser, costly in bulk. */
export const ATTESTATION_BITS = 15;
/** How long a minted challenge may be used for. Short enough to bound replay, long enough for a slow device to solve it. */
export const ATTESTATION_TTL_MS = 120_000;
export const ENV_ATTESTATION_SECRET = "ENQUIRY_ATTESTATION_SECRET";
const MIN_SECRET_LENGTH = 32;
const MAX_COUNTER_DIGITS = 12;

export interface IssuedAttestation {
  /** `cfoclose1.<nonce>.<expiresAt>.<bits>.<signature>` — opaque to the browser, which may only append its counter. */
  readonly challenge: string;
  readonly bits: number;
  readonly expiresAt: number;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Digest-prefix test shared by the issuer's own tests and the verifier. `bits` leading zero bits, most significant first. */
export function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
  if (!Number.isInteger(bits) || bits < 0 || bits > digest.length * 8) return false;
  const wholeBytes = bits >> 3;
  for (let i = 0; i < wholeBytes; i += 1) if (digest[i] !== 0) return false;
  const remainder = bits & 7;
  if (remainder === 0) return true;
  return (digest[wholeBytes] >> (8 - remainder)) === 0;
}

/** Constant-time comparison of two equal-purpose hex strings. Length difference is reported without an early character exit. */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

export function readAttestationSecret(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const secret = raw.trim();
  return secret.length >= MIN_SECRET_LENGTH && !/\s/.test(secret) ? secret : null;
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(`cfoclose:enquiry-attestation:v1:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

export function attestationPayload(input: { nonce: string; expiresAt: number; bits: number }): string {
  return `${ATTESTATION_PREFIX}.${input.nonce}.${input.expiresAt}.${input.bits}`;
}

/** Mints a challenge. The browser receives it verbatim and cannot alter any field without invalidating the signature. */
export async function issueAttestation(
  secret: string,
  options: { nowMs?: number; ttlMs?: number; bits?: number; randomBytes?: (n: number) => Uint8Array } = {},
): Promise<IssuedAttestation> {
  const now = options.nowMs ?? Date.now();
  const ttl = options.ttlMs ?? ATTESTATION_TTL_MS;
  const bits = options.bits ?? ATTESTATION_BITS;
  const random = options.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const expiresAt = now + ttl;
  const payload = attestationPayload({ nonce: toBase64Url(random(16)), expiresAt, bits });
  return { challenge: `${payload}.${await signPayload(secret, payload)}`, bits, expiresAt };
}

/** True when the submitted token belongs to this leg. Routing never depends on guessing a provider from a failure. */
export function isAttestationToken(token: string | null): boolean {
  return typeof token === "string" && token.startsWith(`${ATTESTATION_PREFIX}.`);
}

export async function verifyAttestation(
  secret: string,
  token: string | null,
  options: { nowMs?: number; requiredBits?: number; maxTtlMs?: number } = {},
): Promise<ChallengeVerdict> {
  if (typeof token !== "string" || token === "") return { kind: "rejected", reason: "missing" };
  const now = options.nowMs ?? Date.now();
  const requiredBits = options.requiredBits ?? ATTESTATION_BITS;
  const maxTtl = options.maxTtlMs ?? ATTESTATION_TTL_MS;

  const parts = token.split(".");
  if (parts.length !== 6) return { kind: "rejected", reason: "invalid" };
  const [prefix, nonce, expiresRaw, bitsRaw, signature, counter] = parts;
  if (prefix !== ATTESTATION_PREFIX) return { kind: "rejected", reason: "invalid" };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { kind: "rejected", reason: "invalid" };
  if (!/^[0-9]{10,16}$/.test(expiresRaw) || !/^[0-9]{1,3}$/.test(bitsRaw)) return { kind: "rejected", reason: "invalid" };
  if (!/^[0-9a-f]{64}$/.test(signature) || !new RegExp(`^[0-9]{1,${MAX_COUNTER_DIGITS}}$`).test(counter)) return { kind: "rejected", reason: "invalid" };

  const expiresAt = Number(expiresRaw);
  const bits = Number(bitsRaw);
  if (bits !== requiredBits) return { kind: "rejected", reason: "invalid" }; // a self-chosen easier difficulty is not our challenge
  if (expiresAt <= now) return { kind: "rejected", reason: "expired_or_replayed" };
  if (expiresAt - now > maxTtl) return { kind: "rejected", reason: "invalid" }; // a far-future expiry cannot have come from us

  const payload = attestationPayload({ nonce, expiresAt, bits });
  if (!timingSafeEqual(await signPayload(secret, payload), signature)) return { kind: "rejected", reason: "invalid" };

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${payload}:${counter}`)));
  if (!hasLeadingZeroBits(digest, bits)) return { kind: "rejected", reason: "invalid" };
  return { kind: "passed" };
}

export function createAttestationVerifier(secret: string, options: { nowMs?: () => number; requiredBits?: number; maxTtlMs?: number } = {}): ChallengeVerifier {
  return {
    provider: "first_party_attestation",
    verify: (token) => verifyAttestation(secret, token, { nowMs: (options.nowMs ?? Date.now)(), requiredBits: options.requiredBits, maxTtlMs: options.maxTtlMs }),
  };
}

/**
 * Routes each submitted token to the leg that minted it. Neither leg can be weakened by the other: a first-party token is
 * never checked by Turnstile's rules and vice versa, and an unconfigured leg refuses (it never falls through to a pass).
 */
export function createDualLegVerifier(turnstile: ChallengeVerifier, attestation: ChallengeVerifier): ChallengeVerifier {
  return {
    provider: `${turnstile.provider}+${attestation.provider}`,
    verify: (token) => (isAttestationToken(token) ? attestation.verify(token) : turnstile.verify(token)),
  };
}
