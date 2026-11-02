// @vitest-environment jsdom
import { createElement as h, act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, click } from "@/lib/workbench/testkit/dom";
const f = vi.hoisted(() => ({ actor: "owner" as string | null, current: "owner" as string | null, allowed: true, entries: vi.fn(), sources: false, navigate: vi.fn() }));
vi.mock("react-router-dom", () => ({ Link: ({ children }: { children: unknown }) => h("span", null, children), useNavigate: () => f.navigate }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: f.actor ? { id: f.actor } : null, loading: false }) }));
vi.mock("@/hooks/useActiveEngagements", () => ({ useActiveEngagements: () => { f.entries(); return { entries: [{ engagementId: "eng", companyId: "empty", companyName: "Sample company", periodYear: 2026, workspaceState: { currentUploadId: null } }], loading: false, fetchFailed: false }; } }));
vi.mock("@/hooks/useQboSandboxAccess", () => ({ sandboxStorage: () => sessionStorage, sandboxAccessDeps: { currentUser: async () => f.current, platformOwner: async () => f.allowed, workspaceOwner: async () => f.current, hasSources: async () => f.sources } }));
import QuickBooksSandbox from "./QuickBooksSandbox";
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
let ui: ReturnType<typeof mount> | null = null;
beforeEach(() => { sessionStorage.clear(); f.actor = "owner"; f.current = "owner"; f.allowed = true; f.sources = false; f.entries.mockClear(); f.navigate.mockClear(); });
afterEach(() => { ui?.unmount(); ui = null; });
describe("internal Sandbox entry", () => {
  it("requires sign-in without listing workspaces", async () => {
    f.actor = null; ui = mount(h(QuickBooksSandbox)); await flush(); expect(ui.container.textContent).toContain("Sign in to continue"); expect(f.entries).not.toHaveBeenCalled();
  });
  it("denies ordinary users without listing workspaces", async () => {
    f.allowed = false; ui = mount(h(QuickBooksSandbox)); await flush(); expect(ui.container.textContent).toContain("only to the platform owner"); expect(f.entries).not.toHaveBeenCalled();
  });
  it("requires a sample-data confirmation and enrolls before opening the normal review", async () => {
    ui = mount(h(QuickBooksSandbox)); await flush();
    const select = ui.container.querySelector("select")!;
    act(() => { select.value = "eng"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const button = ui.container.querySelector("button")!; expect(button.disabled).toBe(true);
    click(ui.container.querySelector('input[type="checkbox"]')!); click(button); await flush();
    expect(f.navigate).toHaveBeenCalledWith("/workspace/empty/2026/trial-balance/review?engagement=eng");
    expect(sessionStorage.getItem("cfoclose:qbo-sandbox:empty:2026")).toBe("owner");
  });
  it("rechecks emptiness at opening and reports refusal without navigating", async () => {
    ui = mount(h(QuickBooksSandbox)); await flush(); const select = ui.container.querySelector("select")!;
    act(() => { select.value = "eng"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    click(ui.container.querySelector('input[type="checkbox"]')!); f.sources = true;
    click(ui.container.querySelector("button")!); await flush(); expect(f.navigate).not.toHaveBeenCalled(); expect(ui.container.textContent).toContain("Nothing was imported");
  });
});
