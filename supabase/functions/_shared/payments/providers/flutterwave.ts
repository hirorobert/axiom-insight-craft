/**
 * Ω2 — Flutterwave provider adapter.
 *
 * Iron Dome rules:
 *  - FLUTTERWAVE_SECRET_KEY never leaves this module. Never logged.
 *  - FLUTTERWAVE_WEBHOOK_SECRET never logged.
 *  - Checkout URL returned to browser contains no secrets.
 *  - Browser-returned ?status=successful is NEVER trusted (GATE B always runs).
 *  - Amount comparison is bigint === bigint, never float.
 *
 * API base: https://api.flutterwave.com/v3
 *   POST /payments           → Standard Hosted payment page (redirect flow)
 *   GET  /transactions/{id}/verify → Server-side verification
 *
 * Webhook authentication: Flutterwave sends a `verif-hash` header containing
 * the value of FLUTTERWAVE_WEBHOOK_SECRET verbatim. We do a constant-time
 * string comparison.
 *
 * Environment variables required:
 *   FLUTTERWAVE_SECRET_KEY      — API key (sk_live_... or sk_test_...)
 *   FLUTTERWAVE_WEBHOOK_SECRET  — Webhook hash (set in Flutterwave dashboard)
 *   FLUTTERWAVE_ENVIRONMENT     — "sandbox" | "production"
 */

import { moneyFromProviderDecimal, formatMinorForProvider } from '../money.ts';
import { sha256Hex } from '../authority.ts';
import type {
  ProviderAdapter, CreateCheckoutParams, CreateCheckoutResult,
  VerifyTransactionResult, WebhookAuthResult, NormalizedWebhookEvent,
  NormalizedTransaction, NormalizedStatus,
} from '../contracts.ts';

const FLW_BASE_URL = 'https://api.flutterwave.com/v3';

// ── Status normalisation ────────────────────────────────────────────────────

const FLW_STATUS_MAP: Record<string, NormalizedStatus> = {
  successful:  'SUCCEEDED',
  success:     'SUCCEEDED',
  pending:     'PENDING',
  failed:      'FAILED',
  error:       'FAILED',
  cancelled:   'CANCELLED',
  refunded:    'REFUNDED',
  partial:     'PARTIALLY_REFUNDED',
};

function normalizeFlwStatus(raw: string): NormalizedStatus {
  return FLW_STATUS_MAP[raw?.toLowerCase()] ?? 'UNKNOWN';
}

// ── Adapter implementation ──────────────────────────────────────────────────

export class FlutterwaveAdapter implements ProviderAdapter {
  readonly provider = 'FLUTTERWAVE' as const;

  private readonly secretKey: string;
  private readonly webhookSecret: string;

  constructor() {
    const key = Deno.env.get('FLUTTERWAVE_SECRET_KEY');
    const webhookSecret = Deno.env.get('FLUTTERWAVE_WEBHOOK_SECRET');
    if (!key || !webhookSecret) {
      throw new Error(
        'Iron Dome: FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_SECRET are required. ' +
        'Set them in Supabase Edge Function secrets.'
      );
    }
    this.secretKey = key;
    this.webhookSecret = webhookSecret;
  }

  /** GATE A: Webhook authenticity via verif-hash header */
  verifyWebhookAuthenticity(rawBody: string, headers: Record<string, string>): WebhookAuthResult {
    const receivedHash = headers['verif-hash'] ?? headers['Verif-Hash'] ?? '';
    if (!receivedHash) {
      return { authentic: false, reason: 'MISSING_VERIF_HASH_HEADER' };
    }
    // Constant-time comparison to prevent timing attacks
    const expected = this.webhookSecret;
    if (receivedHash.length !== expected.length) {
      return { authentic: false, reason: 'INVALID_HASH_LENGTH' };
    }
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) {
      mismatch |= receivedHash.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (mismatch !== 0) {
      return { authentic: false, reason: 'HASH_MISMATCH' };
    }
    return { authentic: true };
  }

  /** Parse raw Flutterwave webhook body into neutral event */
  normalizeWebhook(rawBody: string): NormalizedWebhookEvent {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(rawBody); } catch {
      return {
        providerEventId: null, providerTransactionId: null,
        saffReference: null, providerStatus: 'PARSE_ERROR',
        normalizedStatus: 'UNKNOWN', amountMinor: null, currencyCode: null,
      };
    }

    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const txId = String(data.id ?? data.flw_ref ?? '');
    const txRef = String(data.tx_ref ?? '');
    const status = String(data.status ?? '');
    const rawCurrency = String(data.currency ?? '');
    const rawAmount = String(data.amount ?? '');

    const amountMinor = rawAmount && rawCurrency
      ? moneyFromProviderDecimal(rawAmount, rawCurrency)
      : null;

