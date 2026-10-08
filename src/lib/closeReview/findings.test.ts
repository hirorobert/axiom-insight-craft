// @vitest-environment jsdom
/**
 * Close Review findings (I2) in the browser: the status/resolution rules mirror the database's; actions are offered by
 * capability and never an accept path for a mandatory finding; zero/missing/negative amounts render distinctly; rules
 * that were not evaluated are listed with their reason; nothing references a withheld tax service.
 */
import { act, createElement as h } from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FindingsView } from "@/components/closeReview/FindingsView";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { RELEASED_WORKBENCH_PAGES } from "@/lib/workbench/routes";
import { findingResolved, findingStatus, offeredActions, type FindingRow, type FindingsClient } from "./findings";
import type { TimelineClient, TimelineEventRow } from "./timeline";

const ev = (seq: number, event_type: string, detail: Record<string, unknown> = {}): TimelineEventRow & { subject_id: string } =>
  ({ id: `e${seq}`, seq, event_type, body: "x", revises_event_id: null, detail, actor_user_id: "u", created_at: "2026-10-08T10:00:00Z", subject_id: "f1" });

describe("status and resolution (mirror of the database)", () => {
  it("the latest lifecycle event decides; comments do not change it; reopen returns to open", () => {
    expect(findingStatus([])).toBe("open");
    expect(findingStatus([ev(1, "finding_explained"), ev(2, "comment")])).toBe("explained");
    expect(findingStatus([ev(1, "finding_explained"), ev(2, "finding_reopened")])).toBe("open");
  });
  it("blocking findings resolve only by their required resolution", () => {
    const evid = { severity: "blocking" as const, required_resolution: "evidence" as const };
    expect(findingResolved(evid, [ev(1, "finding_explained")])).toBe(false);
    expect(findingResolved(evid, [ev(1, "finding_explained", { evidenceRef: "WP v2" })])).toBe(true);
    const review = { severity: "blocking" as const, required_resolution: "review" as const };
    expect(findingResolved(review, [ev(1, "finding_explained")])).toBe(false);
    expect(findingResolved(review, [ev(1, "finding_adjusted")])).toBe(true);
    expect(findingResolved({ severity: "warning", required_resolution: "explanation" }, [ev(1, "finding_accepted")])).toBe(true);
  });
  it("actions offered by capability; a mandatory finding is never offered accept or not-applicable", () => {
    expect(offeredActions({ mandatory: false }, "open", ["prepare_close", "review_close"])).toEqual(["explain", "accept", "not_applicable"]);
    expect(offeredActions({ mandatory: true }, "open", ["prepare_close", "review_close"])).toEqual(["explain"]);
    expect(offeredActions({ mandatory: false }, "open", [])).toEqual([]);
    expect(offeredActions({ mandatory: false }, "explained", ["prepare_close"])).toEqual([]);
    expect(offeredActions({ mandatory: false }, "explained", ["review_close"])).toEqual(["reopen"]);
  });
  it("the page is not released yet, and nothing in Close Review references a withheld tax service", () => {
    expect(RELEASED_WORKBENCH_PAGES.has("close-findings")).toBe(false);
    const root = path.resolve(__dirname, "../../..");
    const files = ["src/lib/closeReview/findings.ts", "src/lib/closeReview/timeline.ts", "src/components/closeReview/FindingsView.tsx",
      "src/components/closeReview/ReviewTimeline.tsx", "src/pages/workspace/CloseFindings.tsx",
      "supabase/migrations/20261013100000_close_review_timeline.sql", "supabase/migrations/20261014100000_close_review_findings.sql"];
    for (const f of files) expect(fs.readFileSync(path.join(root, f), "utf8"), f).not.toMatch(/kinga|generate-disclosure-notes|generate-management-letter/i);
  });
});

