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
 * The answer names no internal engine or defect (customer-facing copy); the defect id is logged server-side only.
 */

// Function slug -> the open defect, by a short neutral key (string values are scanned as possibly customer-visible, so the
// registered ids, which carry internal engine names, live in the comments above and in openDefectRestriction.test.ts).
export const OPEN_DEFECT_RESTRICTIONS: Readonly<Record<string, string>> = Object.freeze({
  "kinga-findings-engine": "mapping-tenancy-001",              // DEFECT-KINGA-MAPPING-TENANCY-001
  "maono-compute": "untracked-classification-tables-001",      // DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001
});

export const SERVICE_RESTRICTED_BODY = Object.freeze({
  error: "SERVICE_RESTRICTED",
  code: "SERVICE_RESTRICTED",
  message: "This analysis is not available yet.",
});

/** The refusal for a restricted function, or null when it is not restricted. */
export function openDefectRefusal(functionName: string, corsHeaders: Record<string, string>): Response | null {
  const defect = OPEN_DEFECT_RESTRICTIONS[functionName];
  if (!defect) return null;
  console.warn(`[${functionName}] refused: restricted while open defect ${defect} is unresolved`);
  return new Response(JSON.stringify(SERVICE_RESTRICTED_BODY), {
    status: 503,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