    return {
      providerEventId: txId || null,
      providerTransactionId: txId || null,
      saffReference: txRef || null,
      providerStatus: status,
      normalizedStatus: normalizeFlwStatus(status),
      amountMinor,
      currencyCode: rawCurrency || null,
    };
  }

  /** Create hosted payment page */
  async createCheckout(params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    const displayAmount = formatMinorForProvider(params.amountMinor, params.currencyExponent);

    // Payment methods are a provider EXECUTION detail (dimension G), never
    // global commercial identity — mobile money is offered only when the
    // transaction is actually in TZS, not unconditionally for every market
    // this adapter processes.
    const paymentOptions = params.currencyCode === 'TZS' ? 'card,mobilemoneytzania' : 'card';

    // Ω3-CHECKOUT branding correction: the prior revision sent 'SAFF ERP'
    // as the hosted-checkout page title — customer-visible legacy
    // branding on the live Flutterwave payment page — plus a `logo` URL
    // pointing at a favicon.ico that is not a real, approved raster
    // CFOClose asset (a dead/placeholder logo URL is worse than no logo
    // at all on a real payment page). Corrected: CFOClose title, no logo
    // field until an approved raster asset exists, and CFOClose-branded
    // description/meta.source. `saff_reference`/tx_ref/`SAFF-` reference
    // prefixes are UNCHANGED — those are internal historical identifiers
    // this schema and its evidence trail depend on, not customer-visible
    // branding, and renaming them would corrupt evidence, not improve it.
    const body = {
      tx_ref:        params.saffReference,
      amount:        displayAmount,
      currency:      params.currencyCode,
      redirect_url:  params.redirectUrl,
      payment_options: paymentOptions,
      customer: {
        email:       params.customerEmail,
        name:        params.customerName ?? params.customerEmail,
      },
      customizations: {
        title:       'CFOClose',
        description: `CFOClose subscription — ${params.planName}`,
      },
      meta: {
        saff_reference: params.saffReference,
        source:         'CFOCLOSE_OMEGA3',
      },
    };

    let resp: Response;
    try {
      resp = await fetch(`${FLW_BASE_URL}/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.secretKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { success: false, error: `Network error contacting Flutterwave: ${String(err)}` };
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => 'no body');
      return { success: false, error: `Flutterwave API error ${resp.status}: ${text.slice(0, 200)}` };
    }

    let json: Record<string, unknown>;
    try { json = await resp.json(); } catch {
      return { success: false, error: 'Flutterwave returned non-JSON response' };
    }

    const link = (json.data as Record<string, unknown>)?.link;
    if (!link || typeof link !== 'string') {
      return { success: false, error: 'Flutterwave did not return payment link' };
    }

    return { success: true, checkoutUrl: link, providerRef: params.saffReference };
  }

  /**
   * Shared Gate-B corroboration logic, extracted so verifyTransaction
   * (lookup by provider transaction id) and verifyTransactionByReference
   * (lookup by SAFF's own tx_ref — Ω3-CHECKOUT BLOCKER fix, see contracts.ts)
   * apply IDENTICAL independent-verification discipline regardless of which
   * Flutterwave endpoint produced the raw response. Never weakened for
   * either caller.
   */
  private async validateVerifiedTransactionData(
    data: Record<string, unknown>,
    expectedMinor: bigint,
    expectedCurrency: string,
    saffRef: string,
    fallbackTransactionId = '',
  ): Promise<VerifyTransactionResult> {
    const rawStatus = String(data.status ?? '');
    const normalizedStatus = normalizeFlwStatus(rawStatus);
    const rawCurrency = String(data.currency ?? '');
    const rawAmount = String(data.amount ?? '0');
    // NOTE: data.tx_ref may legitimately be absent/null/non-string on a
    // malformed or incomplete provider response — do not let String(undefined)
    // ("undefined") or String(null) ("null") masquerade as a real reference.
    const rawTxRefValue = data.tx_ref;
    const rawTxRef = typeof rawTxRefValue === 'string' ? rawTxRefValue.trim() : '';

    // ── Ω2-GR1 Gate B independent-reference-corroboration repair (BLOCKER-2) ──
    // The independently-fetched provider transaction MUST ITSELF carry the
    // reference that binds it to SAFF's checkout. A missing, empty, or
    // whitespace-only tx_ref is NEVER treated as "fine" — that would let a
    // provider response with no reference at all sail through unverified.
    // There is ALSO no fallback to SAFF's own locally-expected reference:
    // that would defeat the entire point of Gate B, which is independent
    // corroboration from the provider's own systems, not an echo of what
    // SAFF already believed before calling the provider.
    if (!rawTxRef) {
      return { verified: false, reason: `REFERENCE_MISSING: Flutterwave verify response had no tx_ref (expected ${saffRef})` };
    }
    if (rawTxRef !== saffRef) {
      return {
        verified: false,
        reason: `REFERENCE_MISMATCH: expected ${saffRef}, got ${rawTxRef}`,
      };
    }

    if (rawCurrency !== expectedCurrency) {
      return {
        verified: false,
        reason: `CURRENCY_MISMATCH: expected ${expectedCurrency}, got ${rawCurrency}`,
      };
    }

    // Amount verification — bigint comparison, exact decimal authority only
    const verifiedMinor = moneyFromProviderDecimal(rawAmount, rawCurrency);
    if (verifiedMinor === null) {
      return { verified: false, reason: `Cannot parse verified amount: ${rawAmount} ${rawCurrency}` };
    }

    if (verifiedMinor !== expectedMinor) {
      return {
        verified: false,
        reason: `AMOUNT_MISMATCH: expected ${expectedMinor} ${expectedCurrency}, got ${verifiedMinor} ${rawCurrency}`,
      };
    }

    // Ω∞ A+ closure BLOCKER-4 fix: the provider transaction id is
    // mandatory evidence, not optional metadata. `data.id` absent, null,
    // an empty/whitespace string, or a non-string/non-number type (an
    // object or array slipping through a malformed provider response)
    // must never fall through to producing verified:true with a blank or
    // synthetic id — that would let a genuinely-unverified transaction
    // masquerade as identified evidence, and a blank id would corrupt the
    // (provider, provider_transaction_id, checkout_intent_id) idempotency
    // identity two entirely different transactions could then collide on.
    const rawId = data.id;
    const candidateId =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId).trim()
        : (fallbackTransactionId ?? '').trim();
    if (!candidateId) {
      return { verified: false, reason: `PROVIDER_TRANSACTION_ID_MISSING: Flutterwave verify response had no usable id (expected ${saffRef})` };
    }

    const payloadHash = await sha256Hex(JSON.stringify(data));

    const transaction: NormalizedTransaction = {
      provider: 'FLUTTERWAVE',
      providerTransactionId: candidateId,
      providerStatus: rawStatus,
      normalizedStatus,
      amountMinor: verifiedMinor,
      currencyCode: rawCurrency,
      // rawTxRef is proven equal to saffRef above — never a fallback value.
      saffReference: rawTxRef,
      verifiedAt: new Date().toISOString(),
      verificationMethod: 'PROVIDER_API_VERIFY',
      payloadHash,
    };

    return { verified: true, transaction };
  }

  /** GATE B: Independent server-side transaction verification, by provider transaction id */
  async verifyTransaction(
    txId: string,
    expectedMinor: bigint,
    expectedCurrency: string,
    saffRef: string,
  ): Promise<VerifyTransactionResult> {
    let resp: Response;
    try {
      resp = await fetch(`${FLW_BASE_URL}/transactions/${encodeURIComponent(txId)}/verify`, {
        headers: { 'Authorization': `Bearer ${this.secretKey}` },
      });
    } catch (err) {
      return { verified: false, reason: `Network error verifying with Flutterwave: ${String(err)}` };
    }

    if (!resp.ok) {
      return { verified: false, reason: `Flutterwave verify API returned ${resp.status}` };
    }

    let json: Record<string, unknown>;
    try { json = await resp.json(); } catch {
      return { verified: false, reason: 'Flutterwave verify returned non-JSON' };
    }

    const data = (json.data ?? {}) as Record<string, unknown>;
    return this.validateVerifiedTransactionData(data, expectedMinor, expectedCurrency, saffRef, txId);
  }

  /**
   * GATE B, by reference (Ω3-CHECKOUT BLOCKER fix — webhook/status
   * convergence): independently verifies a transaction using ONLY SAFF's
   * own tx_ref, via Flutterwave's documented verify-by-reference endpoint.
   * commercial-payment-status uses this when a customer polls a still-
   * PENDING intent and no webhook has (yet, or ever) delivered the
   * provider transaction id — without this, a lost or delayed webhook
   * left a genuinely-paid customer stuck PENDING indefinitely, since
   * nothing else could ever independently confirm the charge.
   */
  async verifyTransactionByReference(
    saffRef: string,
    expectedMinor: bigint,
    expectedCurrency: string,
  ): Promise<VerifyTransactionResult> {
    let resp: Response;
    try {
      resp = await fetch(`${FLW_BASE_URL}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(saffRef)}`, {
        headers: { 'Authorization': `Bearer ${this.secretKey}` },
      });
    } catch (err) {
      return { verified: false, reason: `Network error verifying with Flutterwave: ${String(err)}` };
    }

    if (!resp.ok) {
      // A 404 here genuinely means "Flutterwave has no record of this
      // reference yet" — a normal, expected outcome while a customer is
      // still mid-checkout, not a hard error. Distinguished explicitly so
      // the caller (commercial-payment-status) can treat it as "still
      // pending" rather than a verification failure worth alarming on.
      if (resp.status === 404) {
        return { verified: false, reason: 'NOT_FOUND_YET' };
      }
      return { verified: false, reason: `Flutterwave verify_by_reference API returned ${resp.status}` };
    }

    let json: Record<string, unknown>;
    try { json = await resp.json(); } catch {
      return { verified: false, reason: 'Flutterwave verify_by_reference returned non-JSON' };
    }

    const data = (json.data ?? {}) as Record<string, unknown>;
    return this.validateVerifiedTransactionData(data, expectedMinor, expectedCurrency, saffRef);
  }
}

/** Singleton factory — reads env vars once */
let _adapter: FlutterwaveAdapter | null = null;
export function getFlutterwaveAdapter(): FlutterwaveAdapter {
  _adapter ??= new FlutterwaveAdapter();
  return _adapter;
}
