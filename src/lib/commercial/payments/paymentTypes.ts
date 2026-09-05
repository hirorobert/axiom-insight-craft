/**
 * Ω2 — Provider-neutral payment domain types.
 *
 * These discriminated unions represent SAFF's commercial state machine,
 * not any provider's state. Flutterwave, Pesapal, Selcom, etc. all map
 * their statuses into these canonical enums before any business logic runs.
 *
 * Iron Dome: never collapse these into booleans.
 * FAILED != CANCELLED != EXPIRED != PENDING != UNKNOWN.
 */

// ── Canonical payment lifecycle status ──────────────────────────────────────

export const PAYMENT_STATUSES = [
  'CHECKOUT_CREATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'EXPIRED',
  'UNKNOWN',
] as const;
export type PaymentStatus = typeof PAYMENT_STATUSES[number];

// ── Provider identity ────────────────────────────────────────────────────────

export const PAYMENT_PROVIDERS = [
  'FLUTTERWAVE',
  'PESAPAL',
  'SELCOM',
  'DPO',
  'STRIPE',
] as const;
export type PaymentProvider = typeof PAYMENT_PROVIDERS[number];

// ── Verification method ──────────────────────────────────────────────────────

export type VerificationMethod =
  | 'PROVIDER_API_VERIFY'
  | 'WEBHOOK_ONLY'
  | 'MANUAL_ADMIN';

// ── Checkout intent (client-safe projection) ─────────────────────────────────

export interface CheckoutIntent {
  readonly id: string;
  readonly saffReference: string;
  readonly billingCustomerId: string;
  readonly planId: string;
  readonly provider: PaymentProvider;
  readonly expectedAmountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly status: 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt: string | null;
}

// ── Checkout result returned to browser (safe — no secrets, no raw provider data) ──

export interface CheckoutCreatedResult {
  readonly saffReference: string;
  readonly checkoutUrl: string;
  readonly expiresAt: string;
  readonly provider: PaymentProvider;
}

// ── Normalised provider transaction (after Flutterwave API verify call) ──────

export interface NormalizedTransaction {
  readonly provider: PaymentProvider;
  readonly providerTransactionId: string;
  readonly providerStatus: string;       // raw provider value
  readonly normalizedStatus: PaymentStatus;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly saffReference: string | null;
  readonly providerReference: string | null;
  readonly verifiedAt: Date;
  readonly verificationMethod: VerificationMethod;
  readonly payloadHash: string;
}

// ── Webhook verification result ──────────────────────────────────────────────

export type WebhookAuthenticityResult =
  | { authentic: true }
  | { authentic: false; reason: string };

export type WebhookVerificationResult =
  | { verified: true; transaction: NormalizedTransaction }
  | { verified: false; reason: string; receiptResult?: WebhookReceiptResult };

export interface WebhookReceiptResult {
  readonly signaturePresent: boolean;
  readonly signatureValid: boolean;
  readonly payloadHash: string;
  readonly providerEventId: string | null;
  readonly saffReference: string | null;
  readonly processingResult: string;
}

// ── Atomic commit result (from commit_verified_commercial_payment RPC) ───────

export type CommitResult =
  | {
      committed: true;
      status: 'COMMITTED';
      eventId: string;
      licenceId: string;
      periodStart: string;
      periodEnd: string;
    }
  | {
      committed: false;
      status:
        | 'ALREADY_COMMITTED'
        | 'INTENT_ALREADY_RESOLVED'
        | 'INTENT_EXPIRED'
        | 'NON_SUCCESS_RECORDED';
      eventId?: string;
      normalizedStatus?: PaymentStatus;
    };

// ── Payment status for return page / billing summary ─────────────────────────

export type PaymentReturnState =
  | { phase: 'PROCESSING'; message: string }
  | { phase: 'CONFIRMED'; planCode: string; periodEnd: string }
  | { phase: 'FAILED'; message: string }
  | { phase: 'CANCELLED'; message: string }
  | { phase: 'UNKNOWN'; message: string };

// ── Provider interface — the contract every adapter must implement ─────────────

export interface PaymentProviderAdapter {
  readonly provider: PaymentProvider;

  /**
   * Create a hosted checkout session. Returns a URL to redirect the user.
   * Never receives price/currency from browser — all derived from SAFF plan.
   */
  createCheckout(params: CreateCheckoutParams): Promise<CreateCheckoutResult>;

  /**
   * GATE B: Independently verify a transaction with the provider's API.
   * Called after webhook receipt. Must succeed before any commercial value is granted.
   */
  verifyTransaction(params: VerifyTransactionParams): Promise<VerifyTransactionResult>;

  /**
   * GATE A: Verify the webhook's authenticity (signature, timestamp, etc.).
   * Returns false immediately if the signature is invalid or missing.
   */
  verifyWebhookAuthenticity(
    rawBody: string,
    headers: Record<string, string>,
  ): WebhookAuthenticityResult;

  /**
   * Parse raw webhook body into provider-neutral event metadata.
   * Only called AFTER Gate A passes.
   */
  normalizeWebhook(rawBody: string): NormalizedWebhookEvent;
}

export interface CreateCheckoutParams {
  saffReference: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  planName: string;
  customerEmail: string;
  customerName: string | null;
  redirectUrl: string;
  metadata: Record<string, string>;
}

export type CreateCheckoutResult =
  | { success: true; checkoutUrl: string; providerRef: string }
  | { success: false; error: string };

export interface VerifyTransactionParams {
  providerTransactionId: string;
  expectedAmountMinor: bigint;
  expectedCurrencyCode: string;
  saffReference: string;
}

export type VerifyTransactionResult =
  | { verified: true; transaction: NormalizedTransaction }
  | { verified: false; reason: string };

export interface NormalizedWebhookEvent {
  providerEventId: string | null;
  providerTransactionId: string | null;
  saffReference: string | null;
  providerStatus: string;
  normalizedStatus: PaymentStatus;
  amountMinor: bigint | null;
  currencyCode: string | null;
}
