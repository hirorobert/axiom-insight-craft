/**
 * workspaceAccess.test.ts — the browser half of the PR #32 access bridge: it only ever narrows what the server
 * (get_workspace_access) returned, and a shared workspace routes straight into Prepare Data.
 */
import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { canOpenStage, fetchWorkspaceAccess, isPrepareOnly, listSharedWorkspaces, toWorkspaceAccess } from "./workspaceAccess";
import { applyForceHub, decideReturningUserRoute } from "./resolveReturningUserRoute";

const ALL = ["prepare", "reconcile", "statements", "tax", "compliance", "filing", "monitor"];
const row = (access: string, stages = ALL) => ({ company_id: "c1", access, capabilities: ["manage_source_files"], stages, name: "Co", fiscal_year_end: null, reporting_framework: null, currency: null, created_at: null });

describe("toWorkspaceAccess — fail closed, never widen", () => {
  it("owner and member get what the server listed", () => {
    expect(toWorkspaceAccess(row("owner"))?.stages).toEqual(ALL);
    expect(toWorkspaceAccess(row("member"))?.stages).toEqual(ALL);
  });
  it("a capability NEVER gets more than Prepare, even if a row claimed more", () => {
    expect(toWorkspaceAccess(row("capability", ALL))?.stages).toEqual(["prepare"]);
    expect(toWorkspaceAccess(row("capability", ["reconcile"]))).toBeNull();
  });
  it("unknown kinds, unknown stages and malformed rows are no access", () => {
    for (const r of [null, undefined, {}, row("partner"), row("admin"), { ...row("owner"), company_id: 1 }, row("owner", ["billing"])]) {
      expect(toWorkspaceAccess(r as never)).toBeNull();
    }
  });
  it("only the minimum metadata is carried (no TIN, code or owner)", () => {
    const a = toWorkspaceAccess({ ...row("capability", ["prepare"]), tin: "123456789", user_id: "owner", code: "X" } as never)!;
    expect(Object.keys(a.company).sort()).toEqual(["created_at", "currency", "fiscal_year_end", "id", "name", "reporting_framework"]);
  });
});

describe("canOpenStage / isPrepareOnly", () => {
  it("capability: Prepare only", () => {
    const a = toWorkspaceAccess(row("capability", ["prepare"]))!;
    expect(isPrepareOnly(a)).toBe(true);
    expect(ALL.filter((s) => canOpenStage(a, s as never))).toEqual(["prepare"]);
  });
  it("unknown access defers to the existing gates", () => expect(canOpenStage(null, "tax")).toBe(true));
});

describe("server calls", () => {
  it("no row → denied; a failed read → error (never denied, never granted)", async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(fetchWorkspaceAccess("c1")).resolves.toEqual({ status: "denied" });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "network" } });
    await expect(fetchWorkspaceAccess("c1")).resolves.toEqual({ status: "error" });
    rpc.mockResolvedValueOnce({ data: [row("capability", ["prepare"])], error: null });
    await expect(fetchWorkspaceAccess("c1")).resolves.toMatchObject({ status: "granted", access: { kind: "capability" } });
    expect(rpc).toHaveBeenLastCalledWith("get_workspace_access", { p_company_id: "c1" });
  });
  it("list_shared_workspaces: a failed read throws (the hub fails closed)", async () => {
    rpc.mockResolvedValueOnce({ data: [{ company_id: "c9", name: "Shared", capabilities: ["prepare_trial_balance"] }], error: null });
    await expect(listSharedWorkspaces()).resolves.toMatchObject([{ id: "c9", name: "Shared" }]);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    await expect(listSharedWorkspaces()).rejects.toBeTruthy();
  });
});

describe("hub routing with shared workspaces", () => {
  const shared = { id: "s1" };
  it("no own workspace + one shared → open it; several shared → choose; none → first run", () => {
    expect(decideReturningUserRoute([], [], [shared])).toEqual({ kind: "open_shared", workspace: shared });
    expect(decideReturningUserRoute([], [], [shared, { id: "s2" }])).toEqual({ kind: "chooser" });
    expect(decideReturningUserRoute([], [], [])).toEqual({ kind: "first_run" });
  });
  it("own and shared workspaces together are a choice; an open engagement still resumes", () => {
    expect(decideReturningUserRoute([], [{ id: "own" }], [shared])).toEqual({ kind: "chooser" });
    expect(decideReturningUserRoute([{ companyId: "own", periodYear: 2025 }], [], [shared]).kind).toBe("resume");
  });
  it("the logo's forced hub never silently re-opens a shared workspace", () => {
    expect(applyForceHub(decideReturningUserRoute([], [], [shared]), true)).toEqual({ kind: "chooser" });
  });
  it("without shared workspaces every existing decision is unchanged", () => {
    expect(decideReturningUserRoute([], [{ id: "own" }])).toEqual({ kind: "start_single_company", company: { id: "own" } });
  });
});
