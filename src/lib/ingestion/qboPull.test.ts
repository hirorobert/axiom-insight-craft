// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { parsePullRequest, runQboPull, type PullDeps, type PullRequest, type StoredConnection } from "../../../supabase/functions/_shared/qboPull";
import { sha256Hex, summariseCanonicalCsv } from "../../../supabase/functions/_shared/qboPullSummary";
import { connectionBinding, openSecret, sealSecret, type EnvelopeKey } from "../../../supabase/functions/_shared/qboTokenEnvelope";
import { normalisedAccountingResult } from "../../../supabase/functions/_shared/qboTrialBalance";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import type { TokenResult } from "../../../supabase/functions/_shared/qboTokenClient";

// Invented values only. The report is Intuit's own UK sandbox company (invented data), recorded in __fixtures__/qbo.
const DIR = path.resolve(__dirname, "__fixtures__/qbo");
const GB_TEXT = fs.readFileSync(path.join(DIR, "qbo-sandbox-gb-trial-balance.json"), "utf8");
const GB_XLSX = new Uint8Array(fs.readFileSync(path.join(DIR, "qbo-sandbox-gb-trial-balance.xlsx")));
const COMPANY = "11111111-1111-1111-1111-111111111111";
const ACTOR = "22222222-2222-2222-2222-222222222222";
const CONN = "33333333-3333-3333-3333-333333333333";
const UPLOAD = "44444444-4444-4444-4444-444444444444";
const REALM = "9341458607761798";
const KEY: EnvelopeKey = { id: "k1", bytes: new Uint8Array(32).fill(3) };
const REQ: PullRequest = { companyId: COMPANY, environment: "sandbox", realmId: REALM, startDate: "2026-01-01", endDate: "2026-10-31", periodYear: 2026, periodId: null, engagementId: null };
const BINDING = connectionBinding(COMPANY, REALM, "sandbox");
const GOOD_TOKENS: TokenResult = { ok: true, tokens: { accessToken: "access-not-real", refreshToken: "refresh-new-not-real", accessExpiresInSeconds: 3600, refreshExpiresAt: "2027-02-09T00:00:00.000Z", hardExpiresAt: "2031-11-01T00:00:00.000Z" } };
const SECRETS = ["access-not-real", "refresh-new-not-real", "refresh-old-not-real", "v1.k1."];

async function world(over: Partial<PullDeps> = {}, opts: { text?: string } = {}) {
  const store = { envelope: await sealSecret("refresh-old-not-real", KEY, BINDING), status: "active" as StoredConnection["status"] };
  const calls: string[] = [];
  const seen = { fetchToken: "", object: new Uint8Array(), recorded: null as null | Record<string, unknown>, removed: [] as string[], registered: [] as unknown[][] };
  const deps: PullDeps = {
    authenticate: async () => (calls.push("authenticate"), ACTOR),
    canPrepare: async () => (calls.push("canPrepare"), true),
    findConnection: async () => (calls.push("findConnection"), { id: CONN, status: store.status, envelope: store.status === "active" ? store.envelope : null }),
    openRefreshToken: async (e, b) => { calls.push("open"); try { return await openSecret(e, [KEY], b); } catch { return null; } },
    refresh: async () => (calls.push("refresh"), GOOD_TOKENS),
    sealRefreshToken: async (t, b) => sealSecret(t, KEY, b),
    rotate: async (_id, expected, next) => { calls.push("rotate"); if (store.envelope !== expected) return false; store.envelope = next; return true; },
    markReconnectNeeded: async () => { calls.push("markReconnectNeeded"); store.status = "reconnect_needed"; },
    fetchReport: async (_e, _r, token) => { calls.push("fetchReport"); seen.fetchToken = token; return { status: 200, text: opts.text ?? GB_TEXT }; },
    sha256Hex,
    summarise: async (csv, currency, year) => (calls.push("summarise"), summariseCanonicalCsv(csv, currency, year)),
    reserve: async () => (calls.push("reserve"), { ok: true, reservationId: "55555555-5555-5555-5555-555555555555", objectPath: `workspaces/${COMPANY}/source/quickbooks.csv` }),
    putObject: async (_p, bytes) => { calls.push("putObject"); seen.object = bytes; return true; },
    removeObject: async (p) => { calls.push("removeObject"); seen.removed.push(p); },
    register: async (...a) => { calls.push("register"); seen.registered.push(a); return { outcome: "registered", uploadId: UPLOAD }; },
    recordPull: async (r) => { calls.push("recordPull"); seen.recorded = r as unknown as Record<string, unknown>; },
    minorVersion: 75,
    ...over,
  };
  return { deps, store, calls, seen };
}
const noSecrets = (r: unknown) => { const t = JSON.stringify(r); for (const s of SECRETS) expect(t).not.toContain(s); };

