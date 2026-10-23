// @vitest-environment jsdom
import { act, createElement as h, useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider, Routes, Route, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { axeViolations, click, key, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { ManagementRouter } from "./ManagementWindow";
import { ManagementLink } from "./ManagementNavigation";
import { managementOrigin, useManagementEditGuard } from "./managementState";
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "fixture", email: "fixture@example.test" }, signOut: vi.fn() }) }));
let mounts = 0;
function Work() {
  useEffect(() => { mounts++; }, []);
  const [value, setValue] = useState("");
  return h("main", { tabIndex: -1 }, h("h1", null, "Fixture work"), h("input", { "aria-label": "Workspace draft", value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value) }), h(ManagementLink, { to: "/settings", "data-management-trigger": true }, "Open settings"));
}
function Edit() {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  useManagementEditGuard(!!value, busy, () => setValue(""));
  return h("section", null, h("h2", null, "Fixture settings"), h("p", null, location.search), h("label", null, "Profile name", h("input", { value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value) })), h("button", { onClick: () => setBusy((v) => !v) }, busy ? "Finish save" : "Start save"));
}
function Harness() {
  return h(ManagementRouter, null, (location) => h(Routes, { location }, h(Route, { path: "/workspace/:id/:year/*", element: h(Work) }), h(Route, { path: "/dashboard", element: h(Work) }), h(Route, { path: "/settings", element: h(Edit) }), h(Route, { path: "/plans", element: h("h2", null, "Plan fixture") }), h(Route, { path: "/settings/billing", element: h("h2", null, "Order fixture") })));
}
let ui: Mounted | undefined;
let router: ReturnType<typeof createMemoryRouter>;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const byText = (text: string) => [...document.querySelectorAll("button, a")].find((element) => element.textContent === text)!;
const dialog = () => document.querySelector('[role="dialog"]')!;
const open = async (entry = "/workspace/fixture/2025/statements?version=3#line-2") => {
  mounts = 0;
  router = createMemoryRouter([{ path: "*", element: h(Harness) }], { initialEntries: [entry] });
  ui = mount(h(RouterProvider, { router })); await flush();
};
beforeAll(() => {
  // Node's Request and jsdom's AbortSignal belong to different realms. No loader runs in this fixture.
  const NativeRequest = globalThis.Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, { ...init, signal: undefined }); }
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { ui?.unmount(); router?.dispose(); ui = undefined; });

describe("route-backed management window", () => {
  it("keeps the original workspace mounted through tabs, plans and orders, then closes to its exact URL and draft", async () => {
    await open();
    typeInto(document.querySelector('[aria-label="Workspace draft"]') as HTMLInputElement, "Keep this work");
    click(byText("Open settings")); await flush();
    expect(dialog()).not.toBeNull();
    expect(mounts).toBe(1);
    click(byText("View plans")); await flush();
    expect(dialog().textContent).toContain("Plan fixture");
    click(byText("Orders & receipts")); await flush();
    expect(dialog().textContent).toContain("Order fixture");
    click(document.querySelector('[aria-label="Close practice settings"]')!); await flush();
    expect(dialog()).toBeNull();
    expect(router.state.location.pathname + router.state.location.search + router.state.location.hash).toBe("/workspace/fixture/2025/statements?version=3#line-2");
    expect((document.querySelector('[aria-label="Workspace draft"]') as HTMLInputElement).value).toBe("Keep this work");
    expect(mounts).toBe(1);
  });
  it("Escape and the footer Close share the unsaved-change guard; discard also resets an edit before changing section", async () => {
    await open(); click(byText("Open settings")); await flush();
    typeInto(dialog().querySelector("input")!, "Unsaved"); await flush();
    key(dialog(), "Escape"); await flush();
    expect(dialog().textContent).toContain("You have unsaved changes");
    click(byText("Keep editing")); await flush();
    expect((dialog().querySelector("input") as HTMLInputElement).value).toBe("Unsaved");
    click(byText("Companies")); await flush();
    click(byText("Discard changes")); await flush();
    expect(router.state.location.search).toBe("?section=companies");
    expect((dialog().querySelector("input") as HTMLInputElement).value).toBe("");
    click(byText("Close")); await flush(); expect(dialog()).toBeNull();
  });
  it("browser Back is guarded and can continue only after an explicit discard", async () => {
    await open(); click(byText("Open settings")); await flush();
    typeInto(dialog().querySelector("input")!, "Unsaved"); await flush();
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(dialog().textContent).toContain("You have unsaved changes");
    click(byText("Discard changes")); await flush(); expect(dialog()).toBeNull();
  });
  it("never discards an in-flight save and allows closing after it finishes", async () => {
    await open(); click(byText("Open settings")); await flush();
    click(byText("Start save")); await flush(); click(byText("Close")); await flush();
    expect(dialog().textContent).toContain("A save is still in progress");
    expect(byText("Discard changes")).toBeUndefined();
    click(byText("Keep editing")); await flush(); click(byText("Finish save")); await flush();
    click(byText("Close")); await flush(); expect(dialog()).toBeNull();
  });
  it("direct links have a visible exit, mobile navigation labels and no axe violations", async () => {
    await open("/settings?section=companies");
    expect(dialog()).not.toBeNull();
    expect(await axeViolations(dialog())).toEqual([]);
    click(byText("Close")); await flush(); expect(router.state.location.pathname).toBe("/dashboard");
  });
  it("rejects external, recursive and malformed background locations", () => {
    for (const pathname of ["//evil.example", "/settings", "/plans", "/billing/checkout", "https://evil.example"]) {
      expect(managementOrigin({ pathname, search: "", hash: "", key: "a" })).toBeNull();
    }
    expect(managementOrigin({ pathname: "/dashboard" })).toBeNull();
  });
});
