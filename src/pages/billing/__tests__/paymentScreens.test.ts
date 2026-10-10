// @vitest-environment jsdom
/**
 * The customer payment screens and the administrator screen, mounted for real (jsdom) against mocked server answers.
 * Expected behaviour is written from the requirements: what is being bought and the total; pending / received / failed
 * / cancelled / expired; whether access is active or still being set up; a next action that never asks for a second
 * payment while one may still be valid; receipt references; and an administrator screen that refuses non-administrators.
 */
import { act, createElement as h } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";

const { auth, client, rpcMod, supabaseRpc } = vi.hoisted(() => ({
  auth: { user: { id: "u1", email: "owner@example.test" } as unknown, loading: false },
  client: {
    getCheckoutOptions: vi.fn(),
    startCheckout: vi.fn(),
    rememberCheckoutPlan: vi.fn(),
    getMyPayments: vi.fn(async () => []),
    usePublicPlanPrices: () => null,
  },
  rpcMod: { pollCheckoutStatus: vi.fn(), requestPaymentVerificationRecovery: vi.fn(), callCommercialRpc: vi.fn(async () => ({ data: [], error: null })) },
  supabaseRpc: vi.fn(),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ ...auth, session: null, signOut: async () => undefined }) }));

vi.mock("@/lib/commercial/checkoutClient", () => client);

vi.mock("@/lib/commercial/commercialRpc", () => rpcMod);

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => supabaseRpc(...a), auth: { getSession: async () => ({ data: { session: null } }), signOut: async () => ({ error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }) } } }));

import Checkout from "@/pages/billing/Checkout";
import PaymentReturn from "@/pages/billing/PaymentReturn";
import CommercialAdmin from "@/pages/commercial/CommercialAdmin";

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
let where = "";
function Where() { where = useLocation().pathname + useLocation().search; return null; }
const at = (path: string, el: ReturnType<typeof h>) => h(MemoryRouter, { initialEntries: [path] }, h(Routes, null,
  h(Route, { path: "*", element: h("div", null, el, h(Where)) })));
const textOf = (m: Mounted) => m.container.textContent ?? "";
const byTestId = (m: Mounted, id: string) => m.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

let m: Mounted | null = null;
beforeEach(() => { auth.user = { id: "u1", email: "owner@example.test" }; vi.clearAllMocks(); });
afterEach(() => { m?.unmount(); m = null; vi.useRealTimers(); });

const BOTH = {
  planCode: "SOLO", platformState: "CUSTOMER_PAYMENTS_ENABLED", placement: { kind: "NEW" },
  options: [
    { paymentRoute: "CARD", available: true, provider: "POLAR", environment: "production", amountMinor: 49000, currencyCode: "USD", currencyExponent: 2 },
    { paymentRoute: "MOBILE_MONEY", available: true, provider: "SNIPPE", environment: "production", amountMinor: 1250000, currencyCode: "TZS", currencyExponent: 0 },
  ],
};

