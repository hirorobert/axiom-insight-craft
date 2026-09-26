/**
 * CFO Close pricing catalogue — the ONE place plan names, capacities, prices and the plan x capability matrix live
 * in the frontend.
 *
 * It mirrors, exactly, the plans, offers, additional-seat prices and the plan / capability matrix seeded by
 * 20260925100000_global_capabilities_entitlements_pricing.sql and
 * 20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql (src/lib/commercial/pricingCatalogue.test.ts
 * parses both migrations and fails on any drift). The database matrix (commercial_plan_features) is what enforcement
 * reads; the pricing page renders this mirror of it. Every component reads prices from here.
 *
 * There is no free plan and no trial. The catalogue keeps five things separate:
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
import type { CapabilityCode, PlanFeatureCode } from "./featureRegistry";
import { CAPABILITIES, PLAN_FEATURES } from "./featureRegistry";

export const CATALOGUE_CURRENCY = { code: "USD", exponent: 2 } as const;

/**
 * There is no online checkout or payment provider in this build. Every customer-facing action is non-transactional
 * ("Request access", "Contact sales"); plans are activated by the commercial team (admin_grant_commercial_licence).
 * Nothing may render Buy, Subscribe, Start free, Start trial or any payment step while this is false
 * (src/lib/commercial/__tests__/noCheckoutClaims.test.ts).
 */
export const CHECKOUT_AVAILABLE = false as const;

/** The one truthful sentence shown wherever a payment step would otherwise be. */
export const NO_CHECKOUT_NOTICE = "There is no online checkout. Plans are activated by our team: contact sales to request one.";

export type PlanCode = "SOLO" | "PRACTICE" | "FIRM" | "ENTERPRISE";
export type SalesMode = "self_serve" | "contact_sales";

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
  /** Base-plan price, USD minor units (cents). null for Enterprise (contact sales). */
  readonly monthlyMinor: number | null;
  readonly annualMinor: number | null;
  readonly capabilities: readonly CapabilityCode[];
  readonly highlights: readonly string[];
}

const EVERY_PLAN: readonly CapabilityCode[] = [
  "CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "ENTITY_CAPACITY", "NAMED_USER_SEATS", "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS",
];

/** One additional named user on Practice or Firm: $20 per month or $200 per year. */
export const ADDITIONAL_SEAT_PRICE: AdditionalSeatPrice = { monthlyMinor: 2000, annualMinor: 20000 };

export const PRICING_CATALOGUE: readonly CataloguePlan[] = [
  {
    code: "SOLO", name: "Solo", tagline: "Certify, issue and analyse the close of one entity.",
    salesMode: "self_serve", entityCapacity: 1, includedSeats: 1, additionalSeat: null, monthlyMinor: 4900, annualMinor: 49000,
    capabilities: EVERY_PLAN,
    highlights: [
      "1 active entity",
      "1 named user (no additional users)",
      "Close Assurance and comparative reporting",
      "Close Certification",
      "Reporting Pack",
      "Close Insights",
    ],
  },
  {
    code: "PRACTICE", name: "Practice", tagline: "Certify, issue and analyse closes for a small portfolio.",
    salesMode: "self_serve", entityCapacity: 5, includedSeats: 1, additionalSeat: ADDITIONAL_SEAT_PRICE, monthlyMinor: 9900, annualMinor: 99000,
    capabilities: EVERY_PLAN,
    highlights: [
      "Up to 5 active entities",
      "1 named user included; add named users separately",
      "Everything in Solo",
      "Multi-entity reporting",
      "Standard support",
    ],
  },
  {
    code: "FIRM", name: "Firm", tagline: "Run the close across a firm-wide portfolio.",
    salesMode: "self_serve", entityCapacity: 25, includedSeats: 1, additionalSeat: ADDITIONAL_SEAT_PRICE, monthlyMinor: 29900, annualMinor: 299000,
    capabilities: EVERY_PLAN,
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
    capabilities: EVERY_PLAN,
    highlights: [
      "More than 25 entities",
      "Negotiated named users",
      "Implementation assistance",
      "Contractual support, custom invoicing and annual terms",
    ],
  },
];

