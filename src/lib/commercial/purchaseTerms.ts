/**
 * The refund and cancellation terms - ONE text, rendered by the Terms of Service (section 6) and by the checkout page before
 * the customer leaves for the payment page. Pure: no I/O, no React.
 *
 * APPROVAL STATUS: commercial package section 10.5 (COMMERCIAL_LEGAL_REVIEW_PACKAGE_2026-11-12.md) inserted verbatim on the owner's
 * directive of 2026-11-13 (handoff "Update 4", S4), plus the two sentences of handoff "Update 5" (the seven-day full refund after the
 * first sentence; the thirty-day refund timing before the last) - that addition (A3) is implemented behind the draft flag and is
 * approved together with A1/A2 by the owner before publication. One rule ends the plan (a refund of the unused term); any other refund
 * keeps it unless we say so - the earlier contradiction is removed.
 *
 * Every sentence matches what the system does today (docs/release/REFUNDS_DISPUTES_AND_RECOVERY.md):
 *   - one 12-month term per one-time payment, no provider subscription, so nothing renews or needs cancelling to stop a
 *     charge (supabase/functions/_shared/payments/providers/polar.ts; 20261001120000_annual_commercial_term.sql);
 *   - refunds are issued by a person in Polar's dashboard (partial refunds allowed) and recorded against the exact order;
 *   - a refund never changes access by itself: an administrator ends or keeps the licence and records the decision
 *     (admin_record_reversal_review), which is what the payment status page tells a refunded customer (PaymentReturn.tsx);
 *   - a holder whose plan has ended keeps read access to the workspace (scripts/db-proof/annualTerm.mjs, "EXPIRED: ...
 *     the workspace is still read").
 * Disputes are not reported to CFOClose by Polar; they are handled through Polar.
 */
import { channel } from "@/lib/contact/contactChannels";

const REFUND_PARAGRAPHS: readonly string[] = Object.freeze([
  "A plan is a one-time payment for a 12-month term and does not renew automatically, so nothing needs to be cancelled to stop a future charge. " +
    `Seven-day cancellation. You may cancel within seven days of buying a plan by writing to ${channel("billing").address} and receive a full refund, whether or not you have started using it. ` +
    `After those seven days, you may cancel a plan before its term ends by writing to ${channel("billing").address} and asking for a refund of the unused part of the term.`,
  "A refund of the unused part is calculated on the price you paid, pro rata to the whole days remaining from the day we receive your request, together with the matching share of any sales tax or VAT charged. " +
    "Refunds are made through Polar, our merchant of record, to the original payment method. A person at CFOClose reviews every request; refunds are never made automatically.",
  "When we refund a plan on cancellation (the seven-day full refund or a refund of the unused part), the plan ends on the day the refund is made, and work already prepared stays readable to the account holder. " +
    "A refund made for another reason, such as a duplicate payment, does not end a plan unless we tell you so.",
  "Polar, as the seller, may also refund a purchase under its own buyer terms; if it does, we tell you how your plan is affected. A dispute raised with your card issuer is handled through Polar.",
  "Refunds we approve are issued through Polar within thirty days of cancellation. This policy does not limit any right you have under the law that applies to you.",
]);

export const REFUNDS_AND_CANCELLATION = {
  /** The Terms section anchor the checkout links to (/terms#refunds). */
  anchor: "refunds",
  heading: "Refunds and cancellation",
  /** The five paragraphs of package section 10.5, in order. */
  paragraphs: REFUND_PARAGRAPHS,
  /** The same text as one string (paragraphs separated by a blank line); rendered with whitespace-pre-line, hashed into TERMS_VERSION. */
  text: REFUND_PARAGRAPHS.join("\n\n"),
} as const;

/**
 * The Terms of Service version a checkout accepts. MIRROR of supabase/functions/_shared/commercial/termsVersion.ts
 * CURRENT_TERMS_VERSION (the server's authority; a test pins the two to each other and to the SHA-256 of the rendered policy
 * texts). The browser sends it with the checkout request; the server refuses any other value before writing anything and
 * records ITS constant on the intent. Format: <publication date>.<first 12 hex of the policy-text SHA-256>.
 */
export const TERMS_VERSION = "2026-11-13.e9570ed37c46";

/**
 * The two acknowledgements required before "Continue to payment" (commercial package 12.7). Box 1 is the Terms acceptance (final,
 * handoff Update 4 S6); box 2 is the customer's request for the plan to start as soon as the payment is confirmed (ETA s.30(5)(d)).
 * APPROVAL STATUS of box 2's WORDING: the conservative candidate of handoff Update 5 (A3) - it states no consequence for any statutory
 * right - DRAFT until the owner approves A1-A3 together; the flag it records is technically determinate. Neither is legal text of its
 * own: the Terms are linked.
 */
export const TERMS_ACCEPTANCE = {
  label: `I accept the CFOClose Terms of Service (version ${TERMS_VERSION}) and Privacy Policy, including the refund terms above.`,
  /** DRAFT until the owner approves A3 (handoff Update 5; package 12.7, C6). */
  consentLabel: "I ask for my plan to start as soon as Polar confirms my payment.",
  /** Shown when the server answers TERMS_VERSION_NOT_CURRENT or TERMS_VERSION_REQUIRED. */
  outdated: "The Terms of Service were updated after this page was opened. Reload the page to review and accept the current version; nothing was charged.",
} as const;
