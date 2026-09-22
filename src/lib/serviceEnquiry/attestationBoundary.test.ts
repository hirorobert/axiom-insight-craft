// The first-party attestation leg: a browser can never mint its own pass, every malformed/expired/under-worked/forged
// attestation is refused, an unconfigured secret refuses rather than passes, and each token is routed to the leg that minted it.

import { describe, expect, it, vi } from "vitest";
import {
  ATTESTATION_BITS,
  ATTESTATION_PREFIX,
  ATTESTATION_TTL_MS,
  attestationPayload,
  createAttestationVerifier,
  createDualLegVerifier,
  hasLeadingZeroBits,
  isAttestationToken,
  issueAttestation,
  readAttestationSecret,
  timingSafeEqual,
  verifyAttestation,
} from "../../../supabase/functions/_shared/enquiryAttestation";
import { createUnconfiguredVerifier, type ChallengeVerifier } from "../../../supabase/functions/_shared/serviceEnquiryChallenge";
import { ATTESTATION_MAX_BITS, hasLeadingZeroBits as clientHasLeadingZeroBits, parseIssuedChallenge, solveChallenge } from "./attestation";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

const SECRET = "a".repeat(64);
const TEST_BITS = 8; // keeps the tests fast; the production difficulty is asserted separately

async function solved(secret: string, bits = TEST_BITS, nowMs = Date.now()): Promise<string> {
  const issued = await issueAttestation(secret, { bits, nowMs });
  const token = await solveChallenge({ challenge: issued.challenge, bits }, 200_000);
  expect(token).not.toBeNull();
  return token as string;
}

