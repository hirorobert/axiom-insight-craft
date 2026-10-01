/**
 * LandingFAQ — renders LANDING_FAQ, the same data the FAQPage structured data in index.html is
 * built from (parity asserted by faqStructuredData.test.ts).
 *
 * Two columns on wide screens: the heading and a short line on the left, the questions on the
 * right. Built on the Radix-backed accordion primitive, so keyboard support, aria-expanded and
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
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20 border-b border-border bg-background">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-6 py-14 lg:grid-cols-12 lg:gap-10 lg:px-10 lg:py-20">
        <div className="lg:col-span-4">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Questions</p>
          <h2 id="faq-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-[2rem]">
            What accountants ask first.
          </h2>
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
            Responsibility, frameworks, formats and plans, answered plainly.
          </p>
        </div>

        <Accordion type="single" collapsible className="border-t border-border lg:col-span-8">
          {LANDING_FAQ.map((entry, i) => (
            <AccordionItem key={entry.id} value={entry.id} className="border-b border-border">
              <AccordionTrigger className="min-h-[56px] gap-4 py-5 text-left text-[15px] font-medium text-foreground hover:no-underline">
                <span className="flex items-baseline gap-4">
                  <span aria-hidden="true" className="w-6 shrink-0 text-[11px] font-mono text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {entry.question}
                </span>
              </AccordionTrigger>
              <AccordionContent className="pb-5 pl-10 pr-6 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-7">
                {entry.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
