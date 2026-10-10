// commercial/planOffers.ts — what a plan card may say about price and payment. Pure: no network, storage or clock.
//
// The server decides (get_public_plan_prices, 20261029100000). Three states per plan:
//   approved price + online payment open → the price and "Choose <plan>";
//   approved price, online payment closed → the price (no "Proposed") and "Request activation";
//   no approved price → the catalogue figure marked "Proposed" and "Request activation".
// Where:
//   - a price is APPROVED only when a commercial administrator has made that plan's annual offer purchasable;
//   - customers can pay online only while commercial_platform_state is CUSTOMER_PAYMENTS_ENABLED.
// A plan is offered for online purchase only when BOTH hold for it; otherwise its action is "Request activation" (the
// enquiry preselected with the plan), so manual activation stays the path whenever online payment is not open. Only a
// launched route's market is ever shown (LAUNCHED_MARKETS). Enterprise is always agreed with the team.
// No price is ever invented here: an approved price is the server's own amount; a proposed one is the catalogue's.

import { PRICING_CATALOGUE, type CataloguePlan, type PlanCode } from "./pricingCatalogue";
import { activationHref, type CommercialSource } from "./offerings";

export interface PublicOffer {
  readonly planCode: string;
  readonly marketCode: string;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly amountMinor: number;
}
export interface PublicPrices {
  readonly onlinePayment: boolean;
  readonly offers: readonly PublicOffer[];
}

/** Server answer (snake_case) → PublicPrices. Anything malformed is "no prices, no online payment". */
export function parsePublicPrices(raw: unknown): PublicPrices | null {
  const r = raw as { online_payment?: unknown; offers?: unknown } | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.offers)) return null;
  const offers: PublicOffer[] = [];
  for (const o of r.offers as Record<string, unknown>[]) {
    const amount = Number(o?.amount_minor);
    const exponent = Number(o?.currency_exponent);
    if (typeof o?.plan_code !== "string" || typeof o?.currency_code !== "string" || typeof o?.market_code !== "string"
        || !Number.isSafeInteger(amount) || amount <= 0 || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) continue;
    offers.push({ planCode: o.plan_code, marketCode: o.market_code, currencyCode: o.currency_code, currencyExponent: exponent, amountMinor: amount });
  }
  return { onlinePayment: r.online_payment === true, offers };
}

/** "USD 490", "USD 2,990", "TZS 1,250,000", "USD 49.50" — exact, from minor units; never rounded. */
export function formatMoney(amountMinor: number, currencyCode: string, exponent: number): string {
  const major = Math.trunc(amountMinor / 10 ** exponent);
  const minor = amountMinor % 10 ** exponent;
  const whole = major.toLocaleString("en-US");
  return `${currencyCode} ${minor === 0 ? whole : `${whole}.${String(minor).padStart(exponent, "0")}`}`;
}

export type PlanPurchaseView =
  | { readonly mode: "online"; readonly priceLines: readonly string[]; readonly actionLabel: string; readonly href: string }
  | { readonly mode: "activation"; readonly priceLines: readonly string[]; readonly actionLabel: string; readonly href: string }
  | { readonly mode: "enterprise"; readonly priceLines: readonly string[]; readonly actionLabel: string; readonly href: string };

const ROUTE_NAME: Readonly<Record<string, string>> = { GLOBAL: "card", TZ: "mobile money" };
/**
 * The markets whose payment route is launched. Owner decision (2026-10-10): Polar card payments only — the TZ (Snippe,
 * mobile money) route is not offered (no TZS price is approved), so a TZ offer is never shown, even if one is approved
 * later by mistake. Mirrors SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false on the server.
 */
export const LAUNCHED_MARKETS: readonly string[] = ["GLOBAL"];

export const checkoutHref = (plan: PlanCode): string => `/billing/checkout?plan=${plan}`;

export function planPurchaseView(plan: CataloguePlan, prices: PublicPrices | null, source: CommercialSource): PlanPurchaseView {
  if (plan.salesMode === "contact_sales") {
    return { mode: "enterprise", priceLines: ["Terms agreed with our team"], actionLabel: "Discuss Enterprise", href: activationHref(plan.code, source) };
  }
  const offers = (prices?.offers ?? []).filter((o) => o.planCode === plan.code && LAUNCHED_MARKETS.includes(o.marketCode));
  if (prices?.onlinePayment && offers.length > 0) {
    const priceLines = offers.map((o) => `${formatMoney(o.amountMinor, o.currencyCode, o.currencyExponent)} per year${ROUTE_NAME[o.marketCode] ? ` by ${ROUTE_NAME[o.marketCode]}` : ""}`);
    return { mode: "online", priceLines, actionLabel: `Choose ${plan.name}`, href: checkoutHref(plan.code) };
  }
  if (offers.length > 0) {
    // An approved price while online payment is closed: the server's amount, without "Proposed", and the activation request.
    const priceLines = offers.map((o) => `${formatMoney(o.amountMinor, o.currencyCode, o.currencyExponent)} per year`);
    return { mode: "activation", priceLines, actionLabel: "Request activation", href: activationHref(plan.code, source) };
  }
  const proposed = plan.annualMinor === null ? "Proposed: terms agreed separately" : `Proposed: USD ${(plan.annualMinor / 100).toLocaleString("en-US")} per year`;
  return { mode: "activation", priceLines: [proposed], actionLabel: "Request activation", href: activationHref(plan.code, source) };
}

/** "Additional named users: proposed USD 200 per year each, arranged with our team" — or null when the plan has none. */
export function additionalUserLine(plan: CataloguePlan): string | null {
  return plan.additionalSeat
    ? `Additional named users: proposed USD ${(plan.additionalSeat.annualMinor / 100).toLocaleString("en-US")} per year each, arranged with our team`
    : null;
}

/** The self-serve plans a checkout may name. */
export const CHECKOUT_PLANS: readonly PlanCode[] = PRICING_CATALOGUE.filter((p) => p.salesMode === "self_serve").map((p) => p.code);
export const parseCheckoutPlan = (v: string | null | undefined): PlanCode | null =>
  v && (CHECKOUT_PLANS as readonly string[]).includes(v.toUpperCase()) ? (v.toUpperCase() as PlanCode) : null;
