// @vitest-environment jsdom
/**
 * Close Review › Findings on the real rendered component (guided-correction r2, 26 Oct 2026): a notice always names the
 * finding and run it is about; the opened finding survives a new check (it is remembered by its key, not a run's id);
 * a finding the new check no longer raises is said to be gone, not left as "Open"; each decision states its effect; and a
 * person without the capability is offered no action. Fake transport only.
 */
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { FindingsView } from "./FindingsView";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import type { FindingRow, FindingsClient, FindingStatus } from "@/lib/closeReview/findings";
import type { TimelineClient } from "@/lib/closeReview/timeline";

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const C = "22222222-2222-4222-8222-222222222222";

const row = (runId: string, key: string, o: Partial<FindingRow> = {}): FindingRow => ({
  id: `${runId}:${key}`, run_id: runId, rule_id: "A01", finding_key: `A01:${key}`, severity: "warning", kind: "risk_indicator", mandatory: false,
  required_resolution: "explanation", account_key: key, account_code: key, account_name: `Account ${key}`, classification: "operating_expenses",
  debit_minor: "0", credit_minor: "100000", class_side_minor: "-100000", detail: {}, ...o,
});

function world(runs: Record<string, FindingRow[]>, first: string) {
  let runId = first;
  const order = Object.keys(runs);
  const status = new Map<string, FindingStatus>();
  const calls = { act: [] as unknown[], selected: [] as (string | null)[] };
  const client: FindingsClient = {
    summary: async () => ({ state: "current", runId, currency: "TZS", exponent: 2, generatedAt: "2026-10-26T08:00:00Z", total: runs[runId].length, unresolved: runs[runId].length, unresolvedBlocking: 0, ruleStatus: {} }),
    list: async (id) => runs[id] ?? [],
    events: async () => [],
    states: async () => runs[runId].map((f) => ({ finding_id: f.id, status: status.get(f.id) ?? "open", resolved: (status.get(f.id) ?? "open") !== "open" })),
    refresh: async () => { const i = order.indexOf(runId); runId = order[Math.min(i + 1, order.length - 1)]; return { outcome: "generated" }; },
    act: async (findingId, action) => { calls.act.push({ findingId, action }); status.set(findingId, action === "explain" ? "explained" : action === "accept" ? "accepted" : action === "not_applicable" ? "not_applicable" : "open"); return { outcome: "recorded", status: status.get(findingId) }; },
  } as never;
  const timeline: TimelineClient = { read: async () => [], comment: async () => ({ outcome: "recorded", eventId: "e" }) } as never;
  const props = (allowed: readonly string[], o: Partial<Parameters<typeof FindingsView>[0]> = {}): Parameters<typeof FindingsView>[0] => ({
    companyId: C, periodYear: 2025, client, timeline, allowed, currentUserId: "user-a", reviewHref: "/review",
    correctionHref: (f) => (f.account_key ? `/workspace/${C}/2025/trial-balance/review?account=${f.account_key}&finding=${f.finding_key}` : null),
    onSelectFinding: (k) => calls.selected.push(k), ...o,
  });
  return { props, calls };
}
const render = (p: Parameters<typeof FindingsView>[0]) => h(MemoryRouter, null, h(FindingsView, p));
const q = (m: Mounted, id: string) => m.container.querySelector(`[data-testid="${id}"]`);
const notice = (m: Mounted) => q(m, "findings-notice")!;
const open = (m: Mounted, key: string) => click(m.container.querySelector(`[data-testid="finding-A01:${key}"] button`)!);
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });

