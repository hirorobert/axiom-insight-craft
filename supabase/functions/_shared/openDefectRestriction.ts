/**
 * _shared/openDefectRestriction.ts — server-side restriction of functions with an OPEN registered defect (R0 release).
 *
 * A function listed here refuses every request before it authenticates, reads or writes anything. The restriction is
 * code, not a setting: it is lifted only by the reviewed change that fixes the defect and removes the entry. It does not
 * depend on the withheld-capability list (capability_customer_available), which hides these services in the product but
 * is not checked by the functions themselves, so a direct call would otherwise reach the defective path.
 *
 *   kinga-findings-engine  DEFECT-KINGA-MAPPING-TENANCY-001 — reads account_mappings by user, not by company, so one
 *                          company's mapping can influence another company's findings.
 *   maono-compute          DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001 — reads account_classifications and
 *                          account_pl_mapping, which no migration creates and no certified authority produces.
 *
 * R0 also WITHHOLDS three services: they are not part of this release, so they refuse every request in the same way,
 * before authentication or any read or write. Their business logic is neither repaired nor enabled here; their recorded
 * defects (CLAUDE.md §9.1, DEFECT-WITHHELD-TAX-NOTES-LETTER-001) are for the reviewed change that releases them, which
 * also removes the entry.
 *
 *   kinga-tax-engine            tax computation
 *   generate-disclosure-notes   disclosure notes
 *   generate-management-letter  management letter
 *
 * The answer names no internal engine or defect (customer-facing copy); the reason is logged server-side only.
 */

// Function slug -> the open defect, by a short neutral key (string values are scanned as possibly customer-visible, so the
// registered ids, which carry internal engine names, live in the comments above and in openDefectRestriction.test.ts).
export const OPEN_DEFECT_RESTRICTIONS: Readonly<Record<string, string>> = Object.freeze({
  "kinga-findings-engine": "mapping-tenancy-001",              // DEFECT-KINGA-MAPPING-TENANCY-001
  "maono-compute": "untracked-classification-tables-001",      // DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001
});

// Function slug -> why it is withheld from this release (neutral key).
export const WITHHELD_SERVICES: Readonly<Record<string, string>> = Object.freeze({
  "kinga-tax-engine": "withheld-r0",
  "generate-disclosure-notes": "withheld-r0",
  "generate-management-letter": "withheld-r0",
});

export const SERVICE_RESTRICTED_BODY = Object.freeze({
  error: "SERVICE_RESTRICTED",
  code: "SERVICE_RESTRICTED",
  message: "This analysis is not available yet.",
});

/** The refusal for a restricted or withheld function, or null when it is neither. */
export function openDefectRefusal(functionName: string, corsHeaders: Record<string, string>): Response | null {
  const defect = OPEN_DEFECT_RESTRICTIONS[functionName];
  const withheld = WITHHELD_SERVICES[functionName];
  if (!defect && !withheld) return null;
  console.warn(defect ? `[${functionName}] refused: restricted while open defect ${defect} is unresolved`
    : `[${functionName}] refused: service withheld from this release (${withheld})`);
  return new Response(JSON.stringify(SERVICE_RESTRICTED_BODY), {
    status: 503,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
