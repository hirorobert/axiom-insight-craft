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
import { PRODUCT_OUTCOMES } from "../../product/outcomes";

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

  it("08 · jurisdiction-pack explanation is present, and neutral (no single jurisdiction is named)", () => {
    const jurisdictionText = JURISDICTION_SECTION.items.map((i) => i.detail).join(" ");
    expect(jurisdictionText).toMatch(/jurisdiction/i);
    expect(jurisdictionText).not.toMatch(/Tanzania|\bTRA\b|\bTIN\b/);
  });

  // 09 was rewritten with the landing-page rebuild. The header navigation is now a set of in-page
  // section links rather than a route list, and commercial information lives in the landing page's
  // own "Commercial" section — so a "/pricing" NAV entry no longer exists. The guarantee this test
  // protects is unchanged and still asserted: commercial information stays reachable from the
  // public navigation, and the /pricing route itself is untouched.
  it("09 · commercial information is reachable from the public navigation", () => {
    const commercialNav = NAV.find((n) => n.href === "#commercial");
    expect(commercialNav, "the public navigation must reach the commercial section").toBeDefined();
    expect(commercialNav?.label).toBe("Commercial");
    expect(NAV.every((n) => n.href.startsWith("#")), "landing navigation is in-page only").toBe(true);
  });

  // Superseded by the CFO Close catalogue (20260925100000): the entry paid plan is Practice at $99 / $990, derived
  // from the one catalogue — no price is written in copy.ts. There is no public $49 plan.
  it("10 · Entry paid plan monthly price is $99 (USD)", () => {
    expect(PRICING.ENTRY_MONTHLY).toBe("$99");
    expect(PRICING.CURRENCY_CODE).toBe("USD");
  });

  it("11 · Entry paid plan annual price is $990", () => {
    expect(PRICING.ENTRY_ANNUAL).toBe("$990");
  });

  it("12 · Entry paid plan annual saving is exactly $198", () => {
    expect(PRICING.ENTRY_ANNUAL_SAVING).toBe("$198");
  });

  it("13 · Annual saving arithmetic: 99 × 12 − 990 = 198 (derived once, in the catalogue)", () => {
    expect(99 * 12 - 990).toBe(198);
    expect(Object.keys(PRICING)).not.toContain("MONTHLY_USD");
  });

  it("14 · Entry paid plan customer-facing name is Practice", () => {
    expect(PRICING.ENTRY_PLAN_NAME).toBe("Practice");
  });

  it("15 · Security headline is the iron-dome moat sentence", () => {
    expect(SECURITY_HEADLINE).toContain("system boundary");
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

  it("32 · Pricing.tsx (real source) never constructs a checkout call of its own and, with no checkout in this build, renders none", () => {
    // CORRECTED (Ω3-CHECKOUT supersedes Ω3-BRAND's "checkout stays fully
    // disabled" milestone): checkout is now server-gated (platform_state,
    // offer resolution, provider configuration all still fail this closed
    // independently of this page), not statically disabled in the UI, so
    // Pricing.tsx legitimately renders <CheckoutUpgradeButton> now. What
    // this test still guards, unchanged in spirit: Pricing.tsx itself must
    // never construct a second, independent checkout call that bypasses
    // the one authorized entry point (CheckoutUpgradeButton ->
    // createCheckoutIntent -> commercial-create-checkout).
    const src = readSource("src/pages/Pricing.tsx");
    expect(src).not.toMatch(/commercial-create-checkout|payment-status|initiatePayment/i);
    expect(src).not.toMatch(/supabase\.functions\.invoke/);
    expect(src).not.toMatch(/\bcreateCheckoutIntent\(/);
    expect(src).not.toMatch(/<CheckoutUpgradeButton\b/);
    // CFO Close catalogue (20260925100000): no checkout in this build, so the pricing page imports none.
    expect(src).not.toMatch(/from "@\/components\/commercial\/CheckoutUpgradeButton"/);
  });

  it("33 · Ω3-CHECKOUT — Settings.tsx (real source) invokes checkout/renewal ONLY through the shared CheckoutUpgradeButton component, never a direct/duplicated call of its own", () => {
    // CORRECTED, same reasoning as test 32: the Plan & Billing panel now
    // legitimately offers a like-for-like manual-renewal action via the
    // SAME shared component, not a bespoke renewal implementation.
    const src = readSource("src/pages/Settings.tsx");
    expect(src).not.toMatch(/commercial-create-checkout|payment-status|initiatePayment/i);
    expect(src).not.toMatch(/supabase\.functions\.invoke/);
    expect(src).not.toMatch(/\bcreateCheckoutIntent\(/);
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

  it("22 · plan codes map to catalogue names; the grandfathered legacy PAID plan is labelled as legacy", () => {
    expect(displayPlanName("FREE")).toBe("Free");
    expect(displayPlanName("PRACTICE")).toBe("Practice");
    expect(displayPlanName("FIRM")).toBe("Firm");
    expect(displayPlanName("ENTERPRISE")).toBe("Enterprise");
    expect(displayPlanName("PAID")).toBe("Professional (legacy)");
  });

  it("23 · null plan code fails closed as 'Plan unavailable' — Settings.tsx only calls displayPlanName after confirming a billing customer exists, so null here is an anomaly, not 'no billing customer'", () => {
    expect(displayPlanName(null)).toBe("Plan unavailable");
    expect(displayPlanName(null)).not.toBe("Free");
    // The distinct "no billing customer at all" state is rendered by Settings.tsx's
    // own separate `!billing.hasBillingCustomer` branch, upstream of this function —
    // never inside displayPlanName itself. Confirmed against the real component source.
    const settingsSrc = readSource("src/pages/Settings.tsx");
    expect(settingsSrc).toMatch(/!billing(?:\?\.|\.)hasBillingCustomer/);
  });

  it("24 · Raw PAID string is never the customer-facing label", () => {
    const label = displayPlanName("PAID");
    expect(label).not.toBe("PAID");
    expect(label).not.toContain("PAID");
  });

  it("34 · An unrecognized, null, or empty plan code all fail closed as 'Plan unavailable', never as an active paid plan (charter item 5, corrected)", () => {
    expect(displayPlanName("SOME_FUTURE_CODE")).toBe("Plan unavailable");
    expect(displayPlanName("corrupted-value")).toBe("Plan unavailable");
    expect(displayPlanName("")).toBe("Plan unavailable");
    expect(displayPlanName(null)).toBe("Plan unavailable");
    for (const bad of ["SOME_FUTURE_CODE", "corrupted-value", "", null]) {
      const label = displayPlanName(bad);
      expect(label).not.toBe(PRICING.PAID_NAME);
      expect(label).not.toBe(PRICING.FREE_NAME);
    }
  });

  it("35 · A known capability code maps to its customer description, never the raw code", () => {
    expect(displayEntitlement("ENTITY_CAPACITY")).toBe("Entity Capacity — How many active entities your plan includes.");
    expect(displayEntitlement("ENTITY_CAPACITY")).not.toBe("ENTITY_CAPACITY");
    expect(displayEntitlement("MULTI_COMPANY")).toBe("Capability details unavailable"); // legacy codes are never displayed raw
  });

  it("36 · An unrecognized entitlement code never exposes the raw code and never claims inclusion (charter item 6, corrected)", () => {
    const label = displayEntitlement("SOME_UNKNOWN_CODE_v2");
    expect(label).toBe(UNKNOWN_ENTITLEMENT_LABEL);
    expect(label).toBe("Capability details unavailable");
    expect(label).not.toContain("SOME_UNKNOWN_CODE_v2");
    // Must not claim the unknown capability is included — only that its details are unavailable.
    expect(label.toLowerCase()).not.toMatch(/\bincluded\b/);
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

  it("37b · An unexpected runtime licence status fails closed as 'Status unavailable' — its raw text is never returned (charter item 3, corrected)", () => {
    // The LicenceStatus type promises only 6 values, but a value crossing a
    // real runtime boundary (an untyped RPC response, a future server status
    // this build doesn't know about yet) can violate that promise. Simulate
    // exactly that boundary crossing with an `as` cast, the same way an
    // untyped `data.licence_status` from a Supabase RPC would arrive.
    const bogusStatus = "SOME_FUTURE_STATUS_NOT_YET_KNOWN" as unknown as Parameters<
      typeof displayLicenceStatus
    >[0];
    const label = displayLicenceStatus(bogusStatus);
    expect(label).toBe("Status unavailable");
    expect(label).not.toBe(bogusStatus);
    expect(label).not.toContain("SOME_FUTURE_STATUS_NOT_YET_KNOWN");
  });

  it("38 · EFFECTIVE_END_LABEL is 'Effective through', never 'Renews' (charter item 7)", () => {
    expect(EFFECTIVE_END_LABEL).toBe("Effective through");
  });

  it("25 · Monthly amount display comes from the catalogue", () => {
    expect(`${PRICING.ENTRY_MONTHLY}/month`).toBe("$99/month");
  });

  it("26 · Annual amount display comes from the catalogue", () => {
    expect(`${PRICING.ENTRY_ANNUAL}/year`).toBe("$990/year");
  });

  it("27 · Annual saving display comes from the catalogue", () => {
    expect(`Save ${PRICING.ENTRY_ANNUAL_SAVING}`).toBe("Save $198");
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

  it("30 · no tax-registration or jurisdiction-specific copy is globally exposed; the jurisdiction pack is described neutrally", () => {
    const globalHero = [HERO.headline, HERO.subhead, HERO_FOOTING].join(" ");
    expect(globalHero).not.toMatch(/\bTIN\b|\bTRA\b|Tanzania/);
    const jurisdictionDetail = JURISDICTION_SECTION.items
      .find((i) => i.label.toLowerCase().includes("jurisdiction compliance"))?.detail ?? "";
    expect(jurisdictionDetail).toMatch(/configured jurisdiction/);
    expect(jurisdictionDetail).not.toMatch(/Tanzania|\bTRA\b|\bTIN\b/);
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

describe("Ω3-BRAND · ProductTour outcome architecture (real source)", () => {
  const tourSrc = readSource("src/components/ProductTour.tsx");

  it("52 · public outcomes follow the canonical customer-job order", () => {
    expect(PRODUCT_OUTCOMES.map((outcome) => outcome.id)).toEqual([
      "clean-trial-balance",
      "prepare-statements",
      "review-statements",
      "tax-compliance",
      "performance-risk",
      "full-close",
    ]);
  });

  it("53 · the public selector renders from the honest-capability-filtered outcome registry (PUBLIC_PRODUCT_OUTCOMES, not PRODUCT_OUTCOMES directly)", () => {
    expect(tourSrc).toMatch(/PUBLIC_PRODUCT_OUTCOMES\.map/);
    expect(tourSrc).toMatch(/outcomeAuthHref\(outcome\.id\)/);
    expect(tourSrc).toMatch(/rememberOutcome\(outcome\.id\)/);
  });

  it("54 · selector is deterministic: no autoplay, timer, synthetic frame or skip state", () => {
    expect(PRODUCT_OUTCOMES).toHaveLength(6);
    expect(tourSrc).not.toMatch(/setInterval|setTimeout|playing|elapsed|ProductTour.*Frame/);
  });

  it("75 · the selector renders each outcome's explicit ctaLabel, never a generic 'Select' CTA", () => {
    // Availability ("Workflow available"/"Data dependent") is a deliberate,
    // retained design element of the recovered landing redesign (PR #20) —
    // only the generic "Select" CTA text is banned, not the availability
    // badge itself.
    expect(tourSrc).not.toMatch(/>\s*Select\s*</);
    expect(tourSrc).toMatch(/outcome\.ctaLabel/);
    expect(tourSrc).toMatch(/fullClose\.ctaLabel/);
  });

  it("76 · every selector row exposes a unique accessible action name (no duplicate 'Select' across rows) and no nested interactive controls", () => {
    expect(tourSrc).toMatch(/aria-label=\{`\$\{outcome\.ctaLabel\}: \$\{outcome\.title\}`\}/);
    expect(tourSrc).toMatch(/aria-label=\{`\$\{fullClose\.ctaLabel\}: \$\{fullClose\.title\}`\}/);
    // Two <Link> elements in source is correct here: one per standard-card
    // iteration (PUBLIC_PRODUCT_OUTCOMES.map) and one for the single,
    // separately-rendered full-close hero card — never a <Link> nested
    // inside another interactive control.
    const linkCount = (tourSrc.match(/<Link\b/g) ?? []).length;
    expect(linkCount).toBe(2);
    expect(tourSrc).not.toMatch(/<Link\b[^>]*>[\s\S]{0,400}<Link\b/);
  });

  it("77 · document review is listed immediately after statement preparation, and never reuses the trial-balance input language", () => {
    const review = PRODUCT_OUTCOMES.find((o) => o.id === "review-statements")!;
    const prepare = PRODUCT_OUTCOMES.find((o) => o.id === "prepare-statements")!;
    expect(PRODUCT_OUTCOMES.indexOf(review)).toBe(PRODUCT_OUTCOMES.indexOf(prepare) + 1);
    expect(review.inputKind).toBe("financial_statements");
    expect(review.input).not.toMatch(/CSV/i);
    expect(review.ctaLabel.toLowerCase()).not.toBe("assess this");
  });
});

// ─────────────────────────────────────────────────────────────
// PART 5 — Public favicon identity (charter item 4, corrected)
// ─────────────────────────────────────────────────────────────

describe("Ω3-BRAND · public favicon identity (real source)", () => {
  const html = readSource("index.html");
  const PUBLIC_DIR = path.join(REPO_ROOT, "public");

  it("55 · index.html references the CFOClose favicon via an explicit <link rel=\"icon\">", () => {
    expect(html).toMatch(/<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/favicon\.svg"\s*\/>/);
  });

  it("56 · no legacy favicon.ico path remains referenced anywhere in index.html", () => {
    expect(html).not.toMatch(/favicon\.ico/);
  });

  it("57 · the legacy favicon.ico file itself no longer exists in public/, so it cannot be served as a default-path fallback", () => {
    expect(fs.existsSync(path.join(PUBLIC_DIR, "favicon.ico"))).toBe(false);
  });

  it("58 · public/favicon.svg exists and is well-formed (parses as valid XML with no comment-syntax errors)", () => {
    const svgPath = path.join(PUBLIC_DIR, "favicon.svg");
    expect(fs.existsSync(svgPath)).toBe(true);
    const svg = fs.readFileSync(svgPath, "utf-8");
    expect(svg).toMatch(/^<svg\b/);
    // XML comments must never contain a literal "--" anywhere in their body —
    // this is exactly the class of bug caught and fixed while authoring this file.
    const commentBodies = [...svg.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
    for (const body of commentBodies) {
      expect(body).not.toMatch(/--/);
    }
  });

  it("59 · favicon.svg's rendered content contains no SAFF, AAA/American Accounting Association text, and no third-party visual system", () => {
    // Check only the rendered (non-comment) SVG content — an explanatory
    // authoring comment documenting "this replaces the legacy SAFF glyph"
    // is legitimate, non-rendered, non-visible source commentary, not a
    // visible identity violation. Strip XML comments before asserting.
    const svg = readSource("public/favicon.svg");
    const rendered = svg.replace(/<!--[\s\S]*?-->/g, "");
    expect(rendered).not.toMatch(/\bSAFF\b/);
    expect(rendered).not.toMatch(/\bAAA\b|American Accounting Association/);
  });

  it("60 · favicon.svg embeds no external asset reference (no <image>, no xlink:href, no remote url())", () => {
    const svg = readSource("public/favicon.svg");
    expect(svg).not.toMatch(/<image\b/i);
    expect(svg).not.toMatch(/xlink:href/i);
    expect(svg).not.toMatch(/url\(\s*["']?https?:/i);
  });

  it("61 · favicon.svg draws its mark as vector paths/shapes, not as embedded raster data (no base64 data: URI)", () => {
    const svg = readSource("public/favicon.svg");
    expect(svg).not.toMatch(/data:image\//i);
  });

  it("62 · public metadata remains fully CFOClose-branded alongside the favicon change (no regression)", () => {
    expect(html).toMatch(/<title>CFOClose/);
    expect(html).toMatch(/<meta name="author" content="CFOClose"/);
    expect(html).not.toContain("SAFF ERP");
  });
});

// ─────────────────────────────────────────────────────────────
// PART 6 — Phase B controlled correction (H-1 tablet nav collision,
// M-1 missing mobile sign-in, H-2 unenforced commercial limits)
// ─────────────────────────────────────────────────────────────

describe("Ω3-BRAND · Header responsive navigation — H-1 tablet collision fix (real source)", () => {
  const headerSrc = readSource("src/components/Header.tsx");
  // Everything from the "Mobile Menu" render block to end of file — isolates
  // the signed-out mobile controls from the unrelated desktop right-actions
  // block, which also contains a `to="/auth"` Sign-in link.
  const mobileMenuSrc = headerSrc.slice(headerSrc.indexOf("{/* Mobile Menu */}"));

  it("63 · desktop navigation and right-actions reveal at the lg breakpoint, not md — no `hidden md:flex` visibility toggle remains", () => {
    expect(headerSrc).not.toMatch(/hidden md:flex/);
    expect(headerSrc).toMatch(/<nav className="hidden lg:flex/);
    expect(headerSrc).toMatch(/<div className="hidden lg:flex/);
  });

  it("64 · the mobile menu toggle button and mobile menu container collapse at lg, not md — the mobile presentation stays active for every width below 1024px", () => {
    expect(headerSrc).not.toMatch(/className="md:hidden/);
    // The toggle gained an explicit 44px target and a visible focus ring in the landing rebuild, so
    // the class list is matched by its meaning (lg:hidden on the toggle) rather than verbatim.
    expect(headerSrc).toMatch(/className="lg:hidden flex h-11 w-11[^"]*"[\s\S]{0,200}aria-controls="mobile-navigation"/);
    expect(headerSrc).toMatch(/id="mobile-navigation"[\s\S]{0,200}className="lg:hidden bg-card/);
  });

  it("65 · Header.tsx introduces no second/duplicated navigation implementation — exactly one <nav> element and one mobile-menu toggle handler", () => {
    expect((headerSrc.match(/<nav\b/g) ?? []).length).toBe(1);
    expect((headerSrc.match(/setMobileOpen\(!mobileOpen\)/g) ?? []).length).toBe(1);
  });

  it("66 · M-1 — the signed-out mobile menu contains both a Sign in action and a Choose outcome action, Sign in listed first", () => {
    const signInIndex = mobileMenuSrc.indexOf(
      '<Link to="/auth" onClick={() => setMobileOpen(false)}>Sign in</Link>',
    );
    const primaryIndex = mobileMenuSrc.indexOf("{CTA.primary}");
    expect(signInIndex, "expected the mobile Sign in link in the signed-out menu").toBeGreaterThan(-1);
    expect(primaryIndex, "expected the mobile primary sign-up action").toBeGreaterThan(-1);
    expect(signInIndex, "Sign in must be listed before the primary action").toBeLessThan(primaryIndex);
  });

  it("67 · M-1 — both signed-out mobile actions close the mobile menu when activated", () => {
    const signedOutBranch = mobileMenuSrc.slice(mobileMenuSrc.indexOf("Sign in") - 400);
    // Exactly two `setMobileOpen(false)` close-handlers in the signed-out
    // branch: one on Sign in, one on the primary sign-up action.
    const closeHandlers = signedOutBranch
      .slice(0, signedOutBranch.indexOf("{CTA.primary}") + 200)
      .match(/onClick=\{\(\) => setMobileOpen\(false\)\}/g) ?? [];
    expect(closeHandlers.length).toBeGreaterThanOrEqual(2);
  });

  it("68 · M-1 — both signed-out mobile actions use the `lg` button size (48px) for a practical touch target of at least 44px, and neither duplicates the page's single primary CTA", () => {
    const signInButtonMatch = mobileMenuSrc.match(
      /<Button variant="outline" size="lg"[^>]*>\s*<Link to="\/auth"/,
    );
    const primaryButtonMatch = mobileMenuSrc.match(
      /<Button variant="hero" size="lg"[^>]*>\s*<Link\b/,
    );
    expect(signInButtonMatch, "Sign in must render as an outline/restrained lg-sized button").toBeTruthy();
    expect(primaryButtonMatch, "the sign-up action must remain the sole hero/primary-styled action").toBeTruthy();
    // Only one hero-variant (primary) button exists in the signed-out mobile menu.
    expect((mobileMenuSrc.match(/variant="hero"/g) ?? []).length).toBe(1);
  });
});

describe("Ω3-BRAND · Pricing/Settings — H-2 unenforced commercial limits removed (real source)", () => {
  const pricingSrc = readSource("src/pages/Pricing.tsx");
  const settingsSrc = readSource("src/pages/Settings.tsx");

  it("69 · Pricing.tsx asserts no company-count or period-count entitlement boundary, and no unlimited promise", () => {
    for (const src of [pricingSrc]) {
      expect(src).not.toMatch(/one company/i);
      expect(src).not.toMatch(/multi-company/i);
      expect(src).not.toMatch(/multi-period/i);
      expect(src).not.toMatch(/unlimited/i);
    }
  });

  it("70 · Settings.tsx asserts no company-count or period-count entitlement boundary, and no unlimited promise", () => {
    expect(settingsSrc).not.toMatch(/one company/i);
    expect(settingsSrc).not.toMatch(/multi-company/i);
    expect(settingsSrc).not.toMatch(/multi-period/i);
    expect(settingsSrc).not.toMatch(/unlimited/i);
  });

  it("71 · neither the pricing page nor the catalogue claims 'Audit trail for all actions'", () => {
    const catalogueSrc = readSource("src/lib/commercial/pricingCatalogue.ts");
    for (const src of [pricingSrc, catalogueSrc]) expect(src).not.toMatch(/Audit trail for all actions/i);
  });

  it("72 · plan names, taglines and features come from the one catalogue, never from page-local copy", () => {
    expect(pricingSrc).toMatch(/PRICING_CATALOGUE\.map\(/);
    expect(pricingSrc).not.toMatch(/const (FREE|PAID)_(FEATURES|TAGLINE)\b/);
  });

  it("73 · Settings.tsx Plan & Billing free-state copy uses the approved scope-neutral replacement", () => {
    expect(settingsSrc).toContain(
      "You are currently using the free plan. Review available plans and released",
    );
    expect(settingsSrc).toMatch(/Professional capabilities\.?/);
  });

  it("74 · neither Pricing.tsx nor Settings.tsx were touched in a way that changes commercial entitlement logic — both still route upgrade/checkout intent through the shared CheckoutUpgradeButton, never a direct call of their own", () => {
    for (const src of [pricingSrc, settingsSrc]) {
      expect(src).not.toMatch(/supabase\.functions\.invoke\(\s*["']commercial-create-checkout["']/);
    }
  });
});
