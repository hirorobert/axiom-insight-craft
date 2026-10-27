// @vitest-environment jsdom
/**
 * Asynchronous context ownership on Close Review › Findings (guided-correction r2 review, 26 Oct 2026). A refresh, a
 * decision or a read that was started under one selection, workspace, year or signed-in actor may finish after the person
 * has moved on. Then: the refreshed LIST still applies to its workspace and run (it is valid), but the old work must not
 * clear the new selection, overwrite new text or evidence, present its notice as the new finding's result, navigate the
 * new context, or start follow-up work against it. A decision's request id survives an unknown outcome. Fake transport
 * with hand-released promises; nothing here invents a server outcome.
 */
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { FindingsView } from "./FindingsView";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import type { FindingRow, FindingsClient, FindingStatus } from "@/lib/closeReview/findings";
import type { TimelineClient } from "@/lib/closeReview/timeline";

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "44444444-4444-4444-8444-444444444444";
type Props = Parameters<typeof FindingsView>[0];

const row = (runId: string, key: string, o: Partial<FindingRow> = {}): FindingRow => ({
  id: `${runId}:${key}`, run_id: runId, rule_id: "A01", finding_key: `A01:${key}`, severity: "warning", kind: "risk_indicator", mandatory: false,
  required_resolution: "explanation", account_key: key, account_code: key, account_name: `Account ${key}`, classification: "operating_expenses",
  debit_minor: "0", credit_minor: "100000", class_side_minor: "-100000", detail: {}, ...o,
});

/** A promise the test releases by hand. */
function gate<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

/**
 * One fake server per workspace: its current run, the rows of each run, recorded decisions. Every call is logged with the
 * workspace it was made for; `defer.refresh` / `defer.act` / `defer.summary` hold the next such call until released.
 */
function server(runs: Record<string, FindingRow[]>, first: string) {
  let runId = first;
  const order = Object.keys(runs);
  const status = new Map<string, FindingStatus>();
  const calls = { act: [] as { findingId: string; action: string; text: string; requestId: string }[], summary: 0, list: [] as string[], refresh: 0 };
  const defer: { refresh: ReturnType<typeof gate<void>> | null; act: ReturnType<typeof gate<{ outcome: string; status?: FindingStatus }>> | null; summary: ReturnType<typeof gate<void>> | null } = { refresh: null, act: null, summary: null };
  const client: FindingsClient = {
    summary: async () => { calls.summary++; if (defer.summary) { const d = defer.summary; defer.summary = null; await d.promise; } return { state: "current", runId, currency: "TZS", exponent: 2, generatedAt: "2026-10-26T08:00:00Z", total: runs[runId].length, unresolved: runs[runId].length, unresolvedBlocking: 0, ruleStatus: {} }; },
    list: async (id) => { calls.list.push(id); return runs[id] ?? []; },
    events: async () => [],
    states: async () => runs[runId].map((f) => ({ finding_id: f.id, status: status.get(f.id) ?? "open", resolved: (status.get(f.id) ?? "open") !== "open" })),
    refresh: async () => { calls.refresh++; if (defer.refresh) { const d = defer.refresh; defer.refresh = null; await d.promise; } const i = order.indexOf(runId); runId = order[Math.min(i + 1, order.length - 1)]; return { outcome: "generated" }; },
    act: async (findingId, action, text, _ev, requestId) => {
      calls.act.push({ findingId, action, text, requestId });
      if (defer.act) { const d = defer.act; defer.act = null; const r = await d.promise; if (r.status) status.set(findingId, r.status); return r; }
      status.set(findingId, "explained"); return { outcome: "recorded", status: "explained" };
    },
  } as never;
  return { client, calls, defer, run: () => runId };
}
const timeline: TimelineClient = { read: async () => [], comment: async () => ({ outcome: "recorded", eventId: "e" }) } as never;
function props(s: ReturnType<typeof server>, o: Partial<Props> = {}): Props & { selected: (string | null)[] } {
  const selected: (string | null)[] = [];
  return {
    companyId: C1, periodYear: 2025, client: s.client, timeline, allowed: ["prepare_close", "review_close"], currentUserId: "user-a", reviewHref: "/review",
    correctionHref: (f) => (f.account_key ? `/review?account=${f.account_key}&finding=${f.finding_key}` : null),
    onSelectFinding: (k) => selected.push(k), selected, ...o,
  };
}
const render = (p: Props) => h(MemoryRouter, null, h(FindingsView, p));
const q = (m: Mounted, id: string) => m.container.querySelector(`[data-testid="${id}"]`);
const notice = (m: Mounted) => q(m, "findings-notice")!;
const open = (m: Mounted, key: string) => click(m.container.querySelector(`[data-testid="finding-A01:${key}"] button`)!);
const textarea = (m: Mounted) => m.container.querySelector("textarea") as HTMLTextAreaElement;
const button = (m: Mounted, label: string) => [...m.container.querySelectorAll("button")].find((b) => b.textContent === label)!;
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });

