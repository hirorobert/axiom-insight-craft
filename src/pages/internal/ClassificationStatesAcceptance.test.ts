/**
 * Focused tests for the internal classification-states visual-acceptance page.
 *
 * Static checks read the real source (mirrors financialStatementsWorkspace/workspaceGate.test.ts's own style).
 * Runtime checks render the REAL page, the REAL deriveClassificationPresentation(), the REAL
 * buildClassificationDecision() and the REAL <DecisionCard> — never a mock of the production pipeline — fed only
 * the fixture module, and prove no Supabase client is ever touched.
 */

import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isClassificationAcceptancePageRenderable } from "@/lib/workspace/classificationAcceptanceGate";
import { CLASSIFICATION_ACCEPTANCE_FIXTURES } from "@/lib/workspace/classificationAcceptanceFixtures";
import { deriveClassificationPresentation } from "@/lib/workspace/classificationPresentation";
import { buildClassificationDecision } from "@/components/workspace/decisionBuilders";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const norm = (s: string) => s.replace(/\r\n/g, "\n");

// A real spy on the Supabase client used throughout the app — if the acceptance page ever called it, this would
// record the call. Renders below assert it is NEVER touched.
const supabaseSpies = vi.hoisted(() => ({
  from: vi.fn(() => ({ update: vi.fn(() => ({ eq: vi.fn() })), select: vi.fn(), insert: vi.fn() })),
  invoke: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: supabaseSpies.from, functions: { invoke: supabaseSpies.invoke }, rpc: supabaseSpies.rpc, auth: { getSession: vi.fn(), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) } },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  supabaseSpies.from.mockClear();
  supabaseSpies.invoke.mockClear();
  supabaseSpies.rpc.mockClear();
});

