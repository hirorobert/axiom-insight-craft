/**
 * Snippe adapter — Tanzania mobile money (M-Pesa, Airtel Money, Mixx by Yas, Halotel), TZS only.
 *
 * Checkout: POST /v1/payments (payment_type "mobile") — the customer approves a USSD prompt on their own phone; no card
 * or PIN ever reaches this system. The request carries the server's offer amount, the intent's saff_reference in
 * metadata, and Idempotency-Key = saff_reference (≤ 30 characters), so the one bounded retry can never create a second
 * payment. The payment reference Snippe returns is bound to the intent at creation; the response's amount and currency
 * must equal the offer, otherwise the attempt is treated as uncertain and never handed to the customer.
 * The customer waits on our own status page, which is the "checkout URL" persisted for this route.
 *
 * Verification (Gate B): GET /v1/payments/<reference> — completed / failed / voided / expired are final; pending is
 * not. The documented status answer carries reference, status and amount (not metadata): the reference must be present
 * and equal, and a COMPLETED payment must report its amount and currency, equal to the offer — an amount is never
 * assumed from the offer. Metadata, when present, must name this order and account.
 *
 * Documented provider behaviour this adapter relies on (re-read 2026-10-11, API version 2026-01-25):
 *   - Authorization: Bearer <API key, prefix snp_>; TZS only; integer amounts in the smallest unit; minimum 500 TZS;
 *   - phone 255XXXXXXXXX or +255XXXXXXXXX (normalised to the former);
 *   - Idempotency-Key at most 30 characters (a longer one is answered 500 PAY_001), valid 24 hours; the same key with
 *     the same body returns the cached response; with a different body 422. A 409 (conflict) or 422 on creation may
 *     mean a payment already exists under this key, so both are UNCERTAIN here, never "nothing was created";
 *   - webhooks: X-Webhook-Signature = hex HMAC-SHA256 over "<X-Webhook-Timestamp>.<raw body>" with the account's
 *     signing key (prefix whsec_, used as-is); 2xx within 30 seconds; retries at 0, 3, 6, 12, 24 minutes, then
 *     abandoned; duplicates possible (deduplicated by event id). The 2026-01-01 flat format names the event in "event";
 *   - no sandbox host, no test-mode marker on a payment, no refund API and no refund event are documented: the
 *     environment is this deployment's configuration only, and a refund made in Snippe's dashboard is not reported
 *     here (docs/release/SNIPPE_TZ_READINESS.md).
 *
 * Sources: https://docs.snippe.sh/docs/2026-01-25/payments, .../payments/mobile-money, .../webhooks,
 * .../authentication, .../error-handling
 */
import type {
  CheckoutReference, CreateCheckoutParams, CreateCheckoutResult, NormalizedStatus, ProviderAdapter,
  VerifyTransactionResult, WebhookClaim,
} from '../contracts.ts';
import { requestJson, sha256Hex, type FetchLike } from '../http.ts';
import { verifySnippeSignature } from '../webhookSignature.ts';

export interface SnippeConfig {
  environment: 'sandbox' | 'production';
  apiKey: string;
  webhookSecret: string;
  webhookUrl: string;
  apiBase: string;
}

export const SNIPPE_API_BASE = 'https://api.snippe.sh';
export const SNIPPE_MIN_TZS = 500n;
/** The documented Idempotency-Key limit. */
export const SNIPPE_IDEMPOTENCY_KEY_MAX = 30;
/** Each outbound attempt's timeout: two status attempts stay inside the 30 seconds Snippe allows a webhook answer. */
export const SNIPPE_TIMEOUT_MS = 10_000;
/** Tanzanian mobile number in the provider's documented form, 255XXXXXXXXX. */
export const TZ_MOBILE = /^255[67]\d{8}$/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const amountOf = (v: unknown): { value: bigint; currency: string } | null => {
  const a = obj(v);
  return typeof a.value === 'number' && Number.isSafeInteger(a.value) && typeof a.currency === 'string'
    ? { value: BigInt(a.value), currency: a.currency.toUpperCase() } : null;
};

