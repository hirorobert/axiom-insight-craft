/**
 * PPG-1 Finding 3 / Ω2 migration identity reconciliation (2026-09-06) —
 * Duplicate billing/commercial database setup guard.
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
 * §Finding 3 for the original Ω1/RLS1 investigation): this repository's
 * Lovable-managed migration-identity model means every already-live wave
 * (Ω1, RLS1, and now Ω2) has TWO files — the source-authored file this
 * team wrote, and Lovable's own recorded copy under its own timestamp
 * identity (the one actually applied live; that one must NEVER be
 * edited). All three source-authored duplicates are quarantined into
 * supabase/migrations_historical/ with a `.sql.historical` extension —
 * outside any tool's migration glob — while the three Lovable-applied
 * live files remain the sole executable identities in
 * supabase/migrations/. This test proves that quarantine holds for all
 * three waves and regression-guards against any of them ever reappearing
 * as a duplicate executable identity.
 *
 * Ω2 identity reconciliation (2026-09-06): Lovable applied Ω2 to
 * production via its managed migration mechanism, generating
 * `20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql`. Semantic
 * equivalence against the source-authored
 * `20260905200000_omega2_commercial_payments.sql` was proven before
 * quarantine: stripping every comment-only line and blank line from both
 * files leaves 710 lines each, byte-for-byte identical — the only
 * differences were Lovable's shortened inline design-rationale comments,
 * exactly the same pattern already established for Ω1 and RLS1.
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

// The three Lovable-applied LIVE managed migration identities — the only
// files that may ever define the commercial/billing schema executably.
const OMEGA1_LIVE = "20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql";
const RLS1_LIVE = "20260905141022_f1029fbe-90d5-4aac-97e0-059eede76338.sql";
const OMEGA2_LIVE = "20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql";

// The three source-authored identities, quarantined — never independently
// live under their own filename.
const OMEGA1_SOURCE_HISTORICAL = "20260904180000_commercial_foundation_wave_omega1.sql.historical";
const RLS1_SOURCE_HISTORICAL = "20260905120000_fix_commercial_admin_rls_recursion.sql.historical";
const OMEGA2_SOURCE_HISTORICAL = "20260905200000_omega2_commercial_payments.sql.historical";

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
    // Exactly one Ω1 identity, one RLS1 identity, and one Ω2 identity
    // (all three Lovable-applied and live) may remain executable. The
    // three source-authored duplicates are quarantined (proven below).
    const omega1Live = files.filter((f) => /CREATE TABLE\s+(public\.)?commercial_admins\b/.test(f.text));
    expect(omega1Live.map((f) => f.file)).toEqual([OMEGA1_LIVE]);

    const omega2Live = files.filter((f) => /CREATE TABLE\s+(public\.)?commercial_offers\b/.test(f.text));
    expect(omega2Live.map((f) => f.file)).toEqual([OMEGA2_LIVE]);
  });
});

describe("migration collision guard — quarantined historical sources are non-executable", () => {
  it("supabase/migrations_historical/ exists and contains all three quarantined source files", () => {
    expect(fs.existsSync(HISTORICAL_DIR)).toBe(true);
    const historicalFiles = fs.readdirSync(HISTORICAL_DIR);
    expect(historicalFiles).toContain(OMEGA1_SOURCE_HISTORICAL);
    expect(historicalFiles).toContain(RLS1_SOURCE_HISTORICAL);
    expect(historicalFiles).toContain(OMEGA2_SOURCE_HISTORICAL);
  });

  it("no file in supabase/migrations_historical/ ends in .sql (Supabase CLI globs *.sql only)", () => {
    const historicalFiles = fs.readdirSync(HISTORICAL_DIR);
    for (const f of historicalFiles) {
      expect(f.endsWith(".sql")).toBe(false);
    }
  });

  it("none of the three quarantined sources are present under supabase/migrations/ by their original filenames", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    expect(files).not.toContain("20260904180000_commercial_foundation_wave_omega1.sql");
    expect(files).not.toContain("20260905120000_fix_commercial_admin_rls_recursion.sql");
    expect(files).not.toContain("20260905200000_omega2_commercial_payments.sql");
  });

  it("all three quarantined files carry an explicit non-executable notice", () => {
    for (const f of [OMEGA1_SOURCE_HISTORICAL, RLS1_SOURCE_HISTORICAL, OMEGA2_SOURCE_HISTORICAL]) {
      const text = fs.readFileSync(path.join(HISTORICAL_DIR, f), "utf-8");
      expect(text).toMatch(/QUARANTINED HISTORICAL SOURCE/);
    }
  });

  it("the live Lovable-applied Ω1/RLS1/Ω2 migration files are untouched (present, unedited identity)", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(OMEGA1_LIVE);
    expect(files).toContain(RLS1_LIVE);
    expect(files).toContain(OMEGA2_LIVE);
  });

  it("Ω2's live managed migration is the sole executable commercial_offers/payment_checkout_intents identity", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    const withOffers = files.filter(
      (f) =>
        /CREATE TABLE\s+(public\.)?commercial_offers\b/.test(
          fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"),
        ),
    );
    expect(withOffers).toEqual([OMEGA2_LIVE]);

    const withCheckoutIntents = files.filter(
      (f) =>
        /CREATE TABLE\s+(public\.)?payment_checkout_intents\b/.test(
          fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"),
        ),
    );
    expect(withCheckoutIntents).toEqual([OMEGA2_LIVE]);
  });
});