describe("pull request", () => {
  const ok = { companyId: COMPANY, environment: "sandbox", realmId: REALM, startDate: "2026-01-01", endDate: "2026-10-31", periodYear: 2026 };
  it("accepts exactly the documented keys", () => {
    expect(parsePullRequest(ok)).toEqual({ ...ok, periodId: null, engagementId: null });
    expect(parsePullRequest({ ...ok, accountingMethod: "Cash", periodId: COMPANY, engagementId: COMPANY })).toMatchObject({ accountingMethod: "Cash", periodId: COMPANY, engagementId: COMPANY });
  });
  it.each<[string, Record<string, unknown>]>([
    ["an extra key (a bucket, a path, a user, a token)", { ...ok, bucket: "trial-balance-files" }],
    ["a token in the body", { ...ok, accessToken: "x" }],
    ["no end date", (({ endDate: _e, ...r }) => r)(ok)],
    ["a lone start date is not the point: the dates must be real", { ...ok, startDate: "2026-02-30" }],
    ["start after end", { ...ok, startDate: "2026-11-01" }],
    ["a malformed date", { ...ok, endDate: "31/10/2026" }],
    ["a realm that is not digits", { ...ok, realmId: "12ab" }],
    ["an unknown environment", { ...ok, environment: "test" }],
    ["a year that is not an integer", { ...ok, periodYear: 2026.5 }],
    ["a year out of range", { ...ok, periodYear: 1999 }],
    ["an unknown accounting method", { ...ok, accountingMethod: "Other" }],
    ["a period id that is not a uuid", { ...ok, periodId: "x" }],
  ])("refuses %s", (_l, body) => { expect(parsePullRequest(body)).toBeNull(); });
  it("refuses a non-object", () => { for (const b of [null, [], "x", 5]) expect(parsePullRequest(b)).toBeNull(); });
});

