/**
 * jurisdiction registry — the ONE place global code learns about filing jurisdictions. Pure, no I/O.
 *
 * Rules (each enforced by a test):
 *   - A filing jurisdiction is an explicit, persisted choice. It is never inferred from a currency, locale, browser
 *     location, company name or legacy data.
 *   - Tax computation, compliance review and filing preparation are unavailable until one is selected, and only
 *     "available" for a jurisdiction that ships a pack (the server enforces the first half; the pack manifest below the second).
 *   - Country names are rendered at runtime from ISO codes (Intl.DisplayNames). No jurisdiction is named in global source.
 *   - Which jurisdictions ship a statutory pack is a manifest of CODES only. A pack's code and terminology live behind a
 *     dynamic import in `packLoader.ts` and are never imported statically by global code.
 */

import type { EngagementCapability } from "@/lib/workspace/mandate";

/** ISO 3166-1 alpha-2 officially assigned codes. */
export const ISO_REGION_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

/** Display name for a jurisdiction code, from the runtime's locale data. Falls back to the code. */
export function jurisdictionName(code: string, locale = "en"): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const isJurisdictionCode = (v: unknown): v is string => typeof v === "string" && ISO_REGION_CODES.includes(v);

/** Services whose work is defined by a tax authority's rules. Mirrors the database function capability_needs_jurisdiction. */
export const JURISDICTION_DEPENDENT: readonly EngagementCapability[] = ["TAX_COMPUTATION", "COMPLIANCE_REVIEW", "FILING_PREPARATION"];
export const needsJurisdiction = (cap: EngagementCapability) => JURISDICTION_DEPENDENT.includes(cap);

/**
 * Manifest of jurisdictions that ship a statutory pack (CODES ONLY). Adding a pack = adding its code here and a loader in
 * packLoader.ts; nothing else in global code changes.
 */
export const PACK_CODES: readonly string[] = ["TZ"];
export const hasJurisdictionPack = (code: string | null | undefined): boolean => !!code && PACK_CODES.includes(code);

export type ServiceAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: "JURISDICTION_REQUIRED" | "NO_PACK"; readonly message: string };

export function serviceAvailability(cap: EngagementCapability, jurisdiction: string | null | undefined): ServiceAvailability {
  if (!needsJurisdiction(cap)) return { available: true };
  if (!jurisdiction) return { available: false, reason: "JURISDICTION_REQUIRED", message: "Select the filing jurisdiction to enable this service." };
  if (!hasJurisdictionPack(jurisdiction)) return { available: false, reason: "NO_PACK", message: "This service is not yet available for the selected filing jurisdiction." };
  return { available: true };
}
