/**
 * Provider routing abstraction (provider-neutral).
 *
 * Provider routing is downstream of commercial offer resolution. It never
 * encodes a fixed rule like "TZS => provider X" as permanent business truth
 * — that would collapse dimension F (payment provider) into dimension C/E
 * (market/currency), which the commercial model forbids. Instead, each
 * configured provider declares its own capabilities, and
 * selectPaymentProvider() picks the first eligible one for a given offer.
 *
 * ── FLUTTERWAVE DECOMMISSION ────────────────────────────────────────────────
 * Flutterwave has been retired as an active payment provider. Its adapter,
 * capabilities, credential reads and environment resolution are removed from
 * this deployment entirely. NO provider is configured, so
 * getConfiguredProviders() returns an empty list and every checkout attempt
 * fails closed with PAYMENT_PROVIDER_UNAVAILABLE — there is deliberately no
 * fallback, no fake checkout, and no partially-wired provider left behind.
 *
 * 'FLUTTERWAVE' remains a legal value of PaymentProvider ONLY so historical
 * payment_events / payment_checkout_intents / webhook receipt rows recorded
 * under that provider stay readable for accounting and audit. Nothing in this
 * file can select it, call it, or verify against it.
 *
 * Adding a future provider is: write its adapter, add its capabilities to
 * getConfiguredProviders(), done — no change to this file's selection logic,
 * no change to commercial_offers, checkout intent semantics, payment_events,
 * licence schema, or the entitlement resolver.
 */

import type { PaymentProvider } from './contracts.ts';

export interface PaymentProviderCapabilities {
  provider: PaymentProvider;
  supportedCurrencies: readonly string[];
  supportedMarkets: readonly string[];
  supportedMethods: readonly string[];
  environment: 'sandbox' | 'production';
}

export interface OfferRoutingInput {
  currencyCode: string;
  marketCode: string;
  /** NULL unless a human has intentionally restricted this specific offer to one provider. */
  providerRestriction: string | null;
}

export type ProviderSelectionResult =
  | { selected: true; provider: PaymentProvider; environment: 'sandbox' | 'production' }
  | { selected: false; reason: 'PAYMENT_PROVIDER_UNAVAILABLE' | 'OFFER_RESTRICTED_TO_UNAVAILABLE_PROVIDER' };

/**
 * Select a payment provider for an offer. Never fabricates a checkout when
 * no eligible configured provider exists — returns
 * PAYMENT_PROVIDER_UNAVAILABLE explicitly instead. Provider routing never
 * alters the offer's price or currency; it only chooses WHO processes an
 * already-resolved, already-priced transaction.
 */
export function selectPaymentProvider(
  offer: OfferRoutingInput,
  configuredProviders: readonly PaymentProviderCapabilities[],
): ProviderSelectionResult {
  const eligible = configuredProviders.filter(
    (p) =>
      p.supportedCurrencies.includes(offer.currencyCode) &&
      p.supportedMarkets.includes(offer.marketCode),
  );

  if (offer.providerRestriction) {
    const restricted = eligible.find((p) => p.provider === offer.providerRestriction);
    return restricted
      ? { selected: true, provider: restricted.provider, environment: restricted.environment }
      : { selected: false, reason: 'OFFER_RESTRICTED_TO_UNAVAILABLE_PROVIDER' };
  }

  if (eligible.length === 0) {
    return { selected: false, reason: 'PAYMENT_PROVIDER_UNAVAILABLE' };
  }

  return { selected: true, provider: eligible[0].provider, environment: eligible[0].environment };
}

/**
 * Providers configured in this deployment. Following the Flutterwave
 * decommission there are NONE: no adapter exists, no provider credential is
 * read here, and no environment is resolved or guessed. Routing must never
 * select a provider it cannot actually call.
 */
export function getConfiguredProviders(): PaymentProviderCapabilities[] {
  return [];
}

/**
 * Resolves the capabilities of a provider a caller already knows it is
 * dealing with (e.g. from `payment_checkout_intents.provider`). Returns null
 * (fail closed) whenever that provider is not currently configured — which,
 * with no provider configured, is always. Callers must treat null as "cannot
 * proceed", never substitute a guess.
 */
export function getCapabilitiesForProvider(provider: PaymentProvider): PaymentProviderCapabilities | null {
  return getConfiguredProviders().find((p) => p.provider === provider) ?? null;
}
