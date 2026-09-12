/**
 * Ω2-G — Provider routing abstraction.
 *
 * Provider routing is downstream of commercial offer resolution. It never
 * encodes a fixed rule like "TZS => Flutterwave" or "TZ => Flutterwave" as
 * permanent business truth — that would collapse dimension F (payment
 * provider) into dimension C/E (market/currency), which the Ω2-G model
 * forbids. Instead, each configured provider declares its own capabilities,
 * and selectPaymentProvider() picks the first eligible one for a given
 * offer. Adding Stripe is: write a StripeAdapter, add its capabilities to
 * getConfiguredProviders(), done — no change to this file's logic, no
 * change to commercial_offers, checkout intent semantics, payment_events,
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

// ── Flutterwave capabilities ────────────────────────────────────────────────
// Flutterwave's real strength is African + global-card processing; it is
// deliberately NOT declared eligible for GB/EU here — that gap is exactly
// what a future Stripe adapter fills, and is why PAYMENT_PROVIDER_UNAVAILABLE
// for a GB/EU offer today is correct behaviour, not a bug.

/**
 * Ω∞ A+ closure BLOCKER-3 fix: resolves FLUTTERWAVE_ENVIRONMENT with NO
 * implicit default. A missing, blank, or unrecognized value returns null —
 * never silently 'sandbox'. Silently defaulting to sandbox would mean a
 * misconfigured/absent env var could route a customer through what LOOKS
 * like a live provider secret but is recorded (and matrix-enforced) as
 * sandbox, or vice versa if the value is simply typo'd — both are
 * corruption of the environment-authority chain the platform-state matrix
 * depends on.
 */
function resolveFlutterwaveEnvironment(): 'sandbox' | 'production' | null {
  const raw = Deno.env.get('FLUTTERWAVE_ENVIRONMENT');
  if (raw === 'sandbox' || raw === 'production') return raw;
  return null;
}

function buildFlutterwaveCapabilities(): PaymentProviderCapabilities | null {
  const environment = resolveFlutterwaveEnvironment();
  if (environment === null) return null;
  return {
    provider: 'FLUTTERWAVE',
    supportedCurrencies: ['TZS', 'USD', 'KES', 'UGX'],
    supportedMarkets: ['GLOBAL', 'TZ', 'MU'],
    supportedMethods: ['card', 'mobilemoneytzania'],
    environment,
  };
}

/**
 * Providers configured in this deployment (secrets present AND environment
 * explicitly, validly declared). A provider whose adapter exists in code
 * but whose secrets are unset, or whose environment is missing/invalid, is
 * NOT eligible — routing must never select a provider it cannot actually
 * call, and must never guess which environment it would be calling under.
 */
export function getConfiguredProviders(): PaymentProviderCapabilities[] {
  const providers: PaymentProviderCapabilities[] = [];
  const flutterwave = buildFlutterwaveCapabilities();
  if (flutterwave && Deno.env.get('FLUTTERWAVE_SECRET_KEY') && Deno.env.get('FLUTTERWAVE_WEBHOOK_SECRET')) {
    providers.push(flutterwave);
  }
  // Future: if (Deno.env.get('STRIPE_SECRET_KEY')) providers.push(STRIPE_CAPABILITIES);
  return providers;
}

/**
 * Ω∞ A+ closure BLOCKER-3 fix: resolves the environment of the ACTUAL
 * provider a caller already knows it is dealing with (e.g. from
 * `payment_checkout_intents.provider`) — never an arbitrary configured
 * provider entry, and never a silent default. Returns null (fail closed)
 * if that provider is not currently configured with a valid environment;
 * callers must treat null as "cannot proceed," never substitute a guess.
 */
export function getCapabilitiesForProvider(provider: PaymentProvider): PaymentProviderCapabilities | null {
  return getConfiguredProviders().find((p) => p.provider === provider) ?? null;
}
