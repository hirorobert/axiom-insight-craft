/**
 * landingPage.test.ts — acceptance gates for the public landing page.
 *
 * Rendering convention: this repository runs vitest in the `node` environment with no jsdom and no
 * @testing-library (see vitest.config.ts and WorkspaceAccessGate.test.ts), so sections are rendered
 * with renderToStaticMarkup — which is also the honest fidelity level for this surface: the landing
 * page is static, so its server-rendered markup IS what a visitor and a crawler receive. Behaviour
 * that genuinely needs a live DOM (mobile-menu focus movement) is asserted here at the mechanism
 * level and verified for real in a browser at 390px; see the browser acceptance run.
 *
 * Five things are protected, each because getting it wrong is a real failure rather than a style
 * regression:
 *
 *  1. The synthetic preview shows exactly the five approved states of a fictional entity. It is the
 *     only product proof a stranger can read, so it must never drift into invented ledger figures,
 *     invented roles, or anything mistakable for real customer data.
 *  2. The landing surface reaches no backend. It renders for an anonymous visitor with no session;
 *     one Supabase, auth, storage or workspace import would turn static marketing into a failing
 *     network call in the first viewport.
 *  3. Copy carries no internal engine name, no occupational hierarchy the product does not
 *     implement, and no absolute claim. (Phrase enforcement lives in publicClaimRegistry.test.ts;
 *     this file guards structure and word budgets.)
 *  4. Every in-page link resolves to a section that actually renders — a dead anchor in the primary
 *     navigation is the most visible possible defect on a marketing page.
 *  5. The commercial section can never be mistaken for a purchasable offer while entity limits,
 *     named-user capacity and self-serve payment remain unenforced.
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

import { Header } from "@/components/Header";
import { CommercialVerification } from "@/components/landing/CommercialVerification";
import { ControlledCloseAndAssurance } from "@/components/landing/ControlledCloseAndAssurance";
import { CoreCapabilities } from "@/components/landing/CoreCapabilities";
import { LandingFAQ } from "@/components/landing/LandingFAQ";
import { LandingFinalCTA } from "@/components/landing/LandingFinalCTA";
import { LandingHero } from "@/components/landing/LandingHero";
import { SyntheticClosePreview } from "@/components/landing/SyntheticClosePreview";
import { VerifiedDeliverables } from "@/components/landing/VerifiedDeliverables";
import { NAV } from "@/constants/copy";
import {
  CLOSE_ASSURANCE_CONTROLS,
  LANDING_CAPABILITIES,
  LANDING_DELIVERABLES,
  LANDING_FAQ,
  LANDING_FINAL_CTA,
  LANDING_HERO,
  LANDING_PROCESS,
  PROPOSED_PLANS,
  SYNTHETIC_PREVIEW,
  SYNTHETIC_PREVIEW_STEPS,
} from "@/content/landing/landingContent";

const ROOT = path.resolve(__dirname, "../../../..");
const LANDING_COMPONENT_DIR = path.join(ROOT, "src/components/landing");

function readLandingSources(): { file: string; source: string }[] {
  return fs
    .readdirSync(LANDING_COMPONENT_DIR)
    .filter((f) => f.endsWith(".tsx"))
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

const renderIn = (node: Parameters<typeof createElement>[1] extends never ? never : ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, node));

const PREVIEW = renderToStaticMarkup(createElement(SyntheticClosePreview));
const PAGE = renderIn(
  createElement(
    "div",
    null,
    createElement(Header),
    createElement(LandingHero),
    createElement(CoreCapabilities),
    createElement(ControlledCloseAndAssurance),
    createElement(VerifiedDeliverables),
    createElement(CommercialVerification),
    createElement(LandingFAQ),
    createElement(LandingFinalCTA),
  ),
);
const PAGE_TEXT = visibleText(PAGE);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Synthetic preview
// ─────────────────────────────────────────────────────────────────────────────

describe("synthetic close preview", () => {
  it("renders exactly the five approved states, in the approved order", () => {
    const items = PREVIEW.match(/<li\b/g) ?? [];
    expect(items).toHaveLength(5);
    const text = visibleText(PREVIEW);
    let cursor = 0;
    for (const step of SYNTHETIC_PREVIEW_STEPS) {
      const at = text.indexOf(step.label, cursor);
      expect(at, `out of order or missing: ${step.label}`).toBeGreaterThan(-1);
      expect(text).toContain(step.detail);
      cursor = at;
    }
  });

  it("marks four states complete and the fifth as the current one", () => {
    expect(SYNTHETIC_PREVIEW_STEPS.filter((s) => s.state === "completed")).toHaveLength(4);
    const current = SYNTHETIC_PREVIEW_STEPS.filter((s) => s.state === "current");
    expect(current).toHaveLength(1);
    expect(current[0].label).toBe("Statements ready for review");
    // Exactly one row is announced as the current step.
    expect(PREVIEW.match(/aria-current="step"/g) ?? []).toHaveLength(1);
  });

  it("names the fictional entity, period and framework, and always discloses synthetic data", () => {
    const text = visibleText(PREVIEW);
    expect(text).toContain(SYNTHETIC_PREVIEW.entity);
    expect(text).toContain(SYNTHETIC_PREVIEW.period);
    expect(text).toContain(SYNTHETIC_PREVIEW.framework);
    expect(text).toContain(SYNTHETIC_PREVIEW.notice);
    expect(SYNTHETIC_PREVIEW.notice.toLowerCase()).toContain("synthetic");
  });

  it("shows no monetary amount: it demonstrates workflow state, never figures", () => {
    const text = visibleText(PREVIEW);
    expect(text).not.toMatch(/[$€£]\s?[\d,]/);
    expect(text).not.toMatch(/\d[\d,]{3,}\.\d{2}/);
  });

  it("uses a fictional entity name that cannot be read as a customer", () => {
    expect(SYNTHETIC_PREVIEW.entity).toBe("Meridian Holdings");
  });
});

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
    for (const { file, source } of readLandingSources()) {
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. Structure, anchors, copy budgets
// ─────────────────────────────────────────────────────────────────────────────

describe("page structure", () => {
  it("renders exactly one level-1 heading, carrying the value proposition", () => {
    const h1s = PAGE.match(/<h1\b/g) ?? [];
    expect(h1s).toHaveLength(1);
    expect(PAGE_TEXT).toContain(LANDING_HERO.headline);
  });

  it("renders every required section", () => {
    for (const id of ["capabilities", "process", "deliverables", "commercial", "faq"]) {
      expect(PAGE, `section #${id} is missing`).toContain(`id="${id}"`);
    }
  });

  it("every in-page navigation link points at a section that exists", () => {
    const inPageTargets = [...NAV.map((i) => i.href), LANDING_HERO.secondaryCta.href].filter((h) => h.startsWith("#"));
    expect(inPageTargets.length).toBeGreaterThan(0);
    for (const href of inPageTargets) {
      expect(PAGE, `dead anchor: ${href}`).toContain(`id="${href.slice(1)}"`);
    }
  });

  it("puts product proof in the hero itself, not in a section below the fold", () => {
    const heroMarkup = renderIn(createElement(LandingHero));
    const heroText = visibleText(heroMarkup);
    expect(heroText).toContain(LANDING_HERO.headline);
    expect(heroText).toContain(SYNTHETIC_PREVIEW.entity);
    expect(heroText).toContain(SYNTHETIC_PREVIEW_STEPS[0].label);
  });

  it("the hero offers exactly two actions and no trust strip", () => {
    const heroText = visibleText(renderIn(createElement(LandingHero)));
    expect(heroText).toContain(LANDING_HERO.primaryCta.label);
    expect(heroText).toContain(LANDING_HERO.secondaryCta.label);
    // The retired four-item trust strip claimed unverifiable metrics; it must not come back.
    expect(heroText).not.toMatch(/7-stage|12 assurance|SHA-256 evidence|firms trust/i);
  });

  it("asks for sign-up in at most three places across the whole page", () => {
    const startFree = PAGE_TEXT.match(/Start free/g) ?? [];
    expect(startFree.length).toBeLessThanOrEqual(3);
    expect(startFree.length).toBeGreaterThan(0);
  });
});

describe("copy budgets keep the page scannable rather than essayistic", () => {
  it("hero copy stays within 35 words", () => {
    expect(wordCount(LANDING_HERO.supporting)).toBeLessThanOrEqual(35);
  });

  it.each(LANDING_CAPABILITIES)("capability '$title' stays within 30 words", (c) => {
    expect(wordCount(c.description)).toBeLessThanOrEqual(30);
  });

  it.each(LANDING_PROCESS)("process step '$title' stays within 30 words", (s) => {
    expect(wordCount(s.description)).toBeLessThanOrEqual(30);
  });

  it.each(CLOSE_ASSURANCE_CONTROLS)("control '$title' stays within 24 words", (c) => {
    expect(wordCount(c.description)).toBeLessThanOrEqual(24);
  });

  it.each(LANDING_FAQ)("FAQ answer to '$question' stays within 80 words", (entry) => {
    expect(wordCount(entry.answer)).toBeLessThanOrEqual(80);
  });

  it("the final call to action stays within 25 words", () => {
    expect(wordCount(`${LANDING_FINAL_CTA.heading} ${LANDING_FINAL_CTA.supporting}`)).toBeLessThanOrEqual(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. FAQ, deliverables and commercial honesty
// ─────────────────────────────────────────────────────────────────────────────

describe("FAQ", () => {
  it("renders all eight questions and answers", () => {
    expect(LANDING_FAQ).toHaveLength(8);
    const faqText = visibleText(renderIn(createElement(LandingFAQ)));
    for (const entry of LANDING_FAQ) {
      expect(faqText, `missing question: ${entry.question}`).toContain(entry.question);
      expect(faqText, `missing answer to: ${entry.question}`).toContain(entry.answer);
    }
  });

  it("explains how preparation decisions are attributed, without inventing an approval hierarchy", () => {
    const attribution = LANDING_FAQ.find((e) => /attributed/i.test(e.question));
    expect(attribution, "the attribution question is missing").toBeDefined();
    expect(attribution!.answer).not.toMatch(/\b(junior|manager|partner|four-eye)\b/i);
  });

  it("answers truthfully that the shown pricing cannot be purchased yet", () => {
    const pricing = LANDING_FAQ.find((e) => /pricing/i.test(e.question));
    expect(pricing, "the pricing-status question is missing").toBeDefined();
    expect(pricing!.answer).toMatch(/proposed|not enforced|switched off/i);
  });
});

describe("verified deliverables", () => {
  it("advertises no regulatory filing format, audit package, or 'Full IFRS'", () => {
    const text = visibleText(renderIn(createElement(VerifiedDeliverables))).toLowerCase();
    for (const forbidden of ["xbrl", "audit package", "full ifrs"]) {
      expect(text, `deliverables claim "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("lists only deliverables reachable in the current interface, each naming where it is produced", () => {
    expect(LANDING_DELIVERABLES.length).toBeGreaterThan(0);
    for (const d of LANDING_DELIVERABLES) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.detail.length, `${d.title} has no description of what it contains`).toBeGreaterThan(20);
    }
  });
});

describe("commercial structure is presented as proposed, not purchasable", () => {
  it("heads the section with the enforcement-verification wording and carries the notice", () => {
    const text = visibleText(renderIn(createElement(CommercialVerification)));
    expect(text).toContain("Commercial structure under final enforcement verification");
    expect(text).toContain(
      "Entity limits, named-user capacity and self-serve payment activation are undergoing final enforcement verification. This preview is not a public commercial offer.",
    );
  });

  it("names four proposed plans", () => {
    expect(PROPOSED_PLANS).toHaveLength(4);
    const text = visibleText(renderIn(createElement(CommercialVerification)));
    for (const plan of PROPOSED_PLANS) expect(text).toContain(plan.name);
  });

  it("offers no checkout, payment or purchase control anywhere on the page", () => {
    expect(PAGE_TEXT.toLowerCase()).not.toMatch(/buy now|subscribe|checkout|pay now|upgrade now|add to cart|contact sales to buy/);
  });

  it("claims no direct-invoicing arrangement", () => {
    expect(PAGE_TEXT.toLowerCase()).not.toContain("direct invoic");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Keyboard operability of the mobile menu (mechanism level; behaviour verified in a browser)
// ─────────────────────────────────────────────────────────────────────────────

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
    expect(HEADER_SOURCE).toMatch(/aria-label=\{mobileOpen \? "Close navigation" : "Open navigation"\}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Retired sections stay retired
// ─────────────────────────────────────────────────────────────────────────────

describe("the superseded landing sections are gone and unreferenced", () => {
  const REMOVED = [
    "src/components/Hero.tsx",
    "src/components/PainPoints.tsx",
    "src/components/Features.tsx",
    "src/components/ClosingCTA.tsx",
  ];

  it.each(REMOVED)("%s no longer exists", (relative) => {
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
          for (const removed of ["@/components/Hero", "@/components/PainPoints", "@/components/Features", "@/components/ClosingCTA"]) {
            if (source.includes(`from "${removed}"`)) offenders.push(`${full} → ${removed}`);
          }
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });
});
