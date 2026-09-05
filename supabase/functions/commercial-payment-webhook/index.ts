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
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getFlutterwaveAdapter } from '../_shared/payments/providers/flutterwave.ts';
import { authoriseCommit, sha256Hex } from '../_shared/payments/authority.ts';
import { generateCorrelationId } from '../_shared/correlationId.ts';

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

  // ── Record raw receipt (BEFORE verification — immutable evidence) ─────────
  let receiptId: string | null = null;
  try {
    const parsed = JSON.parse(rawBody);
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const providerEventId = String(data.id ?? data.flw_ref ?? '');
    const txRef = String(data.tx_ref ?? '');

    const { data: receipt } = await supabase
      .from('payment_webhook_receipts')
      .insert({
        provider:          'FLUTTERWAVE',
        signature_present: !!headers['verif-hash'],
        signature_valid:   false, // will update after Gate A
        payload_hash:      payloadHash,
        provider_event_id: providerEventId || null,
        saff_reference:    txRef || null,
        processing_result: 'PENDING',
        correlation_id:    correlationId,
      })
      .select('id')
      .single();
    receiptId = receipt?.id ?? null;
  } catch {
    // Receipt record failure is non-fatal — continue processing
  }

  const updateReceipt = async (
    processingResult: string,
    signatureValid: boolean = false,
  ) => {
    if (!receiptId) return;
    await supabase.from('payment_webhook_receipts')
      .update({ processing_result: processingResult, signature_valid: signatureValid })
      .eq('id', receiptId);
  };

  // ── GATE A: Webhook authenticity ──────────────────────────────────────────
  const authResult = adapter.verifyWebhookAuthenticity(rawBody, headers);
  if (!authResult.authentic) {
    console.warn('Webhook Gate A failed', { correlationId, reason: authResult.reason });
    await updateReceipt('INVALID_SIGNATURE', false);
    // Return 200 to prevent Flutterwave retries flooding — receipt is evidence
    return new Response(JSON.stringify({ status: 'REJECTED', correlationId }), { status: 200 });
  }

  await supabase.from('payment_webhook_receipts')
    .update({ signature_valid: true })
    .eq('id', receiptId);

  // ── Parse webhook ─────────────────────────────────────────────────────────
  const webhookEvent = adapter.normalizeWebhook(rawBody);

  if (!webhookEvent.providerTransactionId) {
    await updateReceipt('ERROR', true);
    return new Response(JSON.stringify({ status: 'NO_TRANSACTION_ID', correlationId }), { status: 200 });
  }

  // ── Load checkout intent by SAFF reference ────────────────────────────────
  if (!webhookEvent.saffReference) {
    await updateReceipt('REFERENCE_MISMATCH', true);
    return new Response(JSON.stringify({ status: 'NO_REFERENCE', correlationId }), { status: 200 });
  }

  const { data: intent, error: intentErr } = await supabase
    .from('payment_checkout_intents')
    .select('id, billing_customer_id, plan_id, expected_amount_minor, currency_code, currency_exponent, saff_reference, status, expires_at')
    .eq('saff_reference', webhookEvent.saffReference)
    .single();

  if (intentErr || !intent) {
    await updateReceipt('REFERENCE_MISMATCH', true);
    return new Response(JSON.stringify({ status: 'INTENT_NOT_FOUND', correlationId }), { status: 200 });
  }

  // ── Replay detection: already committed? ──────────────────────────────────
  if (intent.status === 'SUCCEEDED') {
    await updateReceipt('REPLAY', true);
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
    const resultCode = verifyResult.reason.startsWith('AMOUNT_MISMATCH')   ? 'AMOUNT_MISMATCH'
                     : verifyResult.reason.startsWith('CURRENCY_MISMATCH') ? 'CURRENCY_MISMATCH'
                     : verifyResult.reason.startsWith('REFERENCE_MISMATCH') ? 'REFERENCE_MISMATCH'
                     : 'VERIFICATION_FAILED';
    await updateReceipt(resultCode, true);
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
    await updateReceipt('VERIFICATION_FAILED', true);
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
      p_saff_reference:           tx.saffReference ?? intent.saff_reference,
    }
  );

  if (commitErr) {
    console.error('Atomic commit failed', { correlationId, error: commitErr.message });
    await updateReceipt('ERROR', true);
    return new Response(JSON.stringify({ status: 'COMMIT_ERROR', correlationId }), { status: 500 });
  }

  const result = commitData as { status: string; committed: boolean };
  await updateReceipt(result.committed ? 'PROCESSED' : 'REPLAY', true);

  return new Response(JSON.stringify({ status: result.status, committed: result.committed, correlationId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