describe("A. a refresh started on finding A finishes after finding B was opened", () => {
  it("the refreshed list applies; B stays open with its text; the 'A no longer raised' notice names A; the address is not moved off B", async () => {
    const s = server({ r1: [row("r1", "1510"), row("r1", "2100")], r2: [row("r2", "2100")] }, "r1");
    const g = gate<void>(); s.defer.refresh = g;
    const p = props(s);
    m = mount(render(p)); await flush();
    open(m, "1510"); await flush();
    click(button(m, "Check again")); await flush();           // refresh for A (1510) is pending
    open(m, "2100"); await flush();                           // the person moves to B
    typeInto(textarea(m), "B's own explanation, typed while A's check was running.");
    const selectedBefore = [...p.selected];
    await act(async () => { g.resolve(); }); await flush();   // A's refresh finishes: r2 no longer raises A
    expect(q(m, "finding-A01:1510")).toBeNull();                               // the refreshed list applies (r2)
    expect(q(m, "finding-A01:2100")).not.toBeNull();
    expect(q(m, "finding-detail")!.textContent).toContain("Account 2100");     // B stays open
    expect(textarea(m).value).toBe("B's own explanation, typed while A's check was running.");
    expect(p.selected).toEqual(selectedBefore);                                 // no navigation off B
    expect(notice(m).getAttribute("data-finding-key")).not.toBe("A01:2100");   // never presented as B's result
    expect(notice(m).getAttribute("data-run-id")).toBe("r2");
    expect(notice(m).textContent).toMatch(/no longer raises “Balance on the unexpected side” for account 1510/);
  });
});

describe("B. a decision started on finding A finishes after B was opened and new text typed", () => {
  it("B's new text and evidence survive; the recorded notice names A, not B; nothing is sent for B", async () => {
    const s = server({ r1: [row("r1", "1510"), row("r1", "2100", { required_resolution: "evidence" })] }, "r1");
    const g = gate<{ outcome: string; status?: FindingStatus }>(); s.defer.act = g;
    const p = props(s);
    m = mount(render(p)); await flush();
    open(m, "1510"); await flush();
    typeInto(textarea(m), "A's explanation.");
    click(button(m, "Record explanation")); await flush();    // decision on A pending
    open(m, "2100"); await flush();
    typeInto(textarea(m), "B's explanation, typed meanwhile.");
    typeInto(m.container.querySelector("input")!, "WP-7 v2");
    await act(async () => { g.resolve({ outcome: "recorded", status: "explained" }); }); await flush();
    expect(textarea(m).value).toBe("B's explanation, typed meanwhile.");
    expect((m.container.querySelector("input") as HTMLInputElement).value).toBe("WP-7 v2");
    expect(q(m, "finding-detail")!.textContent).toContain("Account 2100");
    expect(notice(m).getAttribute("data-finding-key")).toBe("A01:1510");
    expect(notice(m).textContent).toMatch(/recorded for “Balance on the unexpected side” for account 1510/);
    expect(s.calls.act).toHaveLength(1);
    expect(s.calls.act[0]).toMatchObject({ findingId: "r1:1510", text: "A's explanation." });
    // The list refresh after A's decision shows A as Explained in the table, read from the server.
    expect(q(m, "finding-A01:1510")!.textContent).toContain("Explained");
  });
  it("an unknown outcome keeps A's request id: the same text sent again for A reuses it, after a detour through B", async () => {
    const s = server({ r1: [row("r1", "1510"), row("r1", "2100")] }, "r1");
    const g = gate<{ outcome: string; status?: FindingStatus }>(); s.defer.act = g;
    const p = props(s);
    m = mount(render(p)); await flush();
    open(m, "1510"); await flush();
    typeInto(textarea(m), "A's explanation.");
    click(button(m, "Record explanation")); await flush();
    await act(async () => { g.reject(new TypeError("Failed to fetch")); }); await flush();   // answer lost
    expect(notice(m).textContent).toMatch(/Could not confirm the decision/);
    expect(textarea(m).value).toBe("A's explanation.");                           // kept
    open(m, "2100"); await flush();
    open(m, "1510"); await flush();
    typeInto(textarea(m), "A's explanation.");
    click(button(m, "Record explanation")); await flush();
    expect(s.calls.act).toHaveLength(2);
    expect(s.calls.act[1].requestId).toBe(s.calls.act[0].requestId);
  });
});

