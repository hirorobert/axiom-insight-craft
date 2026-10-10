/**
 * Provider-neutral contracts for the Edge Function payment layer.
 * Mirrors src/lib/commercial/payments/paymentTypes.ts for Deno.
 *
 * Two providers are implemented (providers/polar.ts, providers/snippe.ts). Every other identifier remains only so
 * historical payment rows stay readable; nothing can select, call or verify against them.
 */

export type PaymentProvider = 'FLUTTERWAVE' | 'PESAPAL' | 'SELCOM' | 'DPO' | 'STRIPE' | 'SNIPPE' | 'POLAR';

export type NormalizedStatus =
  | 'CHECKOUT_CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED'
  | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'EXPIRED' | 'UNKNOWN';

/** The only outcomes that close a checkout intent (commit_verified_commercial_payment refuses every other). */
export const FINAL_STATUSES: readonly NormalizedStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'];

export type VerificationMethod = 'PROVIDER_API_VERIFY' | 'WEBHOOK_ONLY' | 'MANUAL_ADMIN';

/** A refund or chargeback the provider reports against a verified payment. */
export interface ProviderReversal {
  type: 'REFUND' | 'CHARGEBACK';
  providerEventId: string;
  amountMinor: bigint;
  currencyCode: string;
}

export interface NormalizedTransaction {
  provider: PaymentProvider;
  providerTransactionId: string;
  providerStatus: string;
  normalizedStatus: NormalizedStatus;
  amountMinor: bigint;
  currencyCode: string;
  saffReference: string | null;
  verifiedAt: string; // ISO timestamp
  verificationMethod: VerificationMethod;
  payloadHash: string;
  reversals: ProviderReversal[];
}

export interface CreateCheckoutParams {
  saffReference: string;
  intentId: string;
  billingCustomerId: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  planCode: string;
  planName: string;
  customerEmail: string;
  customerName: string | null;
  /** Where the customer returns to (our own status page). */
  redirectUrl: string;
  /** Mobile money only: the payer's number, 255XXXXXXXXX. Never stored by this system. */
  phoneNumber: string | null;
}

export type CreateCheckoutResult =
  | { success: true; checkoutUrl: string; providerRef: string }
  | {
      success: false;
      outcome: 'DEFINITIVE_FAILURE' | 'UNCERTAIN';
      error: string;
    };

/** What the server knows about an intent when it asks the provider for the truth. */
export interface CheckoutReference {
  saffReference: string;
  providerCheckoutRef: string | null;
  billingCustomerId: string;
}

/** Processing results a verification can map to (payment_webhook_processing_events.processing_result). */
export type VerificationFailure =
  | 'NOT_FINAL' | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'REFERENCE_MISMATCH' | 'REFERENCE_MISSING'
  | 'MERCHANT_MISMATCH' | 'ACCOUNT_MISMATCH' | 'UNKNOWN_PROVIDER_STATUS' | 'VERIFICATION_FAILED';

export type VerifyTransactionResult =
  | { verified: true; transaction: NormalizedTransaction }
  | { verified: false; reason: string; result: VerificationFailure };

export type WebhookAuthResult =
  | { authentic: true }
  | { authentic: false; reason: 'INVALID_SIGNATURE' | 'STALE_TIMESTAMP' };

/** What a webhook delivery claims, before any verification. Nothing in it is trusted. */
export interface WebhookClaim {
  providerEventId: string | null;
  eventType: string;
  /** The provider object to look up (Polar checkout id, Snippe payment reference); null when the event is irrelevant. */
  providerCheckoutRef: string | null;
  /** Polar refund events name an order, not a checkout: the adapter resolves it. */
  providerOrderId: string | null;
  saffReference: string | null;
}

export interface ProviderAdapter {
  provider: PaymentProvider;
  environment: 'sandbox' | 'production';
  createCheckout(params: CreateCheckoutParams): Promise<CreateCheckoutResult>;
  /**
   * Gate B: independently reads the provider's own record of this exact checkout and reports a FINAL outcome only when
   * reference, account, merchant, currency and amount all match what the server expects. Never trusts a webhook body.
   */
  verifyTransactionByReference(ref: CheckoutReference, expectedMinor: bigint, expectedCurrency: string): Promise<VerifyTransactionResult>;
  /** Gate A: the delivery is signed with this deployment's webhook secret, and fresh. */
  verifyWebhookAuthenticity(rawBody: string, headers: Headers, nowSeconds: number): Promise<WebhookAuthResult>;
  parseWebhook(rawBody: string): WebhookClaim;
  /** Polar refund events: the checkout an order belongs to (null when it cannot be read). */
  checkoutRefForOrder?(orderId: string): Promise<string | null>;
}