const STATUS: Record<string, NormalizedStatus> = { completed: 'SUCCEEDED', failed: 'FAILED', voided: 'CANCELLED', expired: 'EXPIRED' };

/** Normalises what a person types into 255XXXXXXXXX, or null. */
export function normaliseTzMobile(input: string | null | undefined): string | null {
  const digits = String(input ?? '').replace(/[\s()+-]/g, '');
  const n = digits.startsWith('0') && digits.length === 10 ? `255${digits.slice(1)}` : digits;
  return TZ_MOBILE.test(n) ? n : null;
}

function names(customerName: string | null, email: string): { firstname: string; lastname: string } {
  const parts = (customerName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
  const single = parts[0] ?? email.split('@')[0] ?? 'Customer';
  return { firstname: single, lastname: single };
}

export function createSnippeAdapter(cfg: SnippeConfig, fetchImpl: FetchLike = fetch): ProviderAdapter {
  const call = (path: string, init: RequestInit, extraHeaders: Record<string, string> = {}, attempts = 2) =>
    requestJson(fetchImpl, `${cfg.apiBase}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
    }, { timeoutMs: SNIPPE_TIMEOUT_MS, attempts });

  async function createCheckout(p: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    if (p.currencyCode !== 'TZS' || p.currencyExponent !== 0) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'SNIPPE_CURRENCY_NOT_SUPPORTED' };
    if (p.amountMinor < SNIPPE_MIN_TZS) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'SNIPPE_AMOUNT_BELOW_MINIMUM' };
    const phone = normaliseTzMobile(p.phoneNumber);
    if (!phone) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'SNIPPE_PHONE_INVALID' };
    if (p.saffReference.length > SNIPPE_IDEMPOTENCY_KEY_MAX) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'IDEMPOTENCY_KEY_TOO_LONG' };
    const r = await call('/v1/payments', {
      method: 'POST',
      body: JSON.stringify({
        payment_type: 'mobile',
        details: { amount: Number(p.amountMinor), currency: 'TZS' },
        phone_number: phone,
        customer: { ...names(p.customerName, p.customerEmail), email: p.customerEmail },
        webhook_url: cfg.webhookUrl,
        metadata: { saff_reference: p.saffReference, billing_customer_id: p.billingCustomerId, plan_code: p.planCode },
      }),
    }, { 'Idempotency-Key': p.saffReference });
    if (!r.answered) return { success: false, outcome: 'UNCERTAIN', error: `SNIPPE_${r.error}` };
    // 409 / 422: a payment may already exist under this Idempotency-Key — never reported as "nothing was created".
    if (r.status === 409 || r.status === 422) return { success: false, outcome: 'UNCERTAIN', error: `SNIPPE_HTTP_${r.status}` };
    if (r.status >= 400 && r.status < 500) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: `SNIPPE_HTTP_${r.status}` };
    if (r.status >= 500) return { success: false, outcome: 'UNCERTAIN', error: `SNIPPE_HTTP_${r.status}` };
    const d = obj(obj(r.body).data);
    const reference = str(d.reference);
    const amount = amountOf(d.amount);
    if (!reference) return { success: false, outcome: 'UNCERTAIN', error: 'SNIPPE_RESPONSE_INCOMPLETE' };
    if (!amount || amount.value !== p.amountMinor || amount.currency !== 'TZS') return { success: false, outcome: 'UNCERTAIN', error: 'SNIPPE_PAYMENT_AMOUNT_MISMATCH' };
    return { success: true, checkoutUrl: p.redirectUrl, providerRef: reference };
  }

  async function verifyTransactionByReference(ref: CheckoutReference, expectedMinor: bigint, expectedCurrency: string): Promise<VerifyTransactionResult> {
    if (!ref.providerCheckoutRef) return { verified: false, reason: 'no provider reference', result: 'REFERENCE_MISSING' };
    const r = await call(`/v1/payments/${encodeURIComponent(ref.providerCheckoutRef)}`, { method: 'GET' });
    if (!r.answered || r.status !== 200) return { verified: false, reason: `status lookup ${r.answered ? r.status : r.error}`, result: 'VERIFICATION_FAILED' };
    const root = obj(r.body);
    const d = Object.keys(obj(root.data)).length ? obj(root.data) : root;
    const reference = str(d.reference);
    if (reference !== ref.providerCheckoutRef) return { verified: false, reason: reference ? 'another payment' : 'no reference in the answer', result: 'REFERENCE_MISMATCH' };
    const meta = obj(d.metadata);
    if (str(meta.saff_reference) !== null && str(meta.saff_reference) !== ref.saffReference) return { verified: false, reason: 'metadata names another order', result: 'REFERENCE_MISMATCH' };
    if (str(meta.billing_customer_id) !== null && str(meta.billing_customer_id) !== ref.billingCustomerId) return { verified: false, reason: 'another account', result: 'ACCOUNT_MISMATCH' };
    const amount = amountOf(d.amount);
    if (amount && amount.currency !== expectedCurrency) return { verified: false, reason: `currency ${amount.currency}`, result: 'CURRENCY_MISMATCH' };
    if (amount && amount.value !== expectedMinor) return { verified: false, reason: `amount ${amount.value}`, result: 'AMOUNT_MISMATCH' };
    const status = String(d.status ?? '').toLowerCase();
    const normalized = STATUS[status];
    if (!normalized) {
      return status === 'pending'
        ? { verified: false, reason: 'pending', result: 'NOT_FINAL' }
        : { verified: false, reason: `status ${status}`, result: 'UNKNOWN_PROVIDER_STATUS' };
    }
    // A completed payment grants a term: its amount must be the provider's own, never assumed from the offer.
    if (normalized === 'SUCCEEDED' && !amount) return { verified: false, reason: 'completed without an amount', result: 'AMOUNT_MISMATCH' };
    return {
      verified: true,
      transaction: {
        provider: 'SNIPPE', providerTransactionId: ref.providerCheckoutRef, providerStatus: status, normalizedStatus: normalized,
        // A completed payment's amount was checked above; a failed, voided or expired one grants nothing.
        amountMinor: amount?.value ?? expectedMinor, currencyCode: amount?.currency ?? expectedCurrency,
        saffReference: ref.saffReference, verifiedAt: new Date().toISOString(), verificationMethod: 'PROVIDER_API_VERIFY',
        payloadHash: await sha256Hex(JSON.stringify(d)), reversals: [],
      },
    };
  }

  function parseWebhook(rawBody: string): WebhookClaim {
    let body: Json = {};
    try { body = obj(JSON.parse(rawBody)); } catch { /* unparseable: nothing claimed */ }
    // API version 2026-01-25 names the event in "type" with the payment in "data"; the 2026-01-01 flat format names it in
    // "event". Either way the delivery only says which payment to read back.
    const type = str(body.type) ?? str(body.event) ?? 'unknown';
    const data = Object.keys(obj(body.data)).length ? obj(body.data) : body;
    return {
      providerEventId: str(body.id),
      eventType: type,
      providerCheckoutRef: type.startsWith('payment.') ? str(data.reference) : null,
      providerOrderId: null,
      saffReference: str(obj(data.metadata).saff_reference),
    };
  }

  return {
    provider: 'SNIPPE',
    environment: cfg.environment,
    createCheckout,
    verifyTransactionByReference,
    verifyWebhookAuthenticity: (rawBody, h, now) => verifySnippeSignature(rawBody, h, cfg.webhookSecret, now),
    parseWebhook,
  };
}