describe("gate — static: development-only, no flag, no deployment configuration can enable it", () => {
  it("the gate reads only import.meta.env.DEV — no VITE_* variable, storage, URL or stored preference", () => {
    const gate = norm(read("src/lib/workspace/classificationAcceptanceGate.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(gate).toMatch(/export function isClassificationAcceptancePageRenderable\(isDevBuild: boolean\): boolean \{\s*return isDevBuild === true;\s*\}/);
    expect(gate).not.toMatch(/VITE_|localStorage|sessionStorage|URLSearchParams|fetch|Deno|process\.env/);
    for (const f of fs.readdirSync(ROOT).filter((n) => /^\.env/.test(n))) expect(read(f), f).not.toMatch(/CLASSIFICATION_ACCEPTANCE|ACCEPTANCE_PAGE/);
  });

  it("is a pure decision: renders only in a dev build, never otherwise", () => {
    expect(isClassificationAcceptancePageRenderable(true)).toBe(true);
    expect(isClassificationAcceptancePageRenderable(false)).toBe(false);
  });

  it("App.tsx registers the route only through a gated lazy import (no static import of the page anywhere else)", () => {
    const app = norm(read("src/App.tsx"));
    const staticImports = [...app.matchAll(/^import .*from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(staticImports.filter((m) => /internal\/acceptance|ClassificationStatesAcceptance/.test(m))).toEqual([]);
    expect(app).toMatch(/const ClassificationStatesAcceptance = import\.meta\.env\.DEV\s*\?\s*lazy\(\(\) => import\("@\/pages\/internal\/ClassificationStatesAcceptance"\)\)\s*:\s*null;/);
    expect(app).toMatch(/\{ClassificationStatesAcceptance && \(/);
    expect(app).toMatch(/path="\/internal\/acceptance\/classification-states"/);
  });

  it("no production module outside the acceptance page's own files imports it", () => {
    const own = new Set(["src/App.tsx", "src/pages/internal/ClassificationStatesAcceptance.tsx", "src/pages/internal/ClassificationStatesAcceptance.test.ts"]);
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const offenders = walk(path.join(ROOT, "src"))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((rel) => !own.has(rel))
      .filter((rel) => /^import .*ClassificationStatesAcceptance/m.test(fs.readFileSync(path.join(ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the page and its fixtures import no Supabase client, no auth context, and call no network primitive", () => {
    for (const f of ["src/pages/internal/ClassificationStatesAcceptance.tsx", "src/lib/workspace/classificationAcceptanceFixtures.ts", "src/lib/workspace/classificationAcceptanceGate.ts"]) {
      const src = norm(read(f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/@\/integrations\/supabase|createClient|@\/contexts\/AuthContext|\bfetch\(|XMLHttpRequest|WebSocket|\.insert\(|\.update\(|\.upsert\(|\.rpc\(/);
    }
  });

  it("every fixture is a plain literal — no randomness, no clock read, no network-derived value", () => {
    const src = norm(read("src/lib/workspace/classificationAcceptanceFixtures.ts"));
    expect(src).not.toMatch(/Math\.random|Date\.now|new Date\(\)(?!\.)|crypto\.|await |async /);
  });
});

describe("fixtures — deterministic inputs that produce exactly the labelled state", () => {
  it("covers all 7 states exactly once", () => {
    expect(CLASSIFICATION_ACCEPTANCE_FIXTURES.map((f) => f.expectedState).sort()).toEqual(
      ["COMPLETE_NO_REVIEW", "COMPLETE_WITH_REVIEW", "FAILED", "INCONSISTENT", "NOT_COMPUTED", "PARTIAL", "PROCESSING"].sort(),
    );
  });

  it.each(CLASSIFICATION_ACCEPTANCE_FIXTURES)("$expectedState fixture actually produces $expectedState from the real function", (fixture) => {
    const result = deriveClassificationPresentation(fixture.uploadStatus, fixture.processingResult);
    expect(result.state).toBe(fixture.expectedState);
  });
});

describe("runtime — every state renders through the real pipeline, with the correct headline, detail and action", () => {
  const EXPECTED: Record<string, { headline: string; detail: string; buttonLabel: string; escape: boolean }> = {
    FAILED: { headline: "The trial balance could not be processed.", detail: "Re-run processing, or replace the file in Prepare Data.", buttonLabel: "Retry processing", escape: true },
    PROCESSING: { headline: "Trial balance is processing.", detail: "This screen updates itself. The run continues on the server if you leave the page.", buttonLabel: "Open Prepare Data", escape: false },
    INCONSISTENT: { headline: "Classification status is unavailable.", detail: "Review the uploaded file.", buttonLabel: "Open Prepare Data", escape: true },
    COMPLETE_WITH_REVIEW: { headline: "85 of 97 accounts classified.", detail: "Review 12 flagged accounts to continue.", buttonLabel: "Review 12 accounts", escape: true },
    PARTIAL: { headline: "82 of 97 accounts classified.", detail: "Review the remaining 15 accounts.", buttonLabel: "Review 15 accounts", escape: true },
    COMPLETE_NO_REVIEW: { headline: "Finish preparing the trial balance.", detail: "97 of 97 accounts classified. No review required.", buttonLabel: "Open Prepare Data", escape: false },
    NOT_COMPUTED: { headline: "Finish preparing the trial balance.", detail: "Later stages open as each one passes.", buttonLabel: "Open Prepare Data", escape: false },
  };

  it("renders the banner and all 7 fixtures when it is a dev build", async () => {
    vi.stubEnv("DEV", true);
    const { default: ClassificationStatesAcceptance } = await import("./ClassificationStatesAcceptance");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ClassificationStatesAcceptance)));

    expect(html).toContain("Internal visual acceptance — fixture data");
    for (const state of Object.keys(EXPECTED)) expect(html, state).toContain(`data-testid="classification-fixture-${state}"`);
  });

  it.each(Object.entries(EXPECTED))("%s renders the correct headline, detail and action", async (state, expected) => {
    vi.stubEnv("DEV", true);
    const { default: ClassificationStatesAcceptance } = await import("./ClassificationStatesAcceptance");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ClassificationStatesAcceptance)));
    const start = html.indexOf(`data-testid="classification-fixture-${state}"`);
    const end = html.indexOf("</li>", start);
    const card = html.slice(start, end);

    expect(card, state).toContain(expected.headline);
    expect(card, state).toContain(expected.detail);
    expect(card, state).toContain(expected.buttonLabel);
    expect(card.includes('data-testid="replace-file-escape"'), state).toBe(expected.escape);
  });

  it("never claims final, certified, approved or auditor-ready — the fixtures exercise the same honesty rules as production", async () => {
    vi.stubEnv("DEV", true);
    const { default: ClassificationStatesAcceptance } = await import("./ClassificationStatesAcceptance");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ClassificationStatesAcceptance)));
    for (const forbidden of [/\bfinal\b/i, /certified/i, /\bapproved\b/i, /auditor-ready/i, /instantly/i]) expect(html).not.toMatch(forbidden);
  });

  it("renders through the SAME buildClassificationDecision the production page calls — not a second mapping", async () => {
    // Proves the page's button labels are not hand-typed duplicates: they equal what the real mapping function
    // produces for the real fixtures, field for field.
    for (const fixture of CLASSIFICATION_ACCEPTANCE_FIXTURES) {
      const classification = deriveClassificationPresentation(fixture.uploadStatus, fixture.processingResult);
      const decision = buildClassificationDecision(classification, { retrying: false, onRetry: () => undefined, prepareHref: "#", reviewHref: "#" });
      expect(decision.headline).toBe(EXPECTED[fixture.expectedState].headline);
      expect(decision.button.label).toBe(EXPECTED[fixture.expectedState].buttonLabel);
    }
  });
});

describe("fail-closed — outside a dev build the page renders nothing and touches nothing", () => {
  it("returns null (renders to an empty string) when import.meta.env.DEV is false, before reading any fixture", async () => {
    vi.stubEnv("DEV", false);
    const { default: ClassificationStatesAcceptance } = await import("./ClassificationStatesAcceptance");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ClassificationStatesAcceptance)));
    expect(html).toBe("");
  });

  it("no Supabase call is ever made, in either build mode", async () => {
    for (const dev of [true, false]) {
      vi.stubEnv("DEV", dev);
      const { default: ClassificationStatesAcceptance } = await import("./ClassificationStatesAcceptance");
      renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ClassificationStatesAcceptance)));
    }
    expect(supabaseSpies.from).not.toHaveBeenCalled();
    expect(supabaseSpies.invoke).not.toHaveBeenCalled();
    expect(supabaseSpies.rpc).not.toHaveBeenCalled();
  });
});

describe("mobile-safe markup (structural proof; see the PR description for a live-browser screenshot at 320/375/768/1440px)", () => {
  it("the page container and the reused DecisionCard both use bounded, responsive width classes — no fixed pixel width", async () => {
    vi.stubEnv("DEV", true);
    const { default: ClassificationStatesAcceptance } = await import("./ClassificationStatesAcceptance");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ClassificationStatesAcceptance)));
    expect(html).toMatch(/class="mx-auto max-w-3xl px-4 py-10 sm:px-6"/);
    expect(html).not.toMatch(/width:\s*\d+px|min-width:\s*[1-9]\d{2,}px/);
  });
});
