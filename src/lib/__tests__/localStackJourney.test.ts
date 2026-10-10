/**
 * The real-application journey on a local Supabase stack (scripts/e2e/localStackJourney.mjs, CI job real-app-e2e): its
 * guards refuse anything but loopback and any production reference; its fixtures are a balanced, non-calendar, distinct-
 * code company whose evidence is dated inside its July–June periods; and the CI job starts the stack locally, never
 * linking, pushing, deploying or reading a secret.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertLocalStack, verifyLocalBundle, TB, CURRENT, PRIOR, PERIODS, EVIDENCE, CODES, ASSIGN, reviewDecisions } from "../../../scripts/e2e/localStackFixtures.mjs";
import { PRODUCTION_PROJECT_REF } from "../../../scripts/ci/stagingGuard.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const cents = (s: string) => (s ? Math.round(Number(s) * 100) : 0);

describe("the local-stack guard", () => {
  const ok = { apiUrl: "http://127.0.0.1:54321", anonKey: "a".repeat(40), serviceRoleKey: "s".repeat(40) };
  it("accepts only a loopback API with keys present", () => {
    expect(assertLocalStack(ok)).toEqual({ origin: "http://127.0.0.1:54321" });
    expect(() => assertLocalStack({ ...ok, apiUrl: "https://example.supabase.co" })).toThrow(/loopback/);
    expect(() => assertLocalStack({ ...ok, serviceRoleKey: "" })).toThrow(/missing/);
    expect(() => assertLocalStack({ ...ok, anonKey: `x${PRODUCTION_PROJECT_REF}x` })).toThrow(/production/);
  });
  it("a bundle that names production, or not the local API, is refused", () => {
    expect(verifyLocalBundle(["fetch('http://127.0.0.1:54321')"], "http://127.0.0.1:54321")).toEqual([]);
    expect(verifyLocalBundle([`https://${PRODUCTION_PROJECT_REF}.supabase.co`, "http://127.0.0.1:54321"], "http://127.0.0.1:54321")).toContain("PRODUCTION_REF_IN_BUNDLE");
    expect(verifyLocalBundle(["nothing"], "http://127.0.0.1:54321")).toContain("LOCAL_API_NOT_IN_BUNDLE");
  });
});

describe("the journey's company", () => {
  it("both trial balances balance; account codes are distinct, non-round, and none is a demo code", () => {
    for (const col of [CURRENT, PRIOR]) {
      const dr = TB.reduce((n, r) => n + cents(r[col]), 0), cr = TB.reduce((n, r) => n + cents(r[col + 1]), 0);
      expect(dr, `column ${col}`).toBe(cr);
    }
    const codes = TB.map((r) => r[0]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) { expect(c).not.toMatch(/^(\d)0+$/); expect(c).not.toBe("91000"); expect(c).not.toBe("1000"); }
    expect(Object.keys(ASSIGN).sort()).toEqual([...codes].sort());
    expect(reviewDecisions().filter((d) => d.is_cash_account).map((d) => d.account_code)).toEqual([CODES.bank]);
  });
  it("its periods run July to June, and every evidence transaction is dated inside its own period", () => {
    expect(PERIODS.current).toEqual({ year: 2026, start: "2025-07-01", end: "2026-06-30" });
    expect(PERIODS.prior).toEqual({ year: 2025, start: "2024-07-01", end: "2025-06-30" });
    for (const [which, p] of [["current", PERIODS.current], ["prior", PERIODS.prior]] as const) {
      const dates = EVIDENCE[which].TRANSACTION_LEDGER.trim().split("\n").slice(1).map((l: string) => l.split(",")[1]);
      expect(dates.length).toBeGreaterThan(0);
      for (const d of dates) { expect(d >= p.start && d <= p.end, `${which} ${d}`).toBe(true); }
    }
  });
});

describe("the CI job", () => {
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const start = wf.indexOf("\n  real-app-e2e:");
  const next = wf.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  const job = next < 0 ? wf.slice(start) : wf.slice(start, start + 1 + next);
  it("starts the stack locally and runs the real-application journey; no link, push, deploy, login or secret", () => {
    expect(start).toBeGreaterThan(-1);
    expect(job).toMatch(/run: supabase start/);
    expect(job).toMatch(/node scripts\/e2e\/localStackJourney\.mjs real-app-evidence/);
    expect(job).toMatch(/supabase stop/);
    expect(job).not.toMatch(/secrets\.|environment:|vars\.|supabase\s+(link|login|db\s+push|functions\s+deploy)/);
  });
});
