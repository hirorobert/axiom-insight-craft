// @vitest-environment jsdom
import { act, createElement as h, useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, click, key, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { ManagementRouter } from "@/components/account/ManagementWindow";
import { ManagementLink } from "@/components/account/ManagementNavigation";
import { EngagementPeriodSettings } from "./EngagementPeriodSettings";
import { settingsWorkspace } from "@/lib/workspace/settingsContinuity";

const fixture = vi.hoisted(() => ({ save: vi.fn(), readFailed: false }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "fixture", email: "fixture@example.test" }, signOut: vi.fn() }) }));
vi.mock("@/hooks/useEngagementMandate", () => ({ useEngagementMandate: () => ({ loading: false, mandate: { granted: ["FINANCIAL_STATEMENTS"] } }) }));
vi.mock("@/hooks/useWorkspaceCapabilities", () => ({ useWorkspaceCapabilities: () => ({ loading: false, state: { access: true, allowed: ["prepare_close"] } }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  from: () => ({ select: () => ({ eq: async () => ({ error: fixture.readFailed ? { code: "offline" } : null, data: fixture.readFailed ? null : [{ id: "p1", reporting_start: "2025-01-01", reporting_end: "2025-12-31", reporting_currency: "TZS", prior_period_id: null }] }) }) }),
  rpc: (name: string, args: unknown) => name === "get_period_currency_correction" ? Promise.resolve({ data: { outcome: "not_eligible", currency: "TZS", block: { code: "ACCEPTED_CERTIFICATION" } }, error: null }) : fixture.save(name, args),
} }));
let mounts = 0;
function Work() {
  useEffect(() => { mounts++; }, []);
  const [draft, setDraft] = useState("");
  return h("main", null, h("h1", null, "Trial balance fixture"), h("input", { "aria-label": "Task draft", value: draft, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value) }), h(ManagementLink, { to: "/settings?section=engagement" }, "Reporting period"));
}
function Settings() {
  const navigate = useNavigate();
  return h(EngagementPeriodSettings, { companyId: "fixture-company", periodYear: 2025, onDone: () => navigate("/workspace/fixture-company/2025/trial-balance/review?v=3#source", { replace: true }) });
}
function Harness() {
  const l = useLocation();
  return h("div", null, h("span", { "data-testid": "route" }, l.pathname + l.search + l.hash), h(ManagementRouter, null, (location) => h(Routes, { location }, h(Route, { path: "/workspace/:id/:year/*", element: h(Work) }), h(Route, { path: "/settings", element: h(Settings) }))));
}
let ui: Mounted | undefined;
let router: ReturnType<typeof createMemoryRouter>;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const button = (text: string) => [...document.querySelectorAll("button, a")].find((el) => el.textContent?.trim() === text)!;
const submit = () => document.querySelector('form button[type="submit"]')!;
const field = (n: number) => document.querySelectorAll<HTMLInputElement>('input[type="date"]')[n];
async function open() {
  mounts = 0;
  router = createMemoryRouter([{ path: "*", element: h(Harness) }], { initialEntries: ["/workspace/fixture-company/2025/trial-balance/review?v=3#source"] });
  ui = mount(h(RouterProvider, { router })); await flush();
  typeInto(document.querySelector('[aria-label="Task draft"]') as HTMLInputElement, "Keep my task");
  click(button("Reporting period")); await flush();
}
beforeAll(() => {
  const NativeRequest = globalThis.Request;
  vi.stubGlobal("Request", class extends NativeRequest { constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, { ...init, signal: undefined }); } });
});
beforeEach(() => { fixture.save.mockReset(); fixture.readFailed = false; });
afterEach(() => { ui?.unmount(); router?.dispose(); ui = undefined; });

describe("engagement settings continuity", () => {
  it("saves once despite same-tick submits, blocks Escape/Back during the save, then returns to the original mounted task", async () => {
    let resolve!: (v: unknown) => void;
    fixture.save.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await open();
    const form = document.querySelector("form")!;
    act(() => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush(); expect(fixture.save).toHaveBeenCalledTimes(1);
    expect(field(0).disabled || field(0).closest("fieldset")?.disabled).toBe(true);
    key(document.querySelector('[role="dialog"]')!, "Escape"); await flush();
    expect(document.body.textContent).toContain("save is still in progress");
    click(button("Keep editing")); await flush();
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    click(button("Keep editing")); await flush();
    await act(async () => resolve({ data: { outcome: "opened", engagementId: "e1", periodId: "p1", periodYear: 2025, created: false, granted: ["FINANCIAL_STATEMENTS"] }, error: null })); await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(router.state.location.pathname + router.state.location.search + router.state.location.hash).toBe("/workspace/fixture-company/2025/trial-balance/review?v=3#source");
    expect((document.querySelector('[aria-label="Task draft"]') as HTMLInputElement).value).toBe("Keep my task");
    expect(mounts).toBe(1);
    await act(async () => { await router.navigate(-1); }); await flush();
    expect(fixture.save).toHaveBeenCalledTimes(1);
  });
  it("failed/uncertain saves retain the edited dates and protected currency; leaving requires keep/discard", async () => {
    fixture.save.mockRejectedValue(new Error("answer lost"));
    await open(); typeInto(field(0), "2025-02-01"); click(submit()); await flush();
    expect(field(0).value).toBe("2025-02-01");
    expect(document.querySelector('[data-testid="period-currency-readonly"]')?.textContent).toBe("TZS");
    expect(document.body.textContent).toContain("could not be confirmed");
    key(document.querySelector('[role="dialog"]')!, "Escape"); await flush();
    expect(document.body.textContent).toContain("unsaved changes");
    click(button("Keep editing")); await flush(); expect(field(0).value).toBe("2025-02-01");
    click(button("Close")); await flush(); click(button("Discard changes")); await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(fixture.save).toHaveBeenCalledTimes(1);
  });
  it("cannot save an unread period or move the current task into a different year", async () => {
    fixture.readFailed = true; await open();
    expect(document.body.textContent).toContain("could not be read");
    click(submit()); expect(fixture.save).not.toHaveBeenCalled();
  });
  it("rejects a different end year without issuing a mutation", async () => {
    await open(); typeInto(field(1), "2026-12-31"); click(submit()); await flush();
    expect(document.body.textContent).toContain("This workspace is FY2025"); expect(fixture.save).not.toHaveBeenCalled();
  });
  it("takes settings scope from the validated workspace origin rather than query overrides", () => {
    expect(settingsWorkspace({ pathname: "/workspace/a/2025/trial-balance/review" } as never)).toEqual({ companyId: "a", periodYear: 2025 });
    expect(settingsWorkspace({ pathname: "/settings?company=other" } as never)).toBeNull();
  });
});
