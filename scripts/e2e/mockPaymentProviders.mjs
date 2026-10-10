// A loopback MOCK of the two payment providers, for the real-application payment journey (scripts/e2e/paymentJourney.mjs).
// It implements only the documented requests the adapters make (supabase/functions/_shared/payments/providers/*.ts):
//
//   Polar   POST /v1/checkouts/  GET /v1/checkouts/:id  GET /v1/orders/?checkout_id=  GET /v1/orders/:id
//           GET /pay/:id — the "hosted checkout" page: a Pay button; paying marks the order paid, sends a signed
//           order.paid delivery (Standard Webhooks) to the webhook endpoint, then redirects to the success_url.
//   Snippe  POST /v1/payments  GET /v1/payments/:reference
//
// Test controls (the journey calls them): complete / fail / expire a payment, refund an order, and send a delivery with
// a chosen body, timestamp or signature. Evidence produced against this server is MOCK evidence — no provider is
// contacted and no money moves. It listens on 0.0.0.0 so the local Edge Functions container reaches it through
// host.docker.internal; it accepts only requests carrying the test bearer tokens.
import crypto from "node:crypto";
import http from "node:http";

export function startMockProviders({ port, polar, snippe, webhookBase, organizationId }) {
  const checkouts = new Map();   // id → { id, status, amount, currency, metadata, successUrl, externalCustomerId, productId, orderId }
  const orders = new Map();      // id → order
  const payments = new Map();    // reference → { reference, status, amount, currency, metadata, idemKey }
  const idem = new Map();        // Idempotency-Key → reference
  const deliveries = [];         // every delivery sent: { provider, url, headers, body, status, response }
  const requests = [];           // every API request received (method, path, auth ok)

  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

  function orderFor(c) {
    return {
      id: c.orderId, status: c.refunded > 0 ? (c.refunded >= c.amount ? "refunded" : "partially_refunded") : "paid", paid: true,
      checkout_id: c.id, currency: c.currency, subtotal_amount: c.amount, discount_amount: 0, net_amount: c.amount, tax_amount: 0,
      total_amount: c.amount, refunded_amount: c.refunded, metadata: c.metadata, billing_reason: "purchase",
      customer: { external_id: c.externalCustomerId, organization_id: organizationId }, product: { id: c.productId, organization_id: organizationId },
    };
  }

  // ── Signed deliveries ──────────────────────────────────────────────────────────────────────────────────────────────
  async function deliver(provider, payload, { timestamp = Math.floor(Date.now() / 1000), tamper = false, id = `msg_${crypto.randomUUID()}` } = {}) {
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json" };
    if (provider === "POLAR") {
      const key = Buffer.from(polar.webhookSecret.slice("whsec_".length), "base64");
      const sig = crypto.createHmac("sha256", tamper ? Buffer.from("wrong-key-wrong-key-wrong-key!!!") : key).update(`${id}.${timestamp}.${body}`).digest("base64");
      Object.assign(headers, { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${sig}` });
    } else {
      const sig = crypto.createHmac("sha256", tamper ? "wrong" : snippe.webhookSecret).update(`${timestamp}.${body}`).digest("hex");
      Object.assign(headers, { "X-Webhook-Event": payload.type, "X-Webhook-Timestamp": String(timestamp), "X-Webhook-Signature": sig });
    }
    const url = `${webhookBase}/${provider === "POLAR" ? "commercial-webhook-polar" : "commercial-webhook-snippe"}`;
    const res = await fetch(url, { method: "POST", headers, body });
    const response = await res.json().catch(() => null);
    const record = { provider, url, id, headers, body, status: res.status, response };
    deliveries.push(record);
    return record;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const auth = req.headers.authorization ?? "";
    const p = url.pathname;
    // ── The hosted Polar page (browser) ────────────────────────────────────────────────────────────────────────────
    if (p.startsWith("/pay/")) {
      const c = checkouts.get(p.slice(5));
      if (!c) { res.writeHead(404); res.end("unknown checkout"); return; }
      if (req.method === "POST") {
        c.status = "succeeded";
        c.orderId = crypto.randomUUID();
        orders.set(c.orderId, c);
        await deliver("POLAR", { type: "order.paid", data: orderFor(c) });
        res.writeHead(303, { Location: c.successUrl }); res.end(); return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock Polar checkout</title></head>
<body style="font-family:sans-serif;padding:24px"><p><strong>MOCK provider page</strong> (local test — no payment is taken)</p>
<p data-testid="mock-amount">USD ${(c.amount / 100).toFixed(2)}</p><form method="post"><button type="submit" data-testid="mock-pay">Pay</button></form></body></html>`);
      return;
    }
    const polarAuth = auth === `Bearer ${polar.accessToken}`;
    const snippeAuth = auth === `Bearer ${snippe.apiKey}`;
    requests.push({ method: req.method, path: p + url.search, polarAuth, snippeAuth });
    // ── Polar API ────────────────────────────────────────────────────────────────────────────────────────────────────
    if (p.startsWith("/v1/checkouts") || p.startsWith("/v1/orders")) {
      if (!polarAuth) return json(res, 401, { error: "Unauthorized" });
      if (req.method === "POST" && p === "/v1/checkouts/") {
        const b = JSON.parse(await readBody(req));
        const productId = b.products?.[0];
        const price = b.prices?.[productId]?.[0];
        const id = crypto.randomUUID();
        const c = { id, status: "open", amount: price?.price_amount, currency: price?.price_currency ?? "usd", metadata: b.metadata, successUrl: b.success_url,
          externalCustomerId: b.external_customer_id, productId, orderId: null, refunded: 0, discounts: b.allow_discount_codes, taxBehavior: price?.tax_behavior };
        checkouts.set(id, c);
        return json(res, 201, { id, url: `http://127.0.0.1:${port}/pay/${id}`, status: "open", net_amount: c.amount, currency: c.currency, metadata: c.metadata,
          expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (req.method === "GET" && p.startsWith("/v1/checkouts/")) {
        const c = checkouts.get(p.slice("/v1/checkouts/".length));
        return c ? json(res, 200, { id: c.id, status: c.status, metadata: c.metadata }) : json(res, 404, {});
      }
      if (req.method === "GET" && p === "/v1/orders/") {
        const c = checkouts.get(url.searchParams.get("checkout_id") ?? "");
        return json(res, 200, { items: c && c.orderId ? [orderFor(c)] : [] });
      }
      if (req.method === "GET" && p.startsWith("/v1/orders/")) {
        const c = orders.get(p.slice("/v1/orders/".length));
        return c ? json(res, 200, orderFor(c)) : json(res, 404, {});
      }
      return json(res, 404, {});
    }
    // ── Snippe API ───────────────────────────────────────────────────────────────────────────────────────────────────
    if (p.startsWith("/v1/payments")) {
      if (!snippeAuth) return json(res, 401, { status: "error", code: 401 });
      if (req.method === "POST" && p === "/v1/payments") {
        const key = req.headers["idempotency-key"];
        const b = JSON.parse(await readBody(req));
        let ref = key ? idem.get(key) : null;
        if (!ref) {
          ref = `pi_${crypto.randomBytes(6).toString("hex")}`;
          payments.set(ref, { reference: ref, status: "pending", amount: b.details?.amount, currency: b.details?.currency, metadata: b.metadata, phone: b.phone_number });
          if (key) idem.set(key, ref);
        }
        const pm = payments.get(ref);
        return json(res, 201, { status: "success", code: 201, data: { reference: ref, status: pm.status, amount: { value: pm.amount, currency: pm.currency }, object: "payment", payment_type: "mobile" } });
      }
      if (req.method === "GET") {
        const pm = payments.get(p.slice("/v1/payments/".length));
        return pm ? json(res, 200, { status: "success", code: 200, data: { reference: pm.reference, status: pm.status, amount: { value: pm.amount, currency: pm.currency }, metadata: pm.metadata } }) : json(res, 404, {});
      }
    }
    json(res, 404, {});
  });

  return new Promise((resolve) => server.listen(port, "0.0.0.0", () => resolve({
    checkouts, payments, deliveries, requests, deliver, orderFor,
    /** Test controls. */
    async completeSnippe(reference, status = "completed") {
      const pm = payments.get(reference);
      pm.status = status;
      return deliver("SNIPPE", { id: `evt_${crypto.randomUUID().slice(0, 12)}`, type: `payment.${status}`, data: { reference, status, amount: { value: pm.amount, currency: pm.currency }, metadata: pm.metadata } });
    },
    async expirePolar(checkoutId) {
      const c = checkouts.get(checkoutId);
      c.status = "expired";
      return deliver("POLAR", { type: "checkout.expired", data: { id: c.id, status: "expired", metadata: c.metadata } });
    },
    async refundPolar(checkoutId) {
      const c = checkouts.get(checkoutId);
      c.refunded = c.amount;
      return deliver("POLAR", { type: "order.refunded", data: orderFor(c) });
    },
    close: () => new Promise((r) => server.close(() => r())),
  })));
}
