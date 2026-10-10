/**
 * The provider webhook endpoint (one per provider: commercial-webhook-polar, commercial-webhook-snippe).
 *
 * Order of operations — every delivery leaves evidence, and nothing in a delivery is trusted:
 *   1. the raw body is recorded as a payment_webhook_receipts row (append-only) BEFORE any verification;
 *   2. Gate A — the provider's signature over the raw body. An invalid signature is recorded (INVALID_SIGNATURE) and
 *      answered 401: nothing else happens;
 *   3. a delivery whose provider event id was already settled is recorded as DUPLICATE and answered 200 — no provider
 *      call, so a replayed capture can never cause work;
 *   4. the delivery only NAMES a checkout; the intent is found by (provider, provider_checkout_ref) — an unknown
 *      checkout is recorded as REFERENCE_MISMATCH and answered 200 (retrying cannot change it);
 *   5. a correctly signed delivery whose timestamp is older than the freshness window (STALE_TIMESTAMP) is recorded as
 *      such and is NOT believed: it only triggers an authenticated reconciliation — the same provider read as any
 *      delivery — at most once per order per RECONCILE_INTERVAL_SECONDS (a further one inside that interval is answered
 *      202, RECONCILIATION_THROTTLED). This is what recovers a legitimate delayed notification: Snippe signs the EVENT
 *      time and retries over ~45 minutes (0, 3, 6, 12, 24 min), and Polar documents up to 10 retries with exponential
 *      backoff without saying whether a retry is re-signed;
 *   6. settleIntent() asks the provider for the truth (Gate B: reference, account, merchant, amount, currency, status)
 *      and commits through the one authoritative, idempotent function.
 * One payment_webhook_processing_events row records each outcome. Only a dependency failure answers 500, so the
 * provider redelivers; every definite answer is 2xx. Out-of-order and delayed events are harmless: each reconciliation
 * reads the provider's CURRENT state, and the commit is idempotent — no second payment, settlement or licence.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { generateCorrelationId } from '../correlationId.ts';
import type { PaymentProvider } from './contracts.ts';
import { sha256Hex } from './http.ts';
import { getAdapterForProvider } from './routing.ts';
import { SETTLEMENT_INTENT_COLUMNS, serviceDbFrom, settleIntent, type ProcessingResult } from './settle.ts';

const MAX_BODY_BYTES = 256 * 1024;
const SETTLED = ['PROCESSED', 'PLACEMENT_REVIEW', 'REVERSAL_RECORDED'];
/** A stale (old but correctly signed) delivery triggers at most one provider reconciliation per order per interval. */
export const RECONCILE_INTERVAL_SECONDS = 60;

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Outcome = ProcessingResult | 'INVALID_SIGNATURE' | 'STALE_TIMESTAMP' | 'IGNORED_EVENT_TYPE';

