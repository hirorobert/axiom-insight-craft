// @vitest-environment jsdom
/**
 * Engagements portfolio, browser side: the server's page read strictly (portfolioClient), and the list's behaviour —
 * the query it sends, keyset paging forwards and back, the exact count line, the refresh notice when the view token
 * moves between pages, refusals and failures in words, one action per row, and no accessibility violations.
 * Invented data only.
 */
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { EngagementPortfolio } from "@/components/workspace/EngagementPortfolio";
import { fetchPortfolioPage, portfolioDestination, PORTFOLIO_STATUSES, PORTFOLIO_STATUS_VIEW, type PortfolioQuery } from "@/lib/workspace/portfolioClient";

type Rpc = Parameters<typeof fetchPortfolioPage>[0];
type Args = Record<string, unknown>;
const C = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, status = "ready", extra: Args = {}) => ({
  engagement_id: C(1000 + n), company_id: C(n), company_name: `Invented Entity ${n}`, company_code: null, company_tin: null,
  period_year: 2025, period_start: "2025-01-01", period_end: "2025-12-31", currency: "TZS", purpose: "client", status,
  upload: null, cursor: { name: `invented entity ${n}`, year: 2025, id: C(1000 + n) }, ...extra,
});
const page = (rows: unknown[], next: unknown, token = "t1", total = 30) => ({
  data: { outcome: "ok", rows, has_more: next !== null, next_cursor: next, total, status_counts: { ready: total }, view_token: token, limit: 25, sort: "entity" },
  error: null,
});
const Q: PortfolioQuery = { search: "", statuses: [], purposes: [], periodYear: null, sort: "entity" };

describe("portfolioClient", () => {
  it("sends the query as the server's parameters (blank search and empty filters as null)", async () => {
    const rpc = vi.fn(async (_f: string, _a: Args) => page([], null, "t", 0));
    await fetchPortfolioPage(rpc, { ...Q, search: "  ", statuses: ["blocked"], periodYear: 2024, sort: "period" }, { id: "x" }, 10);
    expect(rpc).toHaveBeenCalledWith("list_portfolio_engagements", {
      p_search: null, p_statuses: ["blocked"], p_purposes: null, p_period_year: 2024, p_sort: "period", p_limit: 10, p_cursor: { id: "x" },
    });
  });
  it("reads a page strictly: rows, total, counts, next cursor and the view token", async () => {
    const upload = { file_name: "tb.xlsx", uploaded_at: "2026-01-02T00:00:00Z", uploaded_by: null };
    const r = await fetchPortfolioPage(async () => page([row(1, "blocked", { upload })], { id: "n" }), Q, null);
    expect(r).toMatchObject({
      kind: "ok", total: 30, nextCursor: { id: "n" }, viewToken: "t1", statusCounts: { ready: 30 },
      rows: [{ companyName: "Invented Entity 1", status: "blocked", upload: { fileName: "tb.xlsx", uploadedBy: null } }],
    });
  });
  it("a refusal is named; a malformed row, a missing token or a transport error is unavailable (never a partial list)", async () => {
    expect(await fetchPortfolioPage(async () => ({ data: { outcome: "refused", code: "INVALID_CURSOR" }, error: null }), Q, null))
      .toEqual({ kind: "refused", code: "INVALID_CURSOR" });
    expect(await fetchPortfolioPage(async () => page([row(1, "unknown_status")], null), Q, null)).toEqual({ kind: "unavailable" });
    expect(await fetchPortfolioPage(async () => page([row(1)], null, ""), Q, null)).toEqual({ kind: "unavailable" });
    expect(await fetchPortfolioPage(async () => ({ data: null, error: { message: "down" } }), Q, null)).toEqual({ kind: "unavailable" });
  });
  it("every status has words and one action; accepted opens the engagement, everything else the trial balance", () => {
    for (const s of PORTFOLIO_STATUSES) expect(PORTFOLIO_STATUS_VIEW[s].label.length).toBeGreaterThan(0);
    const r = { companyId: C(1), periodYear: 2025 } as Parameters<typeof portfolioDestination>[0];
    expect(portfolioDestination({ ...r, status: "ready" })).toBe(`/workspace/${C(1)}/2025`);
    expect(portfolioDestination({ ...r, status: "needs_decision" })).toBe(`/workspace/${C(1)}/2025/trial-balance/review`);
  });
});