describe("a pull that succeeds", () => {
  it("runs the steps in the safe order: right before connection, rotation BEFORE the report is fetched, provenance last", async () => {
    const w = await world();
    const r = await runQboPull(w.deps, REQ);
    expect(r).toMatchObject({ status: 200, outcome: "imported", uploadId: UPLOAD, currency: "GBP", startDate: "2026-01-01", endDate: "2026-10-31" });
    expect(w.calls).toEqual(["authenticate", "canPrepare", "findConnection", "open", "refresh", "rotate", "fetchReport", "summarise", "reserve", "putObject", "register", "recordPull"]);
  });
  it("uses the NEW access token for the report, stores the NEW refresh token (the old one no longer opens it), and the stored envelope opens only with its binding", async () => {
    const w = await world();
    await runQboPull(w.deps, REQ);
    expect(w.seen.fetchToken).toBe("access-not-real");
    expect(await openSecret(w.store.envelope, [KEY], BINDING)).toBe("refresh-new-not-real");
  });
  it("registers the canonical file as the same upload a person would: the size, the year and the period it was given", async () => {
    const w = await world();
    await runQboPull({ ...w.deps }, { ...REQ, periodId: COMPANY, engagementId: ACTOR });
    expect(w.seen.registered).toEqual([["55555555-5555-5555-5555-555555555555", w.seen.object.byteLength, 2026, COMPANY, ACTOR]]);
    expect(new TextDecoder().decode(w.seen.object).startsWith("Account Name,Debit,Credit\n")).toBe(true);
  });
  it("records provenance: the request, the currency, three fingerprints, the minor version, and no secret", async () => {
    const w = await world();
    await runQboPull(w.deps, REQ);
    const rec = w.seen.recorded as Record<string, unknown>;
    expect(rec).toMatchObject({ companyId: COMPANY, uploadId: UPLOAD, connectionId: CONN, actorUserId: ACTOR, realmId: REALM, environment: "sandbox", startDate: "2026-01-01", endDate: "2026-10-31",
      accountingMethod: null, minorVersion: 75, currency: "GBP", accountCount: 30 });
    expect(rec.rawSha256).toBe(await sha256Hex(GB_TEXT));
    expect(rec.canonicalSha256).toBe(await sha256Hex(w.seen.object));
    for (const k of ["rawSha256", "canonicalSha256", "resultSha256"]) expect(rec[k]).toMatch(/^[0-9a-f]{64}$/);
    noSecrets(rec);
  });
  it("charter A2 through the whole pipeline: the recorded result hash equals the hash of the same books imported from the manual Excel export", async () => {
    const w = await world();
    await runQboPull(w.deps, REQ);
    const viaExcel = readTrialBalanceSource(GB_XLSX, { fileName: "gb.xlsx", periodYear: 2026, currency: "GBP" }, XLSX as unknown as XlsxLike);
    expect((w.seen.recorded as Record<string, unknown>).resultSha256).toBe(await sha256Hex(normalisedAccountingResult(viaExcel.accounts)));
  });
  it("no outcome carries a token or an envelope", async () => {
    const w = await world();
    noSecrets(await runQboPull(w.deps, REQ));
  });
});

