/**
 * CFO Close pricing catalogue — the ONE place plan names, capacities, prices and the plan x capability matrix live
 * in the frontend.
 *
 * It mirrors, exactly, the plans, offers and the plan / capability matrix seeded by
 * 20260925100000_global_capabilities_entitlements_pricing.sql and
 * 20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql, as changed by
 * 20261110100000_unlimited_team_members.sql (src/lib/commercial/pricingCatalogue.test.ts parses them and fails on any
 * drift). The database matrix (commercial_plan_features) is what enforcement
 * reads; the pricing page renders this mirror of it. Every component reads prices from here.
 *
 * There is no free plan and no trial. The catalogue keeps five things separate:
 *   base-plan price        monthlyMinor / annualMinor
 *   entity capacity        entityCapacity
 *   team members           membersUnlimited (Solo, Practice and Firm: unlimited team members, owner decision
 *                          2026-10-18). Enterprise: agreed per contract. No plan sells additional seats.
 *   included seats         includedSeats: the database's recorded number. It bounds membership only on a plan WITHOUT
 *                          unlimited team members (Enterprise and the legacy plans); elsewhere it is history.
 *
 * Prices are marketing and catalogue data. They never decide authorization: the database authority checks the
 * capabilities and capacity attached to the purchased plan (authorize_paid_action, the walls). Whether a plan can be
 * bought online is decided by the server (planOffers.ts), never by this catalogue.
 */
import type { CapabilityCode, PlanFeatureCode } from "./featureRegistry";
import { CAPABILITIES, PLAN_FEATURES } from "./featureRegistry";

export const CATALOGUE_CURRENCY = { code: "USD", exponent: 2 } as const;

/**
 * The legacy in-app upgrade control (CheckoutUpgradeButton, rendered nowhere) never offers a payment step. Online
 * purchase exists only on /billing/checkout, and only where the SERVER reports it open for a plan (get_public_plan_prices
 * and the checkout options of commercial-create-checkout; src/lib/commercial/planOffers.ts). Static copy never claims
 * online payment (src/lib/commercial/__tests__/noCheckoutClaims.test.ts).
 */
export const CHECKOUT_AVAILABLE = false as const;

/** Shown by the legacy upgrade control instead of a payment step. */
export const NO_CHECKOUT_NOTICE = "Online payment is not available yet. No plan is activated by choosing one here.";

export type PlanCode = "SOLO" | "PRACTICE" | "FIRM" | "ENTERPRISE";
export type SalesMode = "self_serve" | "contact_sales";

export interface CataloguePlan {
  readonly code: PlanCode;
  readonly name: string;
  readonly tagline: string;
  readonly salesMode: SalesMode;
  /** Active entities included; null = agreed in the Enterprise contract. */
  readonly entityCapacity: number | null;
  /** Unlimited team members (an explicit flag, never a large number). false = agreed in the Enterprise contract. */
  readonly membersUnlimited: boolean;
  /** The recorded included named users (history on an unlimited-members plan); null = negotiated (Enterprise). */
  readonly includedSeats: number | null;
  /** Base-plan price, USD minor units (cents). null for Enterprise (contact sales). */
  readonly monthlyMinor: number | null;
  readonly annualMinor: number | null;
  readonly capabilities: readonly CapabilityCode[];
  readonly highlights: readonly string[];
}

const EVERY_PLAN: readonly CapabilityCode[] = [
  "CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "ENTITY_CAPACITY", "NAMED_USER_SEATS", "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS",
];

export const PRICING_CATALOGUE: readonly CataloguePlan[] = [
  {
    code: "SOLO", name: "Solo", tagline: "For one entity.",
    salesMode: "self_serve", entityCapacity: 1, membersUnlimited: true, includedSeats: 1, monthlyMinor: 4900, annualMinor: 49000,
    capabilities: EVERY_PLAN,
    highlights: [
      "1 active entity",
      "Unlimited team members",
      "Close Assurance and comparative reporting",
      "Close Certification",
      "Reporting Pack",
      "Close Insights",
    ],
  },
  {
    code: "PRACTICE", name: "Practice", tagline: "For a small portfolio of entities.",
    salesMode: "self_serve", entityCapacity: 5, membersUnlimited: true, includedSeats: 1, monthlyMinor: 9900, annualMinor: 99000,
    capabilities: EVERY_PLAN,
    highlights: [
      "Up to 5 active entities",
      "Unlimited team members",
      "Everything in Solo",
      "Multi-entity reporting",
      "Standard support",
    ],
  },
  {
    code: "FIRM", name: "Firm", tagline: "For a firm-wide portfolio of entities.",
    salesMode: "self_serve", entityCapacity: 25, membersUnlimited: true, includedSeats: 1, monthlyMinor: 29900, annualMinor: 299000,
    capabilities: EVERY_PLAN,
    highlights: [
      "Up to 25 active entities",
      "Unlimited team members",
      "Everything in Practice",
      "Priority support",
    ],
  },
  {
    code: "ENTERPRISE", name: "Enterprise", tagline: "For larger practices with contractual requirements.",
    salesMode: "contact_sales", entityCapacity: null, membersUnlimited: false, includedSeats: null, monthlyMinor: null, annualMinor: null,
    capabilities: EVERY_PLAN,
    highlights: [
      "More than 25 entities",
      "Team members by agreement",
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
 * The named-user allowance, resolved the way the database does (_seat_capacity_for_account): "unlimited" on a plan with
 * unlimited team members (Solo, Practice, Firm — recorded seats are history there); otherwise included_seats + purchased
 * additional seats (Enterprise: its negotiated seats). Anything unknown, negative, fractional or malformed fails closed
 * (null = undetermined: no new person may be added).
 */
export function allowedNamedUsers(plan: CataloguePlan | null, purchasedAdditionalSeats: unknown, negotiatedIncludedSeats: number | null = null): number | "unlimited" | null {
  if (!plan) return null;
  if (plan.membersUnlimited) return "unlimited";
  const included = plan.includedSeats ?? negotiatedIncludedSeats;
  if (typeof included !== "number" || !Number.isInteger(included) || included < 1) return null;
  if (typeof purchasedAdditionalSeats !== "number" || !Number.isInteger(purchasedAdditionalSeats) || purchasedAdditionalSeats < 0) return null;
  return included + purchasedAdditionalSeats;
}

/** Plan name for any plan code the server may report, including the grandfathered legacy plan. */
export function displayCataloguePlanName(code: string | null | undefined): string | null {
  if (code === "PAID") return "Professional (legacy)";
  if (code === "FREE") return "Free (retired)";
  return planByCode(code)?.name ?? null;
}
