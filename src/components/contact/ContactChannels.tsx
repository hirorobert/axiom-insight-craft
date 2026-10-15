// The published CFOClose email addresses, rendered three ways from src/lib/contact/contactChannels.ts:
//   ContactChannelList     a compact labelled list (the public footer)
//   ContactChannelOptions  three quiet options with an icon, purpose and address (the contact page)
//   BillingHelpLine        one line pointing billing questions to billing@ (plans, checkout, orders, payment status, settings)
// Plain links in the existing type scale and tokens: no cards, no decoration. Each address is a real mailto link with an
// accessible name that says what it is for.
import { LifeBuoy, Mail, Receipt, type LucideIcon } from "lucide-react";
import { CONTACT_CHANNELS, channel, mailtoHref, type ContactChannelId } from "@/lib/contact/contactChannels";

const ICON: Readonly<Record<ContactChannelId, LucideIcon>> = { support: LifeBuoy, billing: Receipt, contact: Mail };

export function ContactChannelList({ className = "" }: { className?: string }) {
  return (
    <ul className={`space-y-2.5 ${className}`} data-testid="contact-channel-list">
      {CONTACT_CHANNELS.map((c) => (
        <li key={c.id} className="flex flex-col">
          <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground">{c.label}</span>
          <a href={mailtoHref(c.id)} className="inline-block break-all py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`${c.label}: email ${c.address}`} data-testid={`contact-${c.id}`}>
            {c.address}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function ContactChannelOptions({ className = "" }: { className?: string }) {
  return (
    <section aria-labelledby="contact-options-heading" className={className} data-testid="contact-channel-options">
      <h2 id="contact-options-heading" className="text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">Email the right team</h2>
      <ul className="mt-4 grid divide-y divide-border border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {CONTACT_CHANNELS.map((c) => {
          const Icon = ICON[c.id];
          return (
            <li key={c.id} className="flex min-w-0 flex-col gap-1 py-5 sm:px-5 sm:first:pl-0 sm:last:pr-0">
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />{c.label}
              </span>
              <span className="text-xs leading-5 text-muted-foreground">{c.purpose}</span>
              <a href={mailtoHref(c.id)} className="mt-1 inline-block break-all py-0.5 text-sm text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
                aria-label={`${c.label}: email ${c.address}`} data-testid={`contact-option-${c.id}`}>
                {c.address}
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function BillingHelpLine({ className = "", subject }: { className?: string; subject?: string }) {
  const billing = channel("billing");
  return (
    <p className={`flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground ${className}`} data-testid="billing-help">
      <Receipt className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Questions about billing?</span>
      <a href={mailtoHref("billing", subject)} className="inline-block py-1 text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
        aria-label={`Billing: email ${billing.address}`}>
        {billing.address}
      </a>
    </p>
  );
}
