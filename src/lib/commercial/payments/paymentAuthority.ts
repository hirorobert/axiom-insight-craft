/**
 * Ω2 — Commercial authority boundary declarations.
 *
 * These are NOT enforcement — they are documentation of what the Iron Dome
 * rules guarantee, checked only in tests and audit reports. The actual
 * enforcement happens in:
 *   - SQL: commit_verified_commercial_payment() SECURITY DEFINER
 *   - Edge Functions: commercial-create-checkout, commercial-payment-webhook
 *   - RLS policies on payment_checkout_intents, payment_events, commercial_licences
 *
 * NORTH_STAR_READY: These boundaries are designed to be provenance-graph-compatible.
 * Payment evidence may later feed a Standards Evidence Graph without collision.
 */

export const COMMERCIAL_AUTHORITY_INVARIANTS: Array<{
  code: string;
  description: string;
  enforced_by: string;
}> = [
  {
    code: "NEVER_BUTTON_PAID_TRUE",
    description: "Browser button click NEVER directly sets paid=true or grants commercial value.",
    enforced_by: "commit_verified_commercial_payment() SECURITY DEFINER RPC; RLS on commercial_licences",
  },
  {
    code: "NEVER_BROWSER_CALLBACK_ENTITLEMENT",
    description: "Provider redirect/callback NEVER grants premium entitlement. PaymentReturn polls server-authoritative state.",
    enforced_by: "PaymentReturn.tsx polls commercial-payment-status; server state is authoritative",
  },
  {
    code: "NEVER_UNVERIFIED_WEBHOOK",
    description: "Webhook payload is NEVER trusted without two-gate independent verification.",
    enforced_by: "Gate A (verif-hash constant-time comparison) + Gate B (Flutterwave GET /transactions/{id}/verify)",
  },
  {
    code: "NEVER_PAYMENT_ROW_ACCOUNTING_AUTHORITY",
    description: "A payment_events row NEVER grants accounting or professional authority.",
    enforced_by: "ACCOUNTING_TABLES_NEVER_TOUCHED_BY_COMMERCIAL; commercial_licences is orthogonal to tax_computations/engine_runs",
  },
  {
    code: "TRISTATE_ENTITLEMENT_PRESERVED",
    description: "UNKNOWN != NOT_ENTITLED != ENTITLED — three distinct states, never collapsed.",
    enforced_by: "get_effective_entitlement() RPC; entitlementContract.ts deriveEntitlement()",
  },
  {
    code: "PAYMENT_STATUS_NOT_COLLAPSED",
    description: "FAILED != CANCELLED != EXPIRED != PENDING — payment lifecycle states are distinct.",
    enforced_by: "PaymentStatus type union; commit_verified_commercial_payment() normalized_status CHECK constraint",
  },
  {
    code: "MONEY_IS_INTEGER_MINOR_UNITS",
    description: "All money is stored and compared as BIGINT minor units. No floats in authority paths.",
    enforced_by: "amount_minor BIGINT column; moneyFromProviderDecimal(); bigint comparison in verifyTransaction()",
  },
];

/** Supported payment providers — adding a new one requires ONLY a new adapter file. */
export const SUPPORTED_PROVIDERS = [
  "FLUTTERWAVE",
  "PESAPAL",
  "SELCOM",
  "DPO",
  "STRIPE",
] as const;

/**
 * Features that commercial payment unlocks. Listed for documentation only.
 * Server-side get_effective_entitlement() is the sole authoritative gate.
 */
export const PREMIUM_FEATURES_GATED_BY_PAYMENT = [
  'SAFISHA_CERTIFY',
  'HESABU_EXPORT',
  'MAONO_INTELLIGENCE',
  'MULTI_COMPANY',
  'MULTI_PERIOD',
] as const;

/**
 * Features that remain available on FREE plan. For documentation only.
 */
export const FREE_FEATURES = [
  'SAFISHA_PREVIEW',
  'HESABU_REPORTING',
] as const;

/**
 * These accounting tables are NEVER written by any commercial operation.
 * Commercial authority is orthogonal to accounting authority.
 */
export const ACCOUNTING_TABLES_NEVER_TOUCHED_BY_COMMERCIAL = [
  'trial_balance_uploads',
  'account_mappings',
  'account_review_decisions',
  'tax_computations',
  'engine_runs',
  'statement_sign_offs',
  'safisha_transactions',
] as const;

export type NorthStarCompatibility =
  | 'NORTH_STAR_READY'
  | 'NORTH_STAR_LIMITED_BUT_NONDESTRUCTIVE'
  | 'NORTH_STAR_COLLISION_REQUIRES_REPAIR';

/** Ω2 North-Star compatibility classification */
export const OMEGA2_NORTH_STAR: NorthStarCompatibility = 'NORTH_STAR_READY';
