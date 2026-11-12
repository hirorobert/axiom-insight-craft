/**
 * The refund and cancellation terms — ONE text, rendered by the Terms of Service (§4) and by the checkout page before the
 * customer leaves for the payment page. Pure: no I/O, no React.
 *
 * APPROVAL STATUS: DRAFT. The rule (pro-rata refund of the unused days on request) is the owner decision recorded on
 * 2026-11-01 in "Claude outputs/LEGAL_COPY_DRAFT_terms_privacy_refunds_2026-11-01.md" (decision 1). This wording has NOT
 * been approved by the owner or reviewed by counsel; it must be approved before the frontend is published.
 *
 * Every sentence matches what the system does today (docs/release/REFUNDS_DISPUTES_AND_RECOVERY.md):
 *   - one 12-month term per one-time payment, no provider subscription, so nothing renews or needs cancelling to stop a
 *     charge (supabase/functions/_shared/payments/providers/polar.ts; 20261001120000_annual_commercial_term.sql);
 *   - refunds are issued by a person in Polar's dashboard (partial refunds allowed) and recorded against the exact order;
 *   - a refund never changes access by itself: an administrator ends or keeps the licence and records the decision
 *     (admin_record_reversal_review), which is what the payment status page tells a refunded customer (PaymentReturn.tsx);
 *   - a holder whose plan has ended keeps read access to the workspace (scripts/db-proof/annualTerm.mjs, "EXPIRED: …
 *     the workspace is still read").
 * Disputes are not reported to CFOClose by Polar; they are handled through Polar.
 */
import { channel } from "@/lib/contact/contactChannels";

export const REFUNDS_AND_CANCELLATION = {
  /** The Terms section anchor the checkout links to (/terms#refunds). */
  anchor: "refunds",
  heading: "Refunds and cancellation",
  text:
    "A plan is a one-time payment for a 12-month term and does not renew automatically, so nothing needs to be cancelled to stop a future charge. " +
    `You may cancel a plan before its term ends by writing to ${channel("billing").address} and ask for a refund of the unused part of the term, ` +
    "calculated pro rata by the whole days remaining from the day we receive your request. " +
    "Refunds are made through Polar, our merchant of record, to the original payment method. " +
    "A refund is decided and made by a person at CFOClose, never automatically, and does not change access by itself: we review the plan's access and tell you the outcome. " +
    "A plan cancelled with a refund ends when the refund is made; work already prepared stays readable to the account holder. " +
    "A dispute raised with your card issuer is handled through Polar.",
} as const;
