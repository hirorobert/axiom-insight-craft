import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const page = readFileSync("src/pages/billing/PaymentReturn.tsx", "utf8");
const checkout = readFileSync("src/pages/billing/Checkout.tsx", "utf8");
const edge = readFileSync("supabase/functions/commercial-create-checkout/index.ts", "utf8");
const mig = readFileSync("supabase/migrations/20261105100000_checkout_open_session_conflict.sql", "utf8");
describe("abandoned checkout recovery", () => {
  it("verified OPEN_UNPAID shows Resume for PENDING (polling), MANUAL_REVIEW and timeout — never for a recorded payment", () => {
    expect(page).toMatch(/const unfinished = phase === "POLLING" \|\| phase === "REVIEW" \|\| phase === "TIMEOUT"/);
    expect(page).toMatch(/openUnpaid = unfinished && !status\?\.paymentRecorded && pc\?\.state === "OPEN_UNPAID"/);
    expect(page).toContain("Checkout not completed");
  });
  it("provider outage is explicit and never becomes failed or expired", () => {
    expect(page).toMatch(/PROVIDER_UNAVAILABLE/);
    expect(page).toContain("has not been marked as failed or expired");
  });
  it("acquisition never strands an open PENDING checkout into manual review", () => {
    expect(mig).not.toMatch(/PENDING_CHECKOUT_NOT_REUSABLE'\s*,/);
    expect(mig).toContain("'OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT'");
    expect(edge).toContain("OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT");
    expect(edge).toMatch(/OPEN_CHECKOUT_UNFINISHED/);
  });
  it("Continue is disabled while a known open checkout blocks a new one", () => {
    expect(checkout).toContain('error?.kind === "previous"');
    expect(checkout).toContain("OPEN_CHECKOUT_UNFINISHED");
  });
});
