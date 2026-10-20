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
    rememberReturnTo: vi.fn(),
    getMyPayments: vi.fn(async () => []),
    usePublicPlanPrices: () => null,
  },
  rpcMod: { pollCheckoutStatus: vi.fn(), requestPaymentVerificationRecovery: vi.fn(), abandonUnfinishedCheckout: vi.fn(), NOT_AUTHENTICATED: "Not authenticated", callCommercialRpc: vi.fn(async () => ({ data: [], error: null })) },
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
    expect(byTestId(m, "checkout-total")!.textContent).toContain("USD 490");
    expect(byTestId(m, "checkout-total")!.textContent).toContain("Sales tax may apply and is shown before you pay");
    expect(byTestId(m, "checkout-continue")!.textContent).toBe("Continue to payment");
    expect(await axeViolations(m.container)).toEqual([]);
  });

  it("one open route is stated, not offered as a one-option choice; a NEW purchase needs no placement sentence", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: { ...BOTH, options: [BOTH.options[0]] }, error: null });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    expect(m.container.querySelector('input[type="radio"]')).toBeNull();
    expect(byTestId(m, "route-CARD")!.textContent).toContain("Card, on Polar's secure page");
    expect(byTestId(m, "checkout-placement")).toBeNull();
    expect(byTestId(m, "checkout-continue")!.textContent).toBe("Continue to payment");
    expect((byTestId(m, "checkout-continue") as HTMLButtonElement).disabled).toBe(false);
    expect(await axeViolations(m.container)).toEqual([]);
  });

  const openOrder = { ...statusBase, planCode: "PRACTICE", status: "PENDING", providerCheckout: null };
  const refusedFor = async (error: string) => {
    client.getCheckoutOptions.mockResolvedValue({ data: { ...BOTH, options: [BOTH.options[0]] }, error: null });
    client.startCheckout.mockResolvedValue({ ok: false, error, saffReference: "SAFF-OPEN", previousPlanName: "Practice" });
    rpcMod.pollCheckoutStatus.mockResolvedValue({ data: openOrder, error: null });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    click(byTestId(m, "checkout-continue")!);
    await flush();
    return m;
  };

  it("an open checkout for another plan: stated from the recorded state only (no provider call, no 'nothing was paid' claim), with Resume and Choose another plan; Pay stays off", async () => {
    await refusedFor("OPEN_CHECKOUT_OTHER_PLAN");
    const b = byTestId(m!, "unfinished-checkout")!;
    expect(b.textContent).toContain("Your Practice checkout isn't finished");
    expect(b.textContent).toContain("No payment has been recorded for it");
    expect(b.textContent).not.toMatch(/Nothing has been paid/);
    expect(rpcMod.requestPaymentVerificationRecovery).not.toHaveBeenCalled();
    expect(byTestId(m!, "unfinished-resume")).not.toBeNull();
    expect((byTestId(m!, "checkout-continue") as HTMLButtonElement).disabled).toBe(true);
    expect(await axeViolations(m!.container)).toEqual([]);
  });

  it("Choose another plan first states what it does and does not do; only 'Close this checkout' closes; Keep it changes nothing", async () => {
    rpcMod.abandonUnfinishedCheckout.mockResolvedValue({ outcome: "ABANDONED", status: { ...openOrder, status: "CANCELLED" }, error: null });
    await refusedFor("OPEN_CHECKOUT_OTHER_PLAN");
    click(byTestId(m!, "unfinished-choose-another")!);
    const confirm = byTestId(m!, "unfinished-confirm")!;
    expect(confirm.textContent).toContain("The payment page itself stays open until it expires");
    expect(confirm.textContent).toContain("never applied twice");
    expect(confirm.textContent).not.toMatch(/cancel(l)?ed at|automatic(ally)? refund|credit/i);
    expect(rpcMod.abandonUnfinishedCheckout).not.toHaveBeenCalled();
    click(byTestId(m!, "unfinished-keep")!);
    expect(byTestId(m!, "unfinished-confirm")).toBeNull();
    expect(rpcMod.abandonUnfinishedCheckout).not.toHaveBeenCalled();
    expect(await axeViolations(m!.container)).toEqual([]);
  });

  it("closing re-enables payment and keeps the consequence in view (the old payment page may stay open)", async () => {
    rpcMod.abandonUnfinishedCheckout.mockResolvedValue({ outcome: "ABANDONED", status: { ...openOrder, status: "CANCELLED" }, error: null });
    await refusedFor("OPEN_CHECKOUT_OTHER_PLAN");
    click(byTestId(m!, "unfinished-choose-another")!);
    click(byTestId(m!, "unfinished-confirm-close")!);
    await flush();
    expect(rpcMod.abandonUnfinishedCheckout).toHaveBeenCalledWith("SAFF-OPEN");
    expect(byTestId(m!, "checkout-left-note")!.textContent).toContain("may stay open until it expires");
    expect(byTestId(m!, "unfinished-checkout")).toBeNull();
    expect((byTestId(m!, "checkout-continue") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a provider answer that is moments old is not acted on: RETRY_LATER waits visibly, then asks afresh; nothing closes before that", async () => {
    vi.useFakeTimers();
    rpcMod.abandonUnfinishedCheckout
      .mockResolvedValueOnce({ outcome: "RETRY_LATER", status: openOrder, error: null, retryAfterSeconds: 3 })
      .mockResolvedValueOnce({ outcome: "ABANDONED", status: { ...openOrder, status: "CANCELLED" }, error: null });
    await refusedFor("OPEN_CHECKOUT_OTHER_PLAN");
    click(byTestId(m!, "unfinished-choose-another")!);
    click(byTestId(m!, "unfinished-confirm-close")!);
    await flush();
    expect(byTestId(m!, "unfinished-waiting")!.textContent).toContain("Confirming with the payment provider that nothing was paid");
    expect((byTestId(m!, "checkout-continue") as HTMLButtonElement).disabled).toBe(true);
    expect(rpcMod.abandonUnfinishedCheckout).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); await flush(); }
    expect(rpcMod.abandonUnfinishedCheckout).toHaveBeenCalledTimes(2);
    expect((byTestId(m!, "checkout-continue") as HTMLButtonElement).disabled).toBe(false);
  });

  it("closing is refused while the provider shows the payment in progress: says so, nothing changes, never invites a second payment", async () => {
    rpcMod.abandonUnfinishedCheckout.mockResolvedValue({ outcome: "PAYMENT_PROCESSING", status: openOrder, error: null });
    await refusedFor("OPEN_CHECKOUT_UNFINISHED");
    click(byTestId(m!, "unfinished-choose-another")!);
    click(byTestId(m!, "unfinished-confirm-close")!);
    await flush();
    expect(byTestId(m!, "unfinished-notice")!.textContent).toContain("Do not pay again");
    expect((byTestId(m!, "checkout-continue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a NOT_PENDING answer for an order under review is never reported as closed: the review is shown and payment stays off", async () => {
    const review = { ...openOrder, status: "MANUAL_REVIEW", reviewReason: "OUTCOME_UNCERTAIN" };
    rpcMod.abandonUnfinishedCheckout.mockResolvedValue({ outcome: "NOT_PENDING", status: review, error: null });
    await refusedFor("OPEN_CHECKOUT_UNFINISHED");
    rpcMod.pollCheckoutStatus.mockResolvedValue({ data: review, error: null });
    click(byTestId(m!, "unfinished-choose-another")!);
    click(byTestId(m!, "unfinished-confirm-close")!);
    await flush();
    expect(byTestId(m!, "checkout-left-note")).toBeNull();
    expect(byTestId(m!, "unfinished-checkout-review")!.textContent).toContain("being confirmed");
    expect((byTestId(m!, "checkout-continue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Resume asks the provider at the moment it is pressed and opens its page only when the session is open and unpaid", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, configurable: true });
    await refusedFor("OPEN_CHECKOUT_UNFINISHED");
    rpcMod.requestPaymentVerificationRecovery.mockResolvedValueOnce({ data: { ...openOrder, providerCheckout: { state: "OPEN_UNPAID", resumeUrl: "javascript:alert(1)", expiresAt: null } }, throttled: false, retryAfterSeconds: null, error: null });
    click(byTestId(m!, "unfinished-resume")!);
    await flush();
    expect(assign).not.toHaveBeenCalled();
    rpcMod.requestPaymentVerificationRecovery.mockResolvedValueOnce({ data: { ...openOrder, providerCheckout: { state: "OPEN_UNPAID", resumeUrl: "https://polar.example.test/checkout/s1", expiresAt: null } }, throttled: false, retryAfterSeconds: null, error: null });
    click(byTestId(m!, "unfinished-resume")!);
    await flush();
    expect(assign).toHaveBeenCalledWith("https://polar.example.test/checkout/s1");
    rpcMod.requestPaymentVerificationRecovery.mockResolvedValueOnce({ data: null, throttled: true, retryAfterSeconds: 40, error: null });
    click(byTestId(m!, "unfinished-resume")!);
    await flush();
    expect(byTestId(m!, "unfinished-notice")!.textContent).toContain("Checked moments ago");
    expect(byTestId(m!, "unfinished-notice")!.querySelector("a")!.getAttribute("href")).toBe("/billing/payment/return?ref=SAFF-OPEN");
  });

  it("an open checkout whose status cannot be read is never a silent blank: it links to the order", async () => {
    client.getCheckoutOptions.mockResolvedValue({ data: { ...BOTH, options: [BOTH.options[0]] }, error: null });
    client.startCheckout.mockResolvedValue({ ok: false, error: "OPEN_CHECKOUT_UNFINISHED", saffReference: "SAFF-OPEN" });
    rpcMod.requestPaymentVerificationRecovery.mockResolvedValue({ data: null, throttled: false, retryAfterSeconds: null, error: "Status check failed" });
    rpcMod.pollCheckoutStatus.mockResolvedValue({ data: null, error: "Status check failed" });
    m = mount(at("/billing/checkout?plan=SOLO", h(Checkout)));
    await flush();
    click(byTestId(m, "checkout-continue")!);
    await flush();
    const note = byTestId(m, "unfinished-checkout-unreadable")!;
    expect(note.textContent).toContain("Do not pay again");
    expect(note.querySelector("a")!.getAttribute("href")).toBe("/billing/payment/return?ref=SAFF-OPEN");
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
    expect(textOf(m)).toContain("Online payment is temporarily unavailable for this plan.");
    expect(byTestId(m, "checkout-retry")).toBeTruthy();
    expect(byTestId(m, "checkout-contact-support")!.getAttribute("href")).toBe("/contact?from=plan_wall");
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
  it("a test (sandbox) payment is shown as a test: no plan activated, no access, no review button; the next step is the plans", async () => {
    await showStatus({ status: "SUCCEEDED", paymentRecorded: true, paymentReference: "order-test", paidAt: "2026-10-10T08:01:00Z",
      purchasedLicenceId: "l1", purchasedLicenceStatus: "SANDBOX", purchasedEffectiveStart: "2026-10-10T08:01:00Z", purchasedEffectiveEnd: "2027-10-10T08:01:00Z",
      providerEnvironment: "sandbox", grantsAccess: false });
    expect(byTestId(m!, "payment-heading")!.textContent).toBe("Test payment received");
    const access = byTestId(m!, "access-state")!;
    expect(access.textContent).toContain("No plan was activated");
    expect(access.getAttribute("data-test-payment")).toBe("true");
    expect(textOf(m!)).not.toMatch(/plan is active|Access through/);
    expect(byTestId(m!, "next-start-review")).toBeNull();
    expect(byTestId(m!, "receipt-note")).toBeNull();
    expect(byTestId(m!, "next-see-plans")!.getAttribute("href")).toBe("/plans");
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
  it("the provider reports the session open and unpaid: no spinner; Resume, or Choose another plan → confirm → closed in CFOClose → the plans page", async () => {
    rpcMod.abandonUnfinishedCheckout.mockResolvedValue({ outcome: "ABANDONED", status: null, error: null });
    await showStatus({ status: "PENDING", providerCheckout: { state: "OPEN_UNPAID", resumeUrl: "https://polar.example.test/checkout/s1", expiresAt: null } });
    expect(byTestId(m!, "payment-explanation")!.textContent).toContain("The payment provider reports this Solo checkout open and unpaid");
    expect(byTestId(m!, "next-resume-checkout")).not.toBeNull();
    expect(byTestId(m!, "next-check-again")).toBeNull();
    expect(await axeViolations(m!.container)).toEqual([]);
    click(byTestId(m!, "next-choose-another")!);
    expect(byTestId(m!, "next-confirm")!.textContent).toContain("stays open until it expires");
    click(byTestId(m!, "next-confirm-close")!);
    await flush();
    expect(rpcMod.abandonUnfinishedCheckout).toHaveBeenCalledWith("SAFF-9");
    expect(where).toBe("/plans");
  });
  it("closing a checkout the provider has just completed: not closed; the completed result is shown", async () => {
    const paid = { ...statusBase, status: "SUCCEEDED", paymentRecorded: true, purchasedEffectiveStart: "2026-10-10T08:01:00Z", purchasedEffectiveEnd: "2027-10-10T08:01:00Z" };
    rpcMod.abandonUnfinishedCheckout.mockResolvedValue({ outcome: "SETTLED", status: paid, error: null });
    await showStatus({ status: "PENDING", providerCheckout: { state: "OPEN_UNPAID", resumeUrl: null, expiresAt: null } });
    click(byTestId(m!, "next-choose-another")!);
    click(byTestId(m!, "next-confirm-close")!);
    await flush();
    expect(byTestId(m!, "payment-heading")!.textContent).toBe("Payment received");
    expect(where).toBe("/billing/payment/return?ref=SAFF-9");
  });
  it("an order under review whose provider session is open: Resume only — it is never offered for closing by the customer", async () => {
    await showStatus({ status: "MANUAL_REVIEW", reviewReason: "OUTCOME_UNCERTAIN", providerCheckout: { state: "OPEN_UNPAID", resumeUrl: "https://polar.example.test/checkout/s1", expiresAt: null } });
    expect(byTestId(m!, "next-resume-checkout")).not.toBeNull();
    expect(byTestId(m!, "next-choose-another")).toBeNull();
    expect(byTestId(m!, "payment-explanation")!.textContent).toContain("cannot be closed here");
  });
});

describe("payment status page · never an endless spinner", () => {
  it("no session: asks to sign in instead of waiting", async () => {
    rpcMod.requestPaymentVerificationRecovery.mockResolvedValue({ data: null, throttled: false, retryAfterSeconds: null, error: "Not authenticated" });
    rpcMod.pollCheckoutStatus.mockResolvedValue({ data: null, error: "Not authenticated" });
    m = mount(at("/billing/payment/return?ref=SAFF-9", h(PaymentReturn)));
    await flush();
    expect(byTestId(m, "payment-sign-in")!.querySelector("a")!.getAttribute("href")).toBe("/auth");
    // Signing in returns to exactly this order (one use).
    click(byTestId(m, "payment-sign-in-link")!);
    expect(client.rememberReturnTo).toHaveBeenCalledWith({ kind: "order", ref: "SAFF-9" });
  });
  it("status reads that keep failing: after a few, says so with Try again and Back to plans", async () => {
    vi.useFakeTimers();
    rpcMod.requestPaymentVerificationRecovery.mockResolvedValue({ data: null, throttled: false, retryAfterSeconds: null, error: "Status check failed" });
    rpcMod.pollCheckoutStatus.mockResolvedValue({ data: null, error: "Status check failed" });
    m = mount(at("/billing/payment/return?ref=SAFF-9", h(PaymentReturn)));
    for (let i = 0; i < 5 && !byTestId(m, "payment-unreachable"); i++) { await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); await flush(); }
    const box = byTestId(m, "payment-unreachable")!;
    expect(box.textContent).toContain("Do not pay again");
    expect(byTestId(m, "payment-retry")).not.toBeNull();
    expect(box.querySelector('a[href="/plans"]')).not.toBeNull();
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
  it("a closed local payment window is never presented as a provider-side checkout expiry", async () => {
    supabaseRpc.mockImplementation(async (fn: string) => fn === "admin_list_payment_attention"
      ? { data: { intents: [{ intent_id: "i2", saff_reference: "SAFF-LEASE", status: "PENDING", provider: "POLAR", provider_environment: "production", plan_code: "SOLO", amount_minor: 49000, currency_code: "USD", currency_exponent: 2, created_at: "2026-10-10T08:00:00Z", expires_at: "2026-10-10T09:00:00Z", billing_customer_id: "b1", owner_email: "c@example.test", reason: "PENDING_AFTER_EXPIRY", payment_recorded: false }], reversals: [] }, error: null }
      : { data: null, error: null });
    m = mount(at("/commercial/admin", h(CommercialAdmin)));
    await flush();
    const text = byTestId(m, "attention-SAFF-LEASE")!.textContent!;
    expect(text).toContain("CFOClose payment window closed");
    expect(text).toContain("may still be payable");
    expect(text).not.toMatch(/checkout expired/i);
  });
});

describe("administrator screen · charges needing a decision (a failed read is never an empty list)", () => {
  const ATTENTION = { data: { intents: [{ intent_id: "i1", saff_reference: "SAFF-KEEP", status: "MANUAL_REVIEW", provider: "POLAR", provider_environment: "production", plan_code: "SOLO", amount_minor: 49000, currency_code: "USD", currency_exponent: 2, created_at: "2026-10-10T08:00:00Z", expires_at: "2026-10-10T09:00:00Z", billing_customer_id: "b1", owner_email: "c@example.test", reason: "PAID_LICENCE_PLACEMENT_REQUIRED", payment_recorded: true }], reversals: [] }, error: null };
  const withRecoveries = (answer: () => unknown) => supabaseRpc.mockImplementation(async (fn: string) =>
    fn === "admin_list_payment_attention" ? ATTENTION : fn === "admin_list_payment_recovery_cases" ? answer() : { data: null, error: null });
  const CASE = { id: "rc1", status: "OPEN", reason: "PAYMENT_AFTER_REPLACEMENT_STARTED", created_at: "2026-10-13T08:00:00Z", owner_email: "c@example.test", plan_code: "SOLO", provider: "POLAR", provider_environment: "production", provider_transaction_id: "order-1", amount_minor: 49000, currency_code: "USD", saff_reference: "SAFF-OLD", refunded_minor: 0 };

  for (const [label, answer] of [
    ["a failed read", { data: null, error: { message: "connection reset", code: "08006" } }],
    ["a malformed answer (not a list)", { data: { cases: [] }, error: null }],
    ["a list whose items are not cases", { data: [{ nope: true }], error: null }],
  ] as const) {
    it(`${label}: an explicit error with Retry — never "none waiting"; the other sections still show`, async () => {
      withRecoveries(() => answer);
      m = mount(at("/commercial/admin", h(CommercialAdmin)));
      await flush();
      expect(byTestId(m, "recoveries-error")).not.toBeNull();
      expect(byTestId(m, "recoveries-error")!.getAttribute("role")).toBe("alert");
      expect(byTestId(m, "recoveries-retry")).not.toBeNull();
      expect(byTestId(m, "no-recoveries")).toBeNull();
      expect(byTestId(m, "attention-SAFF-KEEP")).not.toBeNull();
      expect(m.container.textContent).toContain("one list not loaded");
    });
  }
  it("a database without the release (the function does not exist): an explicit 'not available yet' state with Retry, not an empty list", async () => {
    withRecoveries(() => ({ data: null, error: { message: "Could not find the function public.admin_list_payment_recovery_cases without parameters in the schema cache", code: "PGRST202" } }));
    m = mount(at("/commercial/admin", h(CommercialAdmin)));
    await flush();
    expect(byTestId(m, "recoveries-unavailable")).not.toBeNull();
    expect(byTestId(m, "no-recoveries")).toBeNull();
    expect(byTestId(m, "attention-SAFF-KEEP")).not.toBeNull();
  });
  it("Retry reads again: after a failure, a genuine empty list shows 'none waiting'", async () => {
    let calls = 0;
    withRecoveries(() => (++calls === 1 ? { data: null, error: { message: "timeout" } } : { data: [], error: null }));
    m = mount(at("/commercial/admin", h(CommercialAdmin)));
    await flush();
    expect(byTestId(m, "recoveries-error")).not.toBeNull();
    click(byTestId(m, "recoveries-retry") as HTMLButtonElement);
    await flush();
    expect(byTestId(m, "recoveries-error")).toBeNull();
    expect(byTestId(m, "no-recoveries")).not.toBeNull();
  });
  it("an open case is listed; placing it as an additional term needs a reason AND the customer's agreement", async () => {
    withRecoveries(() => ({ data: [CASE, { ...CASE, id: "rc2", status: "REFUNDED" }], error: null }));
    m = mount(at("/commercial/admin", h(CommercialAdmin)));
    await flush();
    const row = byTestId(m, "recovery-rc1")!;
    expect(byTestId(m, "recovery-rc2")).toBeNull();   // only open cases are listed
    const place = [...row.querySelectorAll("button")].find((b) => b.textContent?.includes("Place as an additional term"))!;
    typeInto(row.querySelector('input[aria-label^="Reason"]') as HTMLInputElement, "customer keeps both");
    expect(place.disabled).toBe(true);
    typeInto(row.querySelector('input[aria-label^="The customer"]') as HTMLInputElement, "confirmed by email on 13 Oct");
    expect(place.disabled).toBe(false);
    const refunded = [...row.querySelectorAll("button")].find((b) => b.textContent?.includes("Mark refunded"))!;
    expect(refunded.disabled).toBe(true);   // nothing refunded yet
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
