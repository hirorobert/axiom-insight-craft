// _shared/commercial/termsVersion.ts — the SERVER's authority for the checkout acknowledgement a purchase requires.
//
// Two things are acknowledged before a payment can start (commercial package §12.7, ETA s.30(5)(d)):
//   1. the Terms of Service version — the browser sends the version its customer ticked (src/lib/commercial/purchaseTerms.ts
//      TERMS_VERSION mirrors CURRENT_TERMS_VERSION; src/lib/commercial/__tests__/termsAcceptance.test.ts pins the two to each
//      other and to the SHA-256 of the rendered policy texts). The server never records the client's string: a checkout is
//      refused before any commercial write unless the client's version EQUALS this constant, and the intent then records THIS
//      constant. Changing the policy texts changes the hash, so an old page cannot accept the new terms.
//   2. the customer's consent to the plan starting as soon as the payment is confirmed (`immediateServiceConsent: true`),
//      recorded separately on the intent. Its wording is draft until counsel; the FLAG is technically determinate.
//
// Format of the version: <publication date>.<first 12 hex of SHA-256 over the canonical policy text>. Pure: no I/O, no Deno
// APIs (imported by Vitest as well as by the Edge Functions).
export const CURRENT_TERMS_VERSION = "2026-11-13.e9570ed37c46";

export type AcknowledgementCheck =
  | { ok: true; termsVersion: string; immediateServiceConsent?: true }
  | {
      ok: false;
      error: "TERMS_VERSION_REQUIRED" | "TERMS_VERSION_NOT_CURRENT" | "SERVICE_CONSENT_REQUIRED";
      status: 400 | 409;
      currentTermsVersion: string;
    };

/** The Terms-version half of the acknowledgement (kept separately so the refusal names the exact gap). */
export function checkTermsVersion(body: unknown): AcknowledgementCheck {
  const raw = body && typeof body === "object" ? (body as { termsVersion?: unknown }).termsVersion : undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "TERMS_VERSION_REQUIRED", status: 400, currentTermsVersion: CURRENT_TERMS_VERSION };
  }
  if (raw !== CURRENT_TERMS_VERSION) {
    return { ok: false, error: "TERMS_VERSION_NOT_CURRENT", status: 409, currentTermsVersion: CURRENT_TERMS_VERSION };
  }
  return { ok: true, termsVersion: CURRENT_TERMS_VERSION };
}

/**
 * Validates the whole acknowledgement of a create-checkout request body: the Terms version (above) AND
 * `immediateServiceConsent === true` (the boolean true only — not "true", not 1, not an object). Both are answered before
 * the function touches the database; nothing is written on refusal.
 */
export function checkCheckoutAcknowledgement(body: unknown): AcknowledgementCheck {
  const terms = checkTermsVersion(body);
  if (!terms.ok) return terms;
  const consent = body && typeof body === "object" ? (body as { immediateServiceConsent?: unknown }).immediateServiceConsent : undefined;
  if (consent !== true) {
    return { ok: false, error: "SERVICE_CONSENT_REQUIRED", status: 400, currentTermsVersion: CURRENT_TERMS_VERSION };
  }
  return { ok: true, termsVersion: terms.termsVersion, immediateServiceConsent: true };
}
