import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), in: vi.fn(), limit: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: db }));
import { readPortfolioFrameworks } from "./portfolioFrameworks";
beforeEach(() => { vi.clearAllMocks(); db.from.mockReturnValue(db); db.select.mockReturnValue(db); db.in.mockReturnValue(db); db.limit.mockResolvedValue({ data: [], error: null }); });
describe("portfolio framework metadata", () => {
  it("reads only the unique visible page IDs, bounded at 25, and does not accept unrequested rows", async () => {
    db.limit.mockResolvedValue({ data: [{ id: "c0", reporting_framework: "ipsas_accrual" }, { id: "foreign", reporting_framework: "full_ifrs" }], error: null });
    const result = await readPortfolioFrameworks(["c0", "c0", ...Array.from({ length: 30 }, (_, i) => `c${i}`)]);
    expect(db.from).toHaveBeenCalledWith("companies");
    expect(db.select).toHaveBeenCalledWith("id, reporting_framework");
    expect(db.in).toHaveBeenCalledWith("id", Array.from({ length: 25 }, (_, i) => `c${i}`));
    expect(db.limit).toHaveBeenCalledWith(25);
    expect(result).toEqual({ c0: "ipsas_accrual" });
  });
  it("an empty page sends no read; a refused read invents no framework", async () => {
    expect(await readPortfolioFrameworks([])).toEqual({});
    expect(db.from).not.toHaveBeenCalled();
    db.limit.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect(await readPortfolioFrameworks(["c0"])).toEqual({});
  });
});