describe("checkout", () => {
  it("signed out: asks to create an account or sign in, remembering only the plan", async () => {
    auth.user = null;
    m = mount(at("/billing/checkout?plan=solo", h(Checkout)));
    expect(textOf(m)).toContain("Create an account or sign in to continue");
    click(byTestId(m, "checkout-sign-up")!);
    expect(client.rememberCheckoutPlan).toHaveBeenCalledWith("SOLO");
    expect(client.getCheckoutOptions).not.toHaveBeenCalled();
  });

  it("an unknown plan in the link is refused (never a guessed plan)", async () => {
    m = mount(at("/billing/checkout?plan=ENTERPRISE", h(Checkout)));
    expect(textOf(m)).toContain("Choose a plan first");
  });

  it("shows what is bought and the server's own price on each route; the total follows the chosen route", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: BOTH, error: null });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    const t = textOf(m);
    expect(t).toContain("Solo plan · 12 months");
    expect(t).toContain("12 months, no automatic renewal");
    expect(t).toContain("Card · USD 490");
    expect(t).toContain("Mobile money · TZS 1,250,000");
    expect(t).toContain("starts as soon as the payment is verified");
    expect(byTestId(m, "checkout-total")).toBeNull();
    click(byTestId(m, "route-CARD")!.querySelector("input")!);
    expect(byTestId(m, "checkout-total")!.textContent).toContain("USD 490 + any sales tax");
    expect(await axeViolations(m.container)).toEqual([]);
  });

  it("mobile money: an invalid number is refused before anything is sent; a valid one starts the payment and opens the order's status page", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: BOTH, error: null });
    client.startCheckout.mockResolvedValue({ ok: true, saffReference: "SAFF-1-ABC", checkoutUrl: "https://cfoclose.com/billing/payment/return?ref=SAFF-1-ABC", provider: "SNIPPE", paymentRoute: "MOBILE_MONEY", reused: false });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    click(byTestId(m, "route-MOBILE_MONEY")!.querySelector("input")!);
    typeInto(byTestId(m, "checkout-phone") as HTMLInputElement, "12345");
    click(byTestId(m, "checkout-continue")!);
    await flush();
    expect(client.startCheckout).not.toHaveBeenCalled();
    expect(textOf(m)).toContain("Enter a mobile money number on +255");
    typeInto(byTestId(m, "checkout-phone") as HTMLInputElement, "0712 345 678");
    click(byTestId(m, "checkout-continue")!);
    await flush();
    expect(client.startCheckout).toHaveBeenCalledTimes(1);
    expect(client.startCheckout).toHaveBeenCalledWith("SOLO", "MOBILE_MONEY", "0712 345 678");
    expect(where).toBe("/billing/payment/return?ref=SAFF-1-ABC");
  });

  it("card: the browser goes to the provider's https page; the request carries no price", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: BOTH, error: null });
    client.startCheckout.mockResolvedValue({ ok: true, saffReference: "SAFF-2", checkoutUrl: "https://sandbox.polar.sh/checkout/x", provider: "POLAR", paymentRoute: "CARD", reused: false });
    const assign = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, configurable: true });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    click(byTestId(m, "route-CARD")!.querySelector("input")!);
    click(byTestId(m, "checkout-continue")!);
    await flush();
    expect(client.startCheckout).toHaveBeenCalledWith("SOLO", "CARD", null);
    expect(assign).toHaveBeenCalledWith("https://sandbox.polar.sh/checkout/x");
  });

  it("an uncertain outcome never invites a second payment: it points to the order to check", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: BOTH, error: null });
    client.startCheckout.mockResolvedValue({ ok: false, error: "CHECKOUT_OUTCOME_UNCERTAIN: please contact support before retrying.", saffReference: "SAFF-3" });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    click(byTestId(m, "route-CARD")!.querySelector("input")!);
    click(byTestId(m, "checkout-continue")!);
    await flush();
    const err = byTestId(m, "checkout-error")!;
    expect(err.textContent).toContain("Do not pay again");
    expect(err.querySelector("a")!.getAttribute("href")).toBe("/billing/payment/return?ref=SAFF-3");
  });

  it("an earlier unresolved attempt is opened, not replaced", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: BOTH, error: null });
    client.startCheckout.mockResolvedValue({ ok: false, error: "CHECKOUT_REQUIRES_SUPPORT: a prior attempt …", saffReference: "SAFF-OLD" });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    click(byTestId(m, "route-CARD")!.querySelector("input")!);
    click(byTestId(m, "checkout-continue")!);
    await flush();
    expect(byTestId(m, "checkout-error")!.textContent).toContain("earlier payment attempt");
    expect(byTestId(m, "checkout-error")!.querySelector("a")!.getAttribute("href")).toBe("/billing/payment/return?ref=SAFF-OLD");
  });

  it("no open route: manual activation is offered for that plan; a blocked plan change is sent to the team", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: { ...BOTH, options: [{ paymentRoute: "CARD", available: false, reason: "NO_PURCHASABLE_OFFER" }, { paymentRoute: "MOBILE_MONEY", available: false, reason: "NO_PURCHASABLE_OFFER" }] }, error: null });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    expect(textOf(m)).toContain("Online payment is not open for this plan yet.");
    expect(byTestId(m, "checkout-request-activation")!.getAttribute("href")).toBe("/contact?service=plan_activation&plan=SOLO&from=plan_wall");
    expect(byTestId(m, "checkout-continue")).toBeNull();
    m.unmount();
    client.getCheckoutOptions.mockResolvedValue({ data: { ...BOTH, placement: { kind: "BLOCKED_OPEN_ENDED" } }, error: null });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    expect(textOf(m)).toContain("needs to be arranged with our team");
    expect(byTestId(m, "checkout-continue")).toBeNull();
  });

  it("renewal and downgrade say when the new term starts; an upgrade discloses that unused time is not refunded automatically; sandbox is labelled", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: { ...BOTH, placement: { kind: "AT_RENEWAL", start: "2027-03-01T00:00:00Z" }, options: [{ ...BOTH.options[0], environment: "sandbox" }] }, error: null });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    expect(byTestId(m, "checkout-placement")!.textContent).toContain("starts on 1 March 2027");
    expect(byTestId(m, "checkout-test-mode")!.textContent).toContain("no real money is charged");
    m.unmount();
    client.getCheckoutOptions.mockResolvedValue({ data: { ...BOTH, placement: { kind: "UPGRADE" } }, error: null });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    expect(byTestId(m, "checkout-placement")!.textContent).toContain("not refunded automatically");
  });
});