describe("switching findings while an old notice exists", () => {
  it("a decision's notice names its finding; opening another finding clears the notice and the typed text", async () => {
    const w = world({ r1: [row("r1", "1510"), row("r1", "2100")] }, "r1");
    m = mount(render(w.props(["prepare_close"]))); await flush();
    open(m, "1510"); await flush();
    typeInto(m.container.querySelector("textarea")!, "Accumulated depreciation per the register.");
    click([...m.container.querySelectorAll("button")].find((b) => b.textContent === "Record explanation")!); await flush();
    expect(notice(m).textContent).toBe("Explained — recorded for “Balance on the unexpected side” for account 1510.");
    expect(notice(m).getAttribute("data-finding-key")).toBe("A01:1510");
    expect(notice(m).getAttribute("data-run-id")).toBe("r1");
    open(m, "2100"); await flush();
    expect(notice(m).textContent).toBe("");
    expect((m.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(q(m, "finding-detail")!.textContent).toContain("Account 2100");
  });
});

describe("the opened finding across a new check", () => {
  it("still raised by the new run (a new id): it stays open on the page, read from the new run", async () => {
    const w = world({ r1: [row("r1", "1510")], r2: [row("r2", "1510", { classification: "non_current_assets" })] }, "r1");
    m = mount(render(w.props(["prepare_close"]))); await flush();
    open(m, "1510"); await flush();
    click([...m.container.querySelectorAll("button")].find((b) => b.textContent === "Check again")!); await flush();
    expect(q(m, "finding-detail")).not.toBeNull();
    expect(q(m, "finding-guidance")!.textContent).toContain("The check used Non-Current Assets");
    expect(notice(m).getAttribute("data-run-id")).toBe("r2");
    expect(w.calls.selected).toEqual(["A01:1510"]);
  });
  it("no longer raised by the new run: the notice says which finding, the detail closes, and no row shows it as Open", async () => {
    const w = world({ r1: [row("r1", "1510"), row("r1", "2100")], r2: [row("r2", "2100")] }, "r1");
    m = mount(render(w.props(["prepare_close"]))); await flush();
    open(m, "1510"); await flush();
    click([...m.container.querySelectorAll("button")].find((b) => b.textContent === "Check again")!); await flush();
    expect(notice(m).textContent).toMatch(/The current check no longer raises “Balance on the unexpected side” for account 1510\./);
    expect(notice(m).getAttribute("data-finding-key")).toBe("A01:1510");
    expect(notice(m).getAttribute("data-run-id")).toBe("r2");
    expect(q(m, "finding-detail")).toBeNull();
    expect(q(m, "finding-A01:1510")).toBeNull();
    expect(w.calls.selected).toEqual(["A01:1510", null]);
  });
  it("arriving from the account with a finding the current check no longer raises says so, naming it", async () => {
    const w = world({ r1: [row("r1", "2100")] }, "r1");
    m = mount(render(w.props(["prepare_close"], { focusFindingKey: "A01:1510" }))); await flush();
    expect(notice(m).textContent).toBe("The current check of the reviewed trial balance no longer raises “Balance on the unexpected side” for account 1510.");
    expect(q(m, "finding-detail")).toBeNull();
  });
});

describe("decisions state their effects; a comment is never a resolution", () => {
  it("Prepare sees Record explanation with its effect; Review sees Accept and Not applicable with theirs; neither is called a correction", async () => {
    const w = world({ r1: [row("r1", "1510")] }, "r1");
    m = mount(render(w.props(["prepare_close"]))); await flush();
    open(m, "1510"); await flush();
    let effects = q(m, "finding-action-effects")!.textContent!;
    expect(effects).toMatch(/Record explanation — records your reasoning why the balance is legitimate as it stands/);
    expect(effects).toMatch(/It is not a correction/);
    expect(effects).toMatch(/Comments in the history below are discussion only: they do not change the status/);
    expect(effects).not.toMatch(/Accept —/);
    m.rerender(render(w.props(["review_close"]))); await flush();
    effects = q(m, "finding-action-effects")!.textContent!;
    expect(effects).toMatch(/Accept — a reviewer accepts the finding as it stands, without a correction/);
    expect(effects).toMatch(/Mark not applicable — .*It is not a way past an unresolved issue/);
    expect(effects).not.toMatch(/Record explanation —/);
  });
  it("the correction is the prominent action for Prepare and a read-only link for a reviewer without Prepare", async () => {
    const w = world({ r1: [row("r1", "1510")] }, "r1");
    m = mount(render(w.props(["prepare_close"]))); await flush();
    open(m, "1510"); await flush();
    expect(q(m, "finding-correct-account")).not.toBeNull();
    expect(q(m, "finding-guidance")!.textContent).toMatch(/What the check found\. The check used Operating Expenses/);
    expect(q(m, "finding-guidance")!.textContent).toMatch(/When this can be legitimate\./);
    m.rerender(render(w.props(["review_close"]))); await flush();
    expect(q(m, "finding-correct-account")).toBeNull();
    expect(q(m, "finding-correct-account-readonly")!.textContent).toMatch(/Correcting it needs Prepare/);
  });
});

describe("restricted users receive no unauthorized action", () => {
  it("a member holding neither capability sees the finding and its facts, but no decision button, no correction button and no check", async () => {
    const w = world({ r1: [row("r1", "1510")] }, "r1");
    m = mount(render(w.props([]))); await flush();
    open(m, "1510"); await flush();
    expect(q(m, "finding-no-action")!.textContent).toMatch(/No decision is available to you on this finding \(a decision needs Prepare or Review in this workspace\)/);
    expect(q(m, "finding-correct-account")).toBeNull();
    expect(q(m, "finding-correct-account-readonly")).not.toBeNull();
    const labels = [...m.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toEqual(expect.arrayContaining(["Record explanation", "Accept", "Mark not applicable", "Check again"]));
    expect(w.calls.act).toHaveLength(0);
  });
});
