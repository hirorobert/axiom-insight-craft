/**
 * Polar adapter — merchant of record, card payments, USD, annual term sold as a one-time product.
 *
 * Checkout: POST /v1/checkouts/ for the plan's Polar product with an AD-HOC fixed price taken from the server's offer
 * (tax-exclusive, discount codes disabled), the account as external_customer_id, and saff_reference / billing customer
 * in metadata. The browser never names a price.
 *
 * Verification (Gate B) reads Polar, never the webhook body: GET /v1/orders?checkout_id=<id> for the order, else
 * GET /v1/checkouts/<id> for an unpaid outcome. A FINAL success requires the order to be paid, its checkout to be this
 * intent's checkout, its metadata to name this intent and account, its product to belong to the configured
 * organization, its currency to equal the offer's, and its net amount (after discounts, before tax) to equal the offer
 * exactly. Refunds on a paid order are reported as reversals; the payment itself stays SUCCEEDED.
 *
 * Sources (read 2026-10-10): https://polar.sh/docs/api-reference/checkouts/create-session.md,
 * .../orders/list.md, .../orders/get.md, .../checkouts/get-session.md, https://polar.sh/docs/integrate/webhooks/delivery.md
 */
import type {
  CheckoutReference, CreateCheckoutParams, CreateCheckoutResult, NormalizedTransaction, ProviderAdapter,
  VerifyTransactionResult, WebhookClaim,
} from '../contracts.ts';
import { requestJson, sha256Hex, type FetchLike } from '../http.ts';
import { verifyStandardWebhook } from '../webhookSignature.ts';

export interface PolarConfig {
  environment: 'sandbox' | 'production';
  accessToken: string;
  webhookSecret: string;
  organizationId: string;
  /** Plan code → Polar product id. */
  productIds: Readonly<Record<string, string>>;
  apiBase: string;
}

export const POLAR_API_BASE = { sandbox: 'https://sandbox-api.polar.sh', production: 'https://api.polar.sh' } as const;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): bigint | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);

/**
 * Polar's answer to a refused request, reduced to what is safe to record. Provider text is untrusted, and only the
 * provider's RESPONSE body is read here (never the request body, headers, token or customer):
 *   code   — Polar's `error` name (or a 422 item's `type`), kept only when it is a plain identifier: letters, digits,
 *            `_` and `.`, at most 64 characters. Never free text, so it may be persisted with the failure reason.
 *   detail — for the function LOG only: Polar's `detail` message with URLs, emails, UUIDs, credential-like tokens, long
 *            opaque strings and runs of 4+ digits replaced by [redacted], every character outside a plain-text set
 *            dropped, capped at 200 characters. For a 422, only each item's `type` and `loc` path (at most 5 items).
 */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const LOC_PART = /^[A-Za-z0-9_]{1,40}$/;

