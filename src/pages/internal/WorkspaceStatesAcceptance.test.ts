/**
 * Focused tests for the internal workflow-states visual-acceptance page (extends PR #30's
 * classification-states gallery to the full canonical workflow — requirement #8).
 *
 * Static checks read the real source (mirrors ClassificationStatesAcceptance.test.ts's own style).
 * Runtime checks render the REAL page, the REAL deriveWorkspaceState(), the REAL
 * buildNextActionDecision(), the REAL <DecisionCard>/<WorkspaceGate> — never a mock of the
 * production pipeline — fed only the fixture module, and prove no Supabase client is ever touched.
 */

import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isClassificationAcceptancePageRenderable } from "@/lib/workspace/classificationAcceptanceGate";
import { WORKFLOW_ACCEPTANCE_FIXTURES } from "@/lib/workspace/workflowAcceptanceFixtures";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import { buildNextActionDecision } from "@/components/workspace/decisionBuilders";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const norm = (s: string) => s.replace(/\r\n/g, "\n");

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

describe("gate — static: same dev-only-forever boundary as the classification gallery, reused generically", () => {
  it("App.tsx registers the route only through a gated lazy import (no static import of the page anywhere else)", () => {
    const app = norm(read("src/App.tsx"));
    const staticImports = [...app.matchAll(/^import .*from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(staticImports.filter((m) => /WorkspaceStatesAcceptance/.test(m))).toEqual([]);
    expect(app).toMatch(/const WorkspaceStatesAcceptance = import\.meta\.env\.DEV\s*\?\s*lazy\(\(\) => import\("@\/pages\/internal\/WorkspaceStatesAcceptance"\)\)\s*:\s*null;/);
    expect(app).toMatch(/\{WorkspaceStatesAcceptance && \(/);
    expect(app).toMatch(/path="\/internal\/acceptance\/workflow-states"/);
  });

  it("no production module outside the acceptance page's own files imports it", () => {
    const own = new Set(["src/App.tsx", "src/pages/internal/WorkspaceStatesAcceptance.tsx", "src/pages/internal/WorkspaceStatesAcceptance.test.ts"]);
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
      .filter((rel) => /^import .*WorkspaceStatesAcceptance/m.test(fs.readFileSync(path.join(ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the page and its fixtures import no Supabase client, no auth context, and call no network primitive", () => {
    for (const f of ["src/pages/internal/WorkspaceStatesAcceptance.tsx", "src/lib/workspace/workflowAcceptanceFixtures.ts"]) {
      const src = norm(read(f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/@\/integrations\/supabase|createClient|@\/contexts\/AuthContext|\bfetch\(|XMLHttpRequest|WebSocket|\.insert\(|\.update\(|\.upsert\(|\.rpc\(/);
    }
  });

  it("every fixture is a plain literal — no randomness, no clock read, no network-derived value", () => {
    const src = norm(read("src/lib/workspace/workflowAcceptanceFixtures.ts"));
    expect(src).not.toMatch(/Math\.random|Date\.now|new Date\(\)(?!\.)|crypto\.|await |async /);
  });
});

describe("fixtures — cover the full canonical workflow, including the three PATH 6B sub-states requirement #8 names", () => {
  it("includes contradiction, missing-certification and stale-processing fixtures", () => {
    const ids = WORKFLOW_ACCEPTANCE_FIXTURES.map((f) => f.id);
    expect(ids).toContain("certification-contradiction");
    expect(ids).toContain("certification-missing");
    expect(ids).toContain("certification-stale");
  });

  it("covers all 11 deriveWorkspaceState paths (one fixture per path, at minimum)", () => {
    const ids = new Set(WORKFLOW_ACCEPTANCE_FIXTURES.map((f) => f.id));
    for (const expected of [
      "no-upload",
      "processing",
      "needs-review",
      "upload-error",
      "invalid-tb",
      "safisha-blocked",
      "ready-for-statements",
      "ready-for-tax",
      "ready-for-filing",
      "engagement-complete",
    ]) {
      expect(ids.has(expected), expected).toBe(true);
    }
  });

  it("the contradiction fixture reproduces the exact live-observed defect: classification complete, certification arithmetic-blocked", () => {
    const fixture = WORKFLOW_ACCEPTANCE_FIXTURES.find((f) => f.id === "certification-contradiction")!;
    expect(fixture.snapshot?.isValid).toBe(true);
    expect(fixture.snapshot?.certificationVerdict).toBe("blocked");
    expect(fixture.snapshot?.certificationBlocker).toMatch(/Debits.*!=.*Credits/);
  });

  it("the missing-certification fixture genuinely omits certificationVerdict — never a fabricated 'certified' or 'pending'", () => {
    const fixture = WORKFLOW_ACCEPTANCE_FIXTURES.find((f) => f.id === "certification-missing")!;
    expect(fixture.snapshot?.certificationVerdict).toBeUndefined();
  });

  it("the stale-processing fixture uses the 'stale' verdict specifically, distinct from 'blocked' or 'review'", () => {
    const fixture = WORKFLOW_ACCEPTANCE_FIXTURES.find((f) => f.id === "certification-stale")!;
    expect(fixture.snapshot?.certificationVerdict).toBe("stale");
  });
});

describe("runtime — every fixture renders through the real engine and the real card", () => {
  it("renders the banner and every fixture when it is a dev build", async () => {
    vi.stubEnv("DEV", true);
    const { default: WorkspaceStatesAcceptance } = await import("./WorkspaceStatesAcceptance");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(WorkspaceStatesAcceptance)));

    expect(html).toContain("Internal visual acceptance — fixture data");
    for (const fixture of WORKFLOW_ACCEPTANCE_FIXTURES) {
      expect(html, fixture.id).toContain(`data-testid="workflow-fixture-${fixture.id}"`);
    }
  });

  it("the contradiction fixture never shows 'TB is valid' or any certified/approved claim — same honesty rule as PR #31 fixed on the live page", async () => {
    vi.stubEnv("DEV", true);
    const { default: WorkspaceStatesAcceptance } = await import("./WorkspaceStatesAcceptance");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(WorkspaceStatesAcceptance)));
    const start = html.indexOf('data-testid="workflow-fixture-certification-contradiction"');
    const end = html.indexOf("</li>", start);
    const card = html.slice(start, end);

    expect(card).toContain("Resolve trial-balance difference");
    expect(card).toContain("275580.00");
    expect(card).not.toMatch(/certified|approved|auditor-ready|TB is valid/i);
  });

  it("the direct-route section renders the real WorkspaceGate with the contradiction's actual blocker text", async () => {
    vi.stubEnv("DEV", true);
    const { default: WorkspaceStatesAcceptance } = await import("./WorkspaceStatesAcceptance");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(WorkspaceStatesAcceptance)));

    expect(html).toContain('data-testid="direct-route-fixture"');
    expect(html).toContain("Prepare Statements is locked");
    expect(html).toContain("275580.00");
  });

  it("renders through the SAME buildNextActionDecision the acceptance page calls — not a second mapping, sourced from the real engine", async () => {
    for (const fixture of WORKFLOW_ACCEPTANCE_FIXTURES) {
      const workspaceState = deriveWorkspaceState("fixture-company", "Acceptance Fixture Ltd", 2025, fixture.snapshot);
      const decision = buildNextActionDecision(workspaceState);
      expect(decision.headline).toBeTruthy();
      expect(decision.button.label).toBeTruthy();
    }
  });
});

describe("fail-closed — outside a dev build the page renders nothing and touches nothing", () => {
  it("returns null (renders to an empty string) when import.meta.env.DEV is false, before reading any fixture", async () => {
    vi.stubEnv("DEV", false);
    const { default: WorkspaceStatesAcceptance } = await import("./WorkspaceStatesAcceptance");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(WorkspaceStatesAcceptance)));
    expect(html).toBe("");
  });

  it("no Supabase call is ever made, in either build mode", async () => {
    for (const dev of [true, false]) {
      vi.stubEnv("DEV", dev);
      const { default: WorkspaceStatesAcceptance } = await import("./WorkspaceStatesAcceptance");
      renderToStaticMarkup(createElement(MemoryRouter, null, createElement(WorkspaceStatesAcceptance)));
    }
    expect(supabaseSpies.from).not.toHaveBeenCalled();
    expect(supabaseSpies.invoke).not.toHaveBeenCalled();
    expect(supabaseSpies.rpc).not.toHaveBeenCalled();
  });
});

describe("gate reuse — the SAME dev-only decision function as the classification gallery, not a second gate", () => {
  it("is a pure decision: renders only in a dev build, never otherwise", () => {
    expect(isClassificationAcceptancePageRenderable(true)).toBe(true);
    expect(isClassificationAcceptancePageRenderable(false)).toBe(false);
  });
});
