/**
 * Ω2-G — Provider routing abstraction (frontend mirror).
 *
 * Mirrors supabase/functions/_shared/payments/routing.ts for use in unit
 * tests and any future client-side display logic (e.g. "is a provider
 * likely available for this offer" hints). The Edge Function copy is the
 * one actually consulted at checkout time — this copy exists so the pure
 * selectPaymentProvider() logic is testable without a Deno runtime, exactly
 * like money.ts has a frontend copy and an Edge Function copy.
 *
 * Provider routing is downstream of commercial offer resolution. It never
 * encodes a fixed rule like "TZS => Flutterwave" as permanent business
 * truth — each configured provider declares its own capabilities, and
 * selectPaymentProvider() picks the first eligible one for a given offer.
 */

export type PaymentProvider = "FLUTTERWAVE" | "PESAPAL" | "SELCOM" | "DPO" | "STRIPE";

export interface PaymentProviderCapabilities {
  provider: PaymentProvider;
  supportedCurrencies: readonly string[];
  supportedMarkets: readonly string[];
  supportedMethods: readonly string[];
  environment: "sandbox" | "production";
}

export interface OfferRoutingInput {
  currencyCode: string;
  marketCode: string;
  providerRestriction: string | null;
}

export type ProviderSelectionResult =
  | { selected: true; provider: PaymentProvider }
  | { selected: false; reason: "PAYMENT_PROVIDER_UNAVAILABLE" | "OFFER_RESTRICTED_TO_UNAVAILABLE_PROVIDER" };

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
      ? { selected: true, provider: restricted.provider }
      : { selected: false, reason: "OFFER_RESTRICTED_TO_UNAVAILABLE_PROVIDER" };
  }

  if (eligible.length === 0) {
    return { selected: false, reason: "PAYMENT_PROVIDER_UNAVAILABLE" };
  }

  return { selected: true, provider: eligible[0].provider };
}

export const FLUTTERWAVE_CAPABILITIES: PaymentProviderCapabilities = {
  provider: "FLUTTERWAVE",
  supportedCurrencies: ["TZS", "USD", "KES", "UGX"],
  supportedMarkets: ["GLOBAL", "TZ", "MU"],
  supportedMethods: ["card", "mobilemoneytzania"],
  environment: "sandbox",
};
