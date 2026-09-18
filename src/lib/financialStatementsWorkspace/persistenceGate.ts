// financialStatementsWorkspace/persistenceGate.ts — the single switch for
// database-backed persistence of financial-statement reports, evaluations and
// reviewer decisions.
//
// A plain source constant (same discipline as DOCUMENT_REVIEW_ENABLED in
// src/lib/product/outcomes.ts), deliberately not an env var or a runtime
// setting: enabling it requires a reviewed code change, and it must only be
// flipped after (1) supabase/migrations/20260917000000_financial_statement_reports.sql
// has been applied to the target database and (2) the server-side Edge
// Function that fronts the three write RPCs (validateAuth +
// assertCompanyMembership, actor derived from the JWT) has been deployed.
// Neither has happened, so this is false and every persisted write is
// unavailable.
export const FINANCIAL_STATEMENT_PERSISTENCE_ENABLED = false;
