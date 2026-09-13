import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "../../../../../");
const migration = fs.readFileSync(path.join(ROOT,
  "supabase/migrations/20260914000000_omega3_checkout_provider_boundary_repair.sql"), "utf8");
const checkout = fs.readFileSync(path.join(ROOT,
  "supabase/functions/commercial-create-checkout/index.ts"), "utf8");
const flutterwave = fs.readFileSync(path.join(ROOT,
  "supabase/functions/_shared/payments/providers/flutterwave.ts"), "utf8");
const contracts = fs.readFileSync(path.join(ROOT,
  "supabase/functions/_shared/payments/contracts.ts"), "utf8");
const paymentReturn = fs.readFileSync(path.join(ROOT,
  "src/pages/billing/PaymentReturn.tsx"), "utf8");

describe("provider side-effect boundary", () => {
  it("requires PAYMENTS_DISABLED before schema repair", () => {
    expect(migration).toMatch(/IS DISTINCT FROM 'PAYMENTS_DISABLED'/);
    expect(migration).toMatch(/CHECKOUT_REPAIR_REQUIRES_PAYMENTS_DISABLED/);
  });

  it("persists PROVIDER_CREATING before the provider call", () => {
    expect(migration).toMatch(/status IN \('CREATING','PROVIDER_CREATING','PENDING'/);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.begin_provider_checkout_request/);
    expect(migration).toMatch(/SET status='PROVIDER_CREATING', provider_request_started_at=now\(\)/);
    expect(checkout.indexOf("begin_provider_checkout_request")).toBeLessThan(
      checkout.indexOf("adapter.createCheckout("),
    );
  });

  it("only pre-provider CREATING leases are automatically failed", () => {
    const acquire = migration.match(/CREATE OR REPLACE FUNCTION public\.acquire_checkout_attempt[\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(acquire).toMatch(/v_existing\.status = 'CREATING'[\s\S]*?PRE_PROVIDER_LEASE_EXPIRED/);
    const providerCreatingBranch = acquire.match(
      /IF v_existing\.status = 'PROVIDER_CREATING' THEN[\s\S]*?\n {4}END IF;/,
    )?.[0] ?? "";
    expect(providerCreatingBranch).toMatch(/status='MANUAL_REVIEW'/);
    expect(providerCreatingBranch).not.toMatch(/status='FAILED'/);
  });

  it("never auto-expires or replaces a non-reusable PENDING attempt", () => {
    const acquire = migration.match(/CREATE OR REPLACE FUNCTION public\.acquire_checkout_attempt[\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(acquire).toMatch(/v_existing\.status = 'PENDING'[\s\S]*?PENDING_CHECKOUT_NOT_REUSABLE/);
    expect(acquire).toMatch(/PENDING_CHECKOUT_NOT_REUSABLE'[\s\S]*?MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT/);
  });

  it("all provider-result transitions are fenced from PROVIDER_CREATING", () => {
    for (const fn of ["persist_checkout_provider_result", "mark_checkout_attempt_failed", "mark_checkout_attempt_uncertain"]) {
      const body = migration.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}[\\s\\S]*?\\n\\$\\$;`))?.[0] ?? "";
      expect(body).toMatch(/creation_token=p_creation_token/);
      expect(body).toMatch(/status='PROVIDER_CREATING'/);
    }
  });

  it("classifies ambiguous provider responses as UNCERTAIN", () => {
    expect(contracts).toMatch(/outcome: 'DEFINITIVE_FAILURE' \| 'UNCERTAIN'/);
    expect(flutterwave).toMatch(/\[408, 409, 425, 429\]\.includes\(resp\.status\) \|\| resp\.status >= 500/);
    expect(flutterwave).toMatch(/FLUTTERWAVE_CREATE_RESPONSE_MALFORMED/);
    expect(flutterwave).toMatch(/FLUTTERWAVE_CREATE_LINK_MISSING/);
    expect(checkout).toMatch(/checkoutResult\.outcome === 'DEFINITIVE_FAILURE'/);
  });

  it("bounds all Flutterwave HTTP operations", () => {
    expect(flutterwave).toMatch(/const FLW_TIMEOUT_MS = 25_000/);
    expect((flutterwave.match(/signal: AbortSignal\.timeout\(FLW_TIMEOUT_MS\)/g) ?? []).length).toBe(3);
  });

  it("uses one immediate recovery request then a sixty-second cadence", () => {
    expect(paymentReturn).toMatch(/RECOVERY_EVERY_N_POLLS = 20/);
    expect(paymentReturn).toMatch(/count === 1 \|\| count % RECOVERY_EVERY_N_POLLS === 0/);
    expect(paymentReturn).toMatch(/displayPlanName\(status\.planCode\)/);
  });
});
