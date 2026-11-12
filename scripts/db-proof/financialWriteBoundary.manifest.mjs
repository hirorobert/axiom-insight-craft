// The reviewed case manifest of scripts/db-proof/financialWriteBoundary.mjs (20261221100000_financial_table_member_write_revocation.sql;
// second-pass hostile validation 2026-11-11 S2-S01, S2-S03, S2-S04). The structured result is validated by scripts/ci/validateProofResult.mjs.
//   present: the chain up to main, the demonstrations BEFORE, then 20261221100000 (under lock contention), then every AFTER case passes;
//   absent:  the same world WITHOUT 20261221100000 — every weakness case must FAIL (the defect is real on main), every control still passes.
export const PROOF = "financialWriteBoundary";
export const MIGRATION = "20261221100000_financial_table_member_write_revocation.sql";
const setup = (id) => ({ id, kind: "setup", modes: ["present", "absent"] });
const control = (id, modes = ["present", "absent"]) => ({ id, kind: "control", modes });
const weakness = (id) => ({ id, kind: "weakness", modes: ["present", "absent"] });

/** Server-written only after the migration (A). */
export const SERVER_TABLES = Object.freeze([
  "period_closing_balances", "statement_sign_offs", "tax_losses", "account_pl_mapping",
  "variance_runs", "variance_analyses", "cashflow_forecasts", "maono_insights", "board_packs",
  "filing_obligations", "safisha_reconciliations", "safisha_transactions", "safisha_exceptions",
  "efdms_z_reports", "efdms_reconciliation", "efdms_records", "canonical_financial_records", "ingestion_batches",
]);
/** Professional input, kept and tightened (B). */
export const INPUT_TABLES = Object.freeze(["variance_budgets", "variance_materiality", "variance_alerts"]);

export const CASES = Object.freeze([
  setup("setup.chain-to-main-two-workspaces-five-members-each-and-a-row-in-every-table"),
  // BEFORE (main): the defect, demonstrated directly through the authenticated role
  control("before.every-server-written-table-accepts-a-direct-member-write"),
  control("before.an-invited-not-accepted-member-writes-period-closing-balances"),
  control("before.an-invited-not-accepted-member-submits-a-budget-and-rewrites-an-alert"),
  control("before.cross-tenant-reads-and-writes-are-refused"),
  // the migration itself (present mode only)
  control("migration.behind-a-long-transaction-it-fails-on-lock-timeout-and-changes-nothing", ["present"]),
  control("migration.behind-a-short-transaction-it-waits-then-completes", ["present"]),
  control("migration.every-table-is-byte-identical-across-the-migration", ["present"]),
  control("migration.a-second-application-is-refused", ["present"]),
  // AFTER: the boundary
  weakness("after.no-member-role-can-insert-update-or-delete-a-server-written-table"),
  weakness("after.client-roles-hold-no-write-class-privilege-at-table-or-column-level"),
  weakness("after.no-client-write-policy-remains-on-a-server-written-table"),
  weakness("after.budget-submission-needs-an-accepted-member-holding-prepare-close"),
  weakness("after.an-alert-can-only-be-acknowledged-once-by-a-review-close-holder-as-themselves"),
  control("after.members-still-read-what-they-could-read"),
  control("after.cross-tenant-reads-and-writes-are-refused"),
  control("after.the-service-role-still-writes-every-table"),
  control("after.materiality-stays-review-close-professional-input"),
]);
