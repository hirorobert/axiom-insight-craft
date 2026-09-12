/**
 * Ω2 — Commercial authority guard for Edge Functions.
 * Validates that a verified transaction matches the checkout intent
 * before the atomic commit RPC is called.
 */
import { moneyEquals } from './money.ts';
import type { NormalizedTransaction } from './contracts.ts';

export interface IntentRecord {
  id: string;
  expected_amount_minor: bigint;
  currency_code: string;
  saff_reference: string;
  status: string;
  expires_at: string;
}

export type AuthorityCheckResult =
  | { authorised: true }
  | { authorised: false; reason: string };

/**
 * TWO-GATE authority check.
 * Gate A (webhook authenticity) is checked by the provider adapter.
 * Gate B (independent verification) must have produced a NormalizedTransaction.
 * This function validates that the verified transaction matches the intent.
 */
export function authoriseCommit(
  intent: IntentRecord,
  transaction: NormalizedTransaction,
): AuthorityCheckResult {
  // Intent must be open
  if (!['CREATED', 'PENDING'].includes(intent.status)) {
    return { authorised: false, reason: `INTENT_ALREADY_RESOLVED:${intent.status}` };
  }

  // CORRECTED (Codex Ω∞ A+ audit, BLOCKER): this function previously
  // rejected an already-independently-verified SUCCEEDED payment purely
  // because local wall-clock time had passed intent.expires_at — directly
  // contradicting TIMESTAMP_AUTHORITY_DECISION.md's own stated invariant
  // ("checkout expires_at controls only whether a NEW provider checkout
  // page may be opened... an already-completed, independently-verified
  // provider charge is never invalidated by that local expiry"). A
  // customer whose webhook or status-poll verification arrives even
  // slightly late (network delay, provider retry backoff, a slow customer
  // completing checkout near the 1-hour boundary) would have been charged
  // by Flutterwave — Gate A and Gate B both already passed by the time
  // this function runs — and then PERMANENTLY denied the licence they
  // paid for, with no automatic recovery path. expires_at is checked ONLY
  // where it belongs: gating whether commercial-create-checkout may still
  // treat an open intent as reusable / whether a NEW provider checkout
  // page may be opened for it. It is never re-checked here, at the
  // payment-authority boundary, once a provider has already independently
  // confirmed SUCCEEDED.

  // Payment must be SUCCEEDED
  if (transaction.normalizedStatus !== 'SUCCEEDED') {
    return { authorised: false, reason: `NON_SUCCESS:${transaction.normalizedStatus}` };
  }

  // Amount must exactly match
  if (!moneyEquals(
    transaction.amountMinor, transaction.currencyCode,
    intent.expected_amount_minor, intent.currency_code,
  )) {
    return {
      authorised: false,
      reason: `AMOUNT_MISMATCH: expected ${intent.expected_amount_minor} ${intent.currency_code}, got ${transaction.amountMinor} ${transaction.currencyCode}`,
    };
  }

  // SAFF reference must match if present in transaction
  if (transaction.saffReference && transaction.saffReference !== intent.saff_reference) {
    return {
      authorised: false,
      reason: `REFERENCE_MISMATCH: expected ${intent.saff_reference}, got ${transaction.saffReference}`,
    };
  }

  return { authorised: true };
}

/** Compute SHA-256 hex of a string (for payload_hash) */
export async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
