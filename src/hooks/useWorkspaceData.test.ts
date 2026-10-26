// @vitest-environment jsdom
import { createElement as h, act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount, click } from "@/lib/workbench/testkit/dom";
const f = vi.hoisted(() => ({ snapshot: vi.fn(), user: { id: "owner" }, scope: { companyId: "a", periodYear: "2025" } }));
vi.mock("react-router-dom", () => ({ useParams: () => f.scope, useSearchParams: () => [new URLSearchParams()] }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: f.user }) }));
vi.mock("@/lib/workspace/fetchWorkspaceSnapshot", () => ({ fetchWorkspaceSnapshot: (...a: unknown[]) => f.snapshot(...a) }));
vi.mock("@/lib/workspace/workspaceAccess", () => ({ fetchWorkspaceAccess: async () => ({ status: "granted", access: { company: { id: f.scope.companyId } } }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { channel: () => { const c = { on: () => c, subscribe: () => c }; return c; }, removeChannel: vi.fn() } }));
import { useWorkspaceData } from "./useWorkspaceData";
function View() { const d = useWorkspaceData(); return h("div", null, h("p", null, d.company?.name ?? "waiting"), h("span",null,d.accessState.status), h("button", { onClick: d.refreshUpload }, "refresh")); }
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const snapshot = (name: string) => ({ company: { id: name, name }, upload: null, uploads: [], uploadsTotal: 0, workspaceState: {} });
describe("workspace response isolation", () => {
  it("a failed initial snapshot exposes retryable error instead of endless loading",async()=>{
    f.snapshot.mockReset().mockRejectedValueOnce(Error("offline")).mockResolvedValueOnce(snapshot("recovered"));
    const ui=mount(h(View));await flush();expect(ui.container.textContent).toContain("error");
    click(ui.container.querySelector("button")!);await flush();expect(ui.container.textContent).toContain("recovered");ui.unmount();
  });
  it("a failed background upload read preserves the last confirmed file snapshot",async()=>{
    f.snapshot.mockReset().mockResolvedValueOnce(snapshot("confirmed")).mockRejectedValueOnce(Error("offline"));
    const ui=mount(h(View));await flush();click(ui.container.querySelector("button")!);await flush();expect(ui.container.textContent).toContain("confirmed");ui.unmount();
  });
  it("a late earlier response cannot overwrite the newer confirmed snapshot", async () => {
    let first!: (v: unknown) => void;
    f.snapshot.mockImplementationOnce(() => new Promise(r => { first = r; })).mockResolvedValueOnce(snapshot("newer"));
    const ui = mount(h(View)); await flush();
    click(ui.container.querySelector("button")!); await flush();
    expect(ui.container.textContent).toContain("newer");
    await act(async () => first(snapshot("stale"))); await flush();
    expect(ui.container.textContent).toContain("newer"); expect(ui.container.textContent).not.toContain("stale");
    ui.unmount();
  });
  it("unmounting a company/period scope invalidates its outstanding read", async () => {
    let finish!: (v: unknown) => void;
    f.snapshot.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const old = mount(h(View)); await flush(); old.unmount();
    f.scope = { companyId: "b", periodYear: "2026" }; f.snapshot.mockResolvedValueOnce(snapshot("company-b"));
    const next = mount(h(View)); await flush();
    await act(async () => finish(snapshot("company-a"))); await flush();
    expect(next.container.textContent).toContain("company-b"); expect(next.container.textContent).not.toContain("company-a"); next.unmount();
  });
});
