/**
 * The ONE path from a provider's answer to the database: used by both webhook endpoints and by the customer's /
 * administrator's recovery request (commercial-payment-status POST). A webhook body is never evidence — it only says
 * which intent to look at; settleIntent() asks the provider itself.
 *
 *   1. the intent's provider and environment must be the adapter's (a sandbox answer never settles a production intent);
 *   2. Gate B — adapter.verifyTransactionByReference reads the provider's record of THIS checkout and matches reference,
 *      account, merchant, currency and amount; anything else is a named, recorded non-result;
 *   3. a FINAL outcome is committed through commit_verified_commercial_payment under the canonical idempotency key
 *      sha256(provider:transaction:intent) — identical for a webhook, a retry and a recovery request, so every path
 *      converges on one payment event and at most one licence;
 *   4. refunds the provider reports against the paid order are recorded (record_payment_reversal, idempotent per
 *      provider refund state) for a commercial administrator's decision — a licence is never changed silently.
 *
 * Errors are classified: 'ERROR' (a dependency failed — the caller should let the provider retry) versus every other
 * outcome (a definite answer — retrying cannot change it).
 */
import type { NormalizedTransaction, ProviderAdapter, VerificationFailure } from './contracts.ts';
import { FINAL_STATUSES } from './contracts.ts';
import { sha256Hex } from './http.ts';

export type ProcessingResult =
  | 'PROCESSED' | 'DUPLICATE' | 'PLACEMENT_REVIEW' | 'REVERSAL_RECORDED' | 'ERROR' | VerificationFailure;

export interface SettlementIntent {
  id: string;
  saff_reference: string;
  provider: string;
  provider_environment: string | null;
  provider_checkout_ref: string | null;
  billing_customer_id: string;
  expected_amount_minor: number | string;
  currency_code: string;
  status: string;
}

export interface SettleOutcome {
  result: ProcessingResult;
  detail: string;
  providerTransactionId: string | null;
  paymentEventId: string | null;
  committedStatus: string | null;
}

/** The minimum of a supabase-js service client this module uses (so it can be exercised with a fake in tests). */
export interface ServiceDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: unknown): {
        eq(col: string, v: unknown): { maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }> };
      };
    };
  };
  /** Sum of the REFUND reversals already recorded against a payment event (null when it cannot be read). */
  priorRefundedMinor?(originalEventId: string): Promise<bigint | null>;
}

/** Wraps a supabase-js service client into the ServiceDb this module uses (adds the refund-sum read). */
export function serviceDbFrom(client: unknown): ServiceDb {
  const c = client as ServiceDb;
  const list = client as { from(t: string): { select(c: string): { eq(a: string, b: unknown): { eq(a: string, b: unknown): PromiseLike<{ data: unknown; error: unknown }> } } } };
  return {
    rpc: (fn, args) => c.rpc(fn, args),
    from: (t) => c.from(t),
    async priorRefundedMinor(originalEventId) {
      const { data, error } = await list.from('payment_events').select('amount_minor').eq('event_type', 'REFUND').eq('metadata->>original_event_id', originalEventId);
      if (error || !Array.isArray(data)) return null;
      return (data as { amount_minor: number | string | null }[]).reduce((s, r) => s + BigInt(r.amount_minor ?? 0), 0n);
    },
  };
}

export const SETTLEMENT_INTENT_COLUMNS =
  'id, saff_reference, provider, provider_environment, provider_checkout_ref, billing_customer_id, expected_amount_minor, currency_code, status';

/** The canonical idempotency identity of one provider transaction on one intent. */
export const commitKey = (tx: NormalizedTransaction, intentId: string) => sha256Hex(`${tx.provider}:${tx.providerTransactionId}:${intentId}`);

