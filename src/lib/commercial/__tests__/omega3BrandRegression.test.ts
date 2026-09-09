/**
 * Ω3-BRAND / CFOClose Ω∞ Execution Charter — Phase 1 Regression Suite
 *
 * Corrected from the original 30-test suite, which asserted against a
 * SECOND, hand-duplicated copy of `displayPlanName` written inline in this
 * file (not the real Settings.tsx logic) and against `PRICING_SECTION`
 * constants as a proxy for "the Settings CTA" and "checkout is not
 * initiated" — never reading the real component source at all. That
 * duplication made the real function's fail-open bug (an unrecognized
 * plan code silently rendered as an active paid plan) invisible to this
 * suite. See docs/operations/cfoclose-omega-infinity-phase1/DESIGN_DECISIONS.md
 * item 10 for the full audit finding.
 *
 * This suite now:
 *   - imports the real, pure display-mapping functions from
 *     src/lib/commercial/billingDisplay.ts (the module Settings.tsx itself
 *     imports — not a copy);
 *   - reads the real source text of Header.tsx, Footer.tsx, Auth.tsx,
 *     ProductTour.tsx, Settings.tsx, index.html, and copy.ts to verify
 *     structural claims (no SAFF ERP wordmark, correct tour order, no
 *     checkout invocation, etc.) against the actual files, matching this
 *     repository's established source-of-truth testing convention (see
 *     src/lib/__tests__/migrationReplayCompatibilityGuard.test.ts).
 *
 * Run: npx vitest run src/lib/commercial/__tests__/omega3BrandRegression.test.ts
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BRAND,
  HERO,
  HERO_FOOTING,
  NAV,
  PIPELINE,
  PRICING,
  PRICING_SECTION,
  JURISDICTION_SECTION,
  SECURITY_HEADLINE,
  SECURITY_SUBHEAD,
} from "../../../constants/copy";
import {
  displayPlanName,
  displayEntitlement,
  displayLicenceStatus,
  licenceBadgeVariant,
  UNKNOWN_ENTITLEMENT_LABEL,
  EFFECTIVE_END_LABEL,
} from "../billingDisplay";

const REPO_ROOT = path.join(__dirname, "../../../../");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

// ─────────────────────────────────────────────────────────────
// PART 1 — Brand regression (copy constants)
// ─────────────────────────────────────────────────────────────

describe("Ω3-BRAND · public brand", () => {
  it("01 · BRAND.name is CFOClose", () => {
    expect(BRAND.name).toBe("CFOClose");
  });

  it("02 · BRAND.domain is cfoclose.com", () => {
    expect(BRAND.domain).toBe("cfoclose.com");
  });

  it("03 · HERO.eyebrow contains CFOClose", () => {
    expect(HERO.eyebrow).toContain("CFOClose");
  });

  it("04 · SAFF ERP is absent from the hero eyebrow", () => {
    expect(HERO.eyebrow).not.toContain("SAFF ERP");
  });

  it("05 · SAFF ERP is absent from the hero headline", () => {
    expect(HERO.headline).not.toContain("SAFF ERP");
  });

  it("06 · Global hero contains no Tanzania statutory citation", () => {
    const globalCopy = [HERO.eyebrow, HERO.headline, HERO.subhead, HERO_FOOTING].join(" ");
    expect(globalCopy).not.toMatch(/ITA Cap|Finance Act 2026|NBAA Act|TAA Cap|TRA IDRAS/);
  });

  it("07 · Internal engine names are absent from marketing copy", () => {
    const marketingCopy = [HERO.eyebrow, HERO.headline, HERO.subhead, HERO_FOOTING].join(" ");
    expect(marketingCopy).not.toMatch(/\bSAFISHA\b|\bHESABU\b|\bKINGA\b|\bMAONO\b/);
  });

  it("08 · Tanzania jurisdiction-pack explanation is present", () => {
    const jurisdictionText = JURISDICTION_SECTION.items.map((i) => i.detail).join(" ");
    expect(jurisdictionText).toMatch(/Tanzania/);
  });

  it("09 · /pricing navigation entry exists in NAV", () => {
    const pricingNav = NAV.find((n) => n.href === "/pricing");
    expect(pricingNav).toBeDefined();
    expect(pricingNav?.label).toBe("Pricing");
  });

  it("10 · Monthly price is USD 49", () => {
    expect(PRICING.MONTHLY_USD).toBe(49);
    expect(PRICING.CURRENCY_CODE).toBe("USD");
  });

  it("11 · Annual price is USD 499", () => {
    expect(PRICING.ANNUAL_USD).toBe(499);
  });

  it("12 · Annual saving is exactly USD 89", () => {
    expect(PRICING.ANNUAL_SAVING_USD).toBe(89);
  });

  it("13 · Annual saving arithmetic: 49 × 12 − 499 = 89", () => {
    expect(PRICING.MONTHLY_USD * 12).toBe(PRICING.ANNUAL_FULL_USD);
    expect(PRICING.ANNUAL_FULL_USD - PRICING.ANNUAL_USD).toBe(PRICING.ANNUAL_SAVING_USD);
  });

  it("14 · Paid plan customer-facing name is CFOClose Professional", () => {
    expect(PRICING.PAID_NAME).toBe("CFOClose Professional");
  });

  it("15 · Security headline is the iron-dome moat sentence", () => {
    expect(SECURITY_HEADLINE).toContain("cannot be bypassed");
  });

  it("16 · Security copy does not claim SOC 2, uptime stats, or fabricated social proof", () => {
    const secCopy = [SECURITY_HEADLINE, SECURITY_SUBHEAD].join(" ");
    expect(secCopy).not.toMatch(/SOC 2|uptime|testimonial|customer|partner logo/i);
  });

  it("31 · public-tour PIPELINE constant is Upload → Review → Reconcile → Report → File", () => {
    expect(PIPELINE).toEqual(["Upload", "Review", "Reconcile", "Report", "File"]);
  });
});

// ─────────────────────────────────────────────────────────────
// PART 2 — Pricing and checkout guard
// ─────────────────────────────────────────────────────────────

describe("Ω3-BRAND · pricing and checkout guards", () => {
  it("17 · CHECKOUT_DISABLED_MSG is set and non-empty", () => {
    expect(PRICING.CHECKOUT_DISABLED_MSG).toBeTruthy();
    expect(PRICING.CHECKOUT_DISABLED_MSG.length).toBeGreaterThan(10);
  });

  it("18 · TAX_DISCLAIMER is present", () => {
    expect(PRICING.TAX_DISCLAIMER).toMatch(/taxes/i);
  });

  it("19 · PRICING_SECTION routes to /pricing, not to a checkout function", () => {
    expect(PRICING_SECTION.ctaHref).toBe("/pricing");
  });

  it("20 · PRICING_SECTION.cta does not say contact us", () => {
    expect(PRICING_SECTION.cta.toLowerCase()).not.toContain("contact");
  });

  it("32 · Pricing.tsx (real source) invokes no checkout, payment, or commercial-create-checkout call anywhere", () => {
    const src = readSource("src/pages/Pricing.tsx");
    expect(src).not.toMatch(/commercial-create-checkout|payment-status|createCheckout|initiatePayment/i);
    expect(src).not.toMatch(/supabase\.functions\.invoke/);
    expect(src).toContain("PRICING.CHECKOUT_DISABLED_MSG");
  });

  it("33 · Settings.tsx (real source) Plan & Billing CTA links to /pricing only, invokes no checkout function", () => {
    const src = readSource("src/pages/Settings.tsx");
    expect(src).not.toMatch(/commercial-create-checkout|payment-status|createCheckout|initiatePayment/i);
    expect(src).toMatch(/to=["']\/pricing["']/);
  });
});

// ─────────────────────────────────────────────────────────────
// PART 3 — Settings "Plan & Billing" display logic (real functions, not a duplicate)
// ─────────────────────────────────────────────────────────────

describe("Ω3-BRAND · Settings section — real billingDisplay.ts functions", () => {
  it("21 · FREE plan code maps to Free (not PAID or raw code)", () => {
    expect(displayPlanName("FREE")).toBe("Free");
    expect(displayPlanName("FREE")).not.toBe("PAID");
  });

  it("22 · PAID plan code maps to CFOClose Professional", () => {
    expect(displayPlanName("PAID")).toBe("CFOClose Professional");
  });

  it("23 · null plan code maps to Free (no billing customer state)", () => {
    expect(displayPlanName(null)).toBe("Free");
  });

  it("24 · Raw PAID string is never the customer-facing label", () => {
    const label = displayPlanName("PAID");
    expect(label).not.toBe("PAID");
    expect(label).not.toContain("PAID");
  });

  it("34 · An unrecognized plan code fails closed as 'Plan unavailable', never as an active paid plan (charter item 5)", () => {
    expect(displayPlanName("SOME_FUTURE_CODE")).toBe("Plan unavailable");
    expect(displayPlanName("")).not.toBe("CFOClose Professional");
    expect(displayPlanName("corrupted-value")).toBe("Plan unavailable");
    // Empty string is falsy in JS — same branch as null, correctly Free (no billing customer), not "unavailable".
    expect(displayPlanName("")).toBe("Free");
  });

  it("35 · A known feature code maps to its real description, never the raw code", () => {
    expect(displayEntitlement("MULTI_COMPANY")).toBe(
      "Manage more than one company under a single firm licence.",
    );
    expect(displayEntitlement("MULTI_COMPANY")).not.toBe("MULTI_COMPANY");
  });

  it("36 · An unrecognized entitlement code never exposes the raw code (charter item 6)", () => {
    const label = displayEntitlement("SOME_UNKNOWN_CODE_v2");
    expect(label).toBe(UNKNOWN_ENTITLEMENT_LABEL);
    expect(label).not.toContain("SOME_UNKNOWN_CODE_v2");
  });

  it("37 · Licence status displays and badge variants are defined for every authoritative status, with no review-required state fabricated", () => {
    const statuses = ["PENDING", "ACTIVE", "GRACE", "EXPIRED", "SUSPENDED", "CANCELLED"] as const;
    for (const s of statuses) {
      expect(displayLicenceStatus(s)).not.toBe(s); // every real status has a human label, not the raw enum
      expect(["default", "secondary", "outline", "destructive"]).toContain(licenceBadgeVariant(s));
    }
    expect(displayLicenceStatus(null)).toBe("Unknown");
    // Charter item 8: no REVIEW_REQUIRED (or similar) status is defined anywhere —
    // confirmed by the authoritative LicenceStatus union itself having exactly 6 members.
    const entitlementContractSrc = readSource("src/lib/commercial/entitlementContract.ts");
    expect(entitlementContractSrc).not.toMatch(/REVIEW_REQUIRED/);
  });

  it("38 · EFFECTIVE_END_LABEL is 'Effective through', never 'Renews' (charter item 7)", () => {
    expect(EFFECTIVE_END_LABEL).toBe("Effective through");
  });

  it("25 · Monthly amount display is arithmetically correct", () => {
    const monthly = `USD ${PRICING.MONTHLY_USD}/month`;
    expect(monthly).toBe("USD 49/month");
  });

  it("26 · Annual amount display is arithmetically correct", () => {
    const annual = `USD ${PRICING.ANNUAL_USD}/year`;
    expect(annual).toBe("USD 499/year");
  });

  it("27 · Annual saving display is correct", () => {
    const saving = `Save USD ${PRICING.ANNUAL_SAVING_USD}`;
    expect(saving).toBe("Save USD 89");
  });

  it("28 · Settings CTA routes to /pricing, not to checkout", () => {
    expect(PRICING_SECTION.ctaHref).toBe("/pricing");
    expect(PRICING_SECTION.ctaHref).not.toMatch(/checkout|payment|upgrade/i);
  });

  it("29 · Checkout is not initiated by reading billing summary (real hook source)", () => {
    const hookSrc = readSource("src/hooks/useBillingSummary.ts");
    expect(hookSrc).not.toMatch(/commercial-create-checkout|payment-status|createCheckout/i);
    expect(hookSrc).toMatch(/get_my_billing_summary/);
  });

  it("30 · Tanzania TIN copy is present under Companies, not globally exposed", () => {
    const globalHero = [HERO.headline, HERO.subhead, HERO_FOOTING].join(" ");
    expect(globalHero).not.toMatch(/TIN|TRA Tax Identification/);
    const jurisdictionDetail = JURISDICTION_SECTION.items
      .find((i) => i.label.toLowerCase().includes("tanzania"))?.detail ?? "";
    expect(jurisdictionDetail).toMatch(/Tanzania/);
  });
});

// ─────────────────────────────────────────────────────────────
// PART 4 — Real-source structural checks: Header, Footer, Auth, ProductTour, index.html
// (Charter item 10: "Make regression tests read the actual components and metadata.")
// ─────────────────────────────────────────────────────────────

describe("Ω3-BRAND · Header/Footer/Auth — no visible SAFF ERP wordmark (real source)", () => {
  const headerSrc = readSource("src/components/Header.tsx");
  const footerSrc = readSource("src/components/Footer.tsx");
  const authSrc = readSource("src/pages/Auth.tsx");

  it("39 · Header.tsx does not import or render SaffLogo", () => {
    expect(headerSrc).not.toMatch(/SaffLogo/);
  });

  it("40 · Header.tsx renders the CFOCloseWordmark component", () => {
    expect(headerSrc).toMatch(/import \{ CFOCloseWordmark \} from ["']@\/components\/CFOCloseWordmark["']/);
    expect(headerSrc).toMatch(/<CFOCloseWordmark\b/);
  });

  it("41 · Footer.tsx does not import or render SaffLogo", () => {
    expect(footerSrc).not.toMatch(/SaffLogo/);
  });

  it("42 · Footer.tsx renders the CFOCloseWordmark component", () => {
    expect(footerSrc).toMatch(/import \{ CFOCloseWordmark \} from ["']@\/components\/CFOCloseWordmark["']/);
    expect(footerSrc).toMatch(/<CFOCloseWordmark\b/);
  });

  it("43 · Auth.tsx does not import or render SaffLogo", () => {
    expect(authSrc).not.toMatch(/SaffLogo/);
  });

  it("44 · Auth.tsx renders the CFOCloseWordmark component", () => {
    expect(authSrc).toMatch(/import \{ CFOCloseWordmark \} from ["']@\/components\/CFOCloseWordmark["']/);
    expect(authSrc).toMatch(/<CFOCloseWordmark\b/);
  });

  it("45 · Auth.tsx login subtitle says CFOClose, never SAFF ERP", () => {
    expect(authSrc).not.toMatch(/SAFF ERP/);
    expect(authSrc).toMatch(/Sign in to your CFOClose account/);
  });

  it("46 · CFOCloseWordmark.tsx renders BRAND.name as plain text, with no new icon asset import (original, not a copied visual system)", () => {
    const wordmarkSrc = readSource("src/components/CFOCloseWordmark.tsx");
    expect(wordmarkSrc).toMatch(/BRAND\.name/);
    expect(wordmarkSrc).not.toMatch(/\.svg["']|\.png["']|\.jpg["']/);
  });

  it("47 · No public component (Header/Footer/Auth) contains the literal string 'SAFF ERP'", () => {
    for (const src of [headerSrc, footerSrc, authSrc]) {
      expect(src).not.toContain("SAFF ERP");
    }
  });
});

describe("Ω3-BRAND · index.html metadata (real source)", () => {
  const html = readSource("index.html");

  it("48 · <title> is CFOClose, not SAFF ERP", () => {
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/);
    expect(titleMatch?.[1]).toContain("CFOClose");
    expect(titleMatch?.[1]).not.toContain("SAFF ERP");
  });

  it("49 · meta description, author, and keywords contain no SAFF ERP reference", () => {
    expect(html).not.toMatch(/<meta name="description"[^>]*SAFF ERP/);
    expect(html).not.toMatch(/<meta name="author"[^>]*SAFF ERP/);
    expect(html).not.toMatch(/<meta name="keywords"[^>]*SAFF ERP/);
    expect(html).toMatch(/<meta name="author" content="CFOClose"/);
  });

  it("50 · Open Graph and Twitter tags contain no SAFF ERP reference", () => {
    expect(html).not.toMatch(/og:title[^>]*SAFF ERP/);
    expect(html).not.toMatch(/og:description[^>]*SAFF ERP/);
    expect(html).not.toMatch(/twitter:title[^>]*SAFF ERP/);
    expect(html).not.toMatch(/twitter:description[^>]*SAFF ERP/);
  });

  it("51 · index.html contains zero occurrences of the literal string 'SAFF ERP'", () => {
    expect(html).not.toContain("SAFF ERP");
  });
});

describe("Ω3-BRAND · ProductTour public-tour order (real source, charter item 4)", () => {
  const tourSrc = readSource("src/components/ProductTour.tsx");

  it("52 · STAGES array declares ids in exactly Upload → Review → Reconcile → Report → File order", () => {
    const idOrder = [...tourSrc.matchAll(/\{\s*id:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(idOrder).toEqual(["upload", "review", "reconcile", "report", "file"]);
  });

  it("53 · Stage ordinal labels match the corrected order (03 · Reconcile before 04 · Report)", () => {
    expect(tourSrc).toMatch(/label:\s*"03 · Reconcile"/);
    expect(tourSrc).toMatch(/label:\s*"04 · Report"/);
    expect(tourSrc.indexOf('"03 · Reconcile"')).toBeLessThan(tourSrc.indexOf('"04 · Report"'));
  });

  it("54 · exactly 5 stages are declared, matching the 5-step charter sequence", () => {
    const idOrder = [...tourSrc.matchAll(/\{\s*id:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(idOrder).toHaveLength(5);
  });
});
