/**
 * WorkspaceLayout.logo.test.ts — release blocker 2.1: the CFOClose logo, clicked from ANY
 * authenticated workspace route, must carry an explicit, deterministic escape to the product hub —
 * never a plain `/dashboard` link that could silently auto-resume back into the exact workspace the
 * user just tried to leave (see Dashboard.tsx's `forceHub` / resolveReturningUserRoute.ts's
 * applyForceHub, which is what actually turns this into "always show the hub").
 *
 * Renders the REAL WorkspaceLayout component with its two real data hooks mocked (both do live
 * Supabase reads that this render must never depend on), at five different route paths — Overview,
 * Prepare Data, Reconcile, Statements and Tax — proving the header (and therefore the logo inside
 * it) is the SAME shared chrome regardless of which stage route mounted it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() }, auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1", email: "a@b.com" }, loading: false }) }));

const CID = "c1";
const PY = 2025;

vi.mock("@/hooks/useWorkspaceData", () => ({
  useWorkspaceData: () => ({
    companyId: CID,
    periodYear: PY,
    company: { id: CID, name: "Acme Ltd", code: null, tin: null, reporting_framework: "full_ifrs", fiscal_year_end: "2025-12-31", currency: "TZS" },
    upload: null,
    uploads: [],
    workspaceState: deriveWorkspaceState(CID, "Acme Ltd", PY, null),
    loading: false,
    refreshing: false,
    refreshUpload: vi.fn(),
    // The workspace owner (PR #32 access bridge): every stage, exactly the pre-bridge shell.
    accessState: { status: "granted", access: { kind: "owner", capabilities: [], stages: ["prepare", "reconcile", "statements", "tax", "compliance", "filing", "monitor"], company: { id: CID, name: "Acme Ltd", fiscal_year_end: "2025-12-31", reporting_framework: "full_ifrs", currency: "TZS", created_at: null } } },
    access: { kind: "owner", capabilities: [], stages: ["prepare", "reconcile", "statements", "tax", "compliance", "filing", "monitor"], company: { id: CID, name: "Acme Ltd", fiscal_year_end: "2025-12-31", reporting_framework: "full_ifrs", currency: "TZS", created_at: null } },
  }),
}));
vi.mock("@/hooks/useEngagementMandate", () => ({
  useEngagementMandate: () => ({
    engagement: { id: "eng-1" },
    mandate: { engagementId: "eng-1", granted: ["FINANCIAL_STATEMENTS"] },
    authorities: [],
    events: [],
    canAmend: true,
    loading: false,
    refresh: vi.fn(),
    createEngagement: vi.fn(),
    grantCapability: vi.fn(),
    revokeCapability: vi.fn(),
  }),
}));

async function renderAt(path: string): Promise<string> {
  const { default: WorkspaceLayout } = await import("./WorkspaceLayout");
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Routes, null, createElement(Route, { path: "/workspace/:companyId/:periodYear/*", element: createElement(WorkspaceLayout) })),
      ),
    ),
  );
}

describe("the CFOClose logo carries an explicit hub escape from every stage route", () => {
  it.each([
    ["Overview", `/workspace/${CID}/${PY}`],
    ["Prepare Data", `/workspace/${CID}/${PY}/prepare`],
    ["Reconcile", `/workspace/${CID}/${PY}/reconcile`],
    ["Statements", `/workspace/${CID}/${PY}/statements`],
    ["Tax", `/workspace/${CID}/${PY}/tax`],
  ])("%s: logo links to /dashboard with an explicit forceHub escape, not a bare link that could silently re-land here", async (_label, path) => {
    const html = await renderAt(path);

    // The logo's own href is deterministic and explicit.
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('aria-label="CFOClose home"');
    // React Router serialises Link `state` into the history entry, not raw DOM — so this proves it
    // by reading the real source for the exact call site instead (the render-level assertion above
    // already proves the Link is present and reachable at every one of these five routes; the state
    // wiring itself is covered by WorkspaceLayout.tsx's own source, checked below).
  });

  it("focus and keyboard operability are preserved — the logo is a real, focusable <a>, not a div with a click handler", async () => {
    const html = await renderAt(`/workspace/${CID}/${PY}`);
    const start = html.indexOf('aria-label="CFOClose home"');
    const context = html.slice(Math.max(0, start - 200), start + 300);
    expect(context).toMatch(/<a\b/);
    expect(context).toMatch(/focus-visible:ring/);
  });
});

describe("WorkspaceLayout.tsx source: the logo Link explicitly sets forceHub — a bare /dashboard href alone cannot express this", () => {
  it("the logo's <Link> passes state={{ forceHub: true }}", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");
    const logoBlock = src.slice(src.indexOf('to="/dashboard"'), src.indexOf('to="/dashboard"') + 400);
    expect(logoBlock).toMatch(/state=\{\{\s*forceHub:\s*true\s*\}\}/);
  });
});
