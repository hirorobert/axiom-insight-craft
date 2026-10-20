/**
 * The account home's routing from EXACT server counts (get_account_home): a truncated sample can never turn an ambiguous
 * account into a single-item redirect, a failed or malformed read never routes, and the next action uses the totals.
 * Invented data only.
 */
import { describe, expect, it } from "vitest";
import { decideAccountHomeRoute, fetchAccountHome, type AccountHome } from "./accountHome";
import { deriveAccountNextAction } from "./accountNextAction";

const E = (n: number) => ({ engagementId: `e${n}`, companyId: `c${n}`, companyName: `Invented ${n}`, periodYear: 2025, openedAt: "2026-01-01T00:00:00Z" });
const C = (n: number) => ({ id: `k${n}`, name: `Invented Co ${n}` }) as never;
const S = (n: number) => ({ id: `s${n}`, name: `Shared ${n}`, capabilities: [], fiscal_year_end: null, reporting_framework: null, currency: null, created_at: null });
const counted = <T,>(rows: T[], total = rows.length) => ({ total, rows, complete: rows.length === total });
const home = (p: Partial<{ e: [unknown[], number]; w: number; c: [unknown[], number]; s: [unknown[], number] }>): AccountHome => ({
  engagements: counted((p.e?.[0] ?? []) as never[], p.e?.[1] ?? p.e?.[0]?.length ?? 0),
  withheld: counted([], p.w ?? 0),
  companiesWithoutEngagement: counted((p.c?.[0] ?? []) as never[], p.c?.[1] ?? p.c?.[0]?.length ?? 0),
  shared: counted((p.s?.[0] ?? []) as never[], p.s?.[1] ?? p.s?.[0]?.length ?? 0),
});

describe("decideAccountHomeRoute", () => {
  it("exactly one engagement resumes it; one company with nothing else opens it; one shared workspace opens it; nothing is first run", () => {
    expect(decideAccountHomeRoute(home({ e: [[E(1)], 1] }))).toMatchObject({ kind: "resume", entry: { engagementId: "e1" } });
    expect(decideAccountHomeRoute(home({ c: [[C(1)], 1] }))).toMatchObject({ kind: "start_single_company" });
    expect(decideAccountHomeRoute(home({ s: [[S(1)], 1] }))).toMatchObject({ kind: "open_shared" });
    expect(decideAccountHomeRoute(home({}))).toEqual({ kind: "first_run" });
  });
  it("a sample of one with a larger TOTAL is a choice, never a redirect (the truncation case)", () => {
    expect(decideAccountHomeRoute(home({ e: [[E(1)], 1201] }))).toEqual({ kind: "chooser" });
    expect(decideAccountHomeRoute(home({ c: [[C(1)], 3] }))).toEqual({ kind: "chooser" });
    expect(decideAccountHomeRoute(home({ s: [[S(1)], 2] }))).toEqual({ kind: "chooser" });
  });
  it("a total of one without its row (never expected) is a choice, not a guess; withheld engagements alone are an account, not a first run", () => {
    expect(decideAccountHomeRoute(home({ e: [[], 1] }))).toEqual({ kind: "chooser" });
    expect(decideAccountHomeRoute(home({ w: 2 }))).toEqual({ kind: "chooser" });
  });
  it("the workspace logo's forced home never re-lands in a workspace", () => {
    expect(decideAccountHomeRoute(home({ e: [[E(1)], 1] }), true)).toEqual({ kind: "chooser" });
  });
});

describe("fetchAccountHome", () => {
  const ok = { outcome: "ok", engagements: { total: 2, rows: [{ engagement_id: "e1", company_id: "c1", company_name: "A", period_year: 2025, opened_at: "t" }] },
    withheld: { total: 0, rows: [] }, companies_without_engagement: { total: 0, rows: [] }, shared: { total: 0, rows: [] } };
  it("reads exact totals and samples, marking completeness; sends the withheld services and the limit", async () => {
    let args: Record<string, unknown> = {};
    const h = await fetchAccountHome(async (_f, a) => { args = a; return { data: ok, error: null }; });
    expect(h?.engagements).toMatchObject({ total: 2, complete: false, rows: [{ engagementId: "e1", periodYear: 2025 }] });
    expect(args.p_limit).toBe(50);
    expect(Array.isArray(args.p_withheld)).toBe(true);
  });
  it("a failed, refused or malformed read is unavailable — never a partial picture", async () => {
    expect(await fetchAccountHome(async () => ({ data: null, error: { message: "x" } }))).toBeNull();
    expect(await fetchAccountHome(async () => ({ data: { outcome: "unauthenticated" }, error: null }))).toBeNull();
    expect(await fetchAccountHome(async () => ({ data: { ...ok, shared: { rows: [] } }, error: null }))).toBeNull();
    expect(await fetchAccountHome(async () => ({ data: { ...ok, engagements: { total: 1, rows: [{ engagement_id: "e1" }] } }, error: null }))).toBeNull();
  });
});

describe("deriveAccountNextAction with exact totals", () => {
  const reads = { billing: { loading: false, error: false, summary: { licenceStatus: "ACTIVE" } as never }, capacity: { loading: false, error: false, answer: null } };
  it("one engagement in the sample but more in total: choose, never resume the first", () => {
    const n = deriveAccountNextAction({ ...reads, entries: [E(1)], unavailable: [], reviewGates: {}, companiesWithoutEngagement: [], sharedCount: 0,
      totals: { entries: 75, unavailable: 0, companiesWithoutEngagement: 0 } });
    expect(n.kind).toBe("choose_engagement");
  });
  it("one company in the sample but more in total: choose a company", () => {
    const n = deriveAccountNextAction({ ...reads, entries: [], unavailable: [], reviewGates: {}, companiesWithoutEngagement: [C(1)], sharedCount: 0,
      totals: { entries: 0, unavailable: 0, companiesWithoutEngagement: 4 } });
    expect(n.kind).toBe("choose_company");
  });
});
