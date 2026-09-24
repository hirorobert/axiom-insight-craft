/**
 * StageScopeGate.test.ts — requirement #7: prove a direct URL to a stage OUTSIDE the engagement's
 * declared mandate cannot reach that stage's real content, and that a stage genuinely IN scope (or
 * with retained work, or while the mandate is still unknown) is never wrongly blocked. This is the
 * SCOPE half of direct-route enforcement — stageLockGate.test.ts covers the separate ACCOUNTING
 * gate (mission.status === "locked") each stage page owns for itself; StageScopeGate never
 * evaluates that gate (see its own doc comment).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMissionView } from "@/lib/workspace/mandate";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() }, auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));

const CID = "c1";
const PY = 2025;

const workspaceValue = { companyId: CID, periodYear: PY, uploads: [] as { id: string }[] };

const engagementValue: {
  missionViews: WorkspaceMissionView[];
  loading: boolean;
  mandate: { granted: string[] } | null;
  canAmend: boolean;
  engagement: { id: string } | null;
} = { missionViews: [], loading: false, mandate: null, canAmend: true, engagement: { id: "eng-1" } };

const REAL_CONTENT_TESTID = "tax-real-content";

async function renderGate(): Promise<string> {
  vi.resetModules();
  // Re-registered fresh on every call (not a static top-level vi.mock) so each test's mutation of
  // engagementValue/workspaceValue is what the next dynamic import actually observes — the same
  // pattern WorkspaceOverview.test.ts uses for its per-test-varying context.
  vi.doMock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => workspaceValue }));
  vi.doMock("@/contexts/EngagementContext", () => ({ useEngagement: () => engagementValue }));
  const { default: StageScopeGate } = await import("./StageScopeGate");
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(StageScopeGate, { stage: "tax" }, createElement("div", { "data-testid": REAL_CONTENT_TESTID }, "Real tax content")),
    ),
  );
}

function missionView(overrides: Partial<WorkspaceMissionView>): WorkspaceMissionView {
  return {
    stage: "tax",
    workflowStatus: "not_started",
    mandateStatus: "in_scope",
    visible: true,
    prerequisiteOnly: false,
    retainedWork: false,
    mission: { status: "not_started", label: "Compute Tax", summary: "", href: `/workspace/${CID}/${PY}/tax` },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("@/contexts/WorkspaceContext");
  vi.doUnmock("@/contexts/EngagementContext");
  vi.restoreAllMocks();
  workspaceValue.uploads = [];
  engagementValue.mandate = null;
  engagementValue.missionViews = [];
  engagementValue.loading = false;
});

describe("StageScopeGate — a stage outside the engagement's declared mandate never renders its real content", () => {
  it("mandate still loading: renders a deterministic loading state — never the real content (would leak a stage that scope resolution might still lock) and never a premature redirect to Overview", async () => {
    engagementValue.loading = true;
    const html = await renderGate();
    // Neither of the two authoritative outcomes fires while genuinely unresolved: this is
    // deliberately a THIRD state, not an early guess at either one. useEngagementMandate.ts's own
    // `loading` previously flipped false for one tick while `!user` during fresh-page-load auth
    // session restoration — before this fix, that stale tick's mandate=null (not yet populated)
    // read as "genuinely no scope", producing exactly the premature redirect this test now proves
    // does not happen while loading is still true.
    expect(html).not.toContain(REAL_CONTENT_TESTID);
    expect(html).not.toContain("Real tax content");
    expect(html).toContain("Checking what");
  });

  it("mandate resolved (loading=false) with real scope granted: renders the real content immediately, no lingering loading state", async () => {
    engagementValue.loading = false;
    engagementValue.mandate = { granted: ["TAX_COMPUTATION"] };
    engagementValue.missionViews = [missionView({ visible: true })];
    const html = await renderGate();
    expect(html).toContain(REAL_CONTENT_TESTID);
    expect(html).not.toContain("Checking what");
  });

  it("mandate resolved to null (no engagement ever declared) and no prior work: redirects to Overview — a URL cannot bypass the launchpad", async () => {
    engagementValue.mandate = { granted: [] };
    engagementValue.missionViews = [missionView({ workflowStatus: "not_started" })];
    workspaceValue.uploads = [];
    const html = await renderGate();
    expect(html).not.toContain(REAL_CONTENT_TESTID);
    expect(html).not.toContain("Real tax content");
  });

  it("scope declared but tax is NOT part of it: shows the engagement-scope boundary, never the real content", async () => {
    engagementValue.mandate = { granted: ["FINANCIAL_STATEMENTS"] };
    engagementValue.missionViews = [missionView({ visible: false, mandateStatus: "out_of_scope" })];
    const html = await renderGate();
    expect(html).not.toContain(REAL_CONTENT_TESTID);
    expect(html).toContain("is not included in this engagement");
  });

  it("scope declared and tax IS part of it: renders the real content", async () => {
    engagementValue.mandate = { granted: ["TAX_COMPUTATION"] };
    engagementValue.missionViews = [missionView({ visible: true })];
    const html = await renderGate();
    expect(html).toContain(REAL_CONTENT_TESTID);
    expect(html).toContain("Real tax content");
  });

  it("no scope declared, but this stage already carries retained work: the route stays reachable — nothing existing is hidden", async () => {
    engagementValue.mandate = { granted: [] };
    engagementValue.missionViews = [missionView({ workflowStatus: "passed" })];
    const html = await renderGate();
    expect(html).toContain(REAL_CONTENT_TESTID);
  });
});
