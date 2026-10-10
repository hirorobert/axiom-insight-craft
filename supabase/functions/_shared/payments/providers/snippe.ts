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
 * not. When the status response carries an amount, metadata or reference, each must match.
 *
 * Sources (read 2026-10-10): https://docs.snippe.sh/docs/2026-01-25/payments,
 * .../payments/mobile-money, .../webhooks, .../authentication
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
    }, { timeoutMs: 15_000, attempts });

  async function createCheckout(p: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    if (p.currencyCode !== 'TZS' || p.currencyExponent !== 0) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'SNIPPE_CURRENCY_NOT_SUPPORTED' };
    if (p.amountMinor < SNIPPE_MIN_TZS) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'SNIPPE_AMOUNT_BELOW_MINIMUM' };
    const phone = normaliseTzMobile(p.phoneNumber);
    if (!phone) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'SNIPPE_PHONE_INVALID' };
    if (p.saffReference.length > 30) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'IDEMPOTENCY_KEY_TOO_LONG' };
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
    if (reference !== null && reference !== ref.providerCheckoutRef) return { verified: false, reason: 'another payment', result: 'REFERENCE_MISMATCH' };
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
    return {
      verified: true,
      transaction: {
        provider: 'SNIPPE', providerTransactionId: ref.providerCheckoutRef, providerStatus: status, normalizedStatus: normalized,
        // The amount was bound at creation (the create response must equal the offer); a status answer that carries an
        // amount has been checked above.
        amountMinor: amount?.value ?? expectedMinor, currencyCode: amount?.currency ?? expectedCurrency,
        saffReference: ref.saffReference, verifiedAt: new Date().toISOString(), verificationMethod: 'PROVIDER_API_VERIFY',
        payloadHash: await sha256Hex(JSON.stringify(d)), reversals: [],
      },
    };
  }

  function parseWebhook(rawBody: string): WebhookClaim {
    let body: Json = {};
    try { body = obj(JSON.parse(rawBody)); } catch { /* unparseable: nothing claimed */ }
    const type = str(body.type) ?? 'unknown';
    const data = obj(body.data);
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