describe("a pull that is refused stops at the right step and does nothing later", () => {
  const stops = async (over: Partial<PullDeps>, status: number, outcome: string, notCalled: string[], opts: { text?: string } = {}) => {
    const w = await world(over, opts);
    const r = await runQboPull(w.deps, REQ);
    expect([r.status, r.outcome]).toEqual([status, outcome]);
    for (const c of notCalled) expect(w.calls, c).not.toContain(c);
    noSecrets(r);
    return { w, r };
  };
  it("no login", async () => { await stops({ authenticate: async () => null }, 401, "unauthenticated", ["canPrepare", "findConnection", "refresh"]); });
  it("no right to prepare a trial balance", async () => { await stops({ canPrepare: async () => false }, 403, "forbidden", ["findConnection", "refresh", "fetchReport"]); });
  it("no connection", async () => { await stops({ findConnection: async () => null }, 404, "not_connected", ["refresh", "fetchReport"]); });
  it("a connection that needs reconnecting", async () => { await stops({ findConnection: async () => ({ id: CONN, status: "reconnect_needed", envelope: null }) }, 409, "reconnect_needed", ["refresh", "fetchReport"]); });
  it("a stored token that cannot be opened (a configuration problem, not a reconnect)", async () => { await stops({ openRefreshToken: async () => null }, 500, "token_unreadable", ["refresh", "markReconnectNeeded"]); });
  it("Intuit refuses the refresh token: the connection is marked reconnect-needed", async () => {
    const { w } = await stops({ refresh: async () => ({ ok: false, reason: "invalid_grant" }) }, 409, "reconnect_needed", ["rotate", "fetchReport"]);
    expect(w.calls).toContain("markReconnectNeeded");
  });
  it("Intuit is unavailable or rejects for another reason: nothing is marked, nothing is stored", async () => {
    await stops({ refresh: async () => ({ ok: false, reason: "unavailable" }) }, 503, "quickbooks_unavailable", ["markReconnectNeeded", "rotate", "fetchReport"]);
    await stops({ refresh: async () => ({ ok: false, reason: "rejected" }) }, 502, "quickbooks_rejected", ["markReconnectNeeded", "rotate", "fetchReport"]);
  });
  it("another pull rotated the token first: busy, and the report is NOT fetched with the lost token", async () => { await stops({ rotate: async () => false }, 409, "busy", ["fetchReport", "reserve"]); });
  it.each<[string, { status: number; text: string }, number, string]>([
    ["rate limited", { status: 429, text: "" }, 429, "rate_limited"],
    ["a server error", { status: 503, text: "" }, 503, "quickbooks_unavailable"],
    ["another status", { status: 401, text: "" }, 502, "report_failed"],
    ["not JSON", { status: 200, text: "<html>" }, 502, "report_unreadable"],
    ["too large", { status: 200, text: "x".repeat(5_000_001) }, 502, "report_too_large"],
  ])("the report is %s", async (_l, res, status, outcome) => { await stops({ fetchReport: async () => res }, status, outcome, ["reserve", "putObject", "register", "recordPull"]); });
  it("a report that is not exactly the recorded shape is refused with its reason, never repaired", async () => {
    const j = JSON.parse(GB_TEXT); j.Rows.Row.at(-1).Summary.ColData[1].value = "164377.78";
    const { r } = await stops({}, 422, "report_refused", ["reserve", "putObject", "register", "recordPull"], { text: JSON.stringify(j) });
    expect(r).toMatchObject({ code: "CONTROL_TOTAL_MISMATCH" });
  });
  it("QuickBooks answering a different period than was asked for is refused", async () => {
    const j = JSON.parse(GB_TEXT); j.Header.StartPeriod = "2026-10-01";
    await stops({}, 422, "period_mismatch", ["reserve", "register", "recordPull"], { text: JSON.stringify(j) });
  });
  it("the upload steps refuse: no permission to manage source files, a failed reservation, a failed store", async () => {
    await stops({ reserve: async () => ({ ok: false, reason: "forbidden" }) }, 403, "forbidden", ["putObject", "register", "recordPull"]);
    await stops({ reserve: async () => ({ ok: false, reason: "failed" }) }, 500, "reserve_failed", ["putObject", "register", "recordPull"]);
    await stops({ putObject: async () => false }, 500, "store_failed", ["register", "recordPull"]);
  });
  it("an active upload already exists for the period: the stored object is removed and nothing is recorded", async () => {
    const { w } = await stops({ register: async () => ({ outcome: "active_upload_exists", uploadId: null }) }, 409, "active_upload_exists", ["recordPull"]);
    expect(w.seen.removed).toEqual([`workspaces/${COMPANY}/source/quickbooks.csv`]);
  });
  it("registration refused or failed: removed, nothing recorded", async () => {
    const a = await stops({ register: async () => ({ outcome: "forbidden", uploadId: null }) }, 403, "forbidden", ["recordPull"]); expect(a.w.seen.removed).toHaveLength(1);
    const b = await stops({ register: async () => ({ outcome: "object_missing", uploadId: null }) }, 500, "register_failed", ["recordPull"]); expect(b.w.seen.removed).toHaveLength(1);
  });
  it("provenance that cannot be written is reported plainly, with the upload id, not hidden", async () => {
    const { r } = await stops({ recordPull: async () => { throw new Error("db down"); } }, 500, "provenance_failed", []);
    expect(r).toMatchObject({ uploadId: UPLOAD });
  });
});

describe("two pulls at once", () => {
  it("exactly one rotates the refresh token and fetches; the other is told it is busy and never fetches", async () => {
    const w = await world();
    const rotated: string[] = [];
    // one shared store, atomic compare-and-swap, as the database function is
    const mk = (d: PullDeps): PullDeps => ({ ...d, rotate: async (_id, expected, next) => { if (w.store.envelope !== expected) return false; w.store.envelope = next; rotated.push(next); return true; },
      findConnection: async () => ({ id: CONN, status: "active", envelope: w.store.envelope }) });
    const a = mk(w.deps), b = mk(w.deps);
    const fetches: string[] = [];
    for (const d of [a, b]) { const f = d.fetchReport; d.fetchReport = async (...x) => { fetches.push("f"); return f(...x); }; }
    const [r1, r2] = await Promise.all([runQboPull(a, REQ), runQboPull(b, REQ)]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(["busy", "imported"]);
    expect(rotated).toHaveLength(1); expect(fetches).toHaveLength(1);
  });
});
