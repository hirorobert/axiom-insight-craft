import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatLicenceDate } from "../../billingDisplay";

const ROOT = path.join(__dirname, "../../../../../");
const migrationPath = path.join(
  ROOT,
  "supabase/migrations/20260914120000_omega5_billing_projection_truth.sql",
);
const migration = fs.readFileSync(migrationPath, "utf8");
const settings = fs.readFileSync(path.join(ROOT, "src/pages/Settings.tsx"), "utf8");
const paymentReturn = fs.readFileSync(path.join(ROOT, "src/pages/billing/PaymentReturn.tsx"), "utf8");
const rpc = fs.readFileSync(path.join(ROOT, "src/lib/commercial/commercialRpc.ts"), "utf8");

describe("Ω5 billing projection truth — forward-only migration", () => {
  it("exists and sorts before the subsequent trigger-repair migration", () => {
    const files = fs.readdirSync(path.join(ROOT, "supabase/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const thisFile  = "20260914120000_omega5_billing_projection_truth.sql";
    const nextFile  = "20260915045958_96cc735e-defd-4747-870d-2784030b6da6.sql";
    expect(files).toContain(thisFile);
    expect(files).toContain(nextFile);
    expect(files.indexOf(thisFile)).toBeLessThan(files.indexOf(nextFile));
  });

  it("changes projection functions only and never mutates commercial rows", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.get_my_billing_summary\(\)/);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.get_checkout_status\(p_saff_reference TEXT\)/);
    expect(migration).not.toMatch(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\./i);
    expect(migration).not.toMatch(/commercial_platform_state[\s\S]*?SET\s+state/i);
  });

  it("preserves SECURITY DEFINER, fixed search paths, and authenticated-only grants", () => {
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(migration.match(/SET search_path = public, pg_catalog/g)).toHaveLength(2);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.get_my_billing_summary\(\) FROM PUBLIC, anon;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_my_billing_summary\(\) TO authenticated;/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.get_checkout_status\(TEXT\) FROM PUBLIC, anon;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_checkout_status\(TEXT\) TO authenticated;/);
  });
});

describe("exact checkout-to-licence projection", () => {
  it("binds the purchased licence through the exact checkout's PAYMENT_CONFIRMED event", () => {
    expect(migration).toMatch(/pe\.checkout_intent_id = v_intent\.id/);
    expect(migration).toMatch(/pe\.event_type = 'PAYMENT_CONFIRMED'/);
    expect(migration).toMatch(/JOIN public\.commercial_licences cl ON cl\.id = pe\.licence_id/);
  });

  it("returns purchased fields without changing the existing current-licence fields", () => {
    for (const key of [
      "purchased_licence_id",
      "purchased_licence_status",
      "purchased_effective_start",
      "purchased_effective_end",
    ]) {
      expect(migration).toContain(`'${key}'`);
      expect(rpc).toContain(key);
    }
    expect(paymentReturn).toMatch(/purchasedEffectiveEnd \?\? status\?\.effectiveEnd/);
  });
});

describe("current versus future prepaid terms", () => {
  it("returns explicitly named current, scheduled-horizon, and next-term fields", () => {
    for (const key of [
      "effective_end",
      "scheduled_effective_end",
      "next_effective_start",
      "next_effective_end",
      "next_billing_interval",
      "next_billing_interval_count",
    ]) {
      expect(migration).toContain(`'${key}'`);
    }
  });

  it("Settings presents the next term separately rather than relabeling it current", () => {
    expect(settings).toContain("Prepaid extension scheduled");
    expect(settings).toContain("billing.nextEffectiveStart");
    expect(settings).toContain("billing.nextEffectiveEnd");
  });

  it("uses unambiguous UTC-stable customer dates", () => {
    expect(formatLicenceDate("2027-10-06T12:50:32.999639+00:00")).toBe("6 Oct 2027");
    expect(formatLicenceDate("not-a-date")).toBe("Date unavailable");
    expect(settings).not.toMatch(/effectiveEnd\)\.toLocaleDateString/);
    expect(paymentReturn).not.toMatch(/effectiveEnd\)\.toLocaleDateString/);
  });
});

describe("terminal pricing verification states", () => {
  it("neither checkout surface can leave UNAVAILABLE mapped to VERIFYING", () => {
    expect(settings).toMatch(/renewalPricingVerification === "UNAVAILABLE"/);
    expect(settings).toContain("renewal is currently unavailable");
  });
});
