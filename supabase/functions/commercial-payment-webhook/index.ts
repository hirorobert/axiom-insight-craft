/**
 * commercial-payment-webhook — Ω2 Edge Function
 *
 * Receives Flutterwave webhook events. Implements two-gate security:
 *   GATE A: webhook authenticity (verif-hash header)
 *   GATE B: independent server-side transaction verification
 *
 * Iron Dome:
 *   - A webhook saying "success" while Gate B disagrees → NOT ENTITLED
 *   - Records raw receipt in payment_webhook_receipts BEFORE any processing
 *   - Calls commit_verified_commercial_payment() via service_role only
 *   - Never logs secrets, PAN, CVV, or raw financial source documents
 *   - Idempotent: duplicate webhooks return 200 without duplicating value
 *
 * ── Ω2-GR1 immutable webhook-evidence repair (HIGH-3) ─────────────────────
 * The Ω2-G candidate inserted a PENDING receipt row and then UPDATEd
 * signature_valid/processing_result onto it — but the receipt table's own
 * append-only trigger unconditionally rejects UPDATE. Every one of those
 * updates would have failed the moment a real webhook arrived.
 *
 * Repair model (two immutable tables, never one mutable-looking table):
 *   payment_webhook_receipts          — OBSERVATION of what arrived. Written
 *                                        exactly once per delivery, before
 *                                        any verification. Never touched
 *                                        again.
 *   payment_webhook_processing_events — OUTCOME of processing that receipt.
 *                                        One append-only row per attempt;
 *                                        a retry inserts a NEW row, it never
 *                                        rewrites a previous one.
 *
 * NO DURABLE PROVIDER EVIDENCE => NO LICENCE GRANT: if the receipt itself
 * cannot be durably recorded, processing stops here — Gate A/B never run
 * and commit_verified_commercial_payment() is never called. This differs
 * deliberately from the prior candidate, which treated receipt-insert
 * failure as non-fatal ("continue processing").
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getFlutterwaveAdapter } from '../_shared/payments/providers/flutterwave.ts';
import { authoriseCommit, sha256Hex } from '../_shared/payments/authority.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';
import { FLUTTERWAVE_CAPABILITIES } from '../_shared/payments/routing.ts';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req: Request) => {
  const correlationId = generateCorrelationId();
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // ── Read raw body for hash verification before any parsing ───────────────
  const rawBody = await req.text();
  const payloadHash = await sha256Hex(rawBody);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  // ── Route to correct provider adapter ────────────────────────────────────
  // Currently only Flutterwave. Future: inspect X-Provider or URL path prefix.
  const adapter = getFlutterwaveAdapter();

  // ── Record the immutable receipt (BEFORE any verification) ───────────────
  // This is a pure OBSERVATION insert — no processing_result, no
  // signature_valid. It is never updated after this point.
  let parsedBody: Record<string, unknown> = {};
  let providerEventId: string | null = null;
  let saffReference: string | null = null;
  try {
    parsedBody = JSON.parse(rawBody);
    const data = (parsedBody.data ?? {}) as Record<string, unknown>;
    providerEventId = typeof data.id === 'string' ? data.id
      : typeof data.flw_ref === 'string' ? data.flw_ref
      : (data.id != null ? String(data.id) : null);
    saffReference = typeof data.tx_ref === 'string' && data.tx_ref.trim() ? data.tx_ref.trim() : null;
  } catch {
    // Malformed JSON body — receipt is still recorded (payload_hash proves
    // exactly what arrived); providerEventId/saffReference stay null.
  }

  const { data: receiptRow, error: receiptErr } = await supabase
    .from('payment_webhook_receipts')
    .insert({
      provider:          'FLUTTERWAVE',
      signature_present: !!headers['verif-hash'],
      payload_hash:      payloadHash,
      provider_event_id: providerEventId,
      saff_reference:    saffReference,
      correlation_id:    correlationId,
    })
    .select('id')
    .single();

  if (receiptErr || !receiptRow) {
    // NO DURABLE PROVIDER EVIDENCE => NO LICENCE GRANT. Abort before Gate A/B
    // and before any commit attempt. Return 500 so Flutterwave retries the
    // delivery — a retry is safe: receipts carry no uniqueness constraint,
    // so a retried delivery simply records a second, equally valid receipt.
    console.error('Iron Dome: failed to persist webhook receipt — aborting before verification', {
      correlationId, error: receiptErr?.message,
    });
    return new Response(JSON.stringify({ status: 'RECEIPT_PERSISTENCE_FAILED', correlationId }), { status: 500 });
  }

  const receiptId = receiptRow.id as string;

  const recordProcessingEvent = async (fields: {
    signatureValid: boolean;
    processingResult: string;
    providerTransactionId?: string | null;
    saffReference?: string | null;
    paymentEventId?: string | null;
  }) => {
    const { error } = await supabase.from('payment_webhook_processing_events').insert({
      receipt_id:               receiptId,
      provider:                 'FLUTTERWAVE',
      signature_valid:          fields.signatureValid,
      processing_result:        fields.processingResult,
      provider_transaction_id:  fields.providerTransactionId ?? null,
      saff_reference:           fields.saffReference ?? saffReference,
      payment_event_id:         fields.paymentEventId ?? null,
      correlation_id:           correlationId,
    });
    if (error) {
      // Forensic logging only — the receipt (the durable evidence invariant)
      // is already safely recorded. A lost processing-event row degrades
      // observability, not correctness: commit_verified_commercial_payment()
      // remains the sole, independently idempotent authority for licence
      // grants and is never gated on this insert succeeding.
      console.error('Failed to record webhook processing event', { correlationId, error: error.message });
    }
  };

  // ── GATE A: Webhook authenticity ──────────────────────────────────────────
  const authResult = adapter.verifyWebhookAuthenticity(rawBody, headers);
  if (!authResult.authentic) {
    console.warn('Webhook Gate A failed', { correlationId, reason: authResult.reason });
    await recordProcessingEvent({ signatureValid: false, processingResult: 'INVALID_SIGNATURE' });
    // Return 200 to prevent Flutterwave retries flooding — receipt + this
    // processing event are already durable evidence of what was rejected.
    return new Response(JSON.stringify({ status: 'REJECTED', correlationId }), { status: 200 });
  }

  // ── Parse webhook ─────────────────────────────────────────────────────────
  const webhookEvent = adapter.normalizeWebhook(rawBody);

  if (!webhookEvent.providerTransactionId) {
    await recordProcessingEvent({ signatureValid: true, processingResult: 'ERROR' });
    return new Response(JSON.stringify({ status: 'NO_TRANSACTION_ID', correlationId }), { status: 200 });
  }

  // ── Load checkout intent by SAFF reference ────────────────────────────────
  if (!webhookEvent.saffReference) {
    await recordProcessingEvent({ signatureValid: true, processingResult: 'REFERENCE_MISSING', providerTransactionId: webhookEvent.providerTransactionId });
    return new Response(JSON.stringify({ status: 'NO_REFERENCE', correlationId }), { status: 200 });
  }

  const { data: intent, error: intentErr } = await supabase
    .from('payment_checkout_intents')
    .select('id, billing_customer_id, plan_id, expected_amount_minor, currency_code, currency_exponent, saff_reference, status, expires_at')
    .eq('saff_reference', webhookEvent.saffReference)
    .single();

  if (intentErr || !intent) {
    await recordProcessingEvent({ signatureValid: true, processingResult: 'REFERENCE_MISMATCH', providerTransactionId: webhookEvent.providerTransactionId, saffReference: webhookEvent.saffReference });
    return new Response(JSON.stringify({ status: 'INTENT_NOT_FOUND', correlationId }), { status: 200 });
  }

  // ── Replay detection: already committed? ──────────────────────────────────
  if (intent.status === 'SUCCEEDED') {
    await recordProcessingEvent({ signatureValid: true, processingResult: 'REPLAY', providerTransactionId: webhookEvent.providerTransactionId, saffReference: intent.saff_reference });
    return new Response(JSON.stringify({ status: 'ALREADY_COMMITTED', correlationId }), { status: 200 });
  }

  // ── GATE B: Independent server-side transaction verification ─────────────
  const verifyResult = await adapter.verifyTransaction(
    webhookEvent.providerTransactionId,
    BigInt(intent.expected_amount_minor),
    intent.currency_code,
    intent.saff_reference,
  );

  if (!verifyResult.verified) {
    console.warn('Webhook Gate B failed', { correlationId, reason: verifyResult.reason });
    const resultCode = verifyResult.reason.startsWith('REFERENCE_MISSING')  ? 'REFERENCE_MISSING'
                     : verifyResult.reason.startsWith('REFERENCE_MISMATCH') ? 'REFERENCE_MISMATCH'
                     : verifyResult.reason.startsWith('AMOUNT_MISMATCH')    ? 'AMOUNT_MISMATCH'
                     : verifyResult.reason.startsWith('CURRENCY_MISMATCH')  ? 'CURRENCY_MISMATCH'
                     : 'VERIFICATION_FAILED';
    await recordProcessingEvent({
      signatureValid: true,
      processingResult: resultCode,
      providerTransactionId: webhookEvent.providerTransactionId,
      saffReference: intent.saff_reference,
    });
    return new Response(JSON.stringify({ status: 'VERIFICATION_FAILED', correlationId }), { status: 200 });
  }

  const tx = verifyResult.transaction;

  // ── Two-gate authority check ──────────────────────────────────────────────
  const authority = authoriseCommit(
    {
      id:                    intent.id,
      expected_amount_minor: BigInt(intent.expected_amount_minor),
      currency_code:         intent.currency_code,
      saff_reference:        intent.saff_reference,
      status:                intent.status,
      expires_at:            intent.expires_at,
    },
    tx,
  );

  if (!authority.authorised) {
    await recordProcessingEvent({
      signatureValid: true,
      processingResult: 'VERIFICATION_FAILED',
      providerTransactionId: tx.providerTransactionId,
      saffReference: tx.saffReference,
    });
    return new Response(JSON.stringify({ status: 'NOT_AUTHORISED', reason: authority.reason, correlationId }), { status: 200 });
  }

  // ── Atomic commercial commit ──────────────────────────────────────────────
  const idempotencyKey = await sha256Hex(
    `WEBHOOK:${tx.provider}:${tx.providerTransactionId}:${intent.id}`
  );

  const { data: commitData, error: commitErr } = await supabase.rpc(
    'commit_verified_commercial_payment',
    {
      p_checkout_intent_id:       intent.id,
      p_provider:                 tx.provider,
      p_provider_transaction_id:  tx.providerTransactionId,
      p_provider_status:          tx.providerStatus,
      p_normalized_status:        tx.normalizedStatus,
      p_amount_minor:             tx.amountMinor,
      p_currency_code:            tx.currencyCode,
      p_payload_hash:             tx.payloadHash,
      p_verified_at:              tx.verifiedAt,
      p_verification_method:      tx.verificationMethod,
      p_idempotency_key:          idempotencyKey,
      p_saff_reference:           tx.saffReference,
      // Ω3-CHECKOUT (HIGH fix): the environment THIS webhook is currently
      // running under — validated against the value snapshotted on the
      // intent at checkout-creation time. commit_verified_commercial_
      // payment fails closed on any mismatch or NULL, never silently
      // committing across a sandbox/production boundary mismatch.
      p_provider_environment:     FLUTTERWAVE_CAPABILITIES.environment,
    }
  );

  if (commitErr) {
    console.error('Atomic commit failed', { correlationId, error: commitErr.message });
    await recordProcessingEvent({
      signatureValid: true,
      processingResult: 'ERROR',
      providerTransactionId: tx.providerTransactionId,
      saffReference: tx.saffReference,
    });
    return new Response(JSON.stringify({ status: 'COMMIT_ERROR', correlationId }), { status: 500 });
  }

  const result = commitData as { status: string; committed: boolean };
  await recordProcessingEvent({
    signatureValid: true,
    processingResult: result.committed ? 'PROCESSED' : 'REPLAY',
    providerTransactionId: tx.providerTransactionId,
    saffReference: tx.saffReference,
  });

  return new Response(JSON.stringify({ status: result.status, committed: result.committed, correlationId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
