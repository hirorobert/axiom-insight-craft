/**
 * landingPage.test.tsx — acceptance gates for the public landing page.
 *
 * Five things are protected here, each because getting it wrong is a real-world failure rather
 * than a style regression:
 *
 *  1. The synthetic preview shows exactly the five approved states of a fictional entity. It is the
 *     only "product proof" on a page a stranger can read, so it must never drift into invented
 *     ledger figures, invented roles, or anything a reader could mistake for real customer data.
 *  2. The preview reaches no backend. It renders for an anonymous visitor with no session; a single
 *     Supabase, auth, storage or workspace import would turn a static marketing asset into a
 *     failing network call in the first viewport.
 *  3. Copy carries no internal engine name, no occupational hierarchy the product does not
 *     implement, and no absolute claim. (Phrase-level enforcement lives in
 *     src/content/publicClaimRegistry.test.ts; this file guards structure and word budgets.)
 *  4. Every in-page link resolves to a section that actually renders. A dead anchor in the primary
 *     navigation is the most visible possible defect on a marketing page.
 *  5. The mobile menu is operable by keyboard: focus moves in on open, Escape closes, and focus
 *     returns to the control that opened it (WCAG 2.2 AA, 2.4.3 Focus Order / 2.1.2 No Keyboard Trap).
 */

import fs from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

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

