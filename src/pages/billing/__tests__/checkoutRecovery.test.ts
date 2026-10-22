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
  it("only an ordinary PENDING checkout is offered for closing on the order page; a review case only Resume", () => {
    expect(page).toMatch(/const canLeave = openUnpaid && status\?\.status === "PENDING"/);
    expect(page).toMatch(/\{canLeave && saffRef && \(\s*<LeaveCheckout/);
  });
  it("before refusing a new checkout the server re-verifies the blocking one once — a review case only when it carries NO recorded payment, and only an unpaid final state releases it", () => {
    const fn = edge.slice(edge.indexOf("async function blockingCheckoutClosed"));
    expect(edge).toMatch(/blockingAction === 'OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT' \|\| blockingAction === 'MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT'/);
    expect(fn).toMatch(/\['PENDING', 'MANUAL_REVIEW'\]\.includes\(intent\.status\)/);
    expect(fn).toMatch(/if \(intent\.status === 'MANUAL_REVIEW'\) \{[\s\S]*?\.eq\('event_type', 'PAYMENT_CONFIRMED'\)[\s\S]*?if \(!paid \|\| paid\.length > 0\) return false;/);
    expect(fn.indexOf("claim_verification_attempt")).toBeLessThan(fn.indexOf("settleIntent("));
    expect(fn).toMatch(/\['EXPIRED', 'FAILED', 'CANCELLED'\]\.includes\(/);
    expect(fn).not.toMatch(/SUCCEEDED/);
  });
});
