/**
 * faqStructuredData — builds the FAQPage JSON-LD object from LANDING_FAQ, the same data the
 * visible FAQ renders from.
 *
 * The markup that reaches a crawler lives in index.html (static, served with the document —
 * never injected by post-load client JavaScript). This module exists so that markup has a
 * single, testable source: faqStructuredData.test.ts asserts byte parity between the JSON-LD
 * block in index.html and buildFaqStructuredData() output, so a visible answer can never
 * drift from the answer offered to a crawler.
 *
 * No price, offer, rating or availability field is ever emitted here: the commercial structure
 * on the page is explicitly proposed and unverified, and must not appear in structured data.
 */

import { LANDING_FAQ } from "./landingContent";

export interface FaqStructuredData {
  readonly "@context": "https://schema.org";
  readonly "@type": "FAQPage";
  readonly mainEntity: readonly {
    readonly "@type": "Question";
    readonly name: string;
    readonly acceptedAnswer: { readonly "@type": "Answer"; readonly text: string };
  }[];
}

export function buildFaqStructuredData(): FaqStructuredData {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: LANDING_FAQ.map((entry) => ({
      "@type": "Question" as const,
      name: entry.question,
      acceptedAnswer: { "@type": "Answer" as const, text: entry.answer },
    })),
  };
}

/** The exact serialization expected inside index.html (2-space indent, trailing newline free). */
export function serializeFaqStructuredData(): string {
  return JSON.stringify(buildFaqStructuredData(), null, 2);
}