const statusBase = {
  found: true, planCode: "SOLO", purchasedPlanCode: "SOLO", licenceStatus: "ACTIVE", effectiveStart: null, effectiveEnd: null, billingInterval: "ANNUAL", billingIntervalCount: 1,
  purchasedLicenceId: null, purchasedLicenceStatus: null, purchasedEffectiveStart: null, purchasedEffectiveEnd: null, provider: "POLAR",
  expectedAmountMinor: 49000, currencyCode: "USD", currencyExponent: 2, createdAt: "2026-10-10T08:00:00Z", expiresAt: null,
  paymentRecorded: false, paymentReference: null, paidAt: null, reversalType: null, reviewReason: null, recovery: null, correlationId: "c",
};
const showStatus = async (s: Record<string, unknown>) => {
  rpcMod.requestPaymentVerificationRecovery.mockResolvedValue({ data: { ...statusBase, ...s }, throttled: false, retryAfterSeconds: null, error: null });
  rpcMod.pollCheckoutStatus.mockResolvedValue({ data: { ...statusBase, ...s }, error: null });
  m = mount(at("/billing/payment/return?ref=SAFF-9", h(PaymentReturn)));
  await flush();
  return m;
};

describe("payment status page", () => {
  it("received: the plan, amount, references, active access until its end, the receipt source, and the next step", async () => {
    await showStatus({ status: "SUCCEEDED", paymentRecorded: true, paymentReference: "order-77", paidAt: "2026-10-10T08:01:00Z",
      purchasedLicenceId: "l1", purchasedEffectiveStart: "2026-10-10T08:01:00Z", purchasedEffectiveEnd: "2027-10-10T08:01:00Z" });
    const t = textOf(m!);
    expect(t).toContain("Payment received");
    expect(t).toContain("USD 490 + any sales tax");
    expect(t).toContain("SAFF-9");
    expect(byTestId(m!, "provider-reference")!.textContent).toBe("order-77");
    expect(byTestId(m!, "access-state")!.textContent).toContain("plan is active");
    expect(byTestId(m!, "receipt-note")!.textContent).toContain("emails your receipt and invoice");
    expect(byTestId(m!, "next-start-review")!.getAttribute("href")).toBe("/dashboard");
    expect(await axeViolations(m!.container)).toEqual([]);
  });
  it("a term that starts later is shown as scheduled, never as active now", async () => {
    await showStatus({ status: "SUCCEEDED", paymentRecorded: true, purchasedEffectiveStart: "2099-01-01T00:00:00Z", purchasedEffectiveEnd: "2100-01-01T00:00:00Z" });
    expect(byTestId(m!, "access-state")!.textContent).toContain("scheduled from");
  });
  it("mobile money pending: approve on the phone; 'Check again' asks the provider once and never starts a payment", async () => {
    await showStatus({ status: "PENDING", provider: "SNIPPE", expectedAmountMinor: 1250000, currencyCode: "TZS", currencyExponent: 0 });
    expect(byTestId(m!, "payment-heading")!.textContent).toBe("Approve the payment on your phone");
    expect(textOf(m!)).toContain("TZS 1,250,000");
    const before = rpcMod.requestPaymentVerificationRecovery.mock.calls.length;
    click(byTestId(m!, "next-check-again")!);
    await flush();
    expect(rpcMod.requestPaymentVerificationRecovery.mock.calls.length).toBe(before + 1);
    expect(byTestId(m!, "next-try-again")).toBeNull();
  });
  for (const [status, heading] of [["FAILED", "The payment did not go through"], ["CANCELLED", "The payment was cancelled"], ["EXPIRED", "The payment request expired"]] as const) {
    it(`${status}: no payment was taken, and a new payment can start for the same plan`, async () => {
      await showStatus({ status });
      expect(byTestId(m!, "payment-heading")!.textContent).toBe(heading);
      expect(textOf(m!)).toContain("no payment was taken");
      expect(byTestId(m!, "next-try-again")!.getAttribute("href")).toBe("/billing/checkout?plan=SOLO");
      expect(byTestId(m!, "next-start-review")).toBeNull();
    });
  }
  it("paid but the term is being placed: reassures that it will not be taken again; offers no retry", async () => {
    await showStatus({ status: "MANUAL_REVIEW", paymentRecorded: true, reviewReason: "PAID_LICENCE_PLACEMENT_REQUIRED" });
    expect(byTestId(m!, "payment-heading")!.textContent).toContain("setting up your plan");
    expect(textOf(m!)).toContain("will not be taken again");
    expect(byTestId(m!, "next-try-again")).toBeNull();
    expect(byTestId(m!, "next-check-again")).toBeNull();
  });
  it("uncertain outcome: tells the customer not to pay again and offers 'Check again'", async () => {
    await showStatus({ status: "MANUAL_REVIEW", reviewReason: "OUTCOME_UNCERTAIN" });
    expect(textOf(m!)).toContain("Do not pay again");
    expect(byTestId(m!, "next-check-again")).not.toBeNull();
    expect(byTestId(m!, "next-try-again")).toBeNull();
  });
  it("refunded: says so, and offers no review start", async () => {
    await showStatus({ status: "SUCCEEDED", paymentRecorded: true, reversalType: "REFUND" });
    expect(byTestId(m!, "payment-heading")!.textContent).toBe("Payment refunded");
    expect(byTestId(m!, "next-start-review")).toBeNull();
  });
});

