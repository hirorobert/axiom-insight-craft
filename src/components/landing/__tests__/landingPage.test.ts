/**
 * landingPage.test.ts — acceptance gates for the public landing page.
 *
 * Rendering convention: this repository runs vitest in the `node` environment with no jsdom and no
 * @testing-library, so sections are rendered with renderToStaticMarkup — the honest fidelity level
 * for this surface: its server-rendered markup IS what a visitor and a crawler receive. Interaction
 * (service and plan selection, the mobile menu) is asserted at the mechanism level here and verified
 * in a browser at 1366px and 375px.
 *
 * What is protected, each because getting it wrong is a real failure rather than a style regression:
 *
 *  1. One decision surface. Hero → service chooser → questions → footer. The retired sections (the
 *     fictional status panel, process steps, the control grid, the deliverables table, the separate
 *     plan grid and the separate closing call to action) stay retired.
 *  2. Truthful tiers. Each service states whether it is included in every plan or paid, mirroring the
 *     capability registry. Nothing is labelled free: there is no free plan.
 *  3. The landing surface reaches no backend; selection is local presentation state.
 *  4. Prices are derived from the one catalogue, always beside "Proposed", and nothing on the page
 *     can be mistaken for a purchase while entity limits, named-user capacity and payment are
 *     unenforced. The commercial-status disclosure is stated once, in the footer.
 *  5. Every in-page link resolves to a section that renders.
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
import { LandingFAQ } from "@/components/landing/LandingFAQ";
import { LandingHero } from "@/components/landing/LandingHero";
import { ServiceChooser } from "@/components/landing/ServiceChooser";
import { NAV } from "@/constants/copy";
import {
  COMMERCIAL_NOTICE,
  LANDING_FAQ,
  LANDING_FINAL_CTA,
  LANDING_HERO,
  LANDING_SECTION_IDS,
  LANDING_SERVICES,
} from "@/content/landing/landingContent";
import { PROPOSED_PLANS } from "@/content/landing/proposedPlans";
import { CAPABILITIES } from "@/lib/commercial/featureRegistry";

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

const renderIn = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

const CHOOSER = renderIn(createElement(ServiceChooser));
const CHOOSER_TEXT = visibleText(CHOOSER);
const PAGE = renderIn(
  createElement(
    "div",
    null,
    createElement(Header),
    createElement("main", { id: "main-content" }, createElement(LandingHero), createElement(ServiceChooser), createElement(LandingFAQ)),
    createElement(Footer),
  ),
);
const PAGE_TEXT = visibleText(PAGE);

// ─────────────────────────────────────────────────────────────────────────────
// 1. One decision surface
// ─────────────────────────────────────────────────────────────────────────────

describe("page structure", () => {
  it("renders exactly one level-1 heading, carrying the value proposition", () => {
    expect(PAGE.match(/<h1\b/g) ?? []).toHaveLength(1);
    expect(PAGE_TEXT).toContain(LANDING_HERO.headline);
  });

  it("renders exactly the declared sections: hero, the service chooser and the questions", () => {
    for (const id of LANDING_SECTION_IDS) expect(PAGE, `section #${id} is missing`).toContain(`id="${id}"`);
    for (const retired of ["capabilities", "process", "deliverables", "commercial", "sample-close"]) {
      expect(PAGE, `retired section #${retired} is back`).not.toContain(`id="${retired}"`);
    }
  });

  it("every in-page navigation link points at a section that exists", () => {
    const inPageTargets = [...NAV.map((i) => i.href), LANDING_HERO.secondaryCta.href].filter((h) => h.startsWith("#"));
    expect(inPageTargets.length).toBeGreaterThan(0);
    for (const href of inPageTargets) expect(PAGE, `dead anchor: ${href}`).toContain(`id="${href.slice(1)}"`);
  });

  it("the hero offers exactly two actions, names the four services, and carries no fictional status panel", () => {
    const heroText = visibleText(renderIn(createElement(LandingHero)));
    expect(heroText).toContain(LANDING_HERO.primaryCta.label);
    expect(heroText).toContain(LANDING_HERO.secondaryCta.label);
    for (const s of LANDING_SERVICES) expect(heroText).toContain(s.name);
    expect(heroText).not.toMatch(/Meridian|Preparation status|Illustrative synthetic|7-stage|firms trust/i);
  });

  it("asks for sign-up in at most three places, always as 'Create account'", () => {
    expect(PAGE_TEXT).not.toMatch(/Request access|Send an access request|Start free|Get started|\bBuy\b|Subscribe|Start (a )?trial/i);
    const signups = PAGE_TEXT.match(/Create account/g) ?? [];
    expect(signups.length).toBeGreaterThan(0);
    expect(signups.length).toBeLessThanOrEqual(3);
  });

  it("hero copy stays within 35 words; each service outcome within 30", () => {
    expect(wordCount(LANDING_HERO.supporting)).toBeLessThanOrEqual(35);
    for (const s of LANDING_SERVICES) expect(wordCount(s.outcome), s.name).toBeLessThanOrEqual(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Services: truthful tiers, outputs per service, selection
// ─────────────────────────────────────────────────────────────────────────────

describe("service chooser", () => {
  it("lists the four services, each as a selectable control stating its tier", () => {
    expect(LANDING_SERVICES.map((s) => s.name)).toEqual(["Preparation and review", "Close Certification", "Reporting Pack", "Close Insights"]);
    for (const s of LANDING_SERVICES) {
      expect(CHOOSER).toMatch(new RegExp(`<button[^>]*aria-pressed="(true|false)"[^>]*data-testid="service-${s.id}"`));
      expect(CHOOSER).toContain(`data-testid="tier-${s.id}"`);
    }
  });

  it("tiers mirror the capability registry; nothing is called free, because there is no free plan", () => {
    const registryCode = { certification: "STATEMENT_CERTIFICATION", reporting: "REPORTING_PACK_EXPORT", insights: "CLOSE_INSIGHTS" } as const;
    for (const s of LANDING_SERVICES) {
      if (s.id === "preparation") {
        expect(s.tier).toBe("included");
        expect(CAPABILITIES.CLOSE_ASSURANCE.kind).toBe("included");
      } else {
        expect(s.tier).toBe("paid");
        expect(CAPABILITIES[registryCode[s.id]].kind).toBe("paid");
        expect(CAPABILITIES[registryCode[s.id]].name).toBe(s.name);
      }
    }
    expect(PAGE_TEXT).not.toMatch(/\bfree\b/i);
  });

  it("preparation is always included and cannot be deselected; paid services toggle", () => {
    expect(CHOOSER).toMatch(/aria-pressed="true"[^>]*data-testid="service-preparation"/);
    const source = fs.readFileSync(path.join(LANDING_COMPONENT_DIR, "ServiceChooser.tsx"), "utf8");
    expect(source).toMatch(/if \(service\.tier === "included"\) return;/);
  });

  it("'What you receive' lists the outputs of the selected services, with formats and conditions", () => {
    const selected = LANDING_SERVICES.filter((s) => new RegExp(`aria-pressed="true"[^>]*data-testid="service-${s.id}"`).test(CHOOSER));
    expect(selected.map((s) => s.id)).toEqual(["preparation", "reporting"]);
    for (const s of selected) for (const o of s.outputs) {
      expect(CHOOSER_TEXT).toContain(o.name);
      expect(CHOOSER_TEXT).toContain(o.formats);
    }
    expect(CHOOSER_TEXT).toContain("Where prior-period balances are present");
    expect(CHOOSER).toContain(`>${selected.reduce((n, s) => n + s.outputs.length, 0)} outputs<`);
  });

  it("advertises no regulatory filing format, audit package or 'Full IFRS'", () => {
    const text = CHOOSER_TEXT.toLowerCase();
    for (const forbidden of ["xbrl", "audit package", "full ifrs"]) expect(text).not.toContain(forbidden);
  });

  it("certification is stated as an internal record, never an audit", () => {
    const cert = LANDING_SERVICES.find((s) => s.id === "certification")!;
    expect(cert.note).toContain("It is not an external audit, an audit opinion, or any form of statutory assurance.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Commercial honesty
// ─────────────────────────────────────────────────────────────────────────────

describe("plan sizes are proposed, derived and not purchasable", () => {
  it("every plan figure is derived from the PR #34 catalogue (no duplicate authority) and renders exactly the reviewed wording", async () => {
    const { PRICING_CATALOGUE } = await import("@/lib/commercial/pricingCatalogue");
    expect(PROPOSED_PLANS.map((p) => p.name)).toEqual(PRICING_CATALOGUE.map((p) => p.name));
    expect(PROPOSED_PLANS.map(({ name, proposedAmount, capacitySummary }) => ({ name, proposedAmount, capacitySummary }))).toEqual([
      { name: "Solo", proposedAmount: "Proposed: USD 49 per month", capacitySummary: "1 entity · 1 named user" },
      { name: "Practice", proposedAmount: "Proposed: USD 99 per month", capacitySummary: "5 entities · 1 named user included" },
      { name: "Firm", proposedAmount: "Proposed: USD 299 per month", capacitySummary: "25 entities · 1 named user included" },
      { name: "Enterprise", proposedAmount: "Proposed: terms agreed separately", capacitySummary: "Capacity agreed separately" },
    ]);
    const derived = fs.readFileSync(path.join(ROOT, "src/content/landing/proposedPlans.ts"), "utf8");
    expect(derived).toContain("PRICING_CATALOGUE.map(");
    expect(derived).not.toMatch(/USD \d/);
    const content = fs.readFileSync(path.join(ROOT, "src/content/landing/landingContent.ts"), "utf8");
    expect(content).not.toMatch(/USD \d|named user included|\d+ entities/);
  });

  it("the chooser shows every plan size, each amount beside 'Proposed', as a radio choice", () => {
    for (const p of PROPOSED_PLANS) {
      expect(CHOOSER).toContain(`data-testid="plan-${p.name}"`);
      expect(CHOOSER_TEXT).toContain(p.proposedAmount);
    }
    expect(CHOOSER_TEXT.match(/USD \d+/g)?.length).toBe(PROPOSED_PLANS.filter((p) => /USD/.test(p.proposedAmount)).length);
    expect((CHOOSER.match(/type="radio"/g) ?? []).length).toBe(PROPOSED_PLANS.length);
  });

  it("one closing action: Create account, with the activation note — choosing a plan activates nothing", () => {
    const cta = CHOOSER.match(/<a\s[^>]*data-testid="chooser-create-account"[^>]*>/)?.[0] ?? "";
    expect(cta).toContain('href="/auth?mode=signup"');
    expect(CHOOSER_TEXT).toContain(LANDING_FINAL_CTA.supporting);
    expect(LANDING_FINAL_CTA.supporting).toMatch(/Online payment is not available yet/);
  });

  it("the commercial-status disclosure is stated once, in the footer", () => {
    expect(PAGE_TEXT.split(COMMERCIAL_NOTICE).length - 1).toBe(1);
    expect(visibleText(renderIn(createElement(Footer)))).toContain(COMMERCIAL_NOTICE);
    expect(CHOOSER_TEXT).not.toContain(COMMERCIAL_NOTICE);
  });

  it("offers no checkout, payment or purchase control anywhere on the page", () => {
    expect(PAGE_TEXT.toLowerCase()).not.toMatch(/buy now|subscribe|checkout|pay now|upgrade now|add to cart|contact sales to buy/);
    expect(PAGE_TEXT.toLowerCase()).not.toContain("direct invoic");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. FAQ
// ─────────────────────────────────────────────────────────────────────────────

describe("FAQ", () => {
  it("renders all eight questions, collapsed, from the one source", () => {
    expect(LANDING_FAQ).toHaveLength(8);
    const faqMarkup = renderIn(createElement(LandingFAQ));
    const faqText = visibleText(faqMarkup);
    for (const entry of LANDING_FAQ) expect(faqText, `missing question: ${entry.question}`).toContain(entry.question);
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
    "src/components/landing/LandingFinalCTA.tsx": "@/components/landing/LandingFinalCTA",
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