const F = (o: Partial<FindingRow> & { id: string; finding_key: string; rule_id: FindingRow["rule_id"] }): FindingRow => ({
  run_id: "run", severity: "warning", mandatory: false, required_resolution: "explanation", account_key: null, account_code: null,
  account_name: null, classification: null, debit_minor: null, credit_minor: null, class_side_minor: null, detail: {}, ...o,
});
const ROWS = [
  F({ id: "f1", finding_key: "A03:1010", rule_id: "A03", severity: "blocking", mandatory: true, required_resolution: "review", account_code: "1010", account_name: "Petty cash", debit_minor: "0", credit_minor: "20000" }),
  F({ id: "f2", finding_key: "T01", rule_id: "T01", severity: "blocking", mandatory: true, required_resolution: "evidence" }),
  F({ id: "f3", finding_key: "A01:1510", rule_id: "A01", account_code: "1510", account_name: "Accumulated depreciation", debit_minor: "0", credit_minor: "200000" }),
];
function fakeClient(over: Partial<Record<keyof FindingsClient, unknown>> = {}) {
  return {
    summary: vi.fn(async () => ({ state: "current", runId: "run", currency: "TZS", exponent: 2, generatedAt: "x", total: 3, unresolved: 3, unresolvedBlocking: 2,
      ruleStatus: { A01: { evaluated: true }, A05: { evaluated: false, reason: "Needs the framework pack's materiality threshold." } } })),
    refresh: vi.fn(async () => ({ outcome: "generated", runId: "run" })),
    list: vi.fn(async () => ROWS),
    events: vi.fn(async () => []),
    act: vi.fn(async () => ({ outcome: "recorded", status: "explained" })),
    ...over,
  } as unknown as FindingsClient & Record<string, ReturnType<typeof vi.fn>>;
}
const timeline: TimelineClient = { read: async () => [], comment: async () => ({ outcome: "recorded" }) };
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const view = (c: FindingsClient, allowed: string[]) => h(FindingsView, { companyId: "co", periodYear: 2025, client: c, timeline, allowed, currentUserId: "u1", reviewHref: "/r", newRequestId: () => "req-1" });
const byText = (re: RegExp) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement;

describe("FindingsView", () => {
  it("lists findings with exact amounts (zero 0.00, never a dash), severity, status; not-evaluated rules with their reason; no axe violations", async () => {
    m = mount(view(fakeClient(), ["prepare_close"]));
    await flush();
    const row = document.querySelector("[data-testid='finding-A03:1010']")!;
    expect(row.textContent).toContain("Cash account in credit");
    expect(row.textContent).toContain("0.00");
    expect(row.textContent).toContain("200.00");
    expect(row.textContent).toContain("Blocking · mandatory");
    expect(document.querySelector("[data-testid='finding-T01']")!.textContent).toContain("—");
    expect(document.querySelector("[data-testid=not-evaluated]")!.textContent).toContain("materiality threshold");
    expect(await axeViolations(m.container)).toEqual([]);
  });
  it("a mandatory finding offers no Accept; the evidence finding asks for the workpaper reference and sends it", async () => {
    const c = fakeClient();
    m = mount(view(c, ["prepare_close", "review_close"]));
    await flush();
    click(document.querySelector("[aria-label='Open Income-tax computation workpaper']")!);
    expect(byText(/^Accept$/)).toBeUndefined();
    typeInto(document.querySelector("[data-testid=finding-detail] textarea")!, "Computed in the workpaper");
    typeInto(document.querySelector("[data-testid=finding-detail] input")!, "Tax WP FY2025 v2");
    click(byText(/Record explanation/)); await flush();
    expect(c.act).toHaveBeenCalledWith("f2", "explain", "Computed in the workpaper", "Tax WP FY2025 v2", "req-1");
  });
  it("a warning offers Accept to a reviewer; a member without capabilities sees no action", async () => {
    m = mount(view(fakeClient(), ["review_close"]));
    await flush();
    click(document.querySelector("[aria-label='Open Balance on the unexpected side for Accumulated depreciation']")!);
    expect(byText(/^Accept$/)).toBeDefined();
    expect(byText(/Record explanation/)).toBeUndefined();
    m.unmount(); m = mount(view(fakeClient(), []));
    await flush();
    click(document.querySelector("[aria-label='Open Balance on the unexpected side for Accumulated depreciation']")!);
    expect(document.body.textContent).toContain("No action available to you on this finding.");
  });
  it("a refusal from the server is shown and nothing is assumed (e.g. the trial balance changed)", async () => {
    const c = fakeClient({ act: vi.fn(async () => ({ outcome: "stale_authority" })) });
    m = mount(view(c, ["prepare_close"]));
    await flush();
    click(byText(/Next open item/));
    typeInto(document.querySelector("[data-testid=finding-detail] textarea")!, "Explained");
    click(byText(/Record explanation/)); await flush();
    expect(document.body.textContent).toContain("The trial balance changed since these findings were generated.");
  });
  it("no reviewed trial balance: says so and links to the review; no findings shown", async () => {
    m = mount(view(fakeClient({ summary: vi.fn(async () => ({ state: "no_authority" })) }), ["prepare_close"]));
    await flush();
    expect(document.body.textContent).toContain("Findings are checked on a reviewed trial balance.");
    expect(document.querySelector("table")).toBeNull();
  });
  it("no current check: one action, Check for findings (only with Prepare)", async () => {
    const c = fakeClient({ summary: vi.fn(async () => ({ state: "not_generated" })) });
    m = mount(view(c, ["prepare_close"]));
    await flush();
    click(byText(/Check for findings/)); await flush();
    expect(c.refresh).toHaveBeenCalledWith("co", 2025);
    m.unmount(); m = mount(view(fakeClient({ summary: vi.fn(async () => ({ state: "not_generated" })) }), []));
    await flush();
    expect(byText(/Check for findings/)).toBeUndefined();
  });
});
