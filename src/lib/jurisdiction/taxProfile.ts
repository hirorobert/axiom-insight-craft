/**
 * taxProfile — configuration-driven, jurisdiction-neutral tax-profile requirements. Pure.
 *
 * CFOClose is a globally neutral platform. User-facing wording is always generic ("tax identifier", "tax authority",
 * "filing jurisdiction"); jurisdiction-specific FACTS (whether an identifier is required, its shape) live in this
 * registry, never in a screen. A jurisdiction is a persisted, explicit choice — it is never inferred from a currency,
 * a locale or an address. Until one is configured there is nothing a tax profile can be missing.
 */

import type { EngagementCapability } from "@/lib/workspace/mandate";

export interface JurisdictionProfile {
  readonly code: string;
  /** Whether a tax identifier must be on file before tax / filing work. */
  readonly requiresTaxIdentifier: boolean;
  /** Shape of a well-formed identifier once separators are removed (a data fact, never shown as wording). */
  readonly taxIdentifierPattern: RegExp;
}

/** Configuration registry. Add a jurisdiction here; no screen changes. */
export const JURISDICTION_PROFILES: Readonly<Record<string, JurisdictionProfile>> = {
  TZ: { code: "TZ", requiresTaxIdentifier: true, taxIdentifierPattern: /^\d{9}$/ },
};

export const TAX_PROFILE_COPY = {
  identifierLabel: "Tax identifier",
  authorityLabel: "Tax authority",
  jurisdictionLabel: "Filing jurisdiction",
  warning: "Complete the required tax profile in Settings before filing",
} as const;

/** Services whose work needs a tax profile. */
const TAX_OR_FILING: readonly EngagementCapability[] = ["TAX_COMPUTATION", "FILING_PREPARATION"];

export const isPlaceholderIdentifier = (v: string | null | undefined) => !v || /PUT-REAL|placeholder|todo|tbd/i.test(v);

export interface TaxProfileStatus {
  readonly applicable: boolean;
  readonly missing: boolean;
  /** True exactly when the neutral warning may be shown. */
  readonly warn: boolean;
}

/** A warning is shown ONLY when (1) a tax/filing service is active, (2) the configured jurisdiction requires the field, (3) it is missing. */
export function evaluateTaxProfile(input: {
  granted: readonly EngagementCapability[] | null;
  jurisdiction: string | null | undefined;
  taxIdentifier: string | null | undefined;
}): TaxProfileStatus {
  const taxServiceActive = !!input.granted?.some((c) => TAX_OR_FILING.includes(c));
  const profile = input.jurisdiction ? JURISDICTION_PROFILES[input.jurisdiction] : undefined;
  const applicable = taxServiceActive && !!profile?.requiresTaxIdentifier;
  const digits = (input.taxIdentifier ?? "").replace(/[\s-]/g, "");
  const missing = applicable && (isPlaceholderIdentifier(input.taxIdentifier) || !profile!.taxIdentifierPattern.test(digits));
  return { applicable, missing, warn: applicable && missing };
}
