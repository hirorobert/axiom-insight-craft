/**
 * landingPage.test.ts — acceptance gates for the public landing page.
 *
 * Rendering convention: this repository runs vitest in the `node` environment with no jsdom and no
 * @testing-library, so sections are rendered with renderToStaticMarkup — the honest fidelity level
 * for this surface: its server-rendered markup IS what a visitor and a crawler receive. Interaction
 * (choosing a service, the mobile menu) is asserted at the mechanism level here and verified in a
 * browser at 1366px and 375px.
 *
 * What is protected, each because getting it wrong is a real failure rather than a style regression:
 *
 *  1. Two distinct decisions. The OUTCOME (which service) and the CAPACITY (which plan) are separate
 *     sections; services carry no price and are never a basket (single choice, no counters, no locks).
 *  2. Truthful availability, derived from the plan × capability matrix: "Included in every plan" or
 *     "Plan required" — never "free", never "paid capability".
 *  3. Low cognitive load: at most three outputs by default, the rest behind one disclosure.
 *  4. Intent survives: every sign-up / sign-in action carries the selected service as a closed-registry
 *     identifier. The page grants nothing.
 *  5. Commercial honesty: plan figures derive from the one catalogue and stay "Proposed"; no checkout,
 *     Buy or Subscribe; the commercial-status disclosure is stated once, in the footer.
 *  6. The landing surface reaches no backend; every in-page link resolves.
 */

import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// The Header pulls in the auth context and the notification bell; neither may touch a backend from
// a test, and neither is part of what this file asserts.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
    channel: vi.fn(() => ({ on: vi.fn(() => ({ subscribe: vi.fn() })), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
    functions: { invoke: vi.fn() },
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
  },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null, session: null, signOut: vi.fn() }) }));

import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { CapacityPlans } from "@/components/landing/CapacityPlans";
import { LandingFAQ } from "@/components/landing/LandingFAQ";
import { LandingFinalCTA } from "@/components/landing/LandingFinalCTA";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingIntentProvider } from "@/components/landing/LandingIntent";
import { ServiceChooser } from "@/components/landing/ServiceChooser";
import { TrustStrip } from "@/components/landing/TrustStrip";
import { NAV } from "@/constants/copy";
import {
  COMMERCIAL_NOTICE,
  LANDING_FAQ,
  LANDING_FINAL_CTA,
  LANDING_HERO,
  LANDING_SECTION_IDS,
  LANDING_SERVICES,
  LANDING_TRUST,
} from "@/content/landing/landingContent";
import { PROPOSED_PLANS } from "@/content/landing/proposedPlans";
import { SERVICE_INTENT_IDS, type ServiceIntentId } from "@/lib/commercial/serviceIntent";
import { PUBLIC_CLAIM_REGISTRY } from "@/content/publicClaimRegistry";

const ROOT = path.resolve(__dirname, "../../../..");
const LANDING_COMPONENT_DIR = path.join(ROOT, "src/components/landing");

function readLandingSources(): { file: string; source: string }[] {
  return fs
    .readdirSync(LANDING_COMPONENT_DIR)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => ({ file: f, source: fs.readFileSync(path.join(LANDING_COMPONENT_DIR, f), "utf8") }));
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Markup with tags removed and entities decoded — the text a reader actually sees. */
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

const page = (initial: ServiceIntentId = "prepare-review") =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        LandingIntentProvider,
        { initial },
        createElement(Header),
        createElement(
          "main",
          { id: "main-content" },
          createElement(LandingHero),
          createElement(ServiceChooser),
          createElement(CapacityPlans),
          createElement(TrustStrip),
          createElement(LandingFAQ),
          createElement(LandingFinalCTA),
        ),
        createElement(Footer),
      ),
    ),
  );
