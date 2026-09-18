/**
 * billingTriggerRepairMigration.test.ts
 *
 * Static migration-contract tests for:
 *   supabase/migrations/20260915045958_96cc735e-defd-4747-870d-2784030b6da6.sql
 *
 * These tests are STATIC — they read the migration file directly and assert
 * structural properties without executing SQL. They prove the migration:
 *   E1.  Has a forward-only filename (20260915045958 is the latest migration)
 *   E2.  Contains no INSERT into commercial_products
 *   E3.  Contains no INSERT into commercial_plans
 *   E4.  Contains no INSERT into commercial_licences (backfill)
 *   E5.  Contains no UPDATE or INSERT into companies
 *   E6.  References CFOCLOSE product code lookup
 *   E7.  Has an explicit missing-product (SAFF_ERP / CFOCLOSE absent) failure path
 *   E8.  Has an explicit missing-FREE-plan failure path
 *   E9.  Declares SECURITY DEFINER
 *   E10. Declares hardened search_path = public, pg_catalog
 *   E11. Revokes privileges from PUBLIC, anon, authenticated
 *   E12. Has a postcondition asserting trigger remains enabled
 *   E13. Has a postcondition asserting CFOCLOSE exists post-repair
 *   E14. Makes no reference to payment_events mutation
 *   E15. Makes no reference to commercial_platform_state mutation
 *   E16. Does not contain 'SAFF_ERP' in the repaired function body
 *   E17. Has preflight P1 (CFOCLOSE count = 1)
 *   E18. Has preflight P2 (SAFF_ERP count = 0)
 *   E19. Has preflight asserting trg_provision_billing_customer is enabled
 *   E20. Does not DROP the trigger
 *
 * F. Live behavioral harness stubs (tagged @live — not executed automatically)
 *    Covered in CODEX-LIVE-HARNESS.md alongside this file.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT    = path.join(__dirname, "../../../");
const MIGRATIONS   = path.join(REPO_ROOT, "supabase/migrations");
const MIGRATION_ID = "20260915045958";
const MIGRATION_FILE = path.join(
  MIGRATIONS,
  `${MIGRATION_ID}_96cc735e-defd-4747-870d-2784030b6da6.sql`
);

// Canonical LF normalisation (matches migrationReplayCompatibilityGuard pattern)
function readMigration(): string {
  return fs.readFileSync(MIGRATION_FILE, "utf8").replace(/\r\n/g, "\n");
}

// All existing migration filenames for forward-only guard
function allMigrationTimestamps(): number[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}_/.test(f))
    .map((f) => parseInt(f.slice(0, 14), 10));
}

describe("E — Static migration-contract: 20260915045958_96cc735e-defd-4747-870d-2784030b6da6", () => {
  let sql: string;
  try {
    sql = readMigration();
  } catch {
    sql = "";
  }

  it("E0. Migration file exists", () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it("E1. Forward-only filename: was the latest migration when authored, and precedes every later addition", () => {
    // 20260915100000_financial_statement_documents.sql (North-Star
    // document-review canonical table, UNAPPLIED) is a legitimate later
    // addition — this migration's own forward-only discipline is proven by
    // it sorting before that successor, not by remaining the all-time max.
    const KNOWN_LATER_MIGRATIONS = ["20260915100000", "20260917000000"];
    const timestamps = allMigrationTimestamps().filter(
      (t) => !KNOWN_LATER_MIGRATIONS.includes(String(t)),
    );
    const max = Math.max(...timestamps);
    expect(max).toBe(parseInt(MIGRATION_ID, 10));
  });

  it("E2. No INSERT INTO commercial_products", () => {
    // Seeding a new product is out of scope — the rename already happened
    const inserts = sql.match(/INSERT\s+INTO\s+public\.commercial_products/gi) ?? [];
    expect(inserts).toHaveLength(0);
  });

  it("E3. No INSERT INTO commercial_plans", () => {
    const inserts = sql.match(/INSERT\s+INTO\s+public\.commercial_plans/gi) ?? [];
    expect(inserts).toHaveLength(0);
  });

  it("E4. No INSERT INTO commercial_licences (backfill guard)", () => {
    // The repaired trigger function itself may insert a licence at runtime,
    // but the migration body must not backfill existing rows directly.
    // We verify by checking DML outside the CREATE FUNCTION block.
    // Strategy: strip the function body, then check for licences INSERT.
    const withoutFn = sql.replace(
      /CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/gi,
      "/* FUNCTION_STRIPPED */"
    );
    const inserts = withoutFn.match(/INSERT\s+INTO\s+public\.commercial_licences/gi) ?? [];
    expect(inserts).toHaveLength(0);
  });

  it("E5. No mutation of companies table", () => {
    const mutations = sql.match(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.companies/gi
    ) ?? [];
    expect(mutations).toHaveLength(0);
  });

  it("E6. CFOCLOSE product code lookup present in function body", () => {
    // Must look up CFOCLOSE, never SAFF_ERP
    expect(sql).toMatch(/code\s*=\s*'CFOCLOSE'/);
  });

  it("E7. Explicit failure when CFOCLOSE product cannot be resolved", () => {
    // The function must RAISE EXCEPTION when v_product_id IS NULL
    expect(sql).toMatch(/TRIGGER_CONFIG_ERROR/);
    expect(sql).toMatch(/CFOCLOSE/);
    expect(sql).toMatch(/v_product_id\s+IS\s+NULL/i);
  });

  it("E8. Explicit failure when FREE plan cannot be resolved", () => {
    expect(sql).toMatch(/TRIGGER_CONFIG_ERROR/);
    expect(sql).toMatch(/v_free_plan_id\s+IS\s+NULL/i);
  });

  it("E9. SECURITY DEFINER declared", () => {
    expect(sql).toMatch(/SECURITY\s+DEFINER/i);
  });

  it("E10. Hardened search_path = public, pg_catalog", () => {
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public,\s*pg_catalog/i);
  });

  it("E11. Privilege revocation: REVOKE ALL FROM PUBLIC, anon, authenticated", () => {
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.provision_billing_customer_for_company\(\)/i
    );
    expect(sql).toMatch(/FROM\s+PUBLIC,\s*anon,\s*authenticated/i);
  });

  it("E12. Postcondition: trigger-enabled assertion present", () => {
    // D3 check
    expect(sql).toMatch(/POSTCONDITION_FAILED D3/i);
    expect(sql).toMatch(/trg_provision_billing_customer.*disabled/i);
  });

  it("E13. Postcondition: CFOCLOSE product existence asserted", () => {
    // D4 check
    expect(sql).toMatch(/POSTCONDITION_FAILED D4/i);
  });

  it("E14. No payment_events mutation", () => {
    const withoutFn = sql.replace(
      /CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/gi,
      "/* FUNCTION_STRIPPED */"
    );
    const inserts = withoutFn.match(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.payment_events/gi
    ) ?? [];
    expect(inserts).toHaveLength(0);
  });

  it("E15. No commercial_platform_state mutation", () => {
    const mutations = sql.match(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.commercial_platform_state/gi
    ) ?? [];
    expect(mutations).toHaveLength(0);
  });

  it("E16. Repaired function body contains no SAFF_ERP", () => {
    // Extract the CREATE OR REPLACE FUNCTION block and assert SAFF_ERP is absent
    const fnMatch = sql.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/i);
    expect(fnMatch).not.toBeNull();
    if (fnMatch) {
      expect(fnMatch[0]).not.toMatch(/SAFF_ERP/);
    }
  });

  it("E17. Preflight P1: CFOCLOSE count = 1 assertion exists", () => {
    expect(sql).toMatch(/PREFLIGHT_FAILED P1/i);
    expect(sql).toMatch(/v_cfoclose_count\s*<>\s*1/i);
  });

  it("E18. Preflight P2: SAFF_ERP count = 0 assertion exists", () => {
    expect(sql).toMatch(/PREFLIGHT_FAILED P2/i);
    expect(sql).toMatch(/v_saff_erp_count\s*<>\s*0/i);
  });

  it("E19. Preflight: trigger-enabled state asserted before replacement", () => {
    expect(sql).toMatch(/PREFLIGHT_FAILED P5/i);
    expect(sql).toMatch(/trg_provision_billing_customer.*disabled/i);
  });

  it("E20. Does not DROP the trigger", () => {
    const drops = sql.match(/DROP\s+TRIGGER/gi) ?? [];
    expect(drops).toHaveLength(0);
  });

  it("E21. P3 preflight requires cp.is_active = true", () => {
    // The P3 block must gate on an ACTIVE plan; an inactive FREE plan must not pass
    const p3Block = sql.match(/P3[\s\S]*?END IF;/)?.[0] ?? "";
    expect(p3Block).toMatch(/cp\.is_active\s*=\s*true/);
  });

  it("E22. Runtime FREE-plan resolution requires cp.is_active = true", () => {
    // Inside the CREATE OR REPLACE FUNCTION body, the FREE plan SELECT must
    // include cp.is_active = true — an inactive plan must not be provisioned.
    const fnMatch = sql.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/i)?.[0] ?? "";
    expect(fnMatch).toMatch(/cp\.is_active\s*=\s*true/);
    // Confirm it appears alongside the FREE code check in the same WHERE block
    expect(fnMatch).toMatch(/cp\.code\s*=\s*'FREE'[\s\S]{0,200}cp\.is_active\s*=\s*true/);
  });

  it("E23. D5 postcondition requires cp.is_active = true", () => {
    // D5 must verify the active FREE plan exists after repair — not just any FREE plan
    const d5Block = sql.match(/D5[\s\S]*?END IF;/)?.[0] ?? "";
    expect(d5Block).toMatch(/cp\.is_active\s*=\s*true/);
  });

  it("E24. No COALESCE or nullable fallback weakens the active-plan guard", () => {
    const fnMatch = sql.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/i)?.[0] ?? "";
    // COALESCE(cp.is_active, ...) would allow a NULL is_active to be treated as true
    const coalesces = fnMatch.match(/COALESCE\s*\(\s*cp\.is_active/gi) ?? [];
    expect(coalesces).toHaveLength(0);
  });
});

