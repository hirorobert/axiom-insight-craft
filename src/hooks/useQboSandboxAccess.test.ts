// @vitest-environment jsdom
import { createElement as h, act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@/lib/workbench/testkit/dom";
const f = vi.hoisted(() => ({ actor: "owner", platform: true, company: "owner", getUser: vi.fn(), read: vi.fn(), listener: null as null | ((e: string, s: { user: { id: string } } | null) => void), unsubscribe: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  auth: { getUser: () => f.getUser(), onAuthStateChange: (cb: typeof f.listener) => { f.listener = cb; return { data: { subscription: { unsubscribe: f.unsubscribe } } }; } },
  rpc: async () => { f.read(); return { data: f.platform, error: null }; },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: f.company }, error: null }) }) }) }),
} }));
import { useQboSandboxAccess } from "./useQboSandboxAccess";
const scope = { companyId: "test", periodYear: 2026 };
function View({ company = "test", year = 2026 }: { company?: string; year?: number }) { return h("p", null, useQboSandboxAccess({ companyId: company, periodYear: year }, true) ? "admitted" : "hidden"); }
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
let ui: ReturnType<typeof mount> | null = null;
beforeEach(() => { sessionStorage.clear(); f.actor = "owner"; f.company = "owner"; f.platform = true; f.listener = null; f.read.mockClear(); f.getUser.mockReset().mockImplementation(async () => ({ data: { user: { id: f.actor } }, error: null })); });
afterEach(() => { ui?.unmount(); ui = null; });
const enroll = () => sessionStorage.setItem(`cfoclose:qbo-sandbox:${scope.companyId}:${scope.periodYear}`, "owner");
describe("Sandbox identity and scope isolation", () => {
  it("does not make additional authority reads for ordinary customer pages", async () => {
    ui = mount(h(View)); await flush(); expect(ui.container.textContent).toBe("hidden"); expect(f.getUser).not.toHaveBeenCalled();
  });
  it("admits an enrolled owner and survives same-identity token refresh", async () => {
    enroll(); ui = mount(h(View)); await flush(); expect(ui.container.textContent).toBe("admitted");
    act(() => f.listener?.("TOKEN_REFRESHED", { user: { id: "owner" } })); expect(ui.container.textContent).toBe("admitted");
  });
  it("hides immediately on sign-out and cannot reuse the old owner's marker", async () => {
    enroll(); ui = mount(h(View)); await flush(); f.actor = "other";
    act(() => f.listener?.("SIGNED_OUT", null)); expect(ui.container.textContent).toBe("hidden");
    await flush(); expect(ui.container.textContent).toBe("hidden");
  });
  it("never carries admission into another company or year", async () => {
    enroll(); ui = mount(h(View)); await flush(); expect(ui.container.textContent).toBe("admitted");
    ui.rerender(h(View, { year: 2025 })); expect(ui.container.textContent).toBe("hidden"); await flush();
    ui.rerender(h(View, { company: "other" })); expect(ui.container.textContent).toBe("hidden");
  });
  it("a delayed old-company check cannot admit the next scope", async () => {
    enroll(); let resolve!: (v: unknown) => void;
    f.getUser.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    ui = mount(h(View)); ui.rerender(h(View, { company: "other" }));
    await act(async () => resolve({ data: { user: { id: "owner" } }, error: null })); await flush();
    expect(ui.container.textContent).toBe("hidden");
  });
  it("a stored opt-in cannot replace current platform or workspace authority", async () => {
    enroll(); f.platform = false; ui = mount(h(View)); await flush(); expect(ui.container.textContent).toBe("hidden");
    ui.unmount(); f.platform = true; f.company = "other"; ui = mount(h(View)); await flush(); expect(ui.container.textContent).toBe("hidden");
  });
});