describe("administrator screen", () => {
  it("refuses an account that is not a commercial administrator (owning companies confers nothing)", async () => {
    supabaseRpc.mockResolvedValue({ data: null, error: { message: "NOT_A_COMMERCIAL_ADMIN", code: "42501" } });
    m = mount(at("/commercial/admin", h(CommercialAdmin)));
    await flush();
    expect(byTestId(m, "admin-forbidden")!.textContent).toContain("does not make it one");
  });
  it("lists orders needing attention with the account, amount and reason; placing a paid term calls the audited RPC with a reason", async () => {
    supabaseRpc.mockImplementation(async (fn: string) => fn === "admin_list_payment_attention"
      ? { data: { intents: [{ intent_id: "i1", saff_reference: "SAFF-X", status: "MANUAL_REVIEW", provider: "POLAR", provider_environment: "production", plan_code: "PRACTICE", amount_minor: 99000, currency_code: "USD", currency_exponent: 2, created_at: "2026-10-10T08:00:00Z", expires_at: "2026-10-10T09:00:00Z", billing_customer_id: "b1", owner_email: "c@example.test", reason: "PAID_LICENCE_PLACEMENT_REQUIRED", payment_recorded: true }], reversals: [] }, error: null }
      : { data: { placed: true }, error: null });
    m = mount(at("/commercial/admin", h(CommercialAdmin)));
    await flush();
    const row = byTestId(m, "attention-SAFF-X")!;
    expect(row.textContent).toContain("PRACTICE · USD 990");
    expect(row.textContent).toContain("Paid — the term needs placing");
    const place = [...row.querySelectorAll("button")].find((b) => b.textContent?.includes("Place the paid"))!;
    expect(place.disabled).toBe(true);   // a reason is required
    typeInto(row.querySelector('input[aria-label^="Reason"]') as HTMLInputElement, "Placed after the open-ended agreement ended");
    click(place);
    await flush();
    expect(supabaseRpc).toHaveBeenCalledWith("admin_place_paid_licence", expect.objectContaining({ p_checkout_intent_id: "i1", p_reason: "Placed after the open-ended agreement ended" }));
  });
});

describe("payment status page · another account's order", () => {
  it("found:false (not this account's order) says so and stops; it reveals nothing about the order", async () => {
    rpcMod.requestPaymentVerificationRecovery.mockResolvedValue({ data: { ...statusBase, found: false, status: "UNKNOWN", planCode: null, expectedAmountMinor: null }, throttled: false, retryAfterSeconds: null, error: null });
    rpcMod.pollCheckoutStatus.mockResolvedValue({ data: { ...statusBase, found: false, status: "UNKNOWN" }, error: null });
    m = mount(at("/billing/payment/return?ref=SAFF-OTHER", h(PaymentReturn)));
    await flush();
    expect(byTestId(m, "order-not-found")).not.toBeNull();
    expect(byTestId(m, "order-summary")).toBeNull();
  });
});

describe("checkout · additional named users are never lost silently", () => {
  it("an upgrade that would end paid additional users is not offered: it is sent to the team, with the count", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: { ...BOTH, placement: { kind: "BLOCKED_SEATS", additional_seats: 2 } }, error: null });
    m = mount(at("/billing/checkout?plan=FIRM", h(Checkout)));
    await flush();
    expect(byTestId(m, "checkout-unavailable")!.textContent).toContain("2 additional named users");
    expect(byTestId(m, "checkout-continue")).toBeNull();
  });
  it("a renewal states that the current term's additional users are not part of the purchase", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: { ...BOTH, placement: { kind: "RENEWAL", start: "2027-03-01T00:00:00Z", additional_seats: 3 } }, error: null });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    expect(byTestId(m, "checkout-seats-note")!.textContent).toContain("3 additional named users");
  });
});
