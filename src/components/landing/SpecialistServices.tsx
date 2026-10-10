/**
 * SpecialistServices — forecasting, budgeting, financial analysis, accounting policies and close support, each a clearly
 * labelled ENQUIRY for work delivered by people and quoted separately. None is presented as an automated feature, and none
 * is part of a plan. Each action opens the enquiry form preselected for that service (src/lib/commercial/offerings.ts).
 */

import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { LANDING_SPECIALIST_COPY } from "@/content/landing/landingContent";
import { SPECIALIST_LABEL, SPECIALIST_SERVICES, specialistHref } from "@/lib/commercial/offerings";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

export function SpecialistServices() {
  return (
    <section id="specialist-services" aria-labelledby="specialist-title" className="scroll-mt-20 border-b border-border bg-muted/20">
      <div className="mx-auto max-w-7xl px-6 py-14 lg:px-10 lg:py-20">
        <div className="max-w-2xl">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">{LANDING_SPECIALIST_COPY.eyebrow}</p>
          <h2 id="specialist-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-[2rem]">{LANDING_SPECIALIST_COPY.heading}</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{LANDING_SPECIALIST_COPY.intro}</p>
        </div>
        <ul className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={LANDING_SPECIALIST_COPY.eyebrow}>
          {SPECIALIST_SERVICES.map((s) => (
            <li key={s.code} className="flex flex-col border border-border bg-background p-5" data-testid={`specialist-${s.code}`}>
              <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground" title={SPECIALIST_LABEL}>{LANDING_SPECIALIST_COPY.tag}</p>
              <h3 className="mt-2 text-[15px] font-semibold text-foreground">{s.name}</h3>
              <p className="mt-2 flex-1 text-[13px] leading-5 text-muted-foreground">{s.description}</p>
              {SERVICE_ENQUIRY_SURFACES.contactRoute ? (
                <Link to={specialistHref(s.code)} className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-foreground underline underline-offset-4 hover:no-underline" data-testid={`specialist-action-${s.code}`}>
                  {LANDING_SPECIALIST_COPY.action} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[12px] leading-5 text-muted-foreground" data-testid="specialist-label">{SPECIALIST_LABEL}</p>
      </div>
    </section>
  );
}
