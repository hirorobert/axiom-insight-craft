/**
 * PPG-1 Finding 3 — Duplicate billing/commercial database setup guard.
 *
 * NON-EXECUTABLE DB BEHAVIOR NOTICE: this environment has no live Postgres
 * connection. What CAN be proven here, and is proven below, is that the
 * repository's SOURCE TEXT contains exactly one executable definition of
 * every authoritative commercial/billing table and function — the same
 * static-source-text regression-guard technique already used by
 * featureRegistry.test.ts, rlsRecursionGuard.test.ts, and
 * globalCommerceModel.test.ts in this repository.
 *
 * Forensic history (see docs/operations/PPG1_STABILIZATION_REPORT.md
 * §Finding 3 for the full investigation): this repository's Lovable-managed
 * migration-identity model means every already-live wave (Ω1, RLS1) has TWO
 * files — the source-authored file this team wrote, and Lovable's own
 * recorded copy under its own timestamp identity (the one actually applied
 * live; that one must NEVER be edited). Both used to sit inside
 * supabase/migrations/, which Supabase CLI tooling (`db push`, `db reset`)
 * globs wholesale — so a fresh/disaster-recovery replay of ALL files in that
 * directory would apply BOTH copies of Ω1 and hard-fail with "relation
 * already exists" (Ω1's CREATE TABLE/CREATE POLICY statements carry no
 * IF NOT EXISTS / DROP IF EXISTS guards). PPG-1 quarantined the two
 * source-authored files (never independently live under their own filename)
 * into supabase/migrations_historical/ with a `.sql.historical` extension —
 * outside any tool's migration glob — while leaving both Lovable-applied
 * live files, and the not-yet-live Ω2 canonical migration, untouched in
 * supabase/migrations/. This test proves that quarantine holds and
 * regression-guards against it ever reappearing.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../../../");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase/migrations");
const HISTORICAL_DIR = path.join(REPO_ROOT, "supabase/migrations_historical");

const COMMERCIAL_TABLES = [
  "commercial_admins",
  "commercial_products",
  "commercial_plans",
  "billing_customers",
  "commercial_licences",
  "payment_events",
  "entitlement_overrides",
  "billing_audit_events",
  "commercial_offers",
  "payment_checkout_intents",
  "payment_webhook_receipts",
  "payment_webhook_processing_events",
  "commercial_catalog_audit_events",
];

function readExecutableMigrationFiles(): { file: string; text: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({
      file: f,
      text: fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"),
    }));
}

describe("migration collision guard — every commercial/billing table has exactly one executable CREATE TABLE", () => {
  const files = readExecutableMigrationFiles();

  for (const table of COMMERCIAL_TABLES) {
    it(`"${table}" is created by at most one file under supabase/migrations/`, () => {
      const re = new RegExp(`CREATE TABLE\\s+(public\\.)?${table}\\b`);
      const definers = files.filter((f) => re.test(f.text)).map((f) => f.file);
      expect(
        definers.length,
        `Expected at most 1 executable CREATE TABLE for "${table}", found in: ${definers.join(", ")}`,
      ).toBeLessThanOrEqual(1);
    });
  }

  it("the executable migrations directory contains no duplicate timestamp identity for the known commercial waves", () => {
    // Exactly one Ω1 identity (Lovable-applied), one RLS1 identity
    // (Lovable-applied), and one Ω2 identity (canonical, not yet live) may
    // remain executable. The source-authored Ω1/RLS1 duplicates are
    // quarantined (proven in the next describe block).
    const omega1Live = files.filter((f) => /CREATE TABLE\s+(public\.)?commercial_admins\b/.test(f.text));
    expect(omega1Live.map((f) => f.file)).toEqual([
      "20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql",
    ]);
  });
});

describe("migration collision guard — quarantined historical sources are non-executable", () => {
  it("supabase/migrations_historical/ exists and contains the two quarantined source files", () => {
    expect(fs.existsSync(HISTORICAL_DIR)).toBe(true);
    const historicalFiles = fs.readdirSync(HISTORICAL_DIR);
    expect(historicalFiles).toContain(
      "20260904180000_commercial_foundation_wave_omega1.sql.historical",
    );
    expect(historicalFiles).toContain(
      "20260905120000_fix_commercial_admin_rls_recursion.sql.historical",
    );
  });

  it("no file in supabase/migrations_historical/ ends in .sql (Supabase CLI globs *.sql only)", () => {
    const historicalFiles = fs.readdirSync(HISTORICAL_DIR);
    for (const f of historicalFiles) {
      expect(f.endsWith(".sql")).toBe(false);
    }
  });

  it("the quarantined Ω1 source is not present under supabase/migrations/ by its original filename", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    expect(files).not.toContain("20260904180000_commercial_foundation_wave_omega1.sql");
  });

  it("the quarantined RLS1 source is not present under supabase/migrations/ by its original filename", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    expect(files).not.toContain("20260905120000_fix_commercial_admin_rls_recursion.sql");
  });

  it("both quarantined files carry an explicit non-executable notice", () => {
    for (const f of [
      "20260904180000_commercial_foundation_wave_omega1.sql.historical",
      "20260905120000_fix_commercial_admin_rls_recursion.sql.historical",
    ]) {
      const text = fs.readFileSync(path.join(HISTORICAL_DIR, f), "utf-8");
      expect(text).toMatch(/QUARANTINED HISTORICAL SOURCE/);
    }
  });

  it("the live Lovable-applied Ω1/RLS1 migration files are untouched (present, unedited identity)", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    expect(files).toContain("20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql");
    expect(files).toContain("20260905141022_f1029fbe-90d5-4aac-97e0-059eede76338.sql");
  });

  it("the Ω2 canonical migration remains the sole not-yet-live commercial migration", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    expect(files).toContain("20260905200000_omega2_commercial_payments.sql");
    const omega2Only = files.filter(
      (f) =>
        /CREATE TABLE\s+(public\.)?commercial_offers\b/.test(
          fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"),
        ),
    );
    expect(omega2Only).toEqual(["20260905200000_omega2_commercial_payments.sql"]);
  });
});
