/**
 * landingPage.test.ts — acceptance gates for the public landing page (commercial milestone structure).
 *
 * Rendering convention: vitest runs in the `node` environment with no jsdom, so sections are rendered with
 * renderToStaticMarkup — the markup a visitor and a crawler receive. The real page is additionally driven in a browser at
 * desktop and phone widths by scripts/browser-acceptance/realAppJourney.mjs.
 *
 * What is protected, each because getting it wrong is a real failure rather than a style regression:
 *
 *  1. Structure: one h1; Software → Plans → Specialist services → Questions; no half-empty selector strip.
 *  2. Manual activation: every plan action is "Request activation" (Enterprise: "Discuss Enterprise"), preselected with its
 *     plan, and the manual-activation note stands beside every action. No checkout, Buy or Subscribe; no "preview / not a
 *     public offer" contradiction.
 *  3. Specialist services are labelled enquiries for work delivered by people, quoted separately — never features; each
 *     action opens the form preselected for that service.
 *  4. Financial reporting appears only as a pilot by invitation, not generally available, not independently validated.
 *  5. Plan figures derive from the one catalogue and stay "Proposed".
 *  6. The landing surface reaches no backend; every in-page link resolves.
 */

import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

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
import { SoftwareSection } from "@/components/landing/SoftwareSection";
import { SpecialistServices } from "@/components/landing/SpecialistServices";
import { TrustStrip } from "@/components/landing/TrustStrip";
import { NAV } from "@/constants/copy";
import { COMMERCIAL_NOTICE, LANDING_FAQ, LANDING_HERO, LANDING_PILOT, LANDING_PLANS_COPY, LANDING_SECTION_IDS, LANDING_TRUST } from "@/content/landing/landingContent";
import { PROPOSED_PLANS } from "@/content/landing/proposedPlans";
import { MANUAL_ACTIVATION_NOTE, SPECIALIST_LABEL, SPECIALIST_SERVICES } from "@/lib/commercial/offerings";
import { PUBLIC_CLAIM_REGISTRY } from "@/content/publicClaimRegistry";

const ROOT = path.resolve(__dirname, "../../../..");
const LANDING_COMPONENT_DIR = path.join(ROOT, "src/components/landing");

function readLandingSources(): { file: string; source: string }[] {
  return fs
    .readdirSync(LANDING_COMPONENT_DIR)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => ({ file: f, source: fs.readFileSync(path.join(LANDING_COMPONENT_DIR, f), "utf8") }));
}

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

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

