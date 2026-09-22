// User-visible wording for the enquiry system, in one place. Jurisdiction names are never written here: they are composed at
// runtime from ISO codes (see jurisdictionPathways.ts), which keeps global source jurisdiction-neutral.

import type { AcknowledgementState, REPORT_TYPES, REPORTING_FREQUENCIES } from "./contract";

// Keyed on the contract's own enumerations, so adding or removing an option there fails the typecheck until it is worded here.
export const REPORT_TYPE_LABELS: Readonly<Record<(typeof REPORT_TYPES)[number], string>> = {
  expenditure_report: "Expenditure report",
  budget_vs_actual: "Budget versus actual",
  fund_accountability: "Fund accountability",
  grant_financial_statement: "Grant financial statement",
  management_report: "Management report",
  other: "Other",
};

export const REPORTING_FREQUENCY_LABELS: Readonly<Record<(typeof REPORTING_FREQUENCIES)[number], string>> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annual: "Semi-annual",
  annual: "Annual",
  one_off: "One-off",
  other: "Other",
};

export const ENQUIRY_NOTICES = {
  sensitive: "Do not submit passwords, credentials or highly sensitive source documents.",
  noEngagement: "This form does not establish an engagement.",
  review: "A CFOClose specialist will review your request.",
  emailOnly: "We reply by email.",
} as const;

export const ENQUIRY_FORM_COPY = {
  privacyLabel: "I have read the privacy notice and agree that CFOClose may use these details to respond to this request.",
  submit: "Send enquiry",
  submitting: "Sending…",
  generalHeading: "Contact CFOClose",
  generalIntro: "Ask a question, request support, or tell us what you need help with.",
  errorSummaryTitle: "Please correct the following before sending",
  rateLimited: "Too many enquiries have been sent from this connection. Please try again in a few minutes.",
  conflict: "This enquiry key was already used with different content. Review the form and send it again.",
  unavailable: "We could not reach the enquiry service. Your details are still on this page — please try again.",
  challengeIncomplete: "Please complete the security check before sending.",
  challengeFailed: "The security check could not be confirmed. Please complete it again, then send.",
  challengeUnavailable: "The security check is not available right now, so enquiries cannot be sent from this page. Please try again later.",
  challengeLabel: "Security check",
  challengeLoading: "Loading the security check…",
  challengeLoadFailed: "The security check could not connect. Check your connection, then try again.",
  challengeRetry: "Retry security check",
  receiptHeading: "Request received",
  receiptReference: "Your reference",
  receiptSubmitted: "Received",
  receiptNext: "What happens next",
  receiptNextBody: "A CFOClose specialist will review your request and reply by email. This is not acceptance of an engagement, a proposal or advice.",
  another: "Send another enquiry",
} as const;

export const ACKNOWLEDGEMENT_COPY: Readonly<Record<AcknowledgementState, string>> = {
  // "sent" means our email provider accepted the message. Delivery is not known, so it is never claimed.
  sent: "Our email provider has accepted an acknowledgement message for the address you provided. Delivery is not guaranteed, so please keep this reference.",
  pending: "Your email acknowledgement is queued and has not been sent yet. Please keep this reference.",
  unavailable: "Your request is recorded, but an email acknowledgement is not available right now. Please keep this reference.",
};

export const DONOR_TILE_COPY = {
  number: "03",
  title: "Report to a donor or funder",
  state: "Expert-led",
  description: "Request a controlled donor-reporting engagement for an award, grant or funded programme.",
  producesLabel: "Produces",
  produces: "Scope assessment and reporting plan",
  action: "Request expert support →",
  dialogTitle: "Request expert donor-reporting support",
  dialogIntro: "Tell us about the award or programme. We use this only to triage your request — we do not assume any donor rules or reporting obligations.",
} as const;

export const TAX_TILE_COPY = {
  title: "Tax and jurisdictional compliance",
  state: "Jurisdiction required",
  description: "Tax requirements depend on the entity, jurisdiction and reporting period. Select a jurisdiction to see the appropriate pathway.",
  producesLabel: "Produces",
  produces: "The pathway for your jurisdiction",
  action: "Select jurisdiction →",
  dialogTitle: "Tax and jurisdictional compliance",
  selectLabel: "Jurisdiction",
  selectPlaceholder: "Select a jurisdiction",
  companyPrefillNote: "Taken from your company setting. Confirm it, or choose a different jurisdiction.",
  previewState: "Locked — request access",
  previewDisclosure: "Access is subject to professional assessment and product readiness.",
  generalDisclosure: "Tax availability is assessed jurisdiction by jurisdiction. A specialist can tell you what applies.",
  generalAction: "Ask a jurisdiction specialist →",
} as const;

export const HELP_SUPPORT_COPY = {
  heading: "Help and support",
  body: "Questions about your workspace, or need expert help? Send us an enquiry and a CFOClose specialist will reply by email.",
  action: "Contact support →",
} as const;