describe("first-party attestation", () => {
  it("accepts a challenge this server signed and this browser solved", async () => {
    const now = Date.now();
    const token = await solved(SECRET, TEST_BITS, now);
    expect(await verifyAttestation(SECRET, token, { nowMs: now + 1_000, requiredBits: TEST_BITS })).toEqual({ kind: "passed" });
  });

  it("refuses a token signed with a different secret", async () => {
    const now = Date.now();
    const token = await solved(SECRET, TEST_BITS, now);
    expect(await verifyAttestation("b".repeat(64), token, { nowMs: now + 1_000, requiredBits: TEST_BITS })).toEqual({ kind: "rejected", reason: "invalid" });
  });

  it("refuses an unsolved challenge, a wrong counter and a self-lowered difficulty", async () => {
    const now = Date.now();
    const issued = await issueAttestation(SECRET, { bits: TEST_BITS, nowMs: now });
    const opts = { nowMs: now + 1_000, requiredBits: TEST_BITS };
    expect(await verifyAttestation(SECRET, issued.challenge, opts)).toEqual({ kind: "rejected", reason: "invalid" }); // no counter at all
    expect(await verifyAttestation(SECRET, `${issued.challenge}.1`, opts)).toEqual({ kind: "rejected", reason: "invalid" }); // work not done
    const easier = await solved(SECRET, 1, now);
    expect(await verifyAttestation(SECRET, easier, opts)).toEqual({ kind: "rejected", reason: "invalid" }); // difficulty is ours, not theirs
  });

  it("refuses a missing, malformed, expired or implausibly long-lived attestation", async () => {
    const now = Date.now();
    expect(await verifyAttestation(SECRET, null, { nowMs: now })).toEqual({ kind: "rejected", reason: "missing" });
    expect(await verifyAttestation(SECRET, "", { nowMs: now })).toEqual({ kind: "rejected", reason: "missing" });
    expect(await verifyAttestation(SECRET, "not-a-token", { nowMs: now })).toEqual({ kind: "rejected", reason: "invalid" });
    const token = await solved(SECRET, TEST_BITS, now);
    expect(await verifyAttestation(SECRET, token, { nowMs: now + ATTESTATION_TTL_MS + 1, requiredBits: TEST_BITS })).toEqual({ kind: "rejected", reason: "expired_or_replayed" });
    expect(await verifyAttestation(SECRET, token, { nowMs: now - ATTESTATION_TTL_MS, requiredBits: TEST_BITS })).toEqual({ kind: "rejected", reason: "invalid" });
  });

  it("never lets a browser choose the payload: an edited nonce or expiry breaks the signature", async () => {
    const now = Date.now();
    const token = await solved(SECRET, TEST_BITS, now);
    const parts = token.split(".");
    const tamperedExpiry = [parts[0], parts[1], String(Number(parts[2]) + 1_000), parts[3], parts[4], parts[5]].join(".");
    expect(await verifyAttestation(SECRET, tamperedExpiry, { nowMs: now + 1_000, requiredBits: TEST_BITS })).toEqual({ kind: "rejected", reason: "invalid" });
  });

  it("fails closed when the secret is absent or too weak", () => {
    expect(readAttestationSecret(undefined)).toBeNull();
    expect(readAttestationSecret("short")).toBeNull();
    expect(readAttestationSecret("with space ".repeat(8))).toBeNull();
    expect(readAttestationSecret(` ${SECRET} `)).toBe(SECRET);
  });

  it("routes each token to the leg that minted it and never falls through to a pass", async () => {
    const turnstile: ChallengeVerifier = { provider: "turnstile", verify: async () => ({ kind: "passed" }) };
    const dual = createDualLegVerifier(turnstile, createUnconfiguredVerifier("not_configured"));
    const now = Date.now();
    const token = await solved(SECRET, TEST_BITS, now);
    expect(isAttestationToken(token)).toBe(true);
    expect(isAttestationToken("turnstile-style-token")).toBe(false);
    // an unconfigured first-party leg refuses its own tokens instead of letting Turnstile's "passed" apply to them
    expect(await dual.verify(token)).toEqual({ kind: "unavailable", reason: "not_configured" });
    expect(await dual.verify("turnstile-style-token")).toEqual({ kind: "passed" });

    const configured = createDualLegVerifier({ provider: "turnstile", verify: async () => ({ kind: "rejected", reason: "invalid" }) }, createAttestationVerifier(SECRET, { requiredBits: TEST_BITS, nowMs: () => now + 1_000 }));
    expect(await configured.verify(token)).toEqual({ kind: "passed" });
  });

  it("agrees bit for bit between the browser's solver and the server's check", async () => {
    for (const bits of [0, 1, 7, 8, 9, 16]) {
      const digest = new Uint8Array([0, 0, 0b0000_0001, 255]);
      expect(clientHasLeadingZeroBits(digest, bits)).toBe(hasLeadingZeroBits(digest, bits));
    }
    expect(hasLeadingZeroBits(new Uint8Array([0, 0, 0]), 17)).toBe(true);
    expect(hasLeadingZeroBits(new Uint8Array([1, 0, 0]), 1)).toBe(false);
  });

  it("keeps the production difficulty and payload shape stable", async () => {
    expect(ATTESTATION_BITS).toBe(15);
    expect(ATTESTATION_BITS).toBeLessThanOrEqual(ATTESTATION_MAX_BITS);
    expect(attestationPayload({ nonce: "abcdefghijklmnop", expiresAt: 1_700_000_000_000, bits: 15 })).toBe(`${ATTESTATION_PREFIX}.abcdefghijklmnop.1700000000000.15`);
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("treats a malformed issue response as a failure, not as no protection", () => {
    expect(parseIssuedChallenge(null)).toBeNull();
    expect(parseIssuedChallenge({ ok: false, challenge: `${ATTESTATION_PREFIX}.a.b.c.d`, bits: 15 })).toBeNull();
    expect(parseIssuedChallenge({ ok: true, challenge: "other.a.b.c.d", bits: 15 })).toBeNull();
    expect(parseIssuedChallenge({ ok: true, challenge: `${ATTESTATION_PREFIX}.a.b.c.d`, bits: 99 })).toBeNull();
    expect(parseIssuedChallenge({ ok: true, challenge: `${ATTESTATION_PREFIX}.a.b.c.d`, bits: 15 })).toEqual({ challenge: `${ATTESTATION_PREFIX}.a.b.c.d`, bits: 15 });
  });

  it("gives up rather than inventing a solution when the work budget is exhausted", async () => {
    const issued = await issueAttestation(SECRET, { bits: 24 });
    expect(await solveChallenge({ challenge: issued.challenge, bits: 24 }, 5)).toBeNull();
  });
});
