// _shared/commercial/termsVersion.ts — the SERVER's authority for which Terms of Service version a checkout accepts.
//
// The browser sends the version its customer ticked (src/lib/commercial/purchaseTerms.ts TERMS_VERSION mirrors this constant;
// src/lib/commercial/__tests__/termsAcceptance.test.ts pins the two to each other and to the SHA-256 of the rendered policy
// texts). The server never records the client's string: a checkout is refused before any commercial write unless the client's
// version EQUALS this constant, and the intent then records THIS constant (acquire_checkout_attempt p_terms_version,
// 20261229100000). Changing the policy texts changes the hash, so an old page cannot accept the new terms.
//
// Format: <publication date>.<first 12 hex of SHA-256 over the canonical policy text>. Pure: no I/O, no Deno APIs (imported
// by Vitest as well as by the Edge Functions).
export const CURRENT_TERMS_VERSION = "2026-11-13.ff1cd08560f3";

export type TermsVersionCheck =
  | { ok: true; termsVersion: string }
  | { ok: false; error: "TERMS_VERSION_REQUIRED" | "TERMS_VERSION_NOT_CURRENT"; status: 400 | 409; currentTermsVersion: string };

/**
 * Validates the `termsVersion` field of a create-checkout request body. A missing, empty or non-string value is
 * TERMS_VERSION_REQUIRED (400); any string other than CURRENT_TERMS_VERSION — an older page, a forged value, a case or
 * whitespace variant — is TERMS_VERSION_NOT_CURRENT (409). Both are answered before the function touches the database.
 */
export function checkTermsVersion(body: unknown): TermsVersionCheck {
  const raw = body && typeof body === "object" ? (body as { termsVersion?: unknown }).termsVersion : undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "TERMS_VERSION_REQUIRED", status: 400, currentTermsVersion: CURRENT_TERMS_VERSION };
  }
  if (raw !== CURRENT_TERMS_VERSION) {
    return { ok: false, error: "TERMS_VERSION_NOT_CURRENT", status: 409, currentTermsVersion: CURRENT_TERMS_VERSION };
  }
  return { ok: true, termsVersion: CURRENT_TERMS_VERSION };
}
