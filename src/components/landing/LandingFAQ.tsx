/**
 * LandingFAQ — renders LANDING_FAQ, the same data the FAQPage structured data in index.html is
 * built from (parity asserted by faqStructuredData.test.ts).
 *
 * Built on the Radix-backed accordion primitive, so keyboard support, aria-expanded and
 * aria-controls come from the primitive rather than from hand-rolled state.
 */

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { LANDING_FAQ } from "@/content/landing/landingContent";

export function LandingFAQ() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">
        <div className="max-w-2xl">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
            Questions
          </p>
          <h2
            id="faq-title"
            className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl"
          >
            Governance and control questions.
          </h2>
        </div>

        <Accordion type="single" collapsible className="mt-8 max-w-3xl border-t border-border">
          {LANDING_FAQ.map((entry) => (
            <AccordionItem key={entry.id} value={entry.id} className="border-b border-border">
              <AccordionTrigger className="min-h-[48px] py-4 text-left text-sm font-semibold text-foreground hover:no-underline">
                {entry.question}
              </AccordionTrigger>
              <AccordionContent className="pb-4 text-xs leading-6 text-muted-foreground sm:text-[13px]">
                {entry.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
