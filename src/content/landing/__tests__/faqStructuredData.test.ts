/**
 * faqStructuredData.test.ts — the crawler-visible FAQ and the human-visible FAQ must be the same
 * FAQ, and no price may ever appear in structured data.
 *
 * The first is a correctness gate, not a formality: a FAQPage block that answers differently from
 * the page it describes is, in Google's own terms, deceptive structured data, and the remedy is a
 * manual action against the domain. The parity check below is byte-for-byte against index.html, so
 * the only way to change one is to regenerate the other.
 *
 * The second is a legal gate. The landing page shows a PROPOSED commercial structure whose entity
 * limits and named-user capacity are not system-enforced and whose self-serve payment is switched
 * off. An Offer/price field in JSON-LD is a machine-readable assertion that the price is available
 * for purchase — which would be untrue today. So: no price, no offer, no availability, anywhere in
 * any structured-data or metadata field.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LANDING_FAQ, PROPOSED_PLANS } from "../landingContent";
import { buildFaqStructuredData, serializeFaqStructuredData } from "../faqStructuredData";

const ROOT = path.resolve(__dirname, "../../../..");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

function structuredDataBlocks(): string[] {
  return [...INDEX_HTML.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
}

describe("FAQ structured data is generated from the same data the page renders", () => {
  it("emits one Question per visible FAQ entry, in the same order, with the same text", () => {
    const data = buildFaqStructuredData();
    expect(data["@type"]).toBe("FAQPage");
    expect(data.mainEntity).toHaveLength(LANDING_FAQ.length);
    LANDING_FAQ.forEach((entry, i) => {
      expect(data.mainEntity[i].name).toBe(entry.question);
      expect(data.mainEntity[i].acceptedAnswer.text).toBe(entry.answer);
    });
  });

  it("index.html carries the FAQ block byte-for-byte as generated (regenerate, never hand-edit)", () => {
    const block = [...INDEX_HTML.matchAll(/<script type="application\/ld\+json" data-faq-structured-data>([\s\S]*?)<\/script>/g)];
    expect(block, "index.html has no data-faq-structured-data block").toHaveLength(1);
    const embedded = block[0][1];
    // The block is indented to sit inside <head>; compare on dedented, trimmed lines.
    const normalise = (s: string) =>
      s.trim().split("\n").map((l) => l.trim()).join("\n");
    expect(normalise(embedded)).toBe(normalise(serializeFaqStructuredData()));
  });

  it("is served in the document itself, so it does not depend on client JavaScript", () => {
    expect(INDEX_HTML).toContain('"@type": "FAQPage"');
  });

  it("every answer is a complete, self-contained sentence set (no placeholder or TODO copy)", () => {
    for (const entry of LANDING_FAQ) {
      expect(entry.question.endsWith("?"), `not a question: ${entry.question}`).toBe(true);
      expect(entry.answer.length).toBeGreaterThan(40);
      expect(entry.answer).not.toMatch(/TODO|TBD|lorem|placeholder/i);
    }
  });
});

describe("no price, offer or availability reaches structured data or metadata", () => {
  const FORBIDDEN_IN_STRUCTURED_DATA = [
    "offers",
    "Offer",
    "price",
    "priceCurrency",
    "priceSpecification",
    "availability",
    "aggregateRating",
    "ratingValue",
    "reviewCount",
  ];

  it.each(FORBIDDEN_IN_STRUCTURED_DATA)("no structured-data block contains %s", (field) => {
    for (const block of structuredDataBlocks()) {
      expect(block).not.toContain(field);
    }
  });

  it("no proposed plan amount appears anywhere in index.html", () => {
    for (const plan of PROPOSED_PLANS) {
      if (!/\d/.test(plan.amount)) continue;
      expect(INDEX_HTML, `${plan.name}'s amount leaked into index.html`).not.toContain(plan.amount);
    }
  });

  it("no metadata tag quotes a currency amount", () => {
    const metas = [...INDEX_HTML.matchAll(/<meta[^>]*content="([^"]*)"/g)].map((m) => m[1]);
    for (const content of metas) {
      expect(content, `currency amount in metadata: ${content}`).not.toMatch(/[$€£]\s?\d/);
      expect(content.toLowerCase()).not.toMatch(/per month|per year|\/mo\b/);
    }
  });

  it("the sitemap quotes no price and lists only real public routes", () => {
    const sitemapPath = path.join(ROOT, "public/sitemap.xml");
    if (!fs.existsSync(sitemapPath)) return;
    const sitemap = fs.readFileSync(sitemapPath, "utf8");
    expect(sitemap).not.toMatch(/[$€£]\s?\d/);
    const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const url of urls) {
      // No authenticated or internal surface may be advertised for indexing.
      expect(url, `${url} is not a public route`).not.toMatch(/\/(workspace|dashboard|admin|internal|auth)\b/);
    }
  });
});

describe("page metadata is present and specific", () => {
  it("has a real, app-specific title and description (never the template defaults)", () => {
    const title = INDEX_HTML.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    expect(title).toContain("CFOClose");
    expect(title).not.toMatch(/Lovable/i);
    expect(title.length).toBeGreaterThan(20);
    expect(title.length).toBeLessThanOrEqual(70);

    const description = INDEX_HTML.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    expect(description).not.toMatch(/Lovable Generated Project/i);
    expect(description.length).toBeGreaterThan(70);
    expect(description.length).toBeLessThanOrEqual(200);
  });

  it("declares canonical, Open Graph and Twitter card metadata", () => {
    expect(INDEX_HTML).toMatch(/<link rel="canonical" href="https:\/\/cfoclose\.com\/"/);
    for (const property of ["og:title", "og:description", "og:type", "og:url"]) {
      expect(INDEX_HTML, `missing ${property}`).toContain(`property="${property}"`);
    }
    expect(INDEX_HTML).toContain('name="twitter:card"');
  });
});
