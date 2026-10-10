/**
 * The Polar and Snippe adapters, webhook signatures, configuration-driven routing and the shared settlement path —
 * tested against the EXACT Edge Function files (Web Crypto + fetch only, no Deno-only import), with a recorded mock of
 * each provider's HTTP API. Expected values are written from the providers' documentation
 * (docs/release/PAYMENT_PROVIDER_EVIDENCE.md), not from the implementation. Mock evidence: no provider was contacted.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createPolarAdapter } from "../../../../../supabase/functions/_shared/payments/providers/polar.ts";
import { createSnippeAdapter, normaliseTzMobile } from "../../../../../supabase/functions/_shared/payments/providers/snippe.ts";
import { verifySnippeSignature, verifyStandardWebhook } from "../../../../../supabase/functions/_shared/payments/webhookSignature.ts";
import { providersFromEnv, selectPaymentProvider, SNIPPE_CUSTOMER_CHECKOUT_ENABLED } from "../../../../../supabase/functions/_shared/payments/routing.ts";
import { settleIntent, type ServiceDb } from "../../../../../supabase/functions/_shared/payments/settle.ts";
import type { ProviderAdapter } from "../../../../../supabase/functions/_shared/payments/contracts.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const PRODUCTS = { SOLO: "22222222-2222-4222-8222-222222222222", PRACTICE: "33333333-3333-4333-8333-333333333333", FIRM: "44444444-4444-4444-8444-444444444444" };
const BC = "55555555-5555-4555-8555-555555555555";
const REF = "SAFF-1760000000000-ABCDEF12";
const CHECKOUT = "66666666-6666-4666-8666-666666666666";
const ORDER = "77777777-7777-4777-8777-777777777777";

type Call = { url: string; init: RequestInit };
function mockFetch(responder: (url: string, init: RequestInit, n: number) => { status: number; body?: unknown } | "network" | "timeout") {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responder(url, init, calls.length);
    if (r === "network") throw new TypeError("fetch failed");
    if (r === "timeout") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  };
  return { impl, calls };
}
const polar = (f: ReturnType<typeof mockFetch>) => createPolarAdapter({ environment: "sandbox", accessToken: "polar_oat_test", webhookSecret: "whsec_" + Buffer.from("k".repeat(32)).toString("base64"), organizationId: ORG, productIds: PRODUCTS, apiBase: "https://sandbox-api.polar.sh" }, f.impl);
const snippe = (f: ReturnType<typeof mockFetch>) => createSnippeAdapter({ environment: "sandbox", apiKey: "snp_test", webhookSecret: "snippe-signing-key", webhookUrl: "https://x.supabase.co/functions/v1/commercial-webhook-snippe", apiBase: "https://api.snippe.sh" }, f.impl);
const params = (over: Partial<Parameters<ProviderAdapter["createCheckout"]>[0]> = {}) => ({
  saffReference: REF, intentId: "intent-1", billingCustomerId: BC, amountMinor: 49000n, currencyCode: "USD", currencyExponent: 2,
  planCode: "SOLO", planName: "Solo", customerEmail: "owner@example.test", customerName: "Asha Mushi", redirectUrl: `https://cfoclose.com/billing/payment/return?ref=${REF}`,
  phoneNumber: null, ...over,
});
const paidOrder = (over: Record<string, unknown> = {}) => ({
  id: ORDER, status: "paid", paid: true, checkout_id: CHECKOUT, currency: "usd", subtotal_amount: 49000, discount_amount: 0, net_amount: 49000,
  tax_amount: 0, total_amount: 49000, refunded_amount: 0, metadata: { saff_reference: REF, billing_customer_id: BC },
  customer: { external_id: BC, organization_id: ORG }, product: { organization_id: ORG }, ...over,
});
const ref = { saffReference: REF, providerCheckoutRef: CHECKOUT, billingCustomerId: BC };

describe("webhook signatures (Gate A)", () => {
  const now = 1_760_000_000;
  const snippeHeaders = (body: string, ts: number, key = "snippe-signing-key") =>
    new Headers({ "x-webhook-timestamp": String(ts), "x-webhook-signature": createHmac("sha256", key).update(`${ts}.${body}`).digest("hex") });
  it("Snippe: a signature over `${timestamp}.${raw body}` with the signing key is authentic", async () => {
    const body = '{"id":"evt_1","type":"payment.completed"}';
    expect(await verifySnippeSignature(body, snippeHeaders(body, now), "snippe-signing-key", now)).toEqual({ authentic: true });
  });
  it("Snippe: a changed body, another key, a missing header or a non-hex signature is INVALID_SIGNATURE", async () => {
    const body = '{"id":"evt_1"}';
    expect(await verifySnippeSignature(body + " ", snippeHeaders(body, now), "snippe-signing-key", now)).toEqual({ authentic: false, reason: "INVALID_SIGNATURE" });
    expect(await verifySnippeSignature(body, snippeHeaders(body, now, "other"), "snippe-signing-key", now)).toEqual({ authentic: false, reason: "INVALID_SIGNATURE" });
    expect(await verifySnippeSignature(body, new Headers({ "x-webhook-timestamp": String(now) }), "snippe-signing-key", now)).toEqual({ authentic: false, reason: "INVALID_SIGNATURE" });
    expect(await verifySnippeSignature(body, new Headers({ "x-webhook-timestamp": String(now), "x-webhook-signature": "zz" }), "snippe-signing-key", now)).toEqual({ authentic: false, reason: "INVALID_SIGNATURE" });
  });
  it("Snippe: a correctly signed capture replayed after 5 minutes (or dated in the future) is STALE_TIMESTAMP", async () => {
    const body = '{"id":"evt_1"}';
    expect(await verifySnippeSignature(body, snippeHeaders(body, now - 301), "snippe-signing-key", now)).toEqual({ authentic: false, reason: "STALE_TIMESTAMP" });
    expect(await verifySnippeSignature(body, snippeHeaders(body, now + 301), "snippe-signing-key", now)).toEqual({ authentic: false, reason: "STALE_TIMESTAMP" });
    expect(await verifySnippeSignature(body, snippeHeaders(body, now - 299), "snippe-signing-key", now)).toEqual({ authentic: true });
  });
  const key = Buffer.from("polar-webhook-key-32-bytes-long!");
  const secret = "whsec_" + key.toString("base64");
  const stdHeaders = (body: string, ts: number, id = "msg_1", k = key) =>
    new Headers({ "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${createHmac("sha256", k).update(`${id}.${ts}.${body}`).digest("base64")}` });
  it("Polar (Standard Webhooks): HMAC over `${id}.${timestamp}.${body}` with the base64 key after whsec_ is authentic", async () => {
    const body = '{"type":"order.paid"}';
    expect(await verifyStandardWebhook(body, stdHeaders(body, now), secret, now)).toEqual({ authentic: true });
  });
  it("Polar: any one valid entry among several space-separated signatures is accepted (key rotation)", async () => {
    const body = '{"type":"order.paid"}';
    const h = stdHeaders(body, now);
    h.set("webhook-signature", `v1,${Buffer.from("x".repeat(32)).toString("base64")} ${h.get("webhook-signature")}`);
    expect(await verifyStandardWebhook(body, h, secret, now)).toEqual({ authentic: true });
  });
  it("Polar: another key, another message id, a changed body, a v2 tag or a secret without whsec_ is INVALID_SIGNATURE; old is STALE", async () => {
    const body = '{"type":"order.paid"}';
    expect(await verifyStandardWebhook(body, stdHeaders(body, now, "msg_1", Buffer.from("another-key-another-key-another!")), secret, now)).toMatchObject({ authentic: false, reason: "INVALID_SIGNATURE" });
    const h = stdHeaders(body, now); h.set("webhook-id", "msg_2");
    expect(await verifyStandardWebhook(body, h, secret, now)).toMatchObject({ reason: "INVALID_SIGNATURE" });
    expect(await verifyStandardWebhook(body + "x", stdHeaders(body, now), secret, now)).toMatchObject({ reason: "INVALID_SIGNATURE" });
    const v2 = stdHeaders(body, now); v2.set("webhook-signature", v2.get("webhook-signature")!.replace("v1,", "v2,"));
    expect(await verifyStandardWebhook(body, v2, secret, now)).toMatchObject({ reason: "INVALID_SIGNATURE" });
    expect(await verifyStandardWebhook(body, stdHeaders(body, now), key.toString("base64"), now)).toMatchObject({ reason: "INVALID_SIGNATURE" });
    expect(await verifyStandardWebhook(body, stdHeaders(body, now - 600), secret, now)).toMatchObject({ reason: "STALE_TIMESTAMP" });
  });
});

describe("Polar adapter (merchant of record, USD cards)", () => {
  it("creates a hosted checkout with the server's price as an ad-hoc, tax-exclusive fixed USD price; discounts and trials off; the account and order in metadata", async () => {
    const f = mockFetch(() => ({ status: 201, body: { id: CHECKOUT, url: "https://sandbox.polar.sh/checkout/abc", net_amount: 49000 } }));
    const r = await polar(f).createCheckout(params());
    expect(r).toEqual({ success: true, checkoutUrl: "https://sandbox.polar.sh/checkout/abc", providerRef: CHECKOUT });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://sandbox-api.polar.sh/v1/checkouts/");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer polar_oat_test");
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.products).toEqual([PRODUCTS.SOLO]);
    expect(body.prices).toEqual({ [PRODUCTS.SOLO]: [{ amount_type: "fixed", price_amount: 49000, price_currency: "usd", tax_behavior: "exclusive" }] });
    expect(body).toMatchObject({ currency: "usd", external_customer_id: BC, allow_discount_codes: false, allow_trial: false, metadata: { saff_reference: REF, billing_customer_id: BC, plan_code: "SOLO" } });
  });
  it("refuses before any request: an unconfigured plan, a non-USD offer, a zero amount", async () => {
    const f = mockFetch(() => ({ status: 201, body: {} }));
    expect(await polar(f).createCheckout(params({ planCode: "ENTERPRISE" }))).toMatchObject({ success: false, outcome: "DEFINITIVE_FAILURE" });
    expect(await polar(f).createCheckout(params({ currencyCode: "TZS", currencyExponent: 0 }))).toMatchObject({ success: false, outcome: "DEFINITIVE_FAILURE" });
    expect(await polar(f).createCheckout(params({ amountMinor: 0n }))).toMatchObject({ success: false, outcome: "DEFINITIVE_FAILURE" });
    expect(f.calls).toHaveLength(0);
  });
  it("a 4xx is a definitive failure (nothing was created); a 5xx twice, a network error twice, or timeouts are UNCERTAIN after exactly 2 attempts", async () => {
    expect(await polar(mockFetch(() => ({ status: 422, body: {} }))).createCheckout(params())).toEqual({ success: false, outcome: "DEFINITIVE_FAILURE", error: "POLAR_HTTP_422" });
    for (const fail of [{ status: 503 }, "network", "timeout"] as const) {
      const f = mockFetch(() => fail as never);
      expect(await polar(f).createCheckout(params())).toMatchObject({ success: false, outcome: "UNCERTAIN" });
      expect(f.calls).toHaveLength(2);
    }
  });
  it("a session whose amount differs from the server's price is never handed out (UNCERTAIN)", async () => {
    const f = mockFetch(() => ({ status: 201, body: { id: CHECKOUT, url: "https://sandbox.polar.sh/checkout/abc", net_amount: 100 } }));
    expect(await polar(f).createCheckout(params())).toMatchObject({ success: false, outcome: "UNCERTAIN", error: "POLAR_SESSION_AMOUNT_MISMATCH" });
  });
  it("verifies a paid order of this checkout, merchant, account, currency and net amount as SUCCEEDED (order id = transaction id)", async () => {
    const f = mockFetch((url) => (url.includes("/v1/orders/?checkout_id=") ? { status: 200, body: { items: [paidOrder()] } } : { status: 404 }));
    const r = await polar(f).verifyTransactionByReference(ref, 49000n, "USD");
    expect(r).toMatchObject({ verified: true, transaction: { provider: "POLAR", providerTransactionId: ORDER, normalizedStatus: "SUCCEEDED", amountMinor: 49000n, currencyCode: "USD", reversals: [] } });
    expect(f.calls[0].url).toBe(`https://sandbox-api.polar.sh/v1/orders/?checkout_id=${CHECKOUT}&limit=10`);
  });
  it("tax added by the merchant of record does not change the verified amount (net, before tax, equals the offer)", async () => {
    const f = mockFetch(() => ({ status: 200, body: { items: [paidOrder({ tax_amount: 8820, total_amount: 57820 })] } }));
    expect(await polar(f).verifyTransactionByReference(ref, 49000n, "USD")).toMatchObject({ verified: true, transaction: { amountMinor: 49000n } });
  });
  for (const [label, over, result] of [
    ["a different net amount", { net_amount: 48999 }, "AMOUNT_MISMATCH"],
    ["a discounted order", { discount_amount: 1000, net_amount: 48000 }, "AMOUNT_MISMATCH"],
    ["another currency", { currency: "eur" }, "CURRENCY_MISMATCH"],
    ["another organization (merchant)", { product: { organization_id: "99999999-9999-4999-8999-999999999999" }, customer: { external_id: BC, organization_id: "99999999-9999-4999-8999-999999999999" } }, "MERCHANT_MISMATCH"],
    ["metadata naming another order", { metadata: { saff_reference: "SAFF-OTHER", billing_customer_id: BC } }, "REFERENCE_MISMATCH"],
    ["another account in metadata", { metadata: { saff_reference: REF, billing_customer_id: "88888888-8888-4888-8888-888888888888" } }, "ACCOUNT_MISMATCH"],
    ["another account as Polar customer", { customer: { external_id: "88888888-8888-4888-8888-888888888888", organization_id: ORG } }, "ACCOUNT_MISMATCH"],
    ["another checkout", { checkout_id: "99999999-9999-4999-8999-999999999999" }, "REFERENCE_MISMATCH"],
  ] as const) {
    it(`refuses ${label}: ${result}`, async () => {
      const f = mockFetch(() => ({ status: 200, body: { items: [paidOrder(over as Record<string, unknown>)] } }));
      expect(await polar(f).verifyTransactionByReference(ref, 49000n, "USD")).toMatchObject({ verified: false, result });
    });
  }
  it("two paid orders for one checkout are never resolved by guessing", async () => {
    const f = mockFetch(() => ({ status: 200, body: { items: [paidOrder(), paidOrder({ id: "other" })] } }));
    expect(await polar(f).verifyTransactionByReference(ref, 49000n, "USD")).toMatchObject({ verified: false, result: "VERIFICATION_FAILED" });
  });
  it("a refunded order is still the verified payment, with the refund reported as a reversal", async () => {
    const f = mockFetch(() => ({ status: 200, body: { items: [paidOrder({ status: "refunded", refunded_amount: 49000 })] } }));
    const r = await polar(f).verifyTransactionByReference(ref, 49000n, "USD");
    expect(r).toMatchObject({ verified: true, transaction: { normalizedStatus: "SUCCEEDED", reversals: [{ type: "REFUND", providerEventId: `${ORDER}:refunded:49000`, amountMinor: 49000n, currencyCode: "USD" }] } });
  });
  it("no paid order: the checkout's own state decides — expired → EXPIRED, failed → FAILED, open/confirmed → NOT_FINAL", async () => {
    for (const [status, expected] of [["expired", { verified: true, transaction: { normalizedStatus: "EXPIRED" } }], ["failed", { verified: true, transaction: { normalizedStatus: "FAILED" } }],
      ["open", { verified: false, result: "NOT_FINAL" }], ["confirmed", { verified: false, result: "NOT_FINAL" }]] as const) {
      const f = mockFetch((url) => (url.includes("/v1/orders/") ? { status: 200, body: { items: [] } } : { status: 200, body: { id: CHECKOUT, status, metadata: { saff_reference: REF } } }));
      expect(await polar(f).verifyTransactionByReference(ref, 49000n, "USD")).toMatchObject(expected);
    }
  });
  it("an unreachable provider is VERIFICATION_FAILED (never a guessed outcome)", async () => {
    expect(await polar(mockFetch(() => "network")).verifyTransactionByReference(ref, 49000n, "USD")).toMatchObject({ verified: false, result: "VERIFICATION_FAILED" });
  });
  it("parses order and refund deliveries only as pointers (checkout id / order id)", () => {
    const a = polar(mockFetch(() => ({ status: 200 })));
    expect(a.parseWebhook(JSON.stringify({ type: "order.paid", data: { id: ORDER, checkout_id: CHECKOUT, metadata: { saff_reference: REF } } })))
      .toEqual({ providerEventId: null, eventType: "order.paid", providerCheckoutRef: CHECKOUT, providerOrderId: null, saffReference: REF });
    expect(a.parseWebhook(JSON.stringify({ type: "refund.created", data: { id: "r1", order_id: ORDER } }))).toMatchObject({ providerCheckoutRef: null, providerOrderId: ORDER });
    expect(a.parseWebhook("not json")).toMatchObject({ eventType: "unknown", providerCheckoutRef: null });
  });
});

describe("Snippe adapter (Tanzania mobile money, TZS)", () => {
  const tz = (over = {}) => params({ amountMinor: 1_250_000n, currencyCode: "TZS", currencyExponent: 0, phoneNumber: "0712 345 678", ...over });
  it("normalises Tanzanian mobile numbers to 255XXXXXXXXX and refuses anything else", () => {
    expect(normaliseTzMobile("0712 345 678")).toBe("255712345678");
    expect(normaliseTzMobile("+255 754 000 111")).toBe("255754000111");
    expect(normaliseTzMobile("255612345678")).toBe("255612345678");
    for (const bad of ["0812345678", "12345", "254712345678", "", null]) expect(normaliseTzMobile(bad as string)).toBeNull();
  });
  it("requests a mobile payment for exactly the offer, Idempotency-Key = order reference, the order in metadata; the customer waits on our status page", async () => {
    const f = mockFetch(() => ({ status: 201, body: { status: "success", code: 201, data: { reference: "pi_abc", status: "pending", amount: { value: 1250000, currency: "TZS" } } } }));
    const r = await snippe(f).createCheckout(tz());
    expect(r).toEqual({ success: true, checkoutUrl: `https://cfoclose.com/billing/payment/return?ref=${REF}`, providerRef: "pi_abc" });
    expect(f.calls[0].url).toBe("https://api.snippe.sh/v1/payments");
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h["Idempotency-Key"]).toBe(REF);
    expect(h.Authorization).toBe("Bearer snp_test");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      payment_type: "mobile", details: { amount: 1250000, currency: "TZS" }, phone_number: "255712345678",
      customer: { firstname: "Asha", lastname: "Mushi", email: "owner@example.test" },
      webhook_url: "https://x.supabase.co/functions/v1/commercial-webhook-snippe",
      metadata: { saff_reference: REF, billing_customer_id: BC, plan_code: "SOLO" },
    });
  });
  it("refuses before any request: another currency, below 500 TZS, an invalid phone", async () => {
    const f = mockFetch(() => ({ status: 201, body: {} }));
    expect(await snippe(f).createCheckout(tz({ currencyCode: "USD", currencyExponent: 2 }))).toMatchObject({ outcome: "DEFINITIVE_FAILURE" });
    expect(await snippe(f).createCheckout(tz({ amountMinor: 499n }))).toMatchObject({ outcome: "DEFINITIVE_FAILURE" });
    expect(await snippe(f).createCheckout(tz({ phoneNumber: "12345" }))).toMatchObject({ outcome: "DEFINITIVE_FAILURE", error: "SNIPPE_PHONE_INVALID" });
    expect(f.calls).toHaveLength(0);
  });
  it("a retry after a network failure reuses the same Idempotency-Key (cannot create a second payment)", async () => {
    const f = mockFetch((_u, _i, n) => (n === 1 ? "network" : { status: 201, body: { data: { reference: "pi_abc", amount: { value: 1250000, currency: "TZS" } } } }));
    expect(await snippe(f).createCheckout(tz())).toMatchObject({ success: true });
    expect(f.calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"])).toEqual([REF, REF]);
  });
  it("a created payment whose amount or currency differs from the offer is never handed out (UNCERTAIN)", async () => {
    const f = mockFetch(() => ({ status: 201, body: { data: { reference: "pi_abc", amount: { value: 1, currency: "TZS" } } } }));
    expect(await snippe(f).createCheckout(tz())).toMatchObject({ success: false, outcome: "UNCERTAIN", error: "SNIPPE_PAYMENT_AMOUNT_MISMATCH" });
  });
  const sRef = { saffReference: REF, providerCheckoutRef: "pi_abc", billingCustomerId: BC };
  for (const [status, expected] of [["completed", "SUCCEEDED"], ["failed", "FAILED"], ["voided", "CANCELLED"], ["expired", "EXPIRED"]] as const) {
    it(`status ${status} is final: ${expected}`, async () => {
      const f = mockFetch(() => ({ status: 200, body: { data: { reference: "pi_abc", status, amount: { value: 1250000, currency: "TZS" }, metadata: { saff_reference: REF } } } }));
      expect(await snippe(f).verifyTransactionByReference(sRef, 1_250_000n, "TZS")).toMatchObject({ verified: true, transaction: { provider: "SNIPPE", providerTransactionId: "pi_abc", normalizedStatus: expected } });
      expect(f.calls[0].url).toBe("https://api.snippe.sh/v1/payments/pi_abc");
    });
  }
  it("pending is NOT_FINAL; an amount, currency, reference or account that differs is refused", async () => {
    const v = (data: Record<string, unknown>) => snippe(mockFetch(() => ({ status: 200, body: { data } }))).verifyTransactionByReference(sRef, 1_250_000n, "TZS");
    expect(await v({ status: "pending" })).toMatchObject({ verified: false, result: "NOT_FINAL" });
    expect(await v({ status: "completed", amount: { value: 1000, currency: "TZS" } })).toMatchObject({ result: "AMOUNT_MISMATCH" });
    expect(await v({ status: "completed", amount: { value: 1250000, currency: "KES" } })).toMatchObject({ result: "CURRENCY_MISMATCH" });
    expect(await v({ status: "completed", reference: "pi_other" })).toMatchObject({ result: "REFERENCE_MISMATCH" });
    expect(await v({ status: "completed", metadata: { saff_reference: REF, billing_customer_id: "someone-else" } })).toMatchObject({ result: "ACCOUNT_MISMATCH" });
    expect(await v({ status: "mystery" })).toMatchObject({ result: "UNKNOWN_PROVIDER_STATUS" });
  });
});

describe("routing from configuration (a provider exists only with its complete, valid settings)", () => {
  const full: Record<string, string> = {
    SAFF_PAYMENT_REDIRECT_URL: "https://cfoclose.com/billing/payment/return", SUPABASE_URL: "https://x.supabase.co",
    POLAR_ENVIRONMENT: "sandbox", POLAR_ACCESS_TOKEN: "polar_oat_x", POLAR_WEBHOOK_SECRET: "whsec_abc", POLAR_ORGANIZATION_ID: ORG, POLAR_PRODUCT_IDS: JSON.stringify(PRODUCTS),
    // Snippe is not launched: it is configured only as a sandbox adapter pointed at a loopback mock (local tests).
    SNIPPE_ENVIRONMENT: "sandbox", SNIPPE_API_KEY: "snp_x", SNIPPE_WEBHOOK_SECRET: "sig", SNIPPE_API_BASE_URL: "http://host.docker.internal:9911",
  };
  const caps = (env: Record<string, string | undefined>) => providersFromEnv((n) => env[n]).map((p) => p.capabilities);
  it("with every setting: Polar (USD, GLOBAL, card) and — only as a loopback mock — Snippe (TZS, TZ, mobile money)", () => {
    expect(caps(full)).toEqual([
      { provider: "POLAR", supportedCurrencies: ["USD"], supportedMarkets: ["GLOBAL"], supportedMethods: ["card"], environment: "sandbox" },
      { provider: "SNIPPE", supportedCurrencies: ["TZS"], supportedMarkets: ["TZ"], supportedMethods: ["mobile_money"], environment: "sandbox" },
    ]);
  });
  it("owner decision (Polar only): Snippe is never offered on a hosted configuration, whatever its secrets — production, or sandbox against the real host", () => {
    expect(SNIPPE_CUSTOMER_CHECKOUT_ENABLED).toBe(false);
    const hosted = { ...full, SNIPPE_API_BASE_URL: undefined };
    expect(caps({ ...hosted, SNIPPE_ENVIRONMENT: "production" }).map((c) => c.provider)).toEqual(["POLAR"]);
    expect(caps({ ...hosted, SNIPPE_ENVIRONMENT: "sandbox" }).map((c) => c.provider)).toEqual(["POLAR"]);
    expect(selectPaymentProvider({ currencyCode: "TZS", marketCode: "TZ", providerRestriction: null }, caps({ ...hosted, SNIPPE_ENVIRONMENT: "production" })))
      .toEqual({ selected: false, reason: "PAYMENT_PROVIDER_UNAVAILABLE" });
  });
  it("nothing set → no provider; the return URL missing or not https → no provider at all", () => {
    expect(caps({})).toEqual([]);
    expect(caps({ ...full, SAFF_PAYMENT_REDIRECT_URL: undefined })).toEqual([]);
    expect(caps({ ...full, SAFF_PAYMENT_REDIRECT_URL: "http://cfoclose.com/x" })).toEqual([]);
  });
  for (const k of ["POLAR_ENVIRONMENT", "POLAR_ACCESS_TOKEN", "POLAR_WEBHOOK_SECRET", "POLAR_ORGANIZATION_ID", "POLAR_PRODUCT_IDS"]) {
    it(`Polar without ${k} is not configured (Snippe unaffected)`, () => expect(caps({ ...full, [k]: undefined }).map((c) => c.provider)).toEqual(["SNIPPE"]));
  }
  for (const k of ["SNIPPE_ENVIRONMENT", "SNIPPE_API_KEY", "SNIPPE_WEBHOOK_SECRET"]) {
    it(`Snippe without ${k} is not configured (Polar unaffected)`, () => expect(caps({ ...full, [k]: undefined }).map((c) => c.provider)).toEqual(["POLAR"]));
  }
  it("an invalid environment, a product map missing a plan, or a secret that is not whsec_ disables Polar — never a default", () => {
    expect(caps({ ...full, POLAR_ENVIRONMENT: "live" }).map((c) => c.provider)).toEqual(["SNIPPE"]);
    expect(caps({ ...full, POLAR_PRODUCT_IDS: JSON.stringify({ SOLO: PRODUCTS.SOLO }) }).map((c) => c.provider)).toEqual(["SNIPPE"]);
    expect(caps({ ...full, POLAR_WEBHOOK_SECRET: "plain" }).map((c) => c.provider)).toEqual(["SNIPPE"]);
  });
  it("an API base override is accepted only for a sandbox provider pointed at loopback", () => {
    expect(caps({ ...full, POLAR_API_BASE_URL: "http://host.docker.internal:9911" }).map((c) => c.provider)).toEqual(["POLAR", "SNIPPE"]);
    expect(caps({ ...full, POLAR_API_BASE_URL: "https://evil.example.com" }).map((c) => c.provider)).toEqual(["SNIPPE"]);
    expect(caps({ ...full, SNIPPE_ENVIRONMENT: "production" }).map((c) => c.provider)).toEqual(["POLAR"]);   // an override is never honoured in production
  });
  it("selection: USD/GLOBAL → Polar; TZS/TZ → Snippe; USD offered in TZ, or TZS in GLOBAL → unavailable (no cross-route fallback)", () => {
    const c = caps(full);
    expect(selectPaymentProvider({ currencyCode: "USD", marketCode: "GLOBAL", providerRestriction: null }, c)).toEqual({ selected: true, provider: "POLAR", environment: "sandbox" });
    expect(selectPaymentProvider({ currencyCode: "TZS", marketCode: "TZ", providerRestriction: null }, c)).toEqual({ selected: true, provider: "SNIPPE", environment: "sandbox" });
    expect(selectPaymentProvider({ currencyCode: "USD", marketCode: "TZ", providerRestriction: null }, c)).toEqual({ selected: false, reason: "PAYMENT_PROVIDER_UNAVAILABLE" });
    expect(selectPaymentProvider({ currencyCode: "TZS", marketCode: "GLOBAL", providerRestriction: null }, c)).toEqual({ selected: false, reason: "PAYMENT_PROVIDER_UNAVAILABLE" });
    expect(selectPaymentProvider({ currencyCode: "USD", marketCode: "GLOBAL", providerRestriction: "SNIPPE" }, c)).toEqual({ selected: false, reason: "OFFER_RESTRICTED_TO_UNAVAILABLE_PROVIDER" });
  });
});

describe("settlement (the one path from a provider answer to the database)", () => {
  const intent = { id: "intent-1", saff_reference: REF, provider: "POLAR", provider_environment: "sandbox", provider_checkout_ref: CHECKOUT, billing_customer_id: BC, expected_amount_minor: 49000, currency_code: "USD", status: "PENDING" };
  function fakeDb(commit: { data?: unknown; error?: { message: string } | null } = { data: { status: "COMMITTED", event_id: "evt-1" } }) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const db: ServiceDb = {
      rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve(fn === "commit_verified_commercial_payment" ? { data: commit.data ?? null, error: commit.error ?? null } : { data: { status: "REVERSAL_RECORDED" }, error: null }); },
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "evt-1" }, error: null }) }) }) }) }),
    };
    return { db, calls };
  }
  const adapterWith = (result: Awaited<ReturnType<ProviderAdapter["verifyTransactionByReference"]>> | Error, over: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
    provider: "POLAR", environment: "sandbox",
    createCheckout: async () => { throw new Error("not used"); },
    verifyTransactionByReference: async () => { if (result instanceof Error) throw result; return result; },
    verifyWebhookAuthenticity: async () => ({ authentic: true }), parseWebhook: () => { throw new Error("not used"); }, ...over,
  });
  const tx = (over = {}) => ({ provider: "POLAR" as const, providerTransactionId: ORDER, providerStatus: "paid", normalizedStatus: "SUCCEEDED" as const, amountMinor: 49000n, currencyCode: "USD", saffReference: REF, verifiedAt: "2026-10-10T00:00:00Z", verificationMethod: "PROVIDER_API_VERIFY" as const, payloadHash: "h", reversals: [], ...over });

  it("a verified success commits once, under sha256(provider:transaction:intent), with the adapter's environment", async () => {
    const { db, calls } = fakeDb();
    const out = await settleIntent(db, adapterWith({ verified: true, transaction: tx() }), intent);
    expect(out).toMatchObject({ result: "PROCESSED", providerTransactionId: ORDER, paymentEventId: "evt-1" });
    expect(calls).toHaveLength(1);
    const expectedKey = (await import("node:crypto")).createHash("sha256").update(`POLAR:${ORDER}:intent-1`).digest("hex");
    expect(calls[0].args).toMatchObject({ p_checkout_intent_id: "intent-1", p_provider: "POLAR", p_normalized_status: "SUCCEEDED", p_amount_minor: "49000", p_currency_code: "USD", p_idempotency_key: expectedKey, p_provider_environment: "sandbox" });
  });
  it("an intent from another environment or provider is never settled by this adapter (no provider call, no write)", async () => {
    let asked = false;
    const { db, calls } = fakeDb();
    const a = adapterWith({ verified: true, transaction: tx() }, { verifyTransactionByReference: async () => { asked = true; return { verified: true, transaction: tx() }; } });
    expect(await settleIntent(db, a, { ...intent, provider_environment: "production" })).toMatchObject({ result: "MERCHANT_MISMATCH" });
    expect(await settleIntent(db, a, { ...intent, provider: "SNIPPE" })).toMatchObject({ result: "MERCHANT_MISMATCH" });
    expect(asked).toBe(false); expect(calls).toHaveLength(0);
  });
  it("not final, a mismatch, or a throwing provider writes nothing; an unreachable provider is ERROR (redelivery)", async () => {
    for (const [r, expected] of [[{ verified: false, reason: "pending", result: "NOT_FINAL" }, "NOT_FINAL"], [{ verified: false, reason: "x", result: "AMOUNT_MISMATCH" }, "AMOUNT_MISMATCH"],
      [{ verified: false, reason: "down", result: "VERIFICATION_FAILED" }, "ERROR"], [new Error("boom"), "ERROR"]] as const) {
      const { db, calls } = fakeDb();
      expect(await settleIntent(db, adapterWith(r as never), intent)).toMatchObject({ result: expected });
      expect(calls).toHaveLength(0);
    }
  });
  it("defence in depth: an adapter answer whose amount, currency, reference or status is wrong is refused before the commit", async () => {
    for (const [over, expected] of [[{ amountMinor: 1n }, "AMOUNT_MISMATCH"], [{ currencyCode: "EUR" }, "CURRENCY_MISMATCH"], [{ saffReference: "SAFF-X" }, "REFERENCE_MISMATCH"], [{ normalizedStatus: "PENDING" }, "NOT_FINAL"], [{ provider: "SNIPPE" }, "MERCHANT_MISMATCH"]] as const) {
      const { db, calls } = fakeDb();
      expect(await settleIntent(db, adapterWith({ verified: true, transaction: tx(over) as never }), intent)).toMatchObject({ result: expected });
      expect(calls).toHaveLength(0);
    }
  });
  it("a replay (ALREADY_COMMITTED) is DUPLICATE; a placement review is PLACEMENT_REVIEW; a commit error is ERROR", async () => {
    expect(await settleIntent(fakeDb({ data: { status: "ALREADY_COMMITTED" } }).db, adapterWith({ verified: true, transaction: tx() }), intent)).toMatchObject({ result: "DUPLICATE" });
    expect(await settleIntent(fakeDb({ data: { status: "PLACEMENT_REVIEW_REQUIRED", event_id: "e" } }).db, adapterWith({ verified: true, transaction: tx() }), intent)).toMatchObject({ result: "PLACEMENT_REVIEW" });
    expect(await settleIntent(fakeDb({ error: { message: "Iron Dome: amount mismatch" } }).db, adapterWith({ verified: true, transaction: tx() }), intent)).toMatchObject({ result: "ERROR" });
  });
  it("refunds are recorded as the change since those already recorded: partial 20,000 then full 49,000 records 20,000 then 29,000; a redelivery records nothing", async () => {
    let prior = 0n;
    const recorded: string[] = [];
    const db: ServiceDb = {
      rpc: (fn, args) => { if (fn === "record_payment_reversal") { recorded.push(String(args.p_amount_minor)); prior += BigInt(String(args.p_amount_minor)); } return Promise.resolve({ data: fn === "commit_verified_commercial_payment" ? { status: "ALREADY_COMMITTED" } : { status: "REVERSAL_RECORDED" }, error: null }); },
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "evt-1" }, error: null }) }) }) }) }),
      priorRefundedMinor: async () => prior,
    };
    const refund = (total: bigint) => adapterWith({ verified: true, transaction: tx({ reversals: [{ type: "REFUND", providerEventId: `${ORDER}:refunded:${total}`, amountMinor: total, currencyCode: "USD" }] }) });
    await settleIntent(db, refund(20000n), intent);
    await settleIntent(db, refund(49000n), intent);
    const again = await settleIntent(db, refund(49000n), intent);
    expect(recorded).toEqual(["20000", "29000"]);
    expect(again.result).toBe("DUPLICATE");
  });
  it("a refund reported against the paid order is recorded once per refund state, against the original payment event", async () => {
    const { db, calls } = fakeDb({ data: { status: "ALREADY_COMMITTED" } });
    const r = await settleIntent(db, adapterWith({ verified: true, transaction: tx({ reversals: [{ type: "REFUND", providerEventId: `${ORDER}:refunded:49000`, amountMinor: 49000n, currencyCode: "USD" }] }) }), intent);
    expect(r.result).toBe("REVERSAL_RECORDED");
    expect(calls.map((c) => c.fn)).toEqual(["commit_verified_commercial_payment", "record_payment_reversal"]);
    expect(calls[1].args).toMatchObject({ p_original_event_id: "evt-1", p_reversal_type: "REFUND", p_provider_event_id: `${ORDER}:refunded:49000`, p_amount_minor: "49000" });
  });
});