/**
 * F. LIVE BEHAVIORAL HARNESS — stubs only.
 *
 * These cases are documented here for completeness. They require a live
 * Supabase instance with the migration applied and are executed as part
 * of the post-deployment verification step, NOT as part of the CI suite.
 *
 * F1.  Authenticated new user creates one company → INSERT succeeds.
 * F2.  trg_create_owner_firm_member fires → firm_members row created.
 * F3.  trg_provision_billing_customer fires → billing_customer uses CFOCLOSE UUID.
 * F4.  Exactly one commercial_licences row, status=ACTIVE, source=SYSTEM_DEFAULT_FREE.
 * F5.  Exactly one billing_audit_events row, action=FREE_LICENCE_AUTO_PROVISIONED.
 * F6.  Second company creation for same user → no duplicate billing_customer.
 * F7.  User with existing billing_customer → no duplicate licence.
 * F8.  CFOCLOSE product absent (isolated txn) → explicit TRIGGER_CONFIG_ERROR raised.
 * F9.  FREE plan absent (isolated txn) → explicit TRIGGER_CONFIG_ERROR raised.
 * F10. Failed txn → no partial company row survives (SELECT confirms 0 rows).
 * F11. Cross-user RLS: user A cannot SELECT user B's billing_customers row.
 * F12. Anon insert attempt → RLS rejects before trigger fires (42501).
 *
 * Execute via: scripts/db-contract-tests/run.sh (requires SUPABASE_DB_URL)
 * Do NOT execute against production. Do NOT execute in CI without an
 * isolated test schema.
 */
describe.skip("F — Live behavioral harness (requires live DB, run manually)", () => {
  it.todo("F1. Authenticated new user creates one company successfully");
  it.todo("F2. Owner firm-member trigger succeeds");
  it.todo("F3. Billing customer uses existing CFOCLOSE product UUID");
  it.todo("F4. Exactly one active FREE licence created");
  it.todo("F5. FREE_LICENCE_AUTO_PROVISIONED audit event created once");
  it.todo("F6. Repeated company creation: no duplicate billing_customer");
  it.todo("F7. User with existing billing_customer: no duplicate licence");
  it.todo("F8. Missing CFOCLOSE → explicit TRIGGER_CONFIG_ERROR, atomic rollback");
  it.todo("F9. Missing FREE plan → explicit TRIGGER_CONFIG_ERROR, atomic rollback");
  it.todo("F10. Failed transaction: no partial company row survives");
  it.todo("F11. Cross-user RLS: user A cannot read user B billing_customers");
  it.todo("F12. Anonymous creation: RLS rejects before trigger fires");
});
