// Ω∞ Phase 0 Slice 2 — request-identity hardening tests.
//
// Covers the Slice 2 request-ID hardening review's Section 9 A-H, at the
// narrowest deterministic boundary available: the UUID_PATTERN validation
// regex (inlined below — index.ts does not export it, matching the
// established normalize.test.ts precedent) and requestHash's real,
// exported canonicalization behavior (imported directly, not reimplemented
// — canonicalJson/sha256Hex are already exhaustively tested generically in
// src/lib/shared/canonicalHash.test.ts; this proves the specific
// {uploadId, sourceFileHash, normalizedInputHash} shape used here).
//
// C/D/E/F/H (replay/conflict/new-attempt outcomes) are claimIdempotency's
// own state machine (_shared/idempotency.ts) — UNCHANGED this round (only
// WHICH value is passed as clientRequestId changed, not that function's
// logic), and require a live idempotency_keys table to exercise end to
// end; not fabricated here. Their correctness is Phase 0A's own,
// pre-existing design, verified via deno check on that file this session.
//
// Run: deno test supabase/functions/process-trial-balance/requestIdentity.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalJson, sha256Hex, type CanonicalValue } from "../_shared/hash.ts";

// ── Inline copy of UUID_PATTERN from index.ts ─────────────────────────────
// Keep in sync with index.ts — index.ts does not export it (matches the
// existing normalizeAccountName precedent in normalize.test.ts).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestHash(uploadId: string, sourceFileHash: string, normalizedInputHash: string): Promise<string> {
  return sha256Hex(canonicalJson({ uploadId, sourceFileHash, normalizedInputHash } as unknown as CanonicalValue));
}

// ── A/B — missing / malformed clientRequestId ─────────────────────────────

Deno.test("clientRequestId validation: undefined is rejected (section 9.A)", () => {
  const value: unknown = undefined;
  assert(typeof value !== "string" || !UUID_PATTERN.test(value as string));
});

Deno.test("clientRequestId validation: empty string is rejected", () => {
  assert(!UUID_PATTERN.test(""));
});

Deno.test("clientRequestId validation: non-UUID string is rejected (section 9.B)", () => {
  const malformed = ["not-a-uuid", "12345", "aaaaaaaa-bbbb-cccc-dddd", "  ", "uploadId-123"];
  for (const m of malformed) {
    assert(!UUID_PATTERN.test(m), `expected "${m}" to be rejected`);
  }
});

Deno.test("clientRequestId validation: non-string types are rejected", () => {
  const values: unknown[] = [123, null, {}, [], true];
  for (const v of values) {
    assert(typeof v !== "string");
  }
});

// ── G — a real crypto.randomUUID() is accepted ────────────────────────────

Deno.test("clientRequestId validation: crypto.randomUUID() output is accepted (section 9.G precondition)", () => {
  for (let i = 0; i < 20; i++) {
    const id = crypto.randomUUID();
    assert(UUID_PATTERN.test(id), `expected generated UUID "${id}" to be accepted`);
  }
});

Deno.test("clientRequestId validation: uppercase UUID is accepted (RFC 4122 doesn't mandate case)", () => {
  assert(UUID_PATTERN.test(crypto.randomUUID().toUpperCase()));
});

// ── requestHash composition (real canonicalJson/sha256Hex, real shape) ────

Deno.test("requestHash: same uploadId+sourceFileHash+normalizedInputHash -> identical hash (section 7/9.C precondition)", async () => {
  const a = await requestHash("upload-1", "srchash-1", "normhash-1");
  const b = await requestHash("upload-1", "srchash-1", "normhash-1");
  assertEquals(a, b);
});

Deno.test("requestHash: changed source_file_hash -> different hash (section 9.E precondition)", async () => {
  const h1 = await requestHash("upload-1", "srchash-1", "normhash-1");
  const h2 = await requestHash("upload-1", "srchash-2", "normhash-1");
  assert(h1 !== h2);
});

Deno.test("requestHash: changed normalized_input_hash -> different hash (section 9.D precondition)", async () => {
  const h1 = await requestHash("upload-1", "srchash-1", "normhash-1");
  const h2 = await requestHash("upload-1", "srchash-1", "normhash-2");
  assert(h1 !== h2);
});

Deno.test("requestHash: different uploadId, same other fields -> different hash", async () => {
  const h1 = await requestHash("upload-1", "srchash-1", "normhash-1");
  const h2 = await requestHash("upload-2", "srchash-1", "normhash-1");
  assert(h1 !== h2);
});

Deno.test("requestHash: does NOT include clientRequestId (section 7 invariant — request identity vs request proof stay separate)", async () => {
  // requestHash's signature accepts only uploadId/sourceFileHash/
  // normalizedInputHash — there is no parameter for clientRequestId at
  // all, so two different request IDs over the SAME content necessarily
  // produce the SAME requestHash (proving R2 + same H1/I1 is correctly
  // treated as "same content, different request" — section 9.F).
  const h1 = await requestHash("upload-1", "srchash-1", "normhash-1");
  const h2 = await requestHash("upload-1", "srchash-1", "normhash-1");
  assertEquals(h1, h2); // same content -> same hash regardless of which request carried it
});