describe("C. the workspace, year or signed-in actor changes while a refresh or decision is pending", () => {
  it("a refresh finishing for the old workspace neither touches the new workspace's selection nor navigates it nor reads for it", async () => {
    const s1 = server({ r1: [row("r1", "1510"), row("r1", "2100")], r2: [row("r2", "2100")] }, "r1");
    const s2 = server({ x1: [row("x1", "7000")] }, "x1");
    const g = gate<void>(); s1.defer.refresh = g;
    const p1 = props(s1);
    m = mount(render(p1)); await flush();
    open(m, "1510"); await flush();
    click(button(m, "Check again")); await flush();                           // refresh pending in workspace 1
    const p2 = props(s2, { companyId: C2 });
    m.rerender(render(p2)); await flush();                                    // the person is now in workspace 2
    open(m, "7000"); await flush();
    typeInto(textarea(m), "Workspace 2 text.");
    const reads1 = s1.calls.summary, reads2 = s2.calls.summary;
    await act(async () => { g.resolve(); }); await flush();  // workspace 1's refresh finishes late
    expect(q(m, "finding-detail")!.textContent).toContain("Account 7000");
    expect(textarea(m).value).toBe("Workspace 2 text.");
    expect(p2.selected).toEqual(["A01:7000"]);                                // not navigated off
    expect(notice(m).textContent).toBe("");                                   // no stale notice from workspace 1
    expect(s2.calls.summary).toBe(reads2);                                    // no follow-up read against workspace 2
    expect(s1.calls.summary).toBe(reads1);                                    // and none for the workspace that is gone
  });
  it("another actor signing in on the same page gets a clean view: a pending decision of the earlier actor touches nothing", async () => {
    const s = server({ r1: [row("r1", "1510")] }, "r1");
    const g = gate<{ outcome: string; status?: FindingStatus }>(); s.defer.act = g;
    const p = props(s);
    m = mount(render(p)); await flush();
    open(m, "1510"); await flush();
    typeInto(textarea(m), "User A's explanation.");
    click(button(m, "Record explanation")); await flush();
    const p2 = props(s, { currentUserId: "user-b" });
    m.rerender(render(p2)); await flush();
    expect(q(m, "finding-detail")).toBeNull();                                // clean start for the new actor
    await act(async () => { g.resolve({ outcome: "recorded", status: "explained" }); }); await flush();
    expect(q(m, "finding-detail")).toBeNull();
    expect(notice(m).textContent).toBe("");
    expect(p2.selected).toEqual([]);
  });
});

describe("D. a newer read finishes before an older one", () => {
  it("the older read's result is discarded: the page shows the newer run, not the older one", async () => {
    const s = server({ r1: [row("r1", "1510")], r2: [row("r2", "2100")] }, "r1");
    const p = props(s);
    m = mount(render(p)); await flush();
    expect(q(m, "finding-A01:1510")).not.toBeNull();
    // An older read is held at its summary; a newer read (Try again after moving to r2) completes first.
    const held = gate<void>(); s.defer.summary = held;
    m.rerender(render(props(s, { client: { ...s.client } as never }))); await flush();   // a new client identity starts a read (held)
    await act(async () => { await s.client.refresh(C1, 2025); });                           // the server moves to r2 meanwhile
    m.rerender(render(props(s, { client: { ...s.client } as never }))); await flush();   // the newer read completes
    expect(q(m, "finding-A01:2100")).not.toBeNull();
    await act(async () => { held.resolve(); }); await flush();                            // the older read finishes late
    expect(q(m, "finding-A01:2100")).not.toBeNull();
    expect(q(m, "finding-A01:1510")).toBeNull();
  });
});
