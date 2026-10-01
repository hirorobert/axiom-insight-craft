/**
 * TrustStrip — exactly three assurances, each stated in its registered wording (publicClaimRegistry): a traceable
 * source, attributed decisions and protected history. Not a control encyclopedia.
 */

import { LANDING_TRUST } from "@/content/landing/landingContent";

export function TrustStrip() {
  return (
    <section aria-label="Assurances" className="border-b border-border bg-muted/20">
      <ul className="mx-auto grid max-w-7xl grid-cols-1 gap-px px-6 py-10 sm:grid-cols-3 lg:px-10">
        {LANDING_TRUST.map((t) => (
          <li key={t.title} className="py-3 sm:pr-8">
            <p className="text-[13px] font-semibold text-foreground">{t.title}</p>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{t.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
