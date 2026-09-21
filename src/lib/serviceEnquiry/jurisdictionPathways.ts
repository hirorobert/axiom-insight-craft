// Jurisdiction capability registry for the tax expert-intake pathway.
//
// This controls PRESENTATION and ROUTING only. It contains no tax law, rates, forms or filing claims, and it deliberately
// does not consult `hasJurisdictionPack` (whether a statutory pack exists internally says nothing about whether a pathway is
// released to the public). A jurisdiction is presented as a private preview only because it is listed here.
//
// Country names are rendered at runtime from ISO codes (Intl.DisplayNames) — the same rule as the rest of the global shell —
// so no jurisdiction is named in this source, and nothing is shown for any country until the user selects one.

import { ISO_REGION_CODES, isJurisdictionCode, jurisdictionName } from "@/lib/jurisdiction/registry";
import { PREVIEW_JURISDICTION_CODE } from "./contract";
import { TAX_TILE_COPY } from "./copy";

export type PathwayKind = "PRIVATE_PREVIEW" | "GENERAL_EXPERT";

interface PathwayDefinition {
  readonly kind: PathwayKind;
  /** Must be one of the service codes accepted by the database (chk_service_enquiries_service). */
  readonly serviceCode: "tax_tanzania_preview" | "tax_general";
}

/** Jurisdictions with a specific pathway. Every other ISO jurisdiction receives the general expert-enquiry pathway. */
export const JURISDICTION_PATHWAYS: Readonly<Record<string, PathwayDefinition>> = {
  [PREVIEW_JURISDICTION_CODE]: { kind: "PRIVATE_PREVIEW", serviceCode: "tax_tanzania_preview" },
};

const GENERAL_PATHWAY: PathwayDefinition = { kind: "GENERAL_EXPERT", serviceCode: "tax_general" };

export interface TaxPathway extends PathwayDefinition {
  readonly code: string;
}

/** null until a valid ISO jurisdiction is explicitly chosen. Never defaults, never infers. */
export function resolveTaxPathway(code: string | null | undefined): TaxPathway | null {
  if (!code || !isJurisdictionCode(code)) return null;
  const definition = Object.prototype.hasOwnProperty.call(JURISDICTION_PATHWAYS, code) ? JURISDICTION_PATHWAYS[code] : GENERAL_PATHWAY;
  return { ...definition, code };
}

export interface PathwayPresentation {
  readonly heading: string;
  readonly stateLabel: string | null;
  readonly disclosure: string;
  readonly actionLabel: string;
  readonly locked: boolean;
}

export function pathwayPresentation(pathway: TaxPathway, locale = "en"): PathwayPresentation {
  const name = jurisdictionName(pathway.code, locale);
  if (pathway.kind === "PRIVATE_PREVIEW") {
    return {
      heading: `${name} expert assessment — private preview`,
      stateLabel: TAX_TILE_COPY.previewState,
      disclosure: TAX_TILE_COPY.previewDisclosure,
      actionLabel: `Request ${name} assessment →`,
      locked: true,
    };
  }
  return { heading: name, stateLabel: null, disclosure: TAX_TILE_COPY.generalDisclosure, actionLabel: TAX_TILE_COPY.generalAction, locked: false };
}

export interface CountryOption {
  readonly code: string;
  readonly name: string;
}

/** Every ISO jurisdiction, alphabetically by localised name. No country is emphasised or pre-selected. */
export function countryOptions(locale = "en"): CountryOption[] {
  return ISO_REGION_CODES.map((code) => ({ code, name: jurisdictionName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale));
}