describe("EngagementPortfolio", () => {
  let m: Mounted | null = null;
  afterEach(() => { m?.unmount(); m = null; vi.useRealTimers(); });
  const flush = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
  const render = async (rpc: Rpc) => {
    m = mount(createElement(MemoryRouter, null, createElement(EngagementPortfolio, { rpc, readFrameworks: async () => ({}) })));
    await flush();
    return m.container;
  };
  const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid=${id}]`);
  const first25 = Array.from({ length: 25 }, (_, i) => row(i + 1));
  const last5 = Array.from({ length: 5 }, (_, i) => row(i + 26));

  it("company directory opens the selected company AND period without replaying an action or merging years", async () => {
    const rpc = vi.fn(async () => page([row(1), row(2, "no_trial_balance", { company_id: C(1), company_name: "Invented Entity 1", period_year: 2026 })], null, "t1", 2));
    m = mount(createElement(MemoryRouter, null, createElement(EngagementPortfolio, { companyFirst: true, rpc, readFrameworks: async () => ({}) })));
    await flush();
    const links = [...m.container.querySelectorAll('a')].map(a => a.getAttribute("href"));
    expect(links).toContain(`/workspace/${C(1)}/2025?view=company`);
    expect(links).toContain(`/workspace/${C(1)}/2026?view=company`);
    expect(links.every(h => !h?.includes("trial-balance/review"))).toBe(true);
    expect(m.container.textContent).toContain("Draft");
    expect(m.container.textContent).toContain("Open workspace");
    expect(rpc.mock.calls).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith("list_portfolio_engagements", expect.objectContaining({ p_sort: "opened" }));
  });

  it("pages forwards and back by the server's cursor, with the exact count line", async () => {
    const rpc = vi.fn(async (_f: string, a: Args) => (a.p_cursor ? page(last5, null) : page(first25, { id: "c25" })));
    const el = await render(rpc);
    expect(q(el, "portfolio-count")!.textContent).toBe("Showing 1–25 of 30 engagements");
    click(q(el, "portfolio-next")!); await flush();
    expect(rpc).toHaveBeenLastCalledWith("list_portfolio_engagements", expect.objectContaining({ p_cursor: { id: "c25" } }));
    expect(q(el, "portfolio-count")!.textContent).toBe("Showing 26–30 of 30 engagements");
    expect((q(el, "portfolio-next") as HTMLButtonElement).disabled).toBe(true);
    click(q(el, "portfolio-previous")!); await flush();
    expect(rpc).toHaveBeenLastCalledWith("list_portfolio_engagements", expect.objectContaining({ p_cursor: null }));
    expect(q(el, "portfolio-count")!.textContent).toBe("Showing 1–25 of 30 engagements");
  });
  it("a moved view token between pages asks for a refresh instead of mixing two moments", async () => {
    const rpc = vi.fn(async (_f: string, a: Args) => (a.p_cursor ? page(last5, null, "t2") : page(first25, { id: "c25" }, "t1")));
    const el = await render(rpc);
    click(q(el, "portfolio-next")!); await flush();
    expect(q(el, "portfolio-changed")).not.toBeNull();
    expect(q(el, "portfolio-table")).toBeNull();
    click(q(el, "portfolio-refresh")!); await flush();
    expect(q(el, "portfolio-count")!.textContent).toBe("Showing 1–25 of 30 engagements");
  });
  it("search is sent after a pause in typing, once", async () => {
    vi.useFakeTimers();
    const rpc = vi.fn(async (_f: string, _a: Args) => page([row(1)], null, "t", 1));
    const el = await render(rpc);
    typeInto(q(el, "portfolio-search") as HTMLInputElement, "Inv");
    typeInto(q(el, "portfolio-search") as HTMLInputElement, "Invented");
    await act(async () => { vi.advanceTimersByTime(350); });
    await flush();
    expect(rpc.mock.calls.map((c) => c[1].p_search)).toEqual([null, "Invented"]);
    expect(q(el, "portfolio-count")!.textContent).toBe("Showing 1–1 of 1 engagement");
  });
  it("refusals and failures are said in words; an empty answer says nothing matches", async () => {
    let el = await render(async () => ({ data: { outcome: "refused", code: "INVALID_FILTER" }, error: null }));
    expect(q(el, "portfolio-error")!.textContent).toContain("could not be applied");
    m!.unmount(); m = null;
    el = await render(async () => ({ data: null, error: { message: "x" } }));
    expect(q(el, "portfolio-error")!.textContent).toContain("could not be loaded");
    m!.unmount(); m = null;
    el = await render(async () => page([], null, "t", 0));
    expect(q(el, "portfolio-count")!.textContent).toBe("No engagements match.");
  });
  it("an engagement whose every service is withheld says so and offers no action it cannot complete", async () => {
    const el = await render(async () => page([row(3, "ready", { services: ["TAX_COMPUTATION"] }), row(4, "ready", { services: ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"] })], null, "t", 2));
    const withheld = q(el, `portfolio-row-${C(1003)}`)!, open = q(el, `portfolio-row-${C(1004)}`)!;
    expect(withheld.textContent).toContain("Service no longer offered");
    expect(withheld.querySelectorAll("a").length).toBe(0);
    expect(open.querySelectorAll("a").length).toBe(1);
  });
  it("each row has its status in words and exactly one action, named for the entity and period", async () => {
    const el = await render(async () => page([row(1, "needs_decision"), row(2, "ready")], null, "t", 2));
    const r1 = q(el, `portfolio-row-${C(1001)}`)!;
    expect(r1.querySelector("[data-testid=portfolio-status]")!.textContent).toBe("Needs your decision");
    expect(r1.querySelectorAll("a").length).toBe(1);
    expect(r1.querySelector("a")!.getAttribute("href")).toBe(`/workspace/${C(1)}/2025/trial-balance/review`);
    expect(r1.querySelector("a")!.textContent).toBe("Make decisions — Invented Entity 1, FY2025");
    expect(await axeViolations(el)).toEqual([]);
  });
  it("keeps optional controls collapsed and hides pagination for a single page", async () => {
    const el = await render(async () => page([row(1)], null, "t", 1));
    expect(q(el, "portfolio-next")).toBeNull();
    expect(q(el, "portfolio-sort")).toBeNull();
    expect([...el.querySelectorAll("th")].map((cell) => cell.textContent)).not.toContain("Framework");
    const filters = [...el.querySelectorAll("button")].find((button) => button.textContent === "Filters")!;
    click(filters); await flush();
    expect(filters.getAttribute("aria-expanded")).toBe("true");
    expect(q(el, "portfolio-sort")).not.toBeNull();
  });
  it("Needs attention filters the entire server portfolio and a second click restores all work", async () => {
    const rpc = vi.fn(async (_f: string, _a: Args) => page([row(1, "blocked")], null, "t", 1));
    const el = await render(rpc);
    click(q(el, "portfolio-attention")!); await flush();
    expect(rpc).toHaveBeenLastCalledWith("list_portfolio_engagements", expect.objectContaining({ p_statuses: ["needs_decision", "blocked", "processing_failed", "needs_recheck"], p_cursor: null }));
    expect(q(el, "portfolio-attention")!.getAttribute("aria-pressed")).toBe("true");
    click(q(el, "portfolio-attention")!); await flush();
    expect(rpc).toHaveBeenLastCalledWith("list_portfolio_engagements", expect.objectContaining({ p_statuses: null, p_cursor: null }));
  });
  it("labels trial balance acceptance precisely and identifies training work without an optional column", async () => {
    const el = await render(async () => page([row(1, "ready", { purpose: "training" })], null, "t", 1));
    const record = q(el, `portfolio-row-${C(1001)}`)!;
    expect(record.querySelector("[data-testid=portfolio-status]")!.textContent).toBe("Trial balance accepted");
    expect(record.textContent).toContain("Training");
    expect(q(el, "portfolio-cards")!.textContent).toContain("Training");
  });

});