/** The entry plan — what a locked action points to when the account has no current plan. */
export const ENTRY_PAID_PLAN: PlanCode = "SOLO";

// ── The plan x capability matrix (mirror of commercial_plan_features) ──────────────────────────────────────────────
/** Plans the matrix covers: the four public plans and the grandfathered legacy plan. The retired Free plan has none. */
export type MatrixPlanCode = PlanCode | "PAID";
export type MatrixCapability = Exclude<CapabilityCode, "ENTITY_CAPACITY" | "NAMED_USER_SEATS"> | PlanFeatureCode;

const PAID_PLANS: readonly MatrixPlanCode[] = ["SOLO", "PRACTICE", "FIRM", "ENTERPRISE", "PAID"];

/** For every capability, exactly the plans that include it. Same order and content as the migration. */
export const PLAN_FEATURE_MATRIX: Readonly<Record<MatrixCapability, readonly MatrixPlanCode[]>> = {
  CLOSE_ASSURANCE: PAID_PLANS,
  COMPARATIVE_REPORTING: PAID_PLANS,
  STATEMENT_CERTIFICATION: PAID_PLANS,
  REPORTING_PACK_EXPORT: PAID_PLANS,
  CLOSE_INSIGHTS: PAID_PLANS,
  CLEAN_PDF: PAID_PLANS,
  EXCEL_EXPORT: PAID_PLANS,
  FILING_PACKS: PAID_PLANS,
  MANAGEMENT_LETTERS: PAID_PLANS,
  MULTI_ENTITY_REPORTING: ["PRACTICE", "FIRM", "ENTERPRISE", "PAID"],
  CONSOLIDATION: [],
  REGIONAL_PACKS: PAID_PLANS,
};

export const MATRIX_CAPABILITIES = Object.keys(PLAN_FEATURE_MATRIX) as readonly MatrixCapability[];

/** Does the plan include the capability? Unknown plans, unknown capabilities and no plan are never included. */
export function planIncludes(plan: string | null | undefined, capability: string): boolean {
  if (!plan || !Object.prototype.hasOwnProperty.call(PLAN_FEATURE_MATRIX, capability)) return false;
  return (PLAN_FEATURE_MATRIX[capability as MatrixCapability] as readonly string[]).includes(plan);
}

/** Customer-facing name of a matrix capability. */
export function matrixCapabilityName(capability: MatrixCapability): string {
  return capability in PLAN_FEATURES ? PLAN_FEATURES[capability as PlanFeatureCode].name : CAPABILITIES[capability as CapabilityCode].name;
}

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
 * (_seat_capacity_for_account). Solo is always exactly one: a Solo licence recording purchased seats is malformed and
 * fails closed, exactly as the database does. Anything unknown, negative, fractional or malformed fails closed
 * (null = undetermined: no new person may be added).
 */
export function allowedNamedUsers(plan: CataloguePlan | null, purchasedAdditionalSeats: unknown, negotiatedIncludedSeats: number | null = null): number | null {
  if (!plan) return null;
  const included = plan.includedSeats ?? negotiatedIncludedSeats;
  if (typeof included !== "number" || !Number.isInteger(included) || included < 1) return null;
  if (typeof purchasedAdditionalSeats !== "number" || !Number.isInteger(purchasedAdditionalSeats) || purchasedAdditionalSeats < 0) return null;
  if (plan.code === "SOLO" && purchasedAdditionalSeats !== 0) return null;
  return included + purchasedAdditionalSeats;
}

/** Plan name for any plan code the server may report, including the grandfathered legacy plan. */
export function displayCataloguePlanName(code: string | null | undefined): string | null {
  if (code === "PAID") return "Professional (legacy)";
  if (code === "FREE") return "Free (retired)";
  return planByCode(code)?.name ?? null;
}