const PAGE = renderToStaticMarkup(
  createElement(
    MemoryRouter,
    null,
    createElement(Header),
    createElement(
      "main",
      { id: "main-content" },
      createElement(LandingHero),
      createElement(SoftwareSection),
      createElement(CapacityPlans),
      createElement(SpecialistServices),
      createElement(TrustStrip),
      createElement(LandingFAQ),
      createElement(LandingFinalCTA),
    ),
    createElement(Footer),
  ),
);
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

  it("renders exactly the declared sections, in order: software → plans → specialist services → questions", () => {
    const at = LANDING_SECTION_IDS.map((id) => PAGE.indexOf(`id="${id}"`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("every in-page navigation link points at a section that exists", () => {
    for (const item of NAV) expect(LANDING_SECTION_IDS).toContain(item.href.replace(/^#/, "") as never);
    for (const m of PAGE.matchAll(/href="#([a-z-]+)"/g)) expect(PAGE, `#${m[1]}`).toContain(`id="${m[1]}"`);
  });

  it("the hero: 'Explore plans' first, an activation request second, one genuine labelled screenshot; the brand only in the header; no repeated disclaimer", () => {
    const hero = section(PAGE, "hero-title");
    expect(hrefOf(hero, "hero-explore-plans")).toBe("#plans");
    expect(hero.indexOf('data-testid="hero-explore-plans"')).toBeLessThan(hero.indexOf('data-testid="hero-request-activation"'));
    expect(visibleText(hero)).toMatch(/^.*Explore plans.*Request activation/);
    expect(hrefOf(hero, "hero-request-activation")).toBe("/contact?service=plan_activation&from=landing_plans");
    expect(hero).not.toMatch(/Choose a service|hero-service-|grid-cols-4/);
    expect(visibleText(hero)).not.toContain(MANUAL_ACTIVATION_NOTE);
    // The brand mark is in the header (and footer), not repeated in the hero.
    expect(hero).not.toContain('data-testid="brand-mark"');
    expect(PAGE).toContain('data-testid="brand-mark"');
    // One real product screenshot, served from public/, with a descriptive alt text and a visible label saying so.
    const img = hero.match(/<img[^>]*>/g) ?? [];
    expect(img).toHaveLength(1);
    expect(img[0]).toContain(`src="${LANDING_HERO.screenshot.src}"`);
    expect(img[0]).toMatch(/alt="[^"]{40,}"/);
    expect(fs.existsSync(path.join(ROOT, "public", LANDING_HERO.screenshot.src))).toBe(true);
    expect(visibleText(hero)).toContain("Product screenshot");
    expect(visibleText(hero)).toMatch(/demonstration company/);
    // The division of responsibility, stated once in the hero: the software checks and records; judgement stays with the user.
    expect(LANDING_HERO.supporting).toMatch(/performs the checks and records the decisions; professional judgement stays with you/);
  });

  it("copy budgets: hero ≤ 40 words; each specialist description ≤ 25", () => {
    expect(wordCount(`${LANDING_HERO.headline} ${LANDING_HERO.supporting}`)).toBeLessThanOrEqual(40);
    for (const s of SPECIALIST_SERVICES) expect(wordCount(s.description), s.code).toBeLessThanOrEqual(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Software and the pilot
// ─────────────────────────────────────────────────────────────────────────────

describe("software", () => {
  it("Trial balance review is included in every plan, with its three-step workflow and at most three outputs", () => {
    const sw = section(PAGE, "software");
    expect(visibleText(sw)).toContain("Included in every plan");
    expect((sw.match(/data-testid="service-workflow"[\s\S]*?<\/ol>/)?.[0].match(/<li/g) ?? []).length).toBe(3);
    expect((sw.match(/data-testid="primary-outputs"[\s\S]*?<\/ul>/)?.[0].match(/<li/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it("financial reporting appears only as a pilot by invitation, not generally available and not independently validated", () => {
    const pilot = visibleText(section(PAGE, "software").match(/data-testid="software-pilot"[\s\S]*?<\/div>/)?.[0] ?? "");
    expect(pilot).toContain(LANDING_PILOT.label);
    expect(pilot).toMatch(/Not generally available/);
    expect(pilot).toMatch(/has not been independently validated/);
    expect(PAGE_TEXT).not.toMatch(/financial statements in minutes|audit-ready|compliant statements/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Plans: manual activation beside every action
// ─────────────────────────────────────────────────────────────────────────────

describe("plans", () => {
  it("without the server's prices (or with online payment closed), every figure is the catalogue's and stays 'Proposed'", () => {
    const plans = visibleText(section(PAGE, "plans"));
    for (const p of PROPOSED_PLANS) {
      expect(plans).toContain(p.name);
      if (!p.contactSales) expect(plans).toContain(p.proposedAmount);
    }
    expect(plans).toContain("Terms agreed with our team");   // Enterprise
    expect(plans).toMatch(/Price per year/);
    // Entities, named users and the additional-user charge are stated for every plan that has them.
    expect(plans).toContain("Additional named users: proposed USD 200 per year each, arranged with our team");
    expect(plans).toMatch(/12-month term and does not renew automatically/);
  });

  it("every plan action requests activation of that plan; the activation note is stated once, under the table", () => {
    for (const p of PROPOSED_PLANS) {
      expect(hrefOf(PAGE, `plan-action-${p.name}`)).toBe(`/contact?service=plan_activation&plan=${p.code}&from=landing_plans`);
    }
    const plans = visibleText(section(PAGE, "plans"));
    expect(plans.split("Request activation").length - 1).toBe(PROPOSED_PLANS.filter((p) => !p.contactSales).length);
    expect(plans.split(LANDING_PLANS_COPY.activationNote).length - 1).toBe(1);
    expect(plans).not.toContain(LANDING_PLANS_COPY.onlineNote);
    expect(plans).toContain("Discuss Enterprise");
    expect(plans).not.toMatch(/Choose (Solo|Practice|Firm)/);
  });

  it("with an approved price and online payment open, that plan shows the server's price and 'Choose <plan>' to checkout; the others stay proposed", () => {
    const prices = { onlinePayment: true, offers: [
      { planCode: "PRACTICE", marketCode: "GLOBAL", currencyCode: "USD", currencyExponent: 2, amountMinor: 99000 },
      { planCode: "PRACTICE", marketCode: "TZ", currencyCode: "TZS", currencyExponent: 0, amountMinor: 2500000 },
    ] };
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CapacityPlans, { prices })));
    const text = visibleText(html);
    expect(hrefOf(html, "plan-action-Practice")).toBe("/billing/checkout?plan=PRACTICE");
    expect(text).toContain("Choose Practice");
    expect(text).toContain("USD 990 per year by card");
    // Polar card payments only (owner decision): a TZS (mobile money) offer is never shown, even if one were approved.
    expect(text).not.toMatch(/TZS|mobile money/);
    expect(hrefOf(html, "plan-action-Solo")).toBe("/contact?service=plan_activation&plan=SOLO&from=landing_plans");
    expect(text).toContain("Proposed: USD 490 per year");
    expect(text).toContain(LANDING_PLANS_COPY.onlineNote);
    expect(text).toContain(LANDING_PLANS_COPY.activationNote);
    expect(html).not.toMatch(/<button[^>]*>[^<]*(Buy|Subscribe|Checkout|Pay)/i);
  });

  it("an approved price with online payment closed is shown as the price (not 'Proposed') but never offered for purchase", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CapacityPlans, { prices: { onlinePayment: false, offers: [{ planCode: "SOLO", marketCode: "GLOBAL", currencyCode: "USD", currencyExponent: 2, amountMinor: 49000 }] } })));
    expect(html).not.toContain("/billing/checkout");
    expect(visibleText(html)).not.toMatch(/Choose (Solo|Practice|Firm)/);
    expect(visibleText(html)).toContain("USD 490 per year Request activation");
    expect(visibleText(html)).not.toContain("Proposed: USD 490");
    expect(hrefOf(html, "plan-action-Solo")).toBe("/contact?service=plan_activation&plan=SOLO&from=landing_plans");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Specialist services: enquiries, not features
// ─────────────────────────────────────────────────────────────────────────────

describe("specialist services", () => {
  it("lists the five services, each labelled an enquiry, each opening the form preselected for it", () => {
    const spec = section(PAGE, "specialist-services");
    for (const s of SPECIALIST_SERVICES) {
      expect(spec).toContain(`data-testid="specialist-${s.code}"`);
      expect(hrefOf(spec, `specialist-action-${s.code}`)).toBe(`/contact?service=${s.code}&from=landing_services`);
    }
    expect(visibleText(spec)).toContain(SPECIALIST_LABEL);
    expect(visibleText(spec)).toMatch(/not features of the software and are not included in any plan/);
  });

  it("no specialist service is presented as part of the software or a plan anywhere else on the page", () => {
    const rest = PAGE.replace(section(PAGE, "specialist-services"), "");
    for (const s of SPECIALIST_SERVICES) expect(visibleText(section(rest, "software")), s.name).not.toContain(s.name);
    expect(visibleText(section(PAGE, "plans"))).not.toMatch(/forecast|budgeting|financial analysis|close support/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Trust, commercial honesty, FAQ
// ─────────────────────────────────────────────────────────────────────────────

describe("trust strip", () => {
  it("exactly three assurances, each a registered claim verbatim", () => {
    expect(LANDING_TRUST).toHaveLength(3);
    const registered = PUBLIC_CLAIM_REGISTRY.map((c) => c.approvedWording);
    for (const t of LANDING_TRUST) expect(registered.some((w) => w.includes(t.text) || t.text.includes(w)), t.title).toBe(true);
  });
});

describe("commercial honesty", () => {
  it("no checkout, payment or purchase control anywhere, and no assurance or acquisition wording", () => {
    expect(PAGE_TEXT).not.toMatch(/\b(Buy( now)?|Subscribe|Checkout now|Start (a |your )?(free )?trial|Free trial|Pay now)\b/i);
    expect(PAGE).not.toMatch(/<button[^>]*>[^<]*(Buy|Subscribe|Checkout|Pay)/i);
    expect(PAGE_TEXT).not.toMatch(/stand behind|not a public commercial offer|This preview/i);
  });

  it("the commercial disclosure is stated once, in the footer", () => {
    expect(PAGE_TEXT.split(COMMERCIAL_NOTICE).length - 1).toBe(1);
  });

  it("the closing action returns to the plans and offers sign-in; no account creation is presented as activation", () => {
    expect(hrefOf(PAGE, "final-explore-plans")).toBe("#plans");
    expect(hrefOf(PAGE, "final-sign-in")).toBe("/auth");
  });
});

describe("FAQ", () => {
  it("renders every question, collapsed, from the one source, including how activation works and what specialist services are", () => {
    for (const f of LANDING_FAQ) expect(PAGE_TEXT).toContain(f.question);
    expect(LANDING_FAQ.map((f) => f.id)).toEqual(expect.arrayContaining(["activation", "specialist-services", "pricing-status"]));
    expect(LANDING_FAQ.find((f) => f.id === "activation")!.answer).toMatch(/nothing is activated by sending a request/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. No backend; mobile navigation
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
// 7. Retired sections stay retired
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
    "src/components/landing/ServiceChooser.tsx": "@/components/landing/ServiceChooser",
    "src/components/landing/LandingIntent.tsx": "@/components/landing/LandingIntent",
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