export function redactProviderText(raw: string): string | null {
  const s = raw.slice(0, 1000)
    .replace(/https?:\/\/\S+/gi, '[redacted]')
    .replace(/[^\s@]+@[^\s@]+/g, '[redacted]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[redacted]')
    .replace(/\b(?:polar|whsec|snp|sk|pk)_[A-Za-z0-9_\-+/=]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, '[redacted]')
    .replace(/\d{4,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 .,:;'()_\-[\]]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 200);
  return s.length > 0 ? s : null;
}

export function sanitizePolarError(body: unknown): { code: string | null; detail: string | null } {
  const b = obj(body);
  if (Array.isArray(b.detail)) {
    const items = (b.detail as unknown[]).slice(0, 5).map((item) => {
      const o = obj(item);
      const type = typeof o.type === 'string' && ERROR_CODE.test(o.type) ? o.type : 'unknown';
      const loc = Array.isArray(o.loc)
        ? (o.loc as unknown[]).slice(0, 6).map((p) => (typeof p === 'number' && Number.isSafeInteger(p) ? String(p) : typeof p === 'string' && LOC_PART.test(p) ? p : '?')).join('.')
        : '?';
      return `${type}@${loc}`;
    });
    const first = obj((b.detail as unknown[])[0]).type;
    return { code: typeof first === 'string' && ERROR_CODE.test(first) ? first : null, detail: items.length > 0 ? items.join('; ') : null };
  }
  return {
    code: typeof b.error === 'string' && ERROR_CODE.test(b.error) ? b.error : null,
    detail: typeof b.detail === 'string' ? redactProviderText(b.detail) : null,
  };
}

export function createPolarAdapter(cfg: PolarConfig, fetchImpl: FetchLike = fetch): ProviderAdapter {
  const headers = { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const call = (path: string, init: RequestInit, attempts = 2) =>
    requestJson(fetchImpl, `${cfg.apiBase}${path}`, { ...init, headers }, { timeoutMs: 15_000, attempts });

  async function createCheckout(p: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    const productId = cfg.productIds[p.planCode];
    if (!productId) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'POLAR_PRODUCT_NOT_CONFIGURED' };
    if (p.currencyCode !== 'USD' || p.currencyExponent !== 2) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'POLAR_CURRENCY_NOT_SUPPORTED' };
    const amount = Number(p.amountMinor);
    if (!Number.isSafeInteger(amount) || amount <= 0) return { success: false, outcome: 'DEFINITIVE_FAILURE', error: 'INVALID_AMOUNT' };
    // An orphaned session (created, never handed to anyone) cannot be paid — so one bounded retry is safe.
    const r = await call('/v1/checkouts/', {
      method: 'POST',
      body: JSON.stringify({
        products: [productId],
        prices: { [productId]: [{ amount_type: 'fixed', price_amount: amount, price_currency: 'usd', tax_behavior: 'exclusive' }] },
        currency: 'usd',
        external_customer_id: p.billingCustomerId,
        customer_email: p.customerEmail,
        ...(p.customerName ? { customer_name: p.customerName } : {}),
        allow_discount_codes: false,
        allow_trial: false,
        success_url: p.redirectUrl,
        // Polar's "back" link: leaving without paying returns to the plans page (Resume / Choose another plan), never to
        // the payment status page, which can only wait for a payment that is not coming.
        return_url: p.cancelUrl ?? p.redirectUrl,
        metadata: { saff_reference: p.saffReference, intent_id: p.intentId, billing_customer_id: p.billingCustomerId, plan_code: p.planCode },
      }),
    });
    if (!r.answered) return { success: false, outcome: 'UNCERTAIN', error: `POLAR_${r.error}` };
    if (r.status >= 400 && r.status < 500) {
      // Polar's refusal, sanitised: its error code joins the recorded reason; its redacted message goes to the log only.
      const { code, detail } = sanitizePolarError(r.body);
      return { success: false, outcome: 'DEFINITIVE_FAILURE', error: code ? `POLAR_HTTP_${r.status}:${code}` : `POLAR_HTTP_${r.status}`, ...(detail ? { providerDiagnostic: detail } : {}) };
    }
    if (r.status >= 500) return { success: false, outcome: 'UNCERTAIN', error: `POLAR_HTTP_${r.status}` };
    const b = obj(r.body);
    const id = str(b.id), url = str(b.url);
    // https always; plain http only for a sandbox adapter pointed at a loopback mock (local tests — routing.ts refuses an
    // API override for production), and then only to a loopback page.
    const loopbackMock = cfg.environment === 'sandbox' && cfg.apiBase !== POLAR_API_BASE.sandbox && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url ?? '');
    if (!id || !url || !(/^https:\/\//.test(url) || loopbackMock)) return { success: false, outcome: 'UNCERTAIN', error: 'POLAR_RESPONSE_INCOMPLETE' };
    // The session must carry exactly the server's economics before it is handed to the customer.
    if (int(b.net_amount) !== null && int(b.net_amount) !== p.amountMinor) return { success: false, outcome: 'UNCERTAIN', error: 'POLAR_SESSION_AMOUNT_MISMATCH' };
    return { success: true, checkoutUrl: url, providerRef: id };
  }

  async function verifyTransactionByReference(ref: CheckoutReference, expectedMinor: bigint, expectedCurrency: string): Promise<VerifyTransactionResult> {
    if (!ref.providerCheckoutRef) return { verified: false, reason: 'no provider checkout', result: 'REFERENCE_MISSING' };
    const checkoutId = encodeURIComponent(ref.providerCheckoutRef);
    const orders = await call(`/v1/orders/?checkout_id=${checkoutId}&limit=10`, { method: 'GET' }, 2);
    if (!orders.answered || orders.status !== 200) return { verified: false, reason: `orders lookup ${orders.answered ? orders.status : orders.error}`, result: 'VERIFICATION_FAILED' };
    const items = Array.isArray(obj(orders.body).items) ? (obj(orders.body).items as unknown[]).map(obj) : [];
    const paid = items.filter((o) => o.paid === true || ['paid', 'refunded', 'partially_refunded'].includes(String(o.status)));
    if (paid.length > 1) return { verified: false, reason: 'more than one paid order for one checkout', result: 'VERIFICATION_FAILED' };

    if (paid.length === 1) {
      const o = paid[0];
      const meta = obj(o.metadata);
      const orderCheckout = str(o.checkout_id);
      if (orderCheckout !== ref.providerCheckoutRef) return { verified: false, reason: 'order belongs to another checkout', result: 'REFERENCE_MISMATCH' };
      if (str(meta.saff_reference) !== ref.saffReference) return { verified: false, reason: 'order metadata names another order', result: 'REFERENCE_MISMATCH' };
      const external = str(obj(o.customer).external_id);
      if (str(meta.billing_customer_id) !== ref.billingCustomerId || (external !== null && external !== ref.billingCustomerId)) {
        return { verified: false, reason: 'order belongs to another account', result: 'ACCOUNT_MISMATCH' };
      }
      const org = str(obj(o.product).organization_id) ?? str(obj(o.customer).organization_id);
      if (org !== cfg.organizationId) return { verified: false, reason: 'order is not this merchant\'s', result: 'MERCHANT_MISMATCH' };
      const currency = (str(o.currency) ?? '').toUpperCase();
      if (currency !== expectedCurrency) return { verified: false, reason: `currency ${currency}`, result: 'CURRENCY_MISMATCH' };
      const net = int(o.net_amount);
      if (net === null || net !== expectedMinor) return { verified: false, reason: `net amount ${net}`, result: 'AMOUNT_MISMATCH' };
      const orderId = str(o.id);
      if (!orderId) return { verified: false, reason: 'order without id', result: 'VERIFICATION_FAILED' };

      const reversals: NormalizedTransaction['reversals'] = [];
      const refunded = int(o.refunded_amount) ?? 0n;
      if (refunded > 0n) {
        // One reversal per distinct refunded total: the id changes when the refunded amount grows.
        reversals.push({ type: 'REFUND', providerEventId: `${orderId}:refunded:${refunded}`, amountMinor: refunded, currencyCode: currency });
      }
      return {
        verified: true,
        transaction: {
          provider: 'POLAR', providerTransactionId: orderId, providerStatus: String(o.status), normalizedStatus: 'SUCCEEDED',
          amountMinor: net, currencyCode: currency, saffReference: ref.saffReference, verifiedAt: new Date().toISOString(),
          verificationMethod: 'PROVIDER_API_VERIFY', payloadHash: await sha256Hex(JSON.stringify(o)), reversals,
        },
      };
    }

    // No paid order: the checkout's own state decides whether the attempt is over.
    const co = await call(`/v1/checkouts/${checkoutId}`, { method: 'GET' }, 2);
    if (!co.answered || co.status !== 200) return { verified: false, reason: `checkout lookup ${co.answered ? co.status : co.error}`, result: 'VERIFICATION_FAILED' };
    const c = obj(co.body);
    if (str(c.id) !== ref.providerCheckoutRef || str(obj(c.metadata).saff_reference) !== ref.saffReference) {
      return { verified: false, reason: 'checkout does not belong to this order', result: 'REFERENCE_MISMATCH' };
    }
    const status = String(c.status);
    const final = status === 'expired' ? 'EXPIRED' : status === 'failed' ? 'FAILED' : null;
    if (!final) {
      return ['open', 'confirmed', 'succeeded'].includes(status)
        ? { verified: false, reason: `checkout ${status}`, result: 'NOT_FINAL' }
        : { verified: false, reason: `checkout ${status}`, result: 'UNKNOWN_PROVIDER_STATUS' };
    }
    return {
      verified: true,
      transaction: {
        provider: 'POLAR', providerTransactionId: `${ref.providerCheckoutRef}:${status}`, providerStatus: status, normalizedStatus: final,
        amountMinor: expectedMinor, currencyCode: expectedCurrency, saffReference: ref.saffReference, verifiedAt: new Date().toISOString(),
        verificationMethod: 'PROVIDER_API_VERIFY', payloadHash: await sha256Hex(JSON.stringify(c)), reversals: [],
      },
    };
  }

  function parseWebhook(rawBody: string): WebhookClaim {
    let body: Json = {};
    try { body = obj(JSON.parse(rawBody)); } catch { /* unparseable: nothing claimed */ }
    const type = str(body.type) ?? 'unknown';
    const data = obj(body.data);
    const isCheckout = type.startsWith('checkout.');
    const isOrder = type.startsWith('order.');
    const isRefund = type.startsWith('refund.');
    return {
      providerEventId: null,   // Standard Webhooks carry the id in the webhook-id header, read by the endpoint.
      eventType: type,
      providerCheckoutRef: isCheckout ? str(data.id) : isOrder ? str(data.checkout_id) : null,
      providerOrderId: isRefund ? str(data.order_id) : null,
      saffReference: str(obj(data.metadata).saff_reference),
    };
  }

  async function describeCheckout(ref: CheckoutReference) {
    if (!ref.providerCheckoutRef) return null;
    const co = await call(`/v1/checkouts/${encodeURIComponent(ref.providerCheckoutRef)}`, { method: 'GET' }, 2);
    if (!co.answered || co.status !== 200) return null;
    const c = obj(co.body);
    if (str(c.id) !== ref.providerCheckoutRef || str(obj(c.metadata).saff_reference) !== ref.saffReference) return null;
    const status = str(c.status);
    if (!status) return null;
    return { status, expiresAt: str(c.expires_at), url: str(c.url) };
  }

  async function checkoutRefForOrder(orderId: string): Promise<string | null> {
    const r = await call(`/v1/orders/${encodeURIComponent(orderId)}`, { method: 'GET' }, 2);
    return r.answered && r.status === 200 ? str(obj(r.body).checkout_id) : null;
  }

  return {
    provider: 'POLAR',
    environment: cfg.environment,
    createCheckout,
    verifyTransactionByReference,
    verifyWebhookAuthenticity: (rawBody, h, now) => verifyStandardWebhook(rawBody, h, cfg.webhookSecret, now),
    parseWebhook,
    checkoutRefForOrder,
    describeCheckout,
  };
}
