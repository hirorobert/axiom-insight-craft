/**
 * The provider webhook endpoint (one per provider: commercial-webhook-polar, commercial-webhook-snippe).
 *
 * Order of operations — every delivery leaves evidence, and nothing in a delivery is trusted:
 *   1. the raw body is recorded as a payment_webhook_receipts row (append-only) BEFORE any verification;
 *   2. Gate A — the provider's signature over the raw body, with a 5-minute freshness window; a failure is recorded
 *      (INVALID_SIGNATURE / STALE_TIMESTAMP) and answered 401;
 *   3. a delivery whose provider event id was already processed is recorded as DUPLICATE and answered 200;
 *   4. the delivery only NAMES a checkout; the intent is found by (provider, provider_checkout_ref) — an unknown
 *      checkout is recorded as REFERENCE_MISMATCH and answered 200 (retrying cannot change it);
 *   5. settleIntent() asks the provider for the truth (Gate B) and commits through the one authoritative function.
 * One payment_webhook_processing_events row records the outcome. Only a dependency failure answers 500, so the
 * provider redelivers (Polar: 10 retries; Snippe: 5); every definite answer is 200. Out-of-order and delayed events are
 * harmless: each delivery re-reads the provider's CURRENT state, and the commit is idempotent.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { generateCorrelationId } from '../correlationId.ts';
import type { PaymentProvider } from './contracts.ts';
import { sha256Hex } from './http.ts';
import { getAdapterForProvider } from './routing.ts';
import { SETTLEMENT_INTENT_COLUMNS, settleIntent, type ProcessingResult, type ServiceDb } from './settle.ts';

const MAX_BODY_BYTES = 256 * 1024;
const SETTLED = ['PROCESSED', 'PLACEMENT_REVIEW', 'REVERSAL_RECORDED'];

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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
  const record = async (signatureValid: boolean, result: ProcessingResult | 'INVALID_SIGNATURE' | 'STALE_TIMESTAMP' | 'IGNORED_EVENT_TYPE',
    extra: { provider_transaction_id?: string | null; saff_reference?: string | null; payment_event_id?: string | null } = {}) => {
    const { error } = await db.from('payment_webhook_processing_events').insert({
      receipt_id: receipt.id, provider, signature_valid: signatureValid, processing_result: result, correlation_id: correlationId, ...extra,
    });
    if (error) console.error('webhook outcome not recorded', { correlationId, provider, result, error: error.message });
    return !error;
  };

  // 2. Gate A.
  const auth = await adapter.verifyWebhookAuthenticity(rawBody, req.headers, Math.floor(Date.now() / 1000));
  if (!auth.authentic) {
    await record(false, auth.reason);
    return reply({ error: auth.reason, correlationId }, 401);
  }

  // 3. Duplicate delivery of an already-settled event.
  if (eventId) {
    const { data: earlier } = await db.from('payment_webhook_receipts').select('id').eq('provider', provider).eq('provider_event_id', eventId).neq('id', receipt.id);
    const ids = ((earlier ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length) {
      const { data: done } = await db.from('payment_webhook_processing_events').select('id').in('receipt_id', ids).in('processing_result', SETTLED).limit(1);
      if ((done ?? []).length) {
        await record(true, 'DUPLICATE');
        return reply({ received: true, outcome: 'DUPLICATE', correlationId }, 200);
      }
    }
  }

  // 4. Which checkout the delivery is about (never trusted beyond that).
  let checkoutRef = claim.providerCheckoutRef;
  if (!checkoutRef && claim.providerOrderId && adapter.checkoutRefForOrder) checkoutRef = await adapter.checkoutRefForOrder(claim.providerOrderId);
  if (!checkoutRef) {
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
    await record(true, 'REFERENCE_MISMATCH');
    return reply({ received: true, outcome: 'REFERENCE_MISMATCH', correlationId }, 200);
  }

  // 5. Gate B and the one authoritative commit.
  const outcome = await settleIntent(db as unknown as ServiceDb, adapter, intent);
  await record(true, outcome.result, {
    provider_transaction_id: outcome.providerTransactionId, saff_reference: intent.saff_reference, payment_event_id: outcome.paymentEventId,
  });
  if (outcome.result === 'ERROR') {
    console.error('webhook settlement deferred', { correlationId, provider, detail: outcome.detail });
    return reply({ error: 'SETTLEMENT_DEFERRED', correlationId }, 500);
  }
  return reply({ received: true, outcome: outcome.result, correlationId }, 200);
}
