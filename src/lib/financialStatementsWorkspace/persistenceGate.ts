// financialStatementsWorkspace/persistenceGate.ts — the single switch for
// database-backed persistence of financial-statement reports, evaluations and
// reviewer decisions.
//
// A plain source constant (same discipline as DOCUMENT_REVIEW_ENABLED in
// src/lib/product/outcomes.ts), deliberately not an env var or a runtime
// setting: enabling it requires a reviewed code change.
//
// This branch contains NO database schema, NO Edge Function and NO write path.
// The SQL persistence candidate (tables, RPCs, RLS and its security tests) is
// preserved separately on the branch `codex/financial-statements-persistence-candidate` and is
// NOT part of this change. Do not flip this constant until that candidate has
// been independently reviewed and applied through the project's managed
// migration path, and a server-side function that calls it with the caller's
// own JWT exists. Until then every write is refused before any network call.
export const FINANCIAL_STATEMENT_PERSISTENCE_ENABLED = false;
