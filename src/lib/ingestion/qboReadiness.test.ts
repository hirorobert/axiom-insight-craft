// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { alignQboFiscalBasis, readFiscalPreferences } from "../../../supabase/functions/_shared/qboFiscalBasis";
import { boundedQboRead } from "../../../supabase/functions/_shared/qboBoundedRead";
import { classifyQboRequest, createGuardedQboFetch, qboPreferencesUrl, QBO_REVOKE_URL } from "../../../supabase/functions/_shared/qboReadOnlyGuard";
import { parseDisconnectRequest, runQboDisconnect, type DisconnectDeps } from "../../../supabase/functions/_shared/qboDisconnect";
import { readQboEnv } from "../../../supabase/functions/_shared/qboEnv";
const ID = "11111111-1111-1111-1111-111111111111", RID = "22222222-2222-2222-2222-222222222222";
const prefs = (month: string) => ({ Preferences: { AccountingInfoPrefs: { FirstMonthOfFiscalYear: month }, ReportPrefs: { ReportBasis: "Accrual" }, CurrencyPrefs: { HomeCurrency: { value: "USD" } } } });
const period = (start: string, end: string) => ({ id: ID, companyId: ID, year: Number(end.slice(0, 4)), start, end, currency: "USD" });
describe("verified fiscal YTD, never client range remeasurement", () => {
  it.each([
    ["January", "2026-01-01", "2026-12-31"], ["July", "2025-07-01", "2026-06-30"],
    ["March", "2023-03-01", "2024-02-29"], ["March", "2024-03-01", "2025-02-28"],
    ["July", "2025-07-01", "2025-07-01"], ["January", "2025-01-01", "2025-12-31"],
  ])("accepts fiscal aligned as-of/comparative dates %s %s %s", (m, start, end) => {
    expect(alignQboFiscalBasis(period(start, end), prefs(m), "a".repeat(64))).toMatchObject({ ok: true, basis: { fiscalStart: start, asOf: end } });
  });
  it.each([
    ["July", "2026-01-01", "2026-06-30"], // shortened first year not YTD
    ["January", "2025-01-01", "2026-06-30"], // extended, fiscal reset
    ["March", "2024-02-30", "2024-03-01"], ["July", "2025-07-01", "2026-07-01"],
  ])("refuses short/extended/invalid/reset range %s %s %s", (m, start, end) => {
    expect(alignQboFiscalBasis(period(start, end), prefs(m), "a".repeat(64))).toMatchObject({ ok: false, outcome: "fiscal_period_mismatch" });
  });
  it("never guesses a fiscal month, currency or accounting method", () => {
    for (const payload of [{}, prefs("13"), { Preferences: { AccountingInfoPrefs: { FirstMonthOfFiscalYear: "January" } } }]) expect(readFiscalPreferences(payload)).toBeNull();
    expect(alignQboFiscalBasis({ ...period("2026-01-01", "2026-12-31"), currency: "TZS" }, prefs("January"), "a".repeat(64))).toMatchObject({ outcome: "currency_mismatch" });
  });
});
describe("outbound writes cannot leave the guard", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses %s on every Accounting read", async method => {
    const network = vi.fn(async () => new Response("{}")); const send = createGuardedQboFetch(network);
    for (const path of ["preferences", "account", "reports/TrialBalance", "batch", "journalentry"]) {
      await expect(send({ method, url: `https://sandbox-quickbooks.api.intuit.com/v3/company/123/${path}` })).rejects.toThrow();
    }
    expect(network).not.toHaveBeenCalled();
  });
  it("permits exact Preferences GET and separate fixed revocation POST, never redirect lookalikes", () => {
    expect(classifyQboRequest({ method: "GET", url: qboPreferencesUrl("sandbox", "123", 75) })).toMatchObject({ ok: true, kind: "preferences", environment: "sandbox" });
    expect(classifyQboRequest({ method: "POST", url: QBO_REVOKE_URL })).toMatchObject({ ok: true, kind: "revoke" });
    for (const suffix of ["?realmId=123", "/", "#x"]) expect(classifyQboRequest({ method: "POST", url: QBO_REVOKE_URL + suffix }).ok).toBe(false);
  });
  it("bounded GET retry is at most two; quota never retries; POST never runs", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 503 })); const pause = vi.fn(async () => {});
    expect((await boundedQboRead(f, { method: "GET", url: "fixture" }, pause)).status).toBe(503); expect(f).toHaveBeenCalledTimes(2);
    const quota = vi.fn(async () => new Response("{}", { status: 429 }));
    expect((await boundedQboRead(quota, { method: "GET", url: "fixture" }, pause)).status).toBe(429); expect(quota).toHaveBeenCalledTimes(1);
    await expect(boundedQboRead(f, { method: "POST", url: "fixture" })).rejects.toThrow("read_only_required"); expect(f).toHaveBeenCalledTimes(2);
  });
  it("the guarded body is size bounded, including OAuth responses", async () => {
    const send = createGuardedQboFetch(async () => new Response("x".repeat(5_000_001)));
    expect((await send({ method: "POST", url: QBO_REVOKE_URL })).status).toBe(413);
  });
  it("a slow response body is aborted within the request deadline", async () => {
    vi.useFakeTimers();
    try {
      const send = createGuardedQboFetch(async (_url, init) => new Response(new ReadableStream({
        start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("timed out"))); }
      })), { report: 10, token: 10, preferences: 10, revoke: 10 });
      const result = send({ method: "POST", url: QBO_REVOKE_URL }).catch(() => "timed out");
      await vi.advanceTimersByTimeAsync(11);
      expect(await result).toBe("timed out");
    } finally { vi.useRealTimers(); }
  });
  it("never truncates an oversized response into accepted data", async () => {
    const f = async () => new Response("x".repeat(5_000_001));
    expect(await boundedQboRead(f, { method: "GET", url: "fixture" })).toEqual({ status: 413, text: "" });
  });
});
describe("authenticated disconnect and lost-response recovery", () => {
  const world = (over: Partial<DisconnectDeps> = {}) => {
    const d: DisconnectDeps = { authenticate: async () => ID, begin: vi.fn(async () => ({ outcome: "pending", envelope: "fixture-envelope", companyId: ID, realmId: "123", environment: "sandbox" })), open: vi.fn(async () => "FAKE-not-a-token"), revoke: vi.fn(async () => true), finish: vi.fn(async () => true), ...over };
    return d;
  };
  const request = { connectionId: ID, requestId: RID };
  it("forged realm/actor or absent login cannot reach revocation", async () => {
    expect(parseDisconnectRequest({ ...request, realmId: "123" })).toBeNull();
    const d = world({ authenticate: async () => null }); expect(await runQboDisconnect(d, request)).toEqual({ status: 401, outcome: "unauthenticated" }); expect(d.begin).not.toHaveBeenCalled();
    const forbidden = world({ begin: vi.fn(async () => ({ outcome: "forbidden" })) });
    expect((await runQboDisconnect(forbidden, request)).status).toBe(403); expect(forbidden.revoke).not.toHaveBeenCalled();
  });
  it("in-flight import prevents revoke, completed replay sends no second revoke", async () => {
    for (const outcome of ["busy", "request_conflict", "revoked", "local_only"]) {
      const d = world({ begin: vi.fn(async () => ({ outcome })) }); await runQboDisconnect(d, request); expect(d.revoke).not.toHaveBeenCalled();
    }
  });
  it("upstream timeout or failed final receipt stays pending, never false disconnected", async () => {
    for (const d of [world({ revoke: async () => false }), world({ revoke: async () => { throw new Error("lost response FAKE-not-a-token"); } }), world({ finish: async () => false })]) {
      expect(await runQboDisconnect(d, request)).toEqual({ status: 202, outcome: "revocation_pending" });
    }
    const d = world(); expect(await runQboDisconnect(d, request)).toEqual({ status: 200, outcome: "disconnected" }); expect(d.begin).toHaveBeenCalledWith(ID, ID, RID);
  });
  it("production cannot borrow sandbox credentials or activate solely from client input", () => {
    const values: Record<string,string> = { QBO_CLIENT_ID_SANDBOX: "sandbox", QBO_CLIENT_SECRET_SANDBOX: "fixture", QBO_CLIENT_ID_PRODUCTION: "production", QBO_CLIENT_SECRET_PRODUCTION: "other" };
    expect(readQboEnv(n => values[n]).credentials("production")).toBeNull();
    values.QBO_PRODUCTION_APPROVED = "true"; values.QBO_CLIENT_ID_PRODUCTION = "sandbox";
    expect(readQboEnv(n => values[n]).credentials("production")).toBeNull();
  });
});