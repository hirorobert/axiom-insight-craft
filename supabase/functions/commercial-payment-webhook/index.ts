/**
 * commercial-payment-webhook — DECOMMISSIONED ENDPOINT
 *
 * Flutterwave has been retired as an active payment provider. This endpoint
 * was Flutterwave-specific: it received Flutterwave charge events, verified a
 * Flutterwave signature (Gate A), independently re-verified the transaction
 * against the Flutterwave API (Gate B), and only then committed a verified
 * payment through the licence-granting authority.
 *
 * All of that is now removed. The route is retained ONLY so any inbound
 * delivery to the previously-published URL terminates predictably instead of
 * reaching a stale deployment.
 *
 * Hard invariants of this handler:
 *   - It performs no database read or write of any kind.
 *   - It can NEVER mutate a subscription, licence, entitlement, payment event,
 *     checkout intent, or webhook evidence row.
 *   - It calls NO payment provider and holds NO provider credential.
 *   - It parses no payload and trusts nothing in the request.
 *   - Historical evidence already recorded in payment_webhook_receipts,
 *     payment_webhook_processing_events and payment_events is untouched and
 *     remains readable for accounting and audit.
 *
 * Any genuine future provider must ship its own webhook endpoint with its own
 * two-gate verification. This file is not a template for that and must not be
 * re-enabled by adding a provider to it.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve((req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // 410 Gone: the resource existed and has been permanently retired. No
  // retry will ever succeed, and no state can be changed by trying.
  return new Response(
    JSON.stringify({
      status: 'PAYMENT_WEBHOOK_DECOMMISSIONED',
      detail: 'This payment webhook endpoint has been permanently retired. No billing state can be changed through it.',
    }),
    { status: 410, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
  );
});
