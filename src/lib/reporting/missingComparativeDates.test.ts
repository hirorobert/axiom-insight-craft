// The PRODUCT client reads the authoritative reporting input of a first period: its comparative is `{ state: "missing", periodYear }` with no dates.
// (Before the compiler follow-up the schema required both dates, so a first-period report could not be prepared in the browser at all; the first-period
// proofs of #256 therefore wrapped the harness transport. This test and the proof run with FIRST_PERIOD_PRODUCT_CLIENT=1 show the wrapper is no longer needed.)
import { describe, expect, it } from "vitest";
import { signoffClient, type ReportingDb } from "./signoff";

const db = (answer: unknown): ReportingDb => ({
  rpc: async () => ({ data: answer, error: null }),
  select: async () => ({ data: [], error: null }),
  invoke: async () => ({ data: null, error: { message: "n/a" } }),
}) as unknown as ReportingDb;

describe("the reporting input of a first period", () => {
  it("reads a missing comparative that carries no dates", async () => {
    const r = await signoffClient(db({ state: "ready", current: { reportingStart: "2026-01-01", reportingEnd: "2026-12-31" }, comparative: { state: "missing", periodYear: 2025 } })).input("c", 2026);
    expect((r.comparative as { state: string }).state).toBe("missing");
  });
  it("still reads a present comparative with both dates, and one whose dates are null", async () => {
    const dated = await signoffClient(db({ state: "ready", comparative: { state: "available", reportingStart: "2025-01-01", reportingEnd: "2025-12-31" } })).input("c", 2026);
    expect((dated.comparative as { reportingEnd: string }).reportingEnd).toBe("2025-12-31");
    const nulls = await signoffClient(db({ state: "ready", comparative: { state: "missing", reportingStart: null, reportingEnd: null } })).input("c", 2026);
    expect((nulls.comparative as { state: string }).state).toBe("missing");
  });
  it("still refuses an input without a state", async () => {
    await expect(signoffClient(db({ comparative: { state: "missing" } })).input("c", 2026)).rejects.toThrow();
  });
});
