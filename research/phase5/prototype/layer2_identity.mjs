// Phase 5 prototype — LAYER 2: account identity (isolated adapter; reuses the production rule EXACTLY).
//
// Production facts this mirrors (read-only, not imported — this is an isolated research adapter):
//   - account_key = COALESCE(account_code, normalized_account_name)   (generated column,
//     supabase/migrations/20260703120000_account_mappings_account_key.sql:23-25; identical formula server-side in
//     resolve_account_review_batch and account_review_decisions.review_account_key).
//   - normalizeAccountName  (src/lib/normalizeAccountName.ts:15-21): lower-case, strip punctuation, collapse whitespace.
//   - identity is scoped PER company_id only — no upload/period/DIMENSION axis on account_mappings.
//   - ingestion (tbIngestion.ts) DOES carry a richer identity incl. dimensions ("code:X|cc=Y"); account_mappings collapses
//     it to account_key. Phase 5 keeps both: the ingestion identity (for grouping/relationships) and the mapping key
//     (for reuse against existing account_mappings).
//
// NOTHING here auto-merges "different codes with similar descriptions": when a code is present the key IS the code,
// so two different codes are two different keys even with identical descriptions. Proven in tests/phase5.test.mjs.

/** Mirror of src/lib/normalizeAccountName.ts (the JS copy; the SQL mirror differs only on non-ASCII — documented there). */
export function normalizeAccountName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** account_key = COALESCE(account_code, normalized_account_name). Codeless accounts resolve to the normalized name. */
export function accountKey({ account_code, account_name }) {
  const code = account_code == null ? null : String(account_code).trim();
  return code && code.length > 0 ? code : normalizeAccountName(account_name);
}

/**
 * The richer INGESTION identity (mirrors tbIngestion.ts IngestedAccount.identity): "code:<code>" or "name:<norm>",
 * plus "|<dim>=<value>" per dimension (cost centre / branch / fund / …). Used for relationship detection and to make
 * dimension-split accounts distinguishable at review time — even though account_mappings itself has no dimension axis.
 */
export function ingestionIdentity({ account_code, account_name, dimensions = {} }) {
  const base = account_code != null && String(account_code).trim().length > 0
    ? `code:${String(account_code).trim()}`
    : `name:${normalizeAccountName(account_name)}`;
  const dims = Object.keys(dimensions)
    .sort()
    .map((k) => `|${k}=${String(dimensions[k])}`)
    .join("");
  return base + dims;
}

/** Two accounts are the SAME identity for reuse iff their account_key matches within the same company. Dimensions do
 *  NOT split the mapping key (account_mappings has no dimension axis) but ARE kept on the decision for traceability. */
export function sameMappingIdentity(a, b) {
  return accountKey(a) === accountKey(b);
}
