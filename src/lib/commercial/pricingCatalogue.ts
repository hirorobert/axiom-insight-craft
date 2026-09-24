/**
 * CFO Close pricing catalogue — the ONE place plan names, capacities and prices live in the frontend.
 *
 * It mirrors, exactly, the plans and offers seeded by 20260925100000_global_capabilities_entitlements_pricing.sql
 * (src/lib/commercial/pricingCatalogue.test.ts parses that migration and fails on any drift). Every component reads
 * prices from here; annual savings are derived here once, never recomputed elsewhere.
 *
 * Prices are marketing and catalogue data. They never decide authorization: the database authority checks the
 * capabilities and capacity attached to the purchased plan (authorize_paid_action, the walls). No checkout exists in
 * this build; the catalogue offers are non-purchasable until checkout is separately activated.
 */
import type { CapabilityCode } from "./featureRegistry";

export const CATALOGUE_CURRENCY = { code: "USD", exponent: 2 } as const;

export type PlanCode = "FREE" | "PRACTICE" | "FIRM" | "ENTERPRISE";
export type SalesMode = "free" | "self_serve" | "contact_sales";

export interface CataloguePlan {
  readonly code: PlanCode;
  readonly name: string;
  readonly tagline: string;
  readonly salesMode: SalesMode;
  /** Active entities included; null = agreed in the Enterprise contract. */
  readonly entityCapacity: number | null;
  /** Users included; null = agreed in the Enterprise contract. */
  readonly userCapacity: number | null;
  /** USD minor units (cents). null for Free (no charge) and Enterprise (contact sales). */
  readonly monthlyMinor: number | null;
  readonly annualMinor: number | null;
  readonly capabilities: readonly CapabilityCode[];
  readonly highlights: readonly string[];
}

const ALWAYS_ON: readonly CapabilityCode[] = ["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "ENTITY_CAPACITY"];
const ALL_PAID: readonly CapabilityCode[] = [...ALWAYS_ON, "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS"];

export const PRICING_CATALOGUE: readonly CataloguePlan[] = [
  {
    code: "FREE", name: "Free", tagline: "Prepare and preview a close for one entity.",
    salesMode: "free", entityCapacity: 1, userCapacity: 1, monthlyMinor: null, annualMinor: null,
    capabilities: ALWAYS_ON,
    highlights: [
      "1 entity, 1 user",
      "Trial balance upload and account classification",
      "Reconciliation and validation checks",
      "Statement preview with comparative reporting",
      "Readiness checks",
    ],
  },
  {
    code: "PRACTICE", name: "Practice", tagline: "Certify, issue and analyse closes for a small portfolio.",
    salesMode: "self_serve", entityCapacity: 5, userCapacity: 3, monthlyMinor: 9900, annualMinor: 99000,
    capabilities: ALL_PAID,
    highlights: [
      "Up to 5 active entities, up to 3 users",
      "Close Certification",
      "Reporting Pack",
      "Close Insights",
      "Comparative reporting and historical record access",
      "Standard support",
    ],
  },
  {
    code: "FIRM", name: "Firm", tagline: "Run the close across a firm-wide portfolio.",
    salesMode: "self_serve", entityCapacity: 25, userCapacity: 10, monthlyMinor: 29900, annualMinor: 299000,
    capabilities: ALL_PAID,
    highlights: [
      "Up to 25 active entities, up to 10 users",
      "Everything in Practice",
      "Portfolio-level Close Insights",
      "Firm-wide engagement monitoring",
      "Assignments and review workflow",
      "Bulk reporting",
      "Priority support",
    ],
  },
  {
    code: "ENTERPRISE", name: "Enterprise", tagline: "For larger practices with contractual requirements.",
    salesMode: "contact_sales", entityCapacity: null, userCapacity: null, monthlyMinor: null, annualMinor: null,
    capabilities: ALL_PAID,
    highlights: [
      "More than 25 entities",
      "Negotiated user capacity",
      "SSO-ready packaging",
      "Enhanced audit capability",
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

/** Plan name for any plan code the server may report, including the grandfathered legacy plan. */
export function displayCataloguePlanName(code: string | null | undefined): string | null {
  if (code === "PAID") return "Professional (legacy)";
  return planByCode(code)?.name ?? null;
}
