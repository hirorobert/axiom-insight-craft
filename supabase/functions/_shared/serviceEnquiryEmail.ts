// Enquiry notification messages. Pure functions: no I/O, no secrets.
//
// Content rules (asserted by tests):
//   * the requester's acknowledgement carries the public reference and plain next-step language ONLY — never the enquiry's
//     subject, message, organisation or structured payload — and says clearly that it is not acceptance of an engagement;
//   * the internal notification carries the reference, service code, country code and source context ONLY (no personal data,
//     no message text); staff open the secured queue for details.
// Application email is sent from the same verified sender domain as the authentication emails; the authentication hook
// itself (supabase/functions/auth-email-hook) is not touched by this feature.

export const ENQUIRY_EMAIL_FROM = "CFOClose <noreply@notify.cfoclose.com>";
export const ENQUIRY_EMAIL_SENDER_DOMAIN = "notify.cfoclose.com";
export const ENQUIRY_QUEUE_URL = "https://cfoclose.com/admin/enquiries";

export interface OutboundEmail {
  readonly to: string;
  readonly from: string;
  readonly senderDomain: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** The outbox row id: the provider de-duplicates on it, so a retry after a timeout cannot double-send. */
  readonly idempotencyKey: string;
  readonly purpose: "transactional";
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const shell = (heading: string, paragraphs: readonly string[]): string =>
  `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">` +
  `<div style="max-width:560px;margin:0 auto;"><h1 style="font-size:18px;margin:0 0 16px;">${escapeHtml(heading)}</h1>` +
  paragraphs.map((p) => `<p style="font-size:14px;line-height:1.6;margin:0 0 12px;">${p}</p>`).join("") +
  `<p style="font-size:12px;color:#6b7280;margin:24px 0 0;">CFOClose</p></div></body></html>`;

export function buildRequesterAcknowledgement(input: { reference: string; to: string; notificationId: string }): OutboundEmail {
  const ref = escapeHtml(input.reference);
  const subject = `We received your CFOClose enquiry ${input.reference}`;
  const lines = [
    "Thank you for contacting CFOClose. We have received your enquiry.",
    `Your reference is ${input.reference}. Please quote it in any follow-up.`,
    "A CFOClose specialist will review your request and respond by email.",
    "This message confirms receipt only. It is not acceptance of an engagement, a proposal or professional advice.",
    "Please do not send passwords, credentials or highly sensitive source documents by email.",
  ];
  return {
    to: input.to,
    from: ENQUIRY_EMAIL_FROM,
    senderDomain: ENQUIRY_EMAIL_SENDER_DOMAIN,
    subject,
    text: lines.join("\n\n"),
    html: shell("We received your enquiry", [
      "Thank you for contacting CFOClose. We have received your enquiry.",
      `Your reference is <strong>${ref}</strong>. Please quote it in any follow-up.`,
      "A CFOClose specialist will review your request and respond by email.",
      "This message confirms receipt only. It is not acceptance of an engagement, a proposal or professional advice.",
      "Please do not send passwords, credentials or highly sensitive source documents by email.",
    ]),
    idempotencyKey: input.notificationId,
    purpose: "transactional",
  };
}

export function buildStaffNotification(input: {
  reference: string;
  serviceCode: string;
  countryCode: string | null;
  sourceContext: string;
  to: string;
  notificationId: string;
}): OutboundEmail {
  const country = input.countryCode ?? "not stated";
  const text = [
    `A new enquiry ${input.reference} is waiting for triage.`,
    `Service: ${input.serviceCode}`,
    `Country: ${country}`,
    `Source: ${input.sourceContext}`,
    `Open the secured queue to review it: ${ENQUIRY_QUEUE_URL}`,
  ].join("\n");
  return {
    to: input.to,
    from: ENQUIRY_EMAIL_FROM,
    senderDomain: ENQUIRY_EMAIL_SENDER_DOMAIN,
    subject: `New CFOClose enquiry ${input.reference}`,
    text,
    html: shell("New enquiry awaiting triage", [
      `Enquiry <strong>${escapeHtml(input.reference)}</strong> is waiting for triage.`,
      `Service: ${escapeHtml(input.serviceCode)}<br/>Country: ${escapeHtml(country)}<br/>Source: ${escapeHtml(input.sourceContext)}`,
      `Open the <a href="${ENQUIRY_QUEUE_URL}">secured queue</a> to review it. Requester details are not included in this message.`,
    ]),
    idempotencyKey: input.notificationId,
    purpose: "transactional",
  };
}
