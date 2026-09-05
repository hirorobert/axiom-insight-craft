/**
 * Ω2 — Provider-neutral contracts for Edge Function payment layer.
 * Mirrors src/lib/commercial/payments/paymentTypes.ts for Deno.
 */

export type PaymentProvider = 'FLUTTERWAVE' | 'PESAPAL' | 'SELCOM' | 'DPO' | 'STRIPE';

export type NormalizedStatus =
  | 'CHECKOUT_CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED'
  | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'EXPIRED' | 'UNKNOWN';

export type VerificationMethod = 'PROVIDER_API_VERIFY' | 'WEBHOOK_ONLY' | 'MANUAL_ADMIN';

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
}

export type CreateCheckoutResult =
  | { success: true; checkoutUrl: string; providerRef: string }
  | { success: false; error: string };

export type VerifyTransactionResult =
  | { verified: true; transaction: NormalizedTransaction }
  | { verified: false; reason: string };

export type WebhookAuthResult =
  | { authentic: true }
  | { authentic: false; reason: string };

export interface NormalizedWebhookEvent {
  providerEventId: string | null;
  providerTransactionId: string | null;
  saffReference: string | null;
  providerStatus: string;
  normalizedStatus: NormalizedStatus;
  amountMinor: bigint | null;
  currencyCode: string | null;
}

export interface ProviderAdapter {
  provider: PaymentProvider;
  createCheckout(params: CreateCheckoutParams): Promise<CreateCheckoutResult>;
  verifyTransaction(txId: string, expectedMinor: bigint, expectedCurrency: string, saffRef: string): Promise<VerifyTransactionResult>;
  verifyWebhookAuthenticity(rawBody: string, headers: Record<string, string>): WebhookAuthResult;
  normalizeWebhook(rawBody: string): NormalizedWebhookEvent;
}
