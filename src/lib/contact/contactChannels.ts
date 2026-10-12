// contactChannels.ts — the ONE source of CFOClose's published email addresses (Namecheap-hosted mailboxes on cfoclose.com).
// Every page that shows an address reads it from here; nothing else in the application hard-codes one.
//
// These are people-facing mailboxes for customers to write to. They are deliberately separate from the application's own
// transactional email (enquiry acknowledgements are sent from noreply@notify.cfoclose.com by the service-enquiry functions,
// and the internal enquiry notification goes only to ENQUIRY_INTERNAL_NOTIFY_TO): nothing here sends, routes or configures
// email. A link here opens the visitor's own mail client.

export type ContactChannelId = "support" | "billing" | "contact";

export interface ContactChannel {
  readonly id: ContactChannelId;
  /** Short label shown beside the address. */
  readonly label: string;
  readonly address: string;
  /** One line on what to write about. Makes no promise about response times. */
  readonly purpose: string;
}

export const CONTACT_CHANNELS: readonly ContactChannel[] = Object.freeze([
  Object.freeze({ id: "support", label: "Support", address: "support@cfoclose.com", purpose: "Technical help and account questions" }),
  Object.freeze({ id: "billing", label: "Billing", address: "billing@cfoclose.com", purpose: "Plans, payments and invoices" }),
  Object.freeze({ id: "contact", label: "General", address: "contact@cfoclose.com", purpose: "Partnerships and general enquiries" }),
] as const);

export const channel = (id: ContactChannelId): ContactChannel => {
  const c = CONTACT_CHANNELS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown contact channel ${id}`);
  return c;
};

/** A mailto link, optionally with a subject. Only an address from this file is ever used. */
export function mailtoHref(id: ContactChannelId, subject?: string): string {
  const { address } = channel(id);
  return subject ? `mailto:${address}?subject=${encodeURIComponent(subject)}` : `mailto:${address}`;
}
