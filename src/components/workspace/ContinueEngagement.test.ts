// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { mount, click, type Mounted } from "@/lib/workbench/testkit/dom";
import { ContinueEngagement } from "./ContinueEngagement";
import { readContinueEngagement } from "@/lib/workspace/continueEngagement";
import type { PortfolioRow } from "@/lib/workspace/portfolioClient";
let ui: Mounted | undefined;
afterEach(() => { ui?.unmount(); ui = undefined; });
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
const row = (status: PortfolioRow["status"]): PortfolioRow => ({ engagementId: "e1", companyId: "c1", companyName: "Invented workshop", companyCode: null, companyTin: null, periodYear: 2025, periodStart: "2025-01-01", periodEnd: "2025-12-31", currency: "TZS", purpose: "client", status, upload: null, services: ["FINANCIAL_STATEMENTS"], serviceWithheld: false });
it("shows no guessed progress before the server response, then links to the current corrective action", async () => {
  let resolve!: (r: Awaited<ReturnType<typeof readContinueEngagement>>) => void;
  const read = () => new Promise<Awaited<ReturnType<typeof readContinueEngagement>>>((r) => { resolve = r; });
  ui = mount(h(MemoryRouter, null, h(ContinueEngagement, { read })));
  expect(ui.container.textContent).toContain("Checking saved progress"); expect(ui.container.querySelector("a")).toBeNull();
  await act(async () => resolve({ kind: "ok", row: row("blocked") })); await flush();
  expect(ui.container.querySelector('[data-testid="continue-status"]')?.textContent).toBe("Blocked");
  expect(ui.container.querySelector("a")?.getAttribute("href")).toBe("/workspace/c1/2025/trial-balance/review");
  expect(ui.container.querySelector("a")?.textContent).toBe("Fix trial balance");
});
it("an unavailable progress read offers retry; it does not invent an empty/accepted engagement", async () => {
  const read = vi.fn().mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce({ kind: "ok", row: row("ready") });
  ui = mount(h(MemoryRouter, null, h(ContinueEngagement, { read }))); await flush();
  expect(ui.container.querySelector("a")).toBeNull(); click(ui.container.querySelector("button")!); await flush();
  expect(read).toHaveBeenCalledTimes(2); expect(ui.container.textContent).toContain("Trial balance accepted");
  expect(ui.container.querySelector("a")?.getAttribute("href")).toBe("/workspace/c1/2025");
});
it("uses server-wide opened ordering, never the displayed table's filters or browser visit flags", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { outcome: "ok", total: 1, rows: [{ engagement_id: "e1", company_id: "c1", company_name: "Invented workshop", period_year: 2025, purpose: "client", status: "no_trial_balance", upload: null, services: ["FINANCIAL_STATEMENTS"] }], view_token: "v", status_counts: {}, next_cursor: null }, error: null });
  const answer = await readContinueEngagement(rpc);
  expect(answer.kind).toBe("ok"); expect(rpc.mock.calls[0][1]).toMatchObject({ p_sort: "opened", p_search: null, p_statuses: null, p_cursor: null });
});
