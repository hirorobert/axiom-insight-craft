/**
 * CFO Close pricing catalogue — the ONE place plan names, capacities and prices live in the frontend.
 *
 * It mirrors, exactly, the plans, offers and additional-seat prices seeded by
 * 20260925100000_global_capabilities_entitlements_pricing.sql (src/lib/commercial/pricingCatalogue.test.ts parses that
 * migration and fails on any drift). Every component reads prices from here; annual savings are derived here once.
 *
 * The catalogue keeps five things separate:
 *   base-plan price        monthlyMinor / annualMinor
 *   entity capacity        entityCapacity
 *   included seats         includedSeats (exactly one named user on every plan; Enterprise negotiated)
 *   additional-seat price  additionalSeat (Practice and Firm only; null = cannot be bought)
 *   purchased quantity     NOT catalogue data: it belongs to an account's licence and is read from the server
 *                          (get_workspace_seat_capacity); allowedNamedUsers() combines it with the included seats.
 *
 * Prices are marketing and catalogue data. They never decide authorization: the database authority checks the
 * capabilities and capacity attached to the purchased plan (authorize_paid_action, the walls). No checkout exists in
 * this build; nothing here is purchasable until checkout is separately activated.
 */
import type { CapabilityCode } from "./featureRegistry";

export const CATALOGUE_CURRENCY = { code: "USD", exponent: 2 } as const;

export type PlanCode = "FREE" | "PRACTICE" | "FIRM" | "ENTERPRISE";
export type SalesMode = "free" | "self_serve" | "contact_sales";

export interface AdditionalSeatPrice {
  /** USD minor units per additional named user. */
  readonly monthlyMinor: number;
  readonly annualMinor: number;
}

export interface CataloguePlan {
  readonly code: PlanCode;
  readonly name: string;
  readonly tagline: string;
  readonly salesMode: SalesMode;
  /** Active entities included; null = agreed in the Enterprise contract. */
  readonly entityCapacity: number | null;
  /** Named users included in the base price; null = negotiated in the Enterprise contract. */
  readonly includedSeats: number | null;
  /** Price of each separately purchased additional named user; null = the plan cannot buy seats. */
  readonly additionalSeat: AdditionalSeatPrice | null;
  /** Base-plan price, USD minor units (cents). null for Free (no charge) and Enterprise (contact sales). */
  readonly monthlyMinor: number | null;
  readonly annualMinor: number | null;
  readonly capabilities: readonly CapabilityCode[];
  readonly highlights: readonly string[];
}

const ALWAYS_ON: readonly CapabilityCode[] = ["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "ENTITY_CAPACITY", "NAMED_USER_SEATS"];
const ALL_PAID: readonly CapabilityCode[] = [...ALWAYS_ON, "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS"];

/** One additional named user on Practice or Firm: $20 per month or $200 per year. */
export const ADDITIONAL_SEAT_PRICE: AdditionalSeatPrice = { monthlyMinor: 2000, annualMinor: 20000 };

export const PRICING_CATALOGUE: readonly CataloguePlan[] = [
  {
    code: "FREE", name: "Free", tagline: "Prepare and preview a close for one entity.",
    salesMode: "free", entityCapacity: 1, includedSeats: 1, additionalSeat: null, monthlyMinor: null, annualMinor: null,
    capabilities: ALWAYS_ON,
    highlights: [
      "1 entity",
      "1 named user (no additional users)",
      "Trial balance upload and account classification",
      "Reconciliation and validation checks",
      "In-app statement preview with comparative reporting",
      "Readiness checks",
    ],
  },
  {
    code: "PRACTICE", name: "Practice", tagline: "Certify, issue and analyse closes for a small portfolio.",
    salesMode: "self_serve", entityCapacity: 5, includedSeats: 1, additionalSeat: ADDITIONAL_SEAT_PRICE, monthlyMinor: 9900, annualMinor: 99000,
    capabilities: ALL_PAID,
    highlights: [
      "Up to 5 active entities",
      "1 named user included; add named users separately",
      "Close Certification",
      "Reporting Pack",
      "Close Insights",
      "Comparative reporting and historical record access",
      "Standard support",
    ],
  },
  {
    code: "FIRM", name: "Firm", tagline: "Run the close across a firm-wide portfolio.",
    salesMode: "self_serve", entityCapacity: 25, includedSeats: 1, additionalSeat: ADDITIONAL_SEAT_PRICE, monthlyMinor: 29900, annualMinor: 299000,
    capabilities: ALL_PAID,
    highlights: [
      "Up to 25 active entities",
      "1 named user included; add named users separately",
      "Everything in Practice",
      "Priority support",
    ],
  },
  {
    code: "ENTERPRISE", name: "Enterprise", tagline: "For larger practices with contractual requirements.",
    salesMode: "contact_sales", entityCapacity: null, includedSeats: null, additionalSeat: null, monthlyMinor: null, annualMinor: null,
    capabilities: ALL_PAID,
    highlights: [
      "More than 25 entities",
      "Negotiated named users",
      "Implementation assistance",
      "Contractual support, custom invoicing and annual terms",
    ],
  },
];

/** The first plan that includes paid capabilities — what a locked action points to. */
export const ENTRY_PAID_PLAN: PlanCode = "PRACTICE";

export function planByCode(code: string | null | undefined): CataloguePlan | null {
  return PRICING_CATALOGUE.find((p) => p.code === code) ?? null;
}

/** "$99", "$2,990" — whole dollars in the catalogue's currency. */
export function formatCatalogueAmount(minor: number): string {
  const major = minor / 10 ** CATALOGUE_CURRENCY.exponent;
  return `$${major.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** Annual saving against twelve monthly payments, derived once here (null when either price is absent). */
export function annualSavingMinor(plan: CataloguePlan): number | null {
  if (plan.monthlyMinor === null || plan.annualMinor === null) return null;
  return plan.monthlyMinor * 12 - plan.annualMinor;
}

/**
 * allowed_named_users = included_seats + purchased_additional_seats — the same formula the database resolves
 * (_seat_capacity_for_account). Free is always exactly one, whatever quantity is supplied. Anything unknown,
 * negative, fractional or malformed fails closed (null = undetermined: no new person may be added).
 */
export function allowedNamedUsers(plan: CataloguePlan | null, purchasedAdditionalSeats: unknown, negotiatedIncludedSeats: number | null = null): number | null {
  if (!plan) return null;
  if (plan.code === "FREE") return 1;
  const included = plan.includedSeats ?? negotiatedIncludedSeats;
  if (typeof included !== "number" || !Number.isInteger(included) || included < 1) return null;
  if (typeof purchasedAdditionalSeats !== "number" || !Number.isInteger(purchasedAdditionalSeats) || purchasedAdditionalSeats < 0) return null;
  return included + purchasedAdditionalSeats;
}

/** Plan name for any plan code the server may report, including the grandfathered legacy plan. */
export function displayCataloguePlanName(code: string | null | undefined): string | null {
  if (code === "PAID") return "Professional (legacy)";
  return planByCode(code)?.name ?? null;
}
