/**
 * Ω1 — canonical premium feature vocabulary.
 *
 * Single source of truth for feature codes referenced by React components,
 * Edge Functions, and (mirrored, DB-enforced) the CHECK constraints on
 * commercial_plans.feature_codes / entitlement_overrides.feature_code in
 * migration 20260904180000_commercial_foundation_wave_omega1.sql. Adding a
 * feature requires updating both this array and that migration's two CHECK
 * constraints — there is deliberately no single shared codegen for the two,
 * since the DB constraint must never silently trust an unreviewed TS change.
 *
 * This registry is presentation/organizational only. It never decides
 * entitlement itself — the server (get_effective_entitlement RPC) does.
 */

export const FEATURE_CODES = [
  "SAFISHA_PREVIEW",
  "SAFISHA_CERTIFY",
  "HESABU_REPORTING",
  "HESABU_EXPORT",
  "MAONO_INTELLIGENCE",
  "MULTI_COMPANY",
  "MULTI_PERIOD",
] as const;

export type FeatureCode = (typeof FEATURE_CODES)[number];

export function isFeatureCode(value: string): value is FeatureCode {
  return (FEATURE_CODES as readonly string[]).includes(value);
}

export const FEATURE_DESCRIPTIONS: Record<FeatureCode, string> = {
  SAFISHA_PREVIEW: "Preview bank reconciliation matches without certifying them.",
  SAFISHA_CERTIFY: "Certify reconciliation results as evidence for statements and tax.",
  HESABU_REPORTING: "View prepared financial statements.",
  HESABU_EXPORT: "Export financial statements and filing packs.",
  MAONO_INTELLIGENCE: "Variance analysis, cash-flow forecasting, and monitoring.",
  MULTI_COMPANY: "Manage more than one company under a single firm licence.",
  MULTI_PERIOD: "Work across more than one open reporting period at a time.",
};
