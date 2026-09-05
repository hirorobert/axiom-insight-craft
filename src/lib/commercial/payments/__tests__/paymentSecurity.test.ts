/**
 * Ω2 Test Matrix — Section 2: Security Invariants
 * Tests the Iron Dome payment authority rules:
 *   NEVER: button click → paid=true
 *   NEVER: browser callback → premium entitlement
 *   NEVER: provider webhook payload → trusted without independent verification
 *   NEVER: payment row → accounting/professional authority
 */

import { describe, it, expect } from "vitest";
import {
  COMMERCIAL_AUTHORITY_INVARIANTS,
  OMEGA2_NORTH_STAR,
  ACCOUNTING_TABLES_NEVER_TOUCHED_BY_COMMERCIAL,
} from "../paymentAuthority";

describe("Iron Dome — Payment Authority Constants", () => {
  it("OMEGA2_NORTH_STAR is defined and correct", () => {
    expect(OMEGA2_NORTH_STAR).toBe("NORTH_STAR_READY");
  });

  it("NEVER rule 1 — button click → paid=true is explicitly prohibited", () => {
    const rule = COMMERCIAL_AUTHORITY_INVARIANTS.find(
      (r) => r.code === "NEVER_BUTTON_PAID_TRUE",
    );
    expect(rule).toBeDefined();
    expect(rule?.enforced_by).toContain("commit_verified_commercial_payment");
  });

  it("NEVER rule 2 — browser callback → premium entitlement is prohibited", () => {
    const rule = COMMERCIAL_AUTHORITY_INVARIANTS.find(
      (r) => r.code === "NEVER_BROWSER_CALLBACK_ENTITLEMENT",
    );
    expect(rule).toBeDefined();
    expect(rule?.enforced_by).toContain("PaymentReturn");
  });

  it("NEVER rule 3 — unverified webhook payload is prohibited", () => {
    const rule = COMMERCIAL_AUTHORITY_INVARIANTS.find(
      (r) => r.code === "NEVER_UNVERIFIED_WEBHOOK",
    );
    expect(rule).toBeDefined();
    expect(rule?.enforced_by).toContain("Gate A");
    expect(rule?.enforced_by).toContain("Gate B");
  });

  it("NEVER rule 4 — payment row is not accounting authority", () => {
    const rule = COMMERCIAL_AUTHORITY_INVARIANTS.find(
      (r) => r.code === "NEVER_PAYMENT_ROW_ACCOUNTING_AUTHORITY",
    );
    expect(rule).toBeDefined();
  });

  it("accounting tables are never touched by commercial layer", () => {
    // No commercial RPC should ever write to accounting/professional tables
    const forbidden = ACCOUNTING_TABLES_NEVER_TOUCHED_BY_COMMERCIAL;
    expect(forbidden).toContain("tax_computations");
    expect(forbidden).toContain("engine_runs");
    expect(forbidden).toContain("account_mappings");
    expect(forbidden).toContain("statement_sign_offs");
  });
});

describe("Provider-neutral adapter — Pesapal portability", () => {
  it("PaymentProvider union includes PESAPAL", async () => {
    // Structural check: the type union must include PESAPAL without code changes
    const { SUPPORTED_PROVIDERS } = await import("../paymentAuthority");
    expect(SUPPORTED_PROVIDERS).toContain("PESAPAL");
    expect(SUPPORTED_PROVIDERS).toContain("FLUTTERWAVE");
    expect(SUPPORTED_PROVIDERS).toContain("SELCOM");
  });
});

describe("Tri-state entitlement — UNKNOWN ≠ NOT_ENTITLED ≠ ENTITLED", () => {
  it("entitlement statuses are three distinct values", async () => {
    const { EntitlementStatus } = await import("../../entitlementContract");
    const statuses = Object.values(EntitlementStatus);
    expect(statuses).toContain("ENTITLED");
    expect(statuses).toContain("NOT_ENTITLED");
    expect(statuses).toContain("UNKNOWN");
    expect(new Set(statuses).size).toBeGreaterThanOrEqual(3);
  });
});