const PAGE = page();
const PAGE_TEXT = visibleText(PAGE);
const section = (markup: string, id: string) => {
  const start = markup.indexOf(`id="${id}"`);
  const open = markup.lastIndexOf("<section", start);
  return markup.slice(open, markup.indexOf("</section>", start) + 10);
};
const hrefOf = (markup: string, testid: string) =>
  (markup.match(new RegExp(`<a\\s[^>]*data-testid="${testid}"[^>]*>`))?.[0].match(/href="([^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Structure
// ─────────────────────────────────────────────────────────────────────────────

describe("page structure", () => {
  it("one level-1 heading carrying the value proposition", () => {
    expect(PAGE.match(/<h1\b/g) ?? []).toHaveLength(1);
    expect(PAGE_TEXT).toContain(LANDING_HERO.headline);
  });

  it("renders exactly the declared sections, in order: outcome → what you receive → capacity → questions", () => {
    const at = LANDING_SECTION_IDS.map((id) => PAGE.indexOf(`id="${id}"`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const retired of ["capabilities", "process", "deliverables", "commercial", "sample-close"]) {
      expect(PAGE, `retired section #${retired} is back`).not.toContain(`id="${retired}"`);
    }
  });

  it("every in-page navigation link points at a section that exists", () => {
    const targets = [...NAV.map((i) => i.href), LANDING_HERO.secondaryCta.href, LANDING_FINAL_CTA.secondaryCta.href].filter((h) => h.startsWith("#"));
    expect(targets.length).toBeGreaterThan(0);
    for (const href of targets) expect(PAGE, `dead anchor: ${href}`).toContain(`id="${href.slice(1)}"`);
  });

  it("the hero offers exactly two actions plus a compact service selector, and no fictional status panel", () => {
    const hero = visibleText(renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LandingHero))));
    expect(hero).toContain(LANDING_HERO.primaryCta.label);
    expect(hero).toContain(LANDING_HERO.secondaryCta.label);
    for (const s of LANDING_SERVICES) expect(hero).toContain(s.name);
    expect(hero).not.toMatch(/Meridian|Preparation status|Illustrative synthetic|7-stage|firms trust/i);
  });

  it("asks for sign-up as 'Create account' in at most three places; no acquisition wording the guards forbid", () => {
    expect(PAGE_TEXT).not.toMatch(/Request access|Send an access request|Start free|Get started|\bBuy\b|Subscribe|Start (a )?trial/i);
    const signups = PAGE_TEXT.match(/Create account/g) ?? [];
    expect(signups.length).toBeGreaterThan(0);
    expect(signups.length).toBeLessThanOrEqual(3);
  });

  it("copy budgets: hero ≤ 35 words; each outcome ≤ 30; each value ≤ 15; final CTA ≤ 25", () => {
    expect(wordCount(LANDING_HERO.supporting)).toBeLessThanOrEqual(35);
    for (const s of LANDING_SERVICES) {
      expect(wordCount(s.outcome), s.name).toBeLessThanOrEqual(30);
      expect(wordCount(s.value), s.name).toBeLessThanOrEqual(15);
    }
    expect(wordCount(`${LANDING_FINAL_CTA.heading} ${LANDING_FINAL_CTA.supporting}`)).toBeLessThanOrEqual(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The outcome decision
// ─────────────────────────────────────────────────────────────────────────────

describe("choose your outcome", () => {
  const services = section(PAGE, "services");

  it("four services, ids = the closed intent registry, as ONE single-select radio group", () => {
    expect(LANDING_SERVICES.map((s) => s.id)).toEqual([...SERVICE_INTENT_IDS]);
    const radios = services.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(4);
    expect(new Set(radios.map((r) => r.match(/name="([^"]+)"/)?.[1])).size).toBe(1);
    expect(radios.filter((r) => /checked=""/.test(r))).toHaveLength(1);
  });

  it("no basket: no checkbox, no toggle button, no lock, no counter, no price", () => {
    expect(services).not.toMatch(/type="checkbox"|aria-pressed|Always included|lock|\d+ outputs?\b|Selected ·/i);
    expect(visibleText(services)).not.toMatch(/USD|per month|Proposed:/);
  });

  it("availability comes only from the matrix: 'Included in every plan' / 'Plan required'; never free or paid capability", () => {
    for (const s of LANDING_SERVICES) {
      const label = services.match(new RegExp(`data-testid="availability-${s.id}"[^>]*>([^<]+)<`))?.[1];
      expect(["Included in every plan", "Plan required"]).toContain(label);
    }
    expect(PAGE_TEXT).not.toMatch(/\bfree\b|paid capability|proposed for paid capacity|premium feature/i);
    const sources = readLandingSources().map((s) => s.source).join("\n") + fs.readFileSync(path.join(ROOT, "src/content/landing/landingContent.ts"), "utf8");
    expect(sources).not.toMatch(/"Included in every plan"|"Plan required"/);   // derived, never written in copy
  });

  it.each(SERVICE_INTENT_IDS)("selected '%s': at most three outputs by default, the rest behind one disclosure, and one start action carrying the service", (id) => {
    const markup = page(id);
    const preview = markup.slice(markup.indexOf('data-testid="service-preview"'));
    const svc = LANDING_SERVICES.find((s) => s.id === id)!;
    const primary = preview.slice(0, preview.indexOf("</ul>"));
    expect((primary.match(/<li\b/g) ?? []).length).toBe(svc.primaryOutputs.length);
    expect(svc.primaryOutputs.length).toBeLessThanOrEqual(3);
    for (const o of svc.primaryOutputs) expect(visibleText(primary)).toContain(o.name);
    if (svc.moreOutputs.length) {
      expect(preview).toMatch(/<details[^>]*data-testid="more-outputs"[^>]*>/);
      expect(preview).not.toMatch(/<details[^>]*\bopen\b/);
      expect(visibleText(preview)).toContain("See all included outputs");
    } else {
      expect(preview).not.toContain('data-testid="more-outputs"');
    }
    expect(hrefOf(markup, "service-start")).toBe(`/auth?mode=signup&service=${id}`);
    expect(hrefOf(markup, "service-sign-in")).toBe(`/auth?service=${id}`);
    expect(hrefOf(markup, "hero-create-account")).toBe(`/auth?mode=signup&service=${id}`);
    expect(hrefOf(markup, "final-create-account")).toBe(`/auth?mode=signup&service=${id}`);
  });

  it("advertises no regulatory filing format, audit package or 'Full IFRS'; certification is stated as an internal record", () => {
    const all = LANDING_SERVICES.flatMap((s) => [...s.primaryOutputs, ...s.moreOutputs].map((o) => o.name)).join(" ").toLowerCase();
    for (const forbidden of ["xbrl", "audit package", "full ifrs"]) expect(all).not.toContain(forbidden);
    expect(LANDING_SERVICES.find((s) => s.id === "close-certification")!.note).toBe(
      "It is not an external audit, an audit opinion, or any form of statutory assurance.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The capacity decision
// ─────────────────────────────────────────────────────────────────────────────

describe("choose your capacity", () => {
  const plans = section(PAGE, "plans");

  it("a separate section; every figure derived from the catalogue; prices stay 'Proposed'", async () => {
    const { PRICING_CATALOGUE } = await import("@/lib/commercial/pricingCatalogue");
    expect(PROPOSED_PLANS.map((p) => p.code)).toEqual(PRICING_CATALOGUE.map((p) => p.code));
    expect(PROPOSED_PLANS.map(({ name, entities, namedUsers, proposedAmount, contactSales }) => ({ name, entities, namedUsers, proposedAmount, contactSales }))).toEqual([
      { name: "Solo", entities: "1", namedUsers: "1", proposedAmount: "Proposed: USD 490 per year", contactSales: false },
      { name: "Practice", entities: "5", namedUsers: "1 included · more available", proposedAmount: "Proposed: USD 990 per year", contactSales: false },
      { name: "Firm", entities: "25", namedUsers: "1 included · more available", proposedAmount: "Proposed: USD 2,990 per year", contactSales: false },
      { name: "Enterprise", entities: "Negotiated", namedUsers: "Negotiated", proposedAmount: "Proposed: terms agreed separately", contactSales: true },
    ]);
    for (const p of PRICING_CATALOGUE) expect(PROPOSED_PLANS.find((x) => x.code === p.code)!.bestFor).toBe(p.tagline);
    const derived = fs.readFileSync(path.join(ROOT, "src/content/landing/proposedPlans.ts"), "utf8");
    expect(derived).toContain("PRICING_CATALOGUE.map(");
    expect(derived).not.toMatch(/USD \d/);
    expect(fs.readFileSync(path.join(ROOT, "src/content/landing/landingContent.ts"), "utf8")).not.toMatch(/USD \d|named user included|\d+ entities/);
    for (const p of PROPOSED_PLANS) expect(visibleText(plans)).toContain(p.proposedAmount);
    expect((visibleText(PAGE).match(/USD [\d,]+/g) ?? []).length).toBe(3);   // annual prices, once each, only here
    expect(visibleText(PAGE)).not.toMatch(/per month|monthly|instalment/i);   // no monthly price or instalment claim
  });

  it("each self-serve plan action carries the selected service and the plan preference into sign-up; Enterprise is discussed, never self-activated", () => {
    const markup = page("reporting-pack");
    expect(hrefOf(markup, "plan-action-Solo")).toBe("/auth?mode=signup&service=reporting-pack&plan=solo");
    expect(hrefOf(markup, "plan-action-Practice")).toBe("/auth?mode=signup&service=reporting-pack&plan=practice");
    expect(hrefOf(markup, "plan-action-Firm")).toBe("/auth?mode=signup&service=reporting-pack&plan=firm");
    expect(visibleText(section(markup, "plans"))).toMatch(/Choose Solo.*Choose Practice.*Choose Firm.*Discuss Enterprise/);
    expect(visibleText(section(markup, "plans"))).not.toMatch(/Choose Enterprise/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Trust, commercial honesty, FAQ
// ─────────────────────────────────────────────────────────────────────────────

describe("trust strip", () => {
  it("exactly three assurances, each a registered claim verbatim", () => {
    expect(LANDING_TRUST.map((t) => t.title)).toEqual(["Traceable source", "Attributed decisions", "Protected history"]);
    const registered = PUBLIC_CLAIM_REGISTRY.map((c) => c.approvedWording);
    for (const t of LANDING_TRUST) expect(registered.some((w) => t.text.startsWith(w)), t.title).toBe(true);
  });
});

describe("Enterprise", () => {
  it("with the enquiry surface on (the committed state), 'Discuss Enterprise' opens the registered contact page — no sign-up, no plan link", async () => {
    const { SERVICE_ENQUIRY_SURFACES } = await import("@/lib/serviceEnquiry/serviceEnquiryGate");
    expect(SERVICE_ENQUIRY_SURFACES.contactRoute).toBe(true);
    const { CONTACT_ROUTE, ENTRY_POINTS } = await import("@/lib/serviceEnquiry/entryPoints");
    expect(ENTRY_POINTS.find((e) => e.id === "contact_page")?.route).toBe(CONTACT_ROUTE);
    expect(hrefOf(PAGE, "plan-action-Enterprise")).toBe("/contact");
  });
  it("the link exists only behind the contactRoute surface; otherwise a plain statement", () => {
    const src = fs.readFileSync(path.join(LANDING_COMPONENT_DIR, "CapacityPlans.tsx"), "utf8");
    const at = src.indexOf("to={CONTACT_ROUTE}");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, at - 200), at)).toMatch(/p\.contactSales && SERVICE_ENQUIRY_SURFACES\.contactRoute && \(/);
    expect(src).toMatch(/p\.contactSales && !SERVICE_ENQUIRY_SURFACES\.contactRoute && \(/);
    expect(src).not.toMatch(/contactHref\(/);
  });
});

describe("commercial honesty", () => {
  it("the page states once, plainly, that activation is completed by the team", () => {
    expect((PAGE_TEXT.match(/activated by our team/g) ?? []).length).toBe(1);
  });
  it("no activation, payment-complete or self-serve claim", () => {
    expect(PAGE_TEXT).not.toMatch(/payment (is )?complete|activate (it )?(yourself|instantly|now)|instant activation|activated instantly|self-activat/i);
  });

  it("the closing action states activation by the team and no online payment", () => {
    expect(LANDING_FINAL_CTA.supporting).toMatch(/Online payment is not available yet/);
    expect(PAGE_TEXT).toContain(LANDING_FINAL_CTA.supporting);
  });
  it("the commercial-status disclosure is stated once, in the footer", () => {
    expect(PAGE_TEXT.split(COMMERCIAL_NOTICE).length - 1).toBe(1);
    expect(visibleText(renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Footer))))).toContain(COMMERCIAL_NOTICE);
  });
  it("no checkout, payment or purchase control anywhere on the page", () => {
    expect(PAGE_TEXT.toLowerCase()).not.toMatch(/buy now|subscribe|checkout|pay now|upgrade now|add to cart|contact sales to buy/);
    expect(PAGE_TEXT.toLowerCase()).not.toContain("direct invoic");
  });
});

describe("FAQ", () => {
  it("renders all eight questions, collapsed, from the one source", () => {
    expect(LANDING_FAQ).toHaveLength(8);
    const faqMarkup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LandingFAQ)));
    for (const entry of LANDING_FAQ) expect(visibleText(faqMarkup)).toContain(entry.question);
    expect((faqMarkup.match(/data-state="closed"/g) ?? []).length).toBeGreaterThanOrEqual(LANDING_FAQ.length);
  });
  it.each(LANDING_FAQ)("FAQ answer to '$question' stays within 80 words", (entry) => {
    expect(wordCount(entry.answer)).toBeLessThanOrEqual(80);
  });
  it("explains attribution without inventing an approval hierarchy, and states pricing is not purchasable", () => {
    expect(LANDING_FAQ.find((e) => /attributed/i.test(e.question))!.answer).not.toMatch(/\b(junior|manager|partner|four-eye)\b/i);
    expect(LANDING_FAQ.find((e) => /pricing/i.test(e.question))!.answer).toMatch(/proposed|not enforced|switched off/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. No backend; mobile navigation
// ─────────────────────────────────────────────────────────────────────────────

describe("the landing surface reaches no backend, session or workspace code", () => {
  const FORBIDDEN_IMPORTS = [
    "integrations/supabase",
    "supabase",
    "contexts/AuthContext",
    "lib/auth",
    "lib/workspace",
    "@tanstack/react-query",
    "hooks/useWorkspaceData",
  ];

  it.each(FORBIDDEN_IMPORTS)("no landing component imports %s", (specifier) => {
    for (const { file, source } of readLandingSources()) {
      for (const imported of [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])) {
        expect(imported, `${file} imports ${imported}`).not.toContain(specifier);
      }
    }
  });

  it("no landing component performs a network call, reads storage, or reads the clock", () => {
    // Comments are stripped first: a header comment DOCUMENTING that a component touches no storage
    // is the guarantee, not a violation of it.
    for (const { file, source: raw } of readLandingSources()) {
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "document.cookie", "Date.now", "new Date(", "Math.random"]) {
        expect(source, `${file} uses ${pattern}`).not.toContain(pattern);
      }
    }
  });

  it("the copy module is data only — no imports, no logic", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/content/landing/landingContent.ts"), "utf8");
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toContain("function ");
  });
});


describe("mobile navigation keyboard operability", () => {
  const HEADER_SOURCE = fs.readFileSync(path.join(ROOT, "src/components/Header.tsx"), "utf8");

  it("announces its expanded state and the panel it controls", () => {
    expect(HEADER_SOURCE).toContain("aria-expanded={mobileOpen}");
    expect(HEADER_SOURCE).toContain('aria-controls="mobile-navigation"');
    expect(HEADER_SOURCE).toContain('id="mobile-navigation"');
  });

  it("moves focus into the panel on open and restores it to the toggle on close", () => {
    expect(HEADER_SOURCE).toMatch(/mobilePanelRef\.current\?\.querySelector/);
    expect(HEADER_SOURCE).toMatch(/first\?\.focus\(\)/);
    expect(HEADER_SOURCE).toMatch(/toggleRef\.current\?\.focus\(\)/);
  });

  it("closes on Escape", () => {
    expect(HEADER_SOURCE).toMatch(/event\.key === "Escape"/);
    expect(HEADER_SOURCE).toContain('document.addEventListener("keydown"');
    expect(HEADER_SOURCE).toContain('document.removeEventListener("keydown"');
  });

  it("gives the toggle an accessible name", () => {
    expect(HEADER_SOURCE).toMatch(/aria-label=\{mobileOpen \? "Close menu" : "Open menu"\}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Retired sections stay retired
// ─────────────────────────────────────────────────────────────────────────────

describe("the superseded landing sections are gone and unreferenced", () => {
  const REMOVED: Record<string, string> = {
    "src/components/Hero.tsx": "@/components/Hero",
    "src/components/PainPoints.tsx": "@/components/PainPoints",
    "src/components/Features.tsx": "@/components/Features",
    "src/components/ClosingCTA.tsx": "@/components/ClosingCTA",
    "src/components/landing/SyntheticClosePreview.tsx": "@/components/landing/SyntheticClosePreview",
    "src/components/landing/CoreCapabilities.tsx": "@/components/landing/CoreCapabilities",
    "src/components/landing/ControlledCloseAndAssurance.tsx": "@/components/landing/ControlledCloseAndAssurance",
    "src/components/landing/VerifiedDeliverables.tsx": "@/components/landing/VerifiedDeliverables",
    "src/components/landing/CommercialVerification.tsx": "@/components/landing/CommercialVerification",
  };

  it.each(Object.keys(REMOVED))("%s no longer exists", (relative) => {
    expect(fs.existsSync(path.join(ROOT, relative))).toBe(false);
  });

  it("nothing in src/ imports a removed section", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = fs.readFileSync(full, "utf8");
          for (const removed of Object.values(REMOVED)) if (source.includes(`from "${removed}"`)) offenders.push(`${full} → ${removed}`);
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });
});
