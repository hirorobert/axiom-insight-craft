// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The view is pure, so every state is rendered from props. The container is rendered only to prove it shows nothing while the connector is not released.
afterEach(() => { vi.doUnmock("@/integrations/supabase/client"); vi.resetModules(); });

async function load() {
  vi.resetModules();
  vi.doMock("@/integrations/supabase/client", () => ({ supabase: {} }));
  return import("./QuickBooksImport");
}
const DATES = { start: "2026-01-01", end: "2026-12-31" };
type Props = Parameters<Awaited<ReturnType<typeof load>>["QuickBooksImportView"]>[0];
const base: Props = { state: { kind: "none" }, environment: "sandbox", period: DATES, busy: null, returned: null, result: null, onConnect: () => undefined, onImport: () => undefined };
async function render(over: Partial<Props>) {
  const { QuickBooksImportView } = await load();
  return renderToStaticMarkup(createElement(QuickBooksImportView, { ...base, ...over }));
}
const buttons = (html: string) => [...html.matchAll(/<button[^>]*data-action="(\w+)"[^>]*>/g)].map((m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("Import from QuickBooks card", () => {
  it("renders nothing when the connection status cannot be read (the backend is not there)", async () => {
    expect(await render({ state: { kind: "unavailable" } })).toBe("");
  });
  it("renders nothing at all while the connector is not released", async () => {
    const { QuickBooksImport } = await load();
    expect(renderToStaticMarkup(createElement(QuickBooksImport, { companyId: "c", periodYear: 2026, periodId: null, engagementId: null }))).toBe("");
  });
  it("checking: says so and offers no action", async () => {
    const html = await render({ state: "checking" });
    expect(text(html)).toContain("Checking the QuickBooks connection");
    expect(buttons(html)).toEqual([]);
  });
  it("not connected: explains in plain words and offers exactly one action, Connect", async () => {
    const html = await render({ state: { kind: "none" } });
    expect(buttons(html)).toEqual(["connect"]);
    expect(text(html)).toContain("Connect QuickBooks");
    expect(text(html)).toMatch(/we never see your password/);
    expect(text(html)).toMatch(/read the trial balance report only/);
  });
  it("connected with the period's dates: names the company and the dates it will import, and offers exactly one action, Import", async () => {
    const html = await render({ state: { kind: "connected", realmId: "9341458607761798" } });
    expect(buttons(html)).toEqual(["import"]);
    expect(text(html)).toContain("Connected to QuickBooks company 9341458607761798 (a test company)");
    expect(text(html)).toContain("2026-01-01 to 2026-12-31, the dates of this period");
  });
  it("a production connection is not called a test company", async () => {
    expect(text(await render({ state: { kind: "connected", realmId: "1" }, environment: "production" }))).not.toContain("test company");
  });
  it("connected but the period has no dates: no Import button, and it says what to do first", async () => {
    const html = await render({ state: { kind: "connected", realmId: "1" }, period: { start: null, end: "2026-12-31" } });
    expect(buttons(html)).toEqual([]);
    expect(text(html)).toContain("Set this period's start and end dates first");
  });
  it("connected while the dates are still loading: no button yet", async () => {
    const html = await render({ state: { kind: "connected", realmId: "1" }, period: "loading" });
    expect(buttons(html)).toEqual([]);
    expect(text(html)).toContain("Reading this period's dates");
  });
  it("an expired connection offers exactly one action, Reconnect", async () => {
    const html = await render({ state: { kind: "reconnect", realmId: "1" } });
    expect(buttons(html)).toEqual(["connect"]);
    expect(text(html)).toContain("Reconnect QuickBooks");
    expect(text(html)).toContain("expired or was removed");
  });
  it("while working the button is disabled and says what is happening", async () => {
    const connecting = await render({ state: { kind: "none" }, busy: "connect" });
    expect(connecting).toMatch(/<button[^>]*disabled[^>]*data-action="connect"|<button[^>]*data-action="connect"[^>]*disabled/);
    expect(text(connecting)).toContain("Opening QuickBooks");
    const finishing = await render({ state: { kind: "none" }, busy: "finish" });
    expect(text(finishing)).toContain("Finishing the QuickBooks connection");
    expect(finishing).toMatch(/disabled/);
    const importing = await render({ state: { kind: "connected", realmId: "1" }, busy: "import" });
    expect(text(importing)).toContain("Importing");
    expect(importing).toMatch(/disabled/);
  });
  it("shows the status word the redirect came back with, in plain words", async () => {
    expect(text(await render({ returned: "connected" }))).toContain("QuickBooks is connected");
    expect(text(await render({ returned: "denied" }))).toContain("Nothing was shared");
    const failed = await render({ returned: "failed" });
    expect(text(failed)).toContain("could not be connected");
    expect(failed).toContain("text-destructive");
  });
  it("shows a success as a status and a refusal as an alert, with the server's detail when there is one", async () => {
    const ok = await render({ state: { kind: "connected", realmId: "1" }, result: { ok: true, text: "Imported 30 accounts (GBP). The check has started and its result appears below." } });
    expect(ok).toContain('role="status"');
    expect(text(ok)).toContain("Imported 30 accounts (GBP)");
    const bad = await render({ state: { kind: "connected", realmId: "1" }, result: { ok: false, text: "Nothing was imported.", detail: "The report's debits and credits are not equal." } });
    expect(bad).toContain('role="alert"');
    expect(text(bad)).toContain("The report's debits and credits are not equal.");
  });
  it("never names an engine and never shows a credential term, in any state", async () => {
    const states: Props["state"][] = ["checking", { kind: "none" }, { kind: "connected", realmId: "1" }, { kind: "reconnect", realmId: "1" }];
    for (const state of states) {
      for (const returned of [null, "connected", "denied", "failed"] as const) {
        const t = text(await render({ state, returned }));
        expect(t).not.toMatch(/SAFISHA|HESABU|KINGA|MAONO/);
        expect(t).not.toMatch(/token|secret|envelope|oauth|jwt/i);
      }
    }
  });
});
