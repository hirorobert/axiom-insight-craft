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

  // Intent must not be expired
  if (new Date() > new Date(intent.expires_at)) {
    return { authorised: false, reason: 'INTENT_EXPIRED' };
  }

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
