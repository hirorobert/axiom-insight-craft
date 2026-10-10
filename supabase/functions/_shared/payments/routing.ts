/**
 * Provider routing (provider-neutral selection over declared capabilities).
 *
 * Provider routing is downstream of commercial offer resolution. selectPaymentProvider() picks the configured provider
 * whose declared currencies and markets include the already-resolved offer's; it never changes a price or currency.
 *
 * The two implemented routes (docs/release/PAYMENT_PROVIDER_EVIDENCE.md §3):
 *   POLAR   merchant of record, cards        USD   market GLOBAL
 *   SNIPPE  Tanzania mobile money            TZS   market TZ      NOT LAUNCHED (SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false)
 * Their capabilities do not overlap, so for any offer at most one provider is eligible — there is no fallback from one
 * to the other and no "first match" ambiguity.
 *
 * A provider is CONFIGURED only when every one of its server-side settings is present and valid, including an explicit
 * environment ('sandbox' | 'production' — never defaulted) and the customer return URL. A partial configuration is
 * the same as none: the provider is not offered and checkout fails closed with PAYMENT_PROVIDER_UNAVAILABLE. Secrets
 * are read here and passed only to the provider's own adapter; none is ever returned to a caller.
 *
 * 'FLUTTERWAVE' and the other legacy identifiers remain legal PaymentProvider values ONLY so historical rows stay
 * readable; nothing in this file can select, call or verify against them.
 */

import type { PaymentProvider, ProviderAdapter } from './contracts.ts';
import { createPolarAdapter, POLAR_API_BASE } from './providers/polar.ts';
import { createSnippeAdapter, SNIPPE_API_BASE } from './providers/snippe.ts';

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

/** The payment method a customer chooses, and the commercial market the server maps it to. */
export type PaymentRoute = 'CARD' | 'MOBILE_MONEY';
export const ROUTE_MARKET: Readonly<Record<PaymentRoute, string>> = Object.freeze({ CARD: 'GLOBAL', MOBILE_MONEY: 'TZ' });

/**
 * Select a payment provider for an offer. Never fabricates a checkout when no eligible configured provider exists —
 * returns PAYMENT_PROVIDER_UNAVAILABLE explicitly instead. Provider routing never alters the offer's price or currency;
 * it only chooses WHO processes an already-resolved, already-priced transaction.
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

  if (eligible.length !== 1) {
    // None, or (impossible with the declared capabilities, and refused rather than guessed) more than one.
    return { selected: false, reason: 'PAYMENT_PROVIDER_UNAVAILABLE' };
  }

  return { selected: true, provider: eligible[0].provider, environment: eligible[0].environment };
}

export type EnvReader = (name: string) => string | undefined;

/** Snippe (TZS mobile money) is not launched: no TZS price is approved (owner decision, 2026-10-10). Fails closed. */
export const SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false as const;