export async function settleIntent(db: ServiceDb, adapter: ProviderAdapter, intent: SettlementIntent): Promise<SettleOutcome> {
  const none = { providerTransactionId: null, paymentEventId: null, committedStatus: null };
  if (intent.provider !== adapter.provider || intent.provider_environment !== adapter.environment) {
    return { result: 'MERCHANT_MISMATCH', detail: 'intent was created under another provider or environment', ...none };
  }
  const expected = BigInt(intent.expected_amount_minor);
  let verify;
  try {
    verify = await adapter.verifyTransactionByReference(
      { saffReference: intent.saff_reference, providerCheckoutRef: intent.provider_checkout_ref, billingCustomerId: intent.billing_customer_id },
      expected, intent.currency_code);
  } catch {
    return { result: 'ERROR', detail: 'provider verification threw', ...none };
  }
  if (!verify.verified) {
    return { result: verify.result === 'VERIFICATION_FAILED' ? 'ERROR' : verify.result, detail: verify.reason, ...none };
  }
  const tx = verify.transaction;
  // Independent re-check of the adapter's answer before anything is written.
  if (!FINAL_STATUSES.includes(tx.normalizedStatus)) return { result: 'NOT_FINAL', detail: tx.normalizedStatus, ...none };
  if (tx.provider !== intent.provider) return { result: 'MERCHANT_MISMATCH', detail: 'provider', ...none };
  if (tx.currencyCode !== intent.currency_code) return { result: 'CURRENCY_MISMATCH', detail: tx.currencyCode, ...none };
  if (tx.normalizedStatus === 'SUCCEEDED' && tx.amountMinor !== expected) return { result: 'AMOUNT_MISMATCH', detail: String(tx.amountMinor), ...none };
  if (tx.saffReference && tx.saffReference !== intent.saff_reference) return { result: 'REFERENCE_MISMATCH', detail: 'reference', ...none };

  const { data, error } = await db.rpc('commit_verified_commercial_payment', {
    p_checkout_intent_id: intent.id,
    p_provider: tx.provider,
    p_provider_transaction_id: tx.providerTransactionId,
    p_provider_status: tx.providerStatus,
    p_normalized_status: tx.normalizedStatus,
    p_amount_minor: tx.amountMinor.toString(),
    p_currency_code: tx.currencyCode,
    p_payload_hash: tx.payloadHash,
    p_verified_at: tx.verifiedAt,
    p_verification_method: tx.verificationMethod,
    p_idempotency_key: await commitKey(tx, intent.id),
    p_saff_reference: tx.saffReference ?? intent.saff_reference,
    p_provider_environment: adapter.environment,
  });
  if (error) return { result: 'ERROR', detail: `commit: ${error.message.split('\n')[0]}`, providerTransactionId: tx.providerTransactionId, paymentEventId: null, committedStatus: null };
  const commit = (data ?? {}) as { status?: string; event_id?: string };
  const base = { providerTransactionId: tx.providerTransactionId, paymentEventId: commit.event_id ?? null, committedStatus: commit.status ?? null };

  let result: ProcessingResult =
    commit.status === 'PLACEMENT_REVIEW_REQUIRED' ? 'PLACEMENT_REVIEW'
    : commit.status === 'COMMITTED' || commit.status === 'NON_SUCCESS_RECORDED' ? 'PROCESSED'
    : 'DUPLICATE';

  if (tx.normalizedStatus === 'SUCCEEDED' && tx.reversals.length > 0) {
    const { data: original, error: lookupErr } = await db.from('payment_events').select('id')
      .eq('checkout_intent_id', intent.id).eq('event_type', 'PAYMENT_CONFIRMED').maybeSingle();
    const originalId = (original as { id?: string } | null)?.id;
    if (lookupErr || !originalId) return { result: 'ERROR', detail: 'refund reported but the payment event could not be read', ...base };
    for (const r of tx.reversals) {
      // The provider reports the order's CUMULATIVE refunded total; each reversal row records only what is new since
      // the reversals already recorded against this payment (a partial then a full refund records 20,000 then 29,000,
      // never 20,000 then 49,000).
      let amountMinor = r.amountMinor;
      if (r.type === 'REFUND' && db.priorRefundedMinor) {
        const prior = await db.priorRefundedMinor(originalId);
        if (prior === null) return { result: 'ERROR', detail: 'earlier refunds could not be read', ...base };
        amountMinor = r.amountMinor - prior;
        if (amountMinor <= 0n) continue;   // nothing new (a redelivery of a refund already recorded)
      }
      const { data: rv, error: rvErr } = await db.rpc('record_payment_reversal', {
        p_original_event_id: originalId,
        p_reversal_type: r.type,
        p_provider: tx.provider,
        p_provider_event_id: r.providerEventId,
        p_amount_minor: amountMinor.toString(),
        p_currency_code: r.currencyCode,
        p_idempotency_key: await sha256Hex(`${tx.provider}:reversal:${r.providerEventId}`),
        p_payload_hash: tx.payloadHash,
      });
      if (rvErr) return { result: 'ERROR', detail: `reversal: ${rvErr.message.split('\n')[0]}`, ...base };
      if ((rv as { status?: string } | null)?.status === 'REVERSAL_RECORDED') result = 'REVERSAL_RECORDED';
    }
  }
  return { result, detail: commit.status ?? 'unknown', ...base };
}
