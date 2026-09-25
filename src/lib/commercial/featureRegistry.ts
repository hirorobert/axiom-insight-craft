/**
 * CFO Close — canonical capability vocabulary (20260925100000_global_capabilities_entitlements_pricing.sql).
 *
 * Mirrors public.commercial_capabilities and public.commercial_capability_aliases. The database is the authority
 * (authorize_paid_action / the walls); this registry is presentation only and never decides anything itself.
 * Adding a capability requires the same change in a new migration — src/lib/commercial/featureRegistry.test.ts
 * holds the two in lockstep.
 *
 * Kinds:
 *   included  every plan, always on, never a wall  (Close Assurance, Comparative Reporting)
 *   paid      a NEW action of this kind needs a plan that includes it (Close Certification, Reporting Pack,
 *             Close Insights). Existing records stay readable whatever the plan.
 *   capacity  a number per plan, not an action (Entity Capacity)
 */

export const CAPABILITY_CODES = [
  "CLOSE_ASSURANCE",
  "COMPARATIVE_REPORTING",
  "STATEMENT_CERTIFICATION",
  "REPORTING_PACK_EXPORT",
  "CLOSE_INSIGHTS",
  "ENTITY_CAPACITY",
  "NAMED_USER_SEATS",
] as const;

export type CapabilityCode = (typeof CAPABILITY_CODES)[number];
export type CapabilityKind = "included" | "paid" | "capacity";

export interface CapabilityDefinition {
  readonly code: CapabilityCode;
  readonly kind: CapabilityKind;
  /** Customer-facing name. */
  readonly name: string;
  readonly description: string;
}

export const CAPABILITIES: Readonly<Record<CapabilityCode, CapabilityDefinition>> = {
  CLOSE_ASSURANCE: {
    code: "CLOSE_ASSURANCE", kind: "included", name: "Close Assurance",
    description: "Always-on integrity checks: validations, readiness checks and statement preview.",
  },
  COMPARATIVE_REPORTING: {
    code: "COMPARATIVE_REPORTING", kind: "included", name: "Comparative Reporting",
    description: "The prior-period comparative your reporting framework requires, in every plan.",
  },
  STATEMENT_CERTIFICATION: {
    code: "STATEMENT_CERTIFICATION", kind: "paid", name: "Close Certification",
    description: "Record a certified close: statement sign-offs and final report versions.",
  },
  REPORTING_PACK_EXPORT: {
    code: "REPORTING_PACK_EXPORT", kind: "paid", name: "Reporting Pack",
    description: "Issue formal deliverables: financial statement PDFs and spreadsheets, filing and client packs.",
  },
  CLOSE_INSIGHTS: {
    code: "CLOSE_INSIGHTS", kind: "paid", name: "Close Insights",
    description: "Advanced analysis: variance and trend interpretation, risk commentary, forecasts and recommendations.",
  },
  ENTITY_CAPACITY: {
    code: "ENTITY_CAPACITY", kind: "capacity", name: "Entity Capacity",
    description: "How many active entities your plan includes.",
  },
  NAMED_USER_SEATS: {
    code: "NAMED_USER_SEATS", kind: "capacity", name: "Named Users",
    description: "How many people may use the account, each with their own sign-in: one included in every plan, plus additional seats on Practice and Firm.",
  },
};

export const PAID_CAPABILITY_CODES = CAPABILITY_CODES.filter((c) => CAPABILITIES[c].kind === "paid");

/** Legacy identifiers (still stored by older callers / rows) and their canonical replacement. */
export const LEGACY_CAPABILITY_ALIASES: Readonly<Record<string, CapabilityCode>> = {
  SAFISHA_PREVIEW: "CLOSE_ASSURANCE",
  HESABU_REPORTING: "CLOSE_ASSURANCE",
  SAFISHA_CERTIFY: "STATEMENT_CERTIFICATION",
  HESABU_EXPORT: "REPORTING_PACK_EXPORT",
  MAONO_INTELLIGENCE: "CLOSE_INSIGHTS",
  MULTI_COMPANY: "ENTITY_CAPACITY",
  MULTI_PERIOD: "COMPARATIVE_REPORTING",
};

export function isCapabilityCode(value: unknown): value is CapabilityCode {
  return typeof value === "string" && (CAPABILITY_CODES as readonly string[]).includes(value);
}

/** Canonical code for a canonical or legacy input; null when unknown (fail closed). */
export function canonicalCapability(value: unknown): CapabilityCode | null {
  if (isCapabilityCode(value)) return value;
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(LEGACY_CAPABILITY_ALIASES, value)) {
    return LEGACY_CAPABILITY_ALIASES[value];
  }
  return null;
}

// Compatibility names for existing importers (billing display, entitlement mirror).
export const FEATURE_CODES = CAPABILITY_CODES;
export type FeatureCode = CapabilityCode;
export const isFeatureCode = isCapabilityCode;
export const FEATURE_DESCRIPTIONS: Readonly<Record<CapabilityCode, string>> = Object.fromEntries(
  CAPABILITY_CODES.map((c) => [c, `${CAPABILITIES[c].name} — ${CAPABILITIES[c].description}`]),
) as Record<CapabilityCode, string>;