function renderLandingSections() {
  return render(
    <MemoryRouter>
      <Header />
      <main id="main-content">
        <LandingHero />
        <CoreCapabilities />
        <ControlledCloseAndAssurance />
        <VerifiedDeliverables />
        <CommercialVerification />
        <LandingFAQ />
        <LandingFinalCTA />
      </main>
    </MemoryRouter>,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Synthetic preview
// ─────────────────────────────────────────────────────────────────────────────

describe("synthetic close preview", () => {
  it("renders exactly the five approved states, in order", () => {
    render(<SyntheticClosePreview />);
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    SYNTHETIC_PREVIEW_STEPS.forEach((step, i) => {
      expect(steps[i]).toHaveTextContent(step.label);
      expect(steps[i]).toHaveTextContent(step.detail);
    });
  });

  it("marks four states complete and the fifth as the current one", () => {
    const completed = SYNTHETIC_PREVIEW_STEPS.filter((s) => s.state === "completed");
    const current = SYNTHETIC_PREVIEW_STEPS.filter((s) => s.state === "current");
    expect(completed).toHaveLength(4);
    expect(current).toHaveLength(1);
    expect(current[0].label).toBe("Statements ready for review");

    render(<SyntheticClosePreview />);
    const currentNodes = screen.getAllByRole("listitem").filter((n) => n.getAttribute("aria-current") === "step");
    expect(currentNodes).toHaveLength(1);
    expect(currentNodes[0]).toHaveTextContent("Statements ready for review");
  });

  it("names the fictional entity, period and framework, and always discloses that the data is synthetic", () => {
    render(<SyntheticClosePreview />);
    expect(screen.getByText(SYNTHETIC_PREVIEW.entity)).toBeInTheDocument();
    expect(screen.getByText(SYNTHETIC_PREVIEW.period)).toBeInTheDocument();
    expect(screen.getByText(SYNTHETIC_PREVIEW.framework)).toBeInTheDocument();
    expect(screen.getByText(SYNTHETIC_PREVIEW.notice)).toBeInTheDocument();
    expect(SYNTHETIC_PREVIEW.notice.toLowerCase()).toContain("synthetic");
  });

  it("shows no monetary amount: the preview demonstrates workflow states, never figures", () => {
    const { container } = render(<SyntheticClosePreview />);
    expect(container.textContent ?? "").not.toMatch(/[$€£]\s?[\d,]/);
    // "Two exceptions" is a state description; no formatted balance may appear.
    expect(container.textContent ?? "").not.toMatch(/\d[\d,]{3,}\.\d{2}/);
  });
});

describe("the landing surface reaches no backend, session or workspace code", () => {
  const FORBIDDEN_IMPORTS = [
    "@/integrations/supabase",
    "supabase",
    "@/contexts/AuthContext",
    "@/lib/auth",
    "@/lib/workspace",
    "@tanstack/react-query",
    "@/hooks/useWorkspaceData",
  ];

  it.each(FORBIDDEN_IMPORTS)("no landing component imports %s", (specifier) => {
    for (const { file, source } of readLandingSources()) {
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const imported of imports) {
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
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Structure, anchors, copy budgets
// ─────────────────────────────────────────────────────────────────────────────

describe("page structure", () => {
  it("renders every section, each with a single heading", () => {
    renderLandingSections();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(LANDING_HERO.headline);
    for (const id of ["capabilities", "process", "deliverables", "commercial", "faq"]) {
      expect(document.getElementById(id), `section #${id} is missing`).not.toBeNull();
    }
  });

  it("every in-page navigation link points at a section that exists", () => {
    renderLandingSections();
    const inPageTargets = [
      ...NAV.map((item) => item.href),
      LANDING_HERO.secondaryCta.href,
    ].filter((href) => href.startsWith("#"));
    expect(inPageTargets.length).toBeGreaterThan(0);
    for (const href of inPageTargets) {
      expect(document.getElementById(href.slice(1)), `dead anchor: ${href}`).not.toBeNull();
    }
  });

  it("offers one primary sign-up action in the hero and one in the closing call to action", () => {
    renderLandingSections();
    const startFree = screen.getAllByRole("link", { name: /start free/i });
    // Header, hero and final CTA — and nowhere else, so the page never repeats the same ask.
    expect(startFree.length).toBeLessThanOrEqual(4);
    for (const link of startFree) expect(link).toHaveAttribute("href", "/auth");
  });
});

describe("copy budgets keep the page scannable rather than essayistic", () => {
  it("hero copy stays within 35 words", () => {
    expect(wordCount(LANDING_HERO.supporting)).toBeLessThanOrEqual(35);
  });

  it("each capability description stays within 30 words", () => {
    for (const c of LANDING_CAPABILITIES) {
      expect(wordCount(c.description), c.title).toBeLessThanOrEqual(30);
    }
  });

  it("each process step stays within 30 words", () => {
    for (const s of LANDING_PROCESS) {
      expect(wordCount(s.description), s.title).toBeLessThanOrEqual(30);
    }
  });

  it("each assurance control stays within 24 words", () => {
    for (const c of CLOSE_ASSURANCE_CONTROLS) {
      expect(wordCount(c.description), c.title).toBeLessThanOrEqual(24);
    }
  });

  it("each FAQ answer stays within 80 words", () => {
    for (const entry of LANDING_FAQ) {
      expect(wordCount(entry.answer), entry.question).toBeLessThanOrEqual(80);
    }
  });

  it("the final call to action stays within 25 words", () => {
    expect(wordCount(`${LANDING_FINAL_CTA.heading} ${LANDING_FINAL_CTA.supporting}`)).toBeLessThanOrEqual(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. FAQ and commercial honesty
// ─────────────────────────────────────────────────────────────────────────────

describe("FAQ", () => {
  it("renders every question as an interactive disclosure", () => {
    render(<MemoryRouter><LandingFAQ /></MemoryRouter>);
    for (const entry of LANDING_FAQ) {
      expect(screen.getByRole("button", { name: entry.question })).toBeInTheDocument();
    }
  });

  it("explains how preparation decisions are attributed, without inventing an approval hierarchy", () => {
    const attribution = LANDING_FAQ.find((e) => /attributed/i.test(e.question));
    expect(attribution, "the attribution question is missing").toBeDefined();
    expect(attribution!.answer).not.toMatch(/\b(junior|manager|partner|four-eye)\b/i);
  });
});

describe("commercial structure is presented as proposed, not purchasable", () => {
  it("heads the section with the enforcement-verification wording and carries the notice", () => {
    render(<MemoryRouter><CommercialVerification /></MemoryRouter>);
    expect(
      screen.getByRole("heading", { name: /Commercial structure under final enforcement verification/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not a public commercial offer/i),
    ).toBeInTheDocument();
  });

  it("offers no checkout, payment or purchase control anywhere on the page", () => {
    const { container } = renderLandingSections();
    const actionLabels = [...container.querySelectorAll("a,button")].map((el) => el.textContent?.toLowerCase() ?? "");
    for (const label of actionLabels) {
      expect(label).not.toMatch(/buy now|subscribe|checkout|pay now|upgrade now|add to cart/);
    }
  });

  it("names four proposed plans, each flagged as a proposal", () => {
    expect(PROPOSED_PLANS).toHaveLength(4);
    render(<MemoryRouter><CommercialVerification /></MemoryRouter>);
    const section = document.getElementById("commercial")!;
    for (const plan of PROPOSED_PLANS) {
      expect(within(section).getByText(plan.name)).toBeInTheDocument();
    }
  });
});

describe("verified deliverables", () => {
  it("advertises no regulatory filing format and no audit package", () => {
    const { container } = render(<MemoryRouter><VerifiedDeliverables /></MemoryRouter>);
    const text = (container.textContent ?? "").toLowerCase();
    for (const forbidden of ["xbrl", "audit package", "full ifrs"]) {
      expect(text, `deliverables claim "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Keyboard operability of the mobile menu
// ─────────────────────────────────────────────────────────────────────────────

describe("mobile navigation keyboard operability", () => {
  function openMenu() {
    render(<MemoryRouter><Header /></MemoryRouter>);
    const toggle = screen.getByRole("button", { name: /menu|navigation/i });
    fireEvent.click(toggle);
    return toggle;
  }

  it("announces its expanded state and the panel it controls", () => {
    const toggle = openMenu();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const controlled = toggle.getAttribute("aria-controls");
    expect(controlled).toBeTruthy();
    expect(document.getElementById(controlled!)).not.toBeNull();
  });

  it("moves focus into the panel on open", () => {
    openMenu();
    const panel = document.getElementById("mobile-navigation")!;
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and returns focus to the control that opened it", () => {
    const toggle = openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("mobile-navigation")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(toggle);
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
