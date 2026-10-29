// @vitest-environment jsdom
/**
 * Route / auth boundary of the IPSAS page: the page mounts ONE preparation per company, period AND signed-in actor and builds a new
 * database client when the actor changes, so a change of any of the three discards the previous instance (draft, pending answers, request
 * identities) instead of re-using it. Proven by rendering the real page with the context hooks replaced - not assumed from the route table.
 */
import { createElement as h } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { CO, CO2, heldDb } from "@/components/ipsas/preparationHarness";

const state = vi.hoisted(() => ({
  ws: { companyId: "", periodYear: 2026, company: { name: "Mwamba Community Trust" } as { name: string } | null },
  user: { id: "user-a" } as { id: string } | null,
  dbs: [] as unknown[],
  makeDb: (() => ({})) as () => unknown,
}));
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => state.ws }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/hooks/useWorkspaceCapabilities", () => ({ useWorkspaceCapabilities: () => ({ state: { allowed: ["prepare_close", "review_close"] } }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/reporting/supabaseDb", () => ({ supabaseReportingDb: () => { const d = state.makeDb(); state.dbs.push(d); return d; } }));
const { default: Page } = await import("./IpsasPreparationPage");

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; state.dbs = []; });
const button = (text: string) => [...m!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const tab = (name: string) => [...m!.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name)!;

async function startSave(hd: ReturnType<typeof heldDb>) {
  state.ws = { companyId: CO, periodYear: 2026, company: { name: "Mwamba Community Trust" } };
  state.user = { id: "user-a" };
  // Keep this page-boundary proof focused on the preparation operation; statement review is tested independently.
  state.makeDb = () => ({ rpc: (name: string, args: Record<string, unknown>) => name === "ipsas_statement_review"
    ? Promise.resolve({ data: { outcome: "no_authority" }, error: null }) : hd.db.rpc(name, args) });
  m = mount(h(Page)); await flush();
  act(() => click(tab("Complete preparation")));
  act(() => click(button("Add an asset class")));
  act(() => typeInto(m!.container.querySelector("#c0-label") as HTMLInputElement, "Draft of A"));
  await act(async () => { click(button("Save preparation")); }); await flush();
  expect(hd.held).toHaveLength(1);
  expect(m!.container.textContent).toContain("Saving…");
}
const answerLate = async (hd: ReturnType<typeof heldDb>) => { await act(async () => { hd.held[0].release("recorded"); await Promise.resolve(); }); await flush(); };

describe("the IPSAS page remounts on any change of company, period or actor", () => {
  it("another signed-in actor: a new client, a fresh instance, and the first actor's late answer reaches nothing", async () => {
    const hd = heldDb();
    await startSave(hd);
    const clients = state.dbs.length;
    state.user = { id: "user-b" };
    m!.rerender(h(Page)); await flush();
    expect(state.dbs.length).toBeGreaterThan(clients);             // a new client for the new actor
    expect(m!.container.querySelector("#c0-label")).toBeNull();     // the first actor's draft is gone
    expect(m!.container.textContent).not.toContain("Saving…");
    await answerLate(hd);
    expect(m!.container.textContent).not.toContain("This is the server's recorded version");
    expect(m!.container.querySelector("#c0-label")).toBeNull();
  });

  it("signing out (no actor) discards the instance too", async () => {
    const hd = heldDb();
    await startSave(hd);
    state.user = null;
    m!.rerender(h(Page)); await flush();
    expect(m!.container.querySelector("#c0-label")).toBeNull();
    await answerLate(hd);
    expect(m!.container.textContent).not.toContain("This is the server's recorded version");
  });

  it("another company, and another period, each start a fresh instance", async () => {
    const hd = heldDb();
    await startSave(hd);
    state.ws = { ...state.ws, companyId: CO2 };
    m!.rerender(h(Page)); await flush();
    expect(m!.container.textContent).not.toContain("Saving…");
    await answerLate(hd);
    expect(m!.container.textContent).not.toContain("This is the server's recorded version");
    state.ws = { ...state.ws, periodYear: 2027 };
    m!.rerender(h(Page)); await flush();
    expect(m!.container.textContent).toContain("2027");
    expect(m!.container.textContent).not.toContain("This is the server's recorded version");
  });
});