const ENVIRONMENTS = new Set(['sandbox', 'production']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELF_SERVE_PLANS = ['SOLO', 'PRACTICE', 'FIRM'] as const;

/** An API base override is accepted only for a sandbox provider pointed at a loopback mock (local tests). */
function apiBase(override: string | undefined, fallback: string, environment: string): string | null {
  if (!override) return fallback;
  if (environment !== 'sandbox') return null;
  try {
    const u = new URL(override);
    return ['localhost', '127.0.0.1', 'host.docker.internal'].includes(u.hostname) ? override.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

/** The customer return URL: https, or http on loopback (local stack only). */
export function returnUrlFrom(env: EnvReader): string | null {
  const raw = env('SAFF_PAYMENT_REDIRECT_URL');
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) ? raw : null;
  } catch {
    return null;
  }
}

export interface ConfiguredProvider { capabilities: PaymentProviderCapabilities; adapter: ProviderAdapter }

/** Every provider whose complete configuration is present in `env`. Pure: the env reader and fetch are injected. */
export function providersFromEnv(env: EnvReader, fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>): ConfiguredProvider[] {
  const out: ConfiguredProvider[] = [];
  if (!returnUrlFrom(env)) return out;

  const pEnv = env('POLAR_ENVIRONMENT') ?? '';
  const pToken = env('POLAR_ACCESS_TOKEN');
  const pSecret = env('POLAR_WEBHOOK_SECRET');
  const pOrg = env('POLAR_ORGANIZATION_ID');
  let pProducts: Record<string, string> | null = null;
  try {
    const parsed = JSON.parse(env('POLAR_PRODUCT_IDS') ?? 'null');
    if (parsed && SELF_SERVE_PLANS.every((p) => typeof parsed[p] === 'string' && UUID.test(parsed[p]))) {
      pProducts = Object.fromEntries(SELF_SERVE_PLANS.map((p) => [p, parsed[p] as string]));
    }
  } catch { pProducts = null; }
  const pBase = apiBase(env('POLAR_API_BASE_URL'), POLAR_API_BASE[pEnv as 'sandbox' | 'production'] ?? '', pEnv);
  if (ENVIRONMENTS.has(pEnv) && pToken && pSecret?.startsWith('whsec_') && pOrg && UUID.test(pOrg) && pProducts && pBase) {
    const environment = pEnv as 'sandbox' | 'production';
    out.push({
      capabilities: { provider: 'POLAR', supportedCurrencies: ['USD'], supportedMarkets: ['GLOBAL'], supportedMethods: ['card'], environment },
      adapter: createPolarAdapter({ environment, accessToken: pToken, webhookSecret: pSecret, organizationId: pOrg, productIds: pProducts, apiBase: pBase }, fetchImpl),
    });
  }

  const sEnv = env('SNIPPE_ENVIRONMENT') ?? '';
  const sKey = env('SNIPPE_API_KEY');
  const sSecret = env('SNIPPE_WEBHOOK_SECRET');
  const supabaseUrl = env('SUPABASE_URL');
  const sBase = apiBase(env('SNIPPE_API_BASE_URL'), SNIPPE_API_BASE, sEnv);
  // Owner decision (2026-10-10): launch with Polar card payments only; no TZS price is approved. The Snippe route stays
  // implemented but is offered ONLY to a sandbox adapter pointed at a loopback mock (local tests) — never on the hosted
  // project, whatever secrets are set — until this source constant is changed by a reviewed release.
  const snippeLoopbackMock = sEnv === 'sandbox' && sBase !== null && sBase !== SNIPPE_API_BASE;
  if ((SNIPPE_CUSTOMER_CHECKOUT_ENABLED || snippeLoopbackMock) && ENVIRONMENTS.has(sEnv) && sKey && sSecret && supabaseUrl && sBase) {
    const environment = sEnv as 'sandbox' | 'production';
    out.push({
      capabilities: { provider: 'SNIPPE', supportedCurrencies: ['TZS'], supportedMarkets: ['TZ'], supportedMethods: ['mobile_money'], environment },
      adapter: createSnippeAdapter({ environment, apiKey: sKey, webhookSecret: sSecret, apiBase: sBase,
        webhookUrl: `${supabaseUrl.replace(/\/$/, '')}/functions/v1/commercial-webhook-snippe` }, fetchImpl),
    });
  }
  return out;
}

const denoEnv: EnvReader = (name) => Deno.env.get(name);

/** Capabilities of every provider configured in this deployment. */
export function getConfiguredProviders(): PaymentProviderCapabilities[] {
  return providersFromEnv(denoEnv).map((p) => p.capabilities);
}

/**
 * Resolves the capabilities of a provider a caller already knows it is dealing with (e.g. from
 * `payment_checkout_intents.provider`). Returns null (fail closed) whenever that provider is not currently configured.
 * Callers must treat null as "cannot proceed", never substitute a guess.
 */
export function getCapabilitiesForProvider(provider: PaymentProvider): PaymentProviderCapabilities | null {
  return getConfiguredProviders().find((p) => p.provider === provider) ?? null;
}

/** The adapter of a configured provider, or null. */
export function getAdapterForProvider(provider: string): ProviderAdapter | null {
  return providersFromEnv(denoEnv).find((p) => p.capabilities.provider === provider)?.adapter ?? null;
}
