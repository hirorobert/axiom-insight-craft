/**
 * WorkspaceAccessGate.test.ts — the PR #32 access bridge, rendered: a Prepare-only grant holder reaches Prepare Data
 * and nothing else; no access renders a refusal and nothing of the workspace; owners and members keep the existing
 * gates. The server decision itself (get_workspace_access, list_shared_workspaces, the two read policies) is
 * proven on real PostgreSQL (scripts/db-proof/uploadLifecycle.mjs) and on hosted staging
 * (scripts/upload_lifecycle_staging.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceAccess } from "@/lib/workspace/workspaceAccess";
import type { WorkspaceMission } from "@/lib/workspace/types";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() }, auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));

const CID = "c1";
const PY = 2025;
const STAGES: WorkspaceMission[] = ["prepare", "reconcile", "statements", "tax", "compliance", "filing", "monitor"];
const access = (kind: WorkspaceAccess["kind"]): WorkspaceAccess => ({
  kind,
  capabilities: kind === "capability" ? ["manage_source_files"] : [],
  stages: kind === "capability" ? ["prepare"] : STAGES,
  company: { id: CID, name: "Shared Co", fiscal_year_end: null, reporting_framework: null, currency: null, created_at: null },
});

const workspaceValue: { companyId: string; periodYear: number; uploads: { id: string }[]; access: WorkspaceAccess | null; loading?: boolean } =
  { companyId: CID, periodYear: PY, uploads: [], access: null };
const engagementValue = { missionViews: [], loading: false, mandate: null, canAmend: false, engagement: null };
const REAL = "real-stage-content";

async function load() {
  vi.resetModules();
  vi.doMock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => workspaceValue }));
  vi.doMock("@/contexts/EngagementContext", () => ({ useEngagement: () => engagementValue }));
  const gate = await import("./WorkspaceAccessGate");
  const { default: StageScopeGate } = await import("./StageScopeGate");
  return { ...gate, StageScopeGate };
}
const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const real = () => createElement("div", { "data-testid": REAL }, "Real content");

afterEach(() => {
  vi.doUnmock("@/contexts/WorkspaceContext");
  vi.doUnmock("@/contexts/EngagementContext");
  workspaceValue.access = null;
  workspaceValue.uploads = [];
  workspaceValue.loading = false;
});

describe("WorkspaceAccessShell — nothing of the workspace renders without a server grant", () => {
  it("denied (unrelated user, other workspace, revoked grant, anonymous): a refusal, never the workspace", async () => {
    const { WorkspaceAccessShell } = await load();
    const html = render(createElement(WorkspaceAccessShell, { accessState: { status: "denied" }, onRetry: () => {} }, real()));
    expect(html).toContain('data-testid="workspace-access-denied"');
    expect(html).toContain("You don&#x27;t have access to this workspace");
    expect(html).not.toContain(REAL);
  });
  it("loading and a failed check render neither the workspace nor a refusal (never a guess)", async () => {
    const { WorkspaceAccessShell } = await load();
    const loading = render(createElement(WorkspaceAccessShell, { accessState: { status: "loading" }, onRetry: () => {} }, real()));
    const error = render(createElement(WorkspaceAccessShell, { accessState: { status: "error" }, onRetry: () => {} }, real()));
    for (const html of [loading, error]) { expect(html).not.toContain(REAL); expect(html).not.toContain("workspace-access-denied"); }
    expect(error).toContain('data-testid="workspace-access-error"');
  });
  it("granted: the workspace renders", async () => {
    const { WorkspaceAccessShell } = await load();
    for (const kind of ["owner", "member", "capability"] as const) {
      expect(render(createElement(WorkspaceAccessShell, { accessState: { status: "granted", access: access(kind) }, onRetry: () => {} }, real()))).toContain(REAL);
    }
  });
});

describe("StageScopeGate — a Prepare grant opens Prepare ONLY", () => {
  it("capability: Prepare renders even with no mandate and no uploads (the grant, not the mandate, decides)", async () => {
    workspaceValue.access = access("capability");
    const { StageScopeGate } = await load();
    expect(render(createElement(StageScopeGate, { stage: "prepare" }, real()))).toContain(REAL);
  });
  it.each(STAGES.filter((s) => s !== "prepare"))("capability: %s renders the access boundary, never the stage", async (stage) => {
    workspaceValue.access = access("capability");
    const { StageScopeGate } = await load();
    const html = render(createElement(StageScopeGate, { stage }, real()));
    expect(html).not.toContain(REAL);
    expect(html).toContain('data-testid="stage-access-boundary"');
    expect(html).toContain(`href="/workspace/${CID}/${PY}/prepare"`);
  });
  it("the boundary wording is user-based: no owner, firm or role decides, only explicit access from an authorized user", async () => {
    workspaceValue.access = access("capability");
    const { StageScopeGate } = await load();
    const html = render(createElement(StageScopeGate, { stage: "tax" }, real()));
    expect(html).toContain("You have access to Prepare Data only. Additional stages require explicit access from a user authorized to administer this workspace.");
    expect(html).not.toMatch(/workspace owner decides|partner|manager|firm/i);
  });
  it("owner and member keep the existing gates exactly (an undeclared scope with no work still redirects, not the boundary)", async () => {
    for (const kind of ["owner", "member"] as const) {
      workspaceValue.access = access(kind);
      const { StageScopeGate } = await load();
      const html = render(createElement(StageScopeGate, { stage: "tax" }, real()));
      expect(html).not.toContain(REAL);
      expect(html).not.toContain("stage-access-boundary");
    }
  });
});

describe("StageScopeGate — never decides on a workspace that has not loaded (found by the staging browser suite)", () => {
  it("owner, first read in flight, uploads not yet arrived: a checking state, never a redirect and never the stage", async () => {
    workspaceValue.access = access("owner");
    workspaceValue.loading = true;
    const { StageScopeGate } = await load();
    const html = render(createElement(StageScopeGate, { stage: "prepare" }, real()));
    expect(html).toContain("Checking what&#x27;s in scope");
    expect(html).not.toContain(REAL);
  });
});

describe("OverviewAccessGate — the Overview's service decisions are not a Prepare grant holder's", () => {
  it("capability lands on Prepare; owner and member see the Overview", async () => {
    workspaceValue.access = access("capability");
    let gate = await load();
    expect(render(createElement(gate.OverviewAccessGate, null, real()))).not.toContain(REAL);
    for (const kind of ["owner", "member"] as const) {
      workspaceValue.access = access(kind);
      gate = await load();
      expect(render(createElement(gate.OverviewAccessGate, null, real()))).toContain(REAL);
    }
  });
});

describe("the shell and Prepare narrow to the grant (source contract)", () => {
  const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  it("the layout wraps everything in the access shell and filters navigation to the granted stages", () => {
    const layout = src("src/pages/workspace/WorkspaceLayout.tsx");
    expect(layout).toMatch(/<WorkspaceAccessShell accessState=\{workspaceData\.accessState\}/);
    expect(layout).toMatch(/item\.id === "overview" \? !prepareOnly : canOpenStage\(workspaceData\.access/);
    expect(src("src/App.tsx")).toMatch(/<Route index element=\{<OverviewAccessGate><WorkspaceOverview \/><\/OverviewAccessGate>\} \/>/);
  });
  it("Prepare-only: no account review, no mapping, no framework prompt, and the evidence gate is never opened by them", () => {
    const prep = src("src/pages/workspace/PrepareWorkspace.tsx");
    expect(prep).toMatch(/\{!prepareOnly && showReviewPanel && upload\.company_id && user && \(/);
    expect(prep).toMatch(/\{!prepareOnly && <EntityContextSuggestion/);
    expect(prep).toMatch(/disabled=\{prepareOnly\} onClick=\{\(\) => setMappingModalOpen\(true\)\}/);
    expect(prep).toMatch(/if \(prepareOnly\) toast\.success\([^\n]*\n\s+else setSafishaUpload/);
    expect(prep).toMatch(/evidenceByReconcileOnly=\{prepareOnly\}/);
    const up = src("src/components/TrialBalanceUpload.tsx");
    expect(up).toMatch(/if \(evidenceByReconcileOnly\) \{[\s\S]{0,200}\} else \{\s+setSafishaUpload/);
  });
  it("a workspace the caller may not open is never read (access is resolved before the snapshot)", () => {
    const hook = src("src/hooks/useWorkspaceData.ts");
    expect(hook.indexOf("fetchWorkspaceAccess(cId)")).toBeGreaterThan(-1);
    expect(hook.indexOf("fetchWorkspaceAccess(cId)")).toBeLessThan(hook.indexOf("fetchWorkspaceSnapshot({"));
    expect(hook).toMatch(/if \(nextAccess\.status !== "granted"\) \{/);
  });
});