export async function handleProviderWebhook(req: Request, provider: PaymentProvider): Promise<Response> {
  const correlationId = generateCorrelationId();
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);

  const adapter = getAdapterForProvider(provider);
  if (!adapter) return reply({ error: 'PAYMENT_PROVIDER_UNAVAILABLE', correlationId }, 503);

  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) return reply({ error: 'Payload too large' }, 413);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const claim = adapter.parseWebhook(rawBody);
  const eventId = provider === 'POLAR' ? req.headers.get('webhook-id') : claim.providerEventId;
  const signaturePresent = provider === 'POLAR' ? req.headers.has('webhook-signature') : req.headers.has('x-webhook-signature');

  // 1. Receipt first — what arrived, before anything is believed.
  const { data: receipt, error: receiptErr } = await db.from('payment_webhook_receipts').insert({
    provider, signature_present: signaturePresent, payload_hash: await sha256Hex(rawBody),
    provider_event_id: eventId, saff_reference: claim.saffReference, correlation_id: correlationId,
  }).select('id').single();
  if (receiptErr || !receipt) {
    console.error('webhook receipt not recorded', { correlationId, provider, error: receiptErr?.message });
    return reply({ error: 'RECEIPT_NOT_RECORDED', correlationId }, 500);
  }
  const record = async (signatureValid: boolean, result: Outcome,
    extra: { provider_transaction_id?: string | null; saff_reference?: string | null; payment_event_id?: string | null } = {}) => {
    const { error } = await db.from('payment_webhook_processing_events').insert({
      receipt_id: receipt.id, provider, signature_valid: signatureValid, processing_result: result, correlation_id: correlationId, ...extra,
    });
    if (error) console.error('webhook outcome not recorded', { correlationId, provider, result, error: error.message });
    return !error;
  };

  // 2. Gate A. A bad signature ends here; a stale timestamp on a correct signature is handled in step 5.
  const auth = await adapter.verifyWebhookAuthenticity(rawBody, req.headers, Math.floor(Date.now() / 1000));
  if (!auth.authentic && auth.reason === 'INVALID_SIGNATURE') {
    await record(false, 'INVALID_SIGNATURE');
    return reply({ error: 'INVALID_SIGNATURE', correlationId }, 401);
  }
  const stale = !auth.authentic;   // signature correct, timestamp outside the window

  // 3. Duplicate delivery of an already-settled event: no provider call.
  if (eventId) {
    const { data: earlier } = await db.from('payment_webhook_receipts').select('id').eq('provider', provider).eq('provider_event_id', eventId).neq('id', receipt.id);
    const ids = ((earlier ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length) {
      const { data: done } = await db.from('payment_webhook_processing_events').select('id').in('receipt_id', ids).in('processing_result', SETTLED).limit(1);
      if ((done ?? []).length) {
        if (stale) await record(true, 'STALE_TIMESTAMP');
        await record(true, 'DUPLICATE');
        return reply({ received: true, outcome: 'DUPLICATE', correlationId }, 200);
      }
    }
  }

  // 4. Which checkout the delivery is about (never trusted beyond that).
  let checkoutRef = claim.providerCheckoutRef;
  if (!checkoutRef && claim.providerOrderId && adapter.checkoutRefForOrder) checkoutRef = await adapter.checkoutRefForOrder(claim.providerOrderId);
  if (!checkoutRef) {
    if (stale) await record(true, 'STALE_TIMESTAMP');
    await record(true, 'IGNORED_EVENT_TYPE');
    return reply({ received: true, outcome: 'IGNORED_EVENT_TYPE', correlationId }, 200);
  }
  const { data: intent, error: intentErr } = await db.from('payment_checkout_intents').select(SETTLEMENT_INTENT_COLUMNS)
    .eq('provider', provider).eq('provider_checkout_ref', checkoutRef).maybeSingle();
  if (intentErr) {
    await record(true, 'ERROR');
    return reply({ error: 'LOOKUP_FAILED', correlationId }, 500);
  }
  if (!intent) {
    if (stale) await record(true, 'STALE_TIMESTAMP');
    await record(true, 'REFERENCE_MISMATCH');
    return reply({ received: true, outcome: 'REFERENCE_MISMATCH', correlationId }, 200);
  }

  // 5. A stale delivery is evidence only that something happened: reconcile from the provider, throttled per order.
  if (stale) {
    await record(true, 'STALE_TIMESTAMP', { saff_reference: intent.saff_reference });
    const since = new Date(Date.now() - RECONCILE_INTERVAL_SECONDS * 1000).toISOString();
    const { data: recent } = await db.from('payment_webhook_processing_events').select('id')
      .eq('provider', provider).eq('saff_reference', intent.saff_reference).neq('receipt_id', receipt.id)
      .not('processing_result', 'in', '("INVALID_SIGNATURE","STALE_TIMESTAMP")').gte('created_at', since).limit(1);
    if ((recent ?? []).length) return reply({ received: true, outcome: 'RECONCILIATION_THROTTLED', correlationId }, 202);
  }

  // 6. Gate B and the one authoritative commit.
  const outcome = await settleIntent(serviceDbFrom(db), adapter, intent);
  await record(true, outcome.result, {
    provider_transaction_id: outcome.providerTransactionId, saff_reference: intent.saff_reference, payment_event_id: outcome.paymentEventId,
  });
  if (outcome.result === 'ERROR') {
    console.error('webhook settlement deferred', { correlationId, provider, detail: outcome.detail });
    return reply({ error: 'SETTLEMENT_DEFERRED', correlationId }, 500);
  }
  return reply({ received: true, outcome: outcome.result, reconciled: stale || undefined, correlationId }, 200);
}
