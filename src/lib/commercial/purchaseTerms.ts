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

/**
 * The Terms of Service version a checkout accepts. MIRROR of supabase/functions/_shared/commercial/termsVersion.ts
 * CURRENT_TERMS_VERSION (the server's authority; a test pins the two to each other and to the SHA-256 of the rendered policy
 * texts). The browser sends it with the checkout request; the server refuses any other value before writing anything and
 * records ITS constant on the intent. Format: <publication date>.<first 12 hex of the policy-text SHA-256>.
 */
export const TERMS_VERSION = "2026-11-13.43956c6fa6a8";

/**
 * The two acknowledgements required before "Continue to payment" (commercial package 12.7). Box 1 is the Terms acceptance; box 2 is the
 * customer's consent to the plan starting as soon as the payment is confirmed (ETA s.30(5)(d)). APPROVAL STATUS of box 2's WORDING:
 * DRAFT, subject to counsel (C6); the flag it records is technically determinate. Neither is legal text of its own: the Terms are linked.
 */
export const TERMS_ACCEPTANCE = {
  label: `I accept the CFOClose Terms of Service (version ${TERMS_VERSION}) and Privacy Policy, including the refund terms above.`,
  /** DRAFT until counsel C6 (package 12.7). */
  consentLabel: "I ask for my plan to start as soon as Polar confirms my payment. I understand that, because the service starts immediately at my request, the seven-day cancellation right under the Electronic Transactions Act does not apply; the CFOClose refund policy above still applies.",
  /** Shown when the server answers TERMS_VERSION_NOT_CURRENT or TERMS_VERSION_REQUIRED. */
  outdated: "The Terms of Service were updated after this page was opened. Reload the page to review and accept the current version; nothing was charged.",
} as const;
