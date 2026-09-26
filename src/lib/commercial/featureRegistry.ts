/**
 * CFO Close — canonical capability vocabulary (20260925100000_global_capabilities_entitlements_pricing.sql).
 *
 * Mirrors public.commercial_capabilities and public.commercial_capability_aliases. The database is the authority
 * (authorize_paid_action / the walls); this registry is presentation only and never decides anything itself.
 * Adding a capability requires the same change in a new migration — src/lib/commercial/featureRegistry.test.ts
 * holds the two in lockstep.
 *
 * Kinds:
 *   included  included in every plan, never charged separately — but never free: with no current plan it is
 *             refused like any other (Close Assurance, Comparative Reporting; 20260925130000)
 *   paid      a NEW action of this kind needs a plan that includes it (Close Certification, Reporting Pack,
 *             Close Insights). Existing records stay readable whatever the plan.
 *   capacity  a number per plan, not an action (Entity Capacity)
 *   feature   a plan feature from the plan x capability matrix (PLAN_FEATURES below; 20260925130000)
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
export type CapabilityKind = "included" | "paid" | "capacity" | "feature";

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
    description: "Integrity checks: validations, readiness checks and statement preview. Included in every plan.",
  },
  COMPARATIVE_REPORTING: {
    code: "COMPARATIVE_REPORTING", kind: "included", name: "Comparative Reporting",
    description: "The prior-period comparative your reporting framework requires. Included in every plan, never charged separately.",
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

/** Plan features (kind "feature"): mirrors the rows 20260925130000 adds to public.commercial_capabilities. */
export const PLAN_FEATURE_CODES = [
  "CLEAN_PDF",
  "EXCEL_EXPORT",
  "FILING_PACKS",
  "MANAGEMENT_LETTERS",
  "MULTI_ENTITY_REPORTING",
  "CONSOLIDATION",
  "REGIONAL_PACKS",
] as const;
export type PlanFeatureCode = (typeof PLAN_FEATURE_CODES)[number];

export const PLAN_FEATURES: Readonly<Record<PlanFeatureCode, { readonly code: PlanFeatureCode; readonly kind: "feature"; readonly name: string; readonly description: string }>> = {
  CLEAN_PDF: { code: "CLEAN_PDF", kind: "feature", name: "Clean PDF", description: "Official PDF deliverables without the draft marking." },
  EXCEL_EXPORT: { code: "EXCEL_EXPORT", kind: "feature", name: "Excel", description: "Official spreadsheet and data exports." },
  FILING_PACKS: { code: "FILING_PACKS", kind: "feature", name: "XBRL and regional filing packs", description: "Official filing packs, including XBRL instances." },
  MANAGEMENT_LETTERS: { code: "MANAGEMENT_LETTERS", kind: "feature", name: "Management letters", description: "Official management letters." },
  MULTI_ENTITY_REPORTING: { code: "MULTI_ENTITY_REPORTING", kind: "feature", name: "Multi-entity reporting", description: "Reporting across more than one active entity." },
  CONSOLIDATION: { code: "CONSOLIDATION", kind: "feature", name: "Consolidation", description: "Group consolidation. Not offered on any plan." },
  REGIONAL_PACKS: { code: "REGIONAL_PACKS", kind: "feature", name: "Regional packs", description: "Jurisdiction-specific statutory packs." },
};

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
