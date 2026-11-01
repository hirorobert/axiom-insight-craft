// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { parsePullRequest, REFRESH_LEASE_SECONDS, runQboPull, type PullDeps, type PullRequest, type StoredConnection } from "../../../supabase/functions/_shared/qboPull";
import { QBO_TIMEOUTS_MS } from "../../../supabase/functions/_shared/qboReadOnlyGuard";
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
  const store = { envelope: await sealSecret("refresh-old-not-real", KEY, BINDING), status: "active" as StoredConnection["status"], leased: false, leaseId: null as string | null, leases: 0 };
  const calls: string[] = [];
  const seen = { fetchToken: "", object: new Uint8Array(), recorded: null as null | Record<string, unknown>, removed: [] as string[], registered: [] as unknown[][], released: [] as string[], refused: [] as string[] };
  const deps: PullDeps = {
    authenticate: async () => (calls.push("authenticate"), ACTOR),
    canPrepare: async () => (calls.push("canPrepare"), true),
    canManageSources: async () => (calls.push("canManageSources"), true),
    acquireRefreshLease: async () => { calls.push("acquireLease"); if (store.leased) return null; store.leased = true; store.leaseId = `lease-${++store.leases}`; return store.leaseId; },
    // As the database does: only the holder's own id releases the lease.
    releaseRefreshLease: async (_c, id) => { calls.push("releaseLease"); seen.released.push(id); if (store.leaseId === id) { store.leased = false; store.leaseId = null; } },
    pause: async () => undefined,
    findConnection: async () => (calls.push("findConnection"), { id: CONN, status: store.status, envelope: store.status === "active" ? store.envelope : null }),
    openRefreshToken: async (e, b) => { calls.push("open"); try { return await openSecret(e, [KEY], b); } catch { return null; } },
    refresh: async () => (calls.push("refresh"), GOOD_TOKENS),
    sealRefreshToken: async (t, b) => sealSecret(t, KEY, b),
    rotate: async (_id, expected, next) => { calls.push("rotate"); if (store.envelope === next) return true; if (store.envelope !== expected) return false; store.envelope = next; store.leased = false; store.leaseId = null; return true; },
    // As the database does: only the token that was refused is deleted.
    markReconnectNeeded: async (_c, refused) => { calls.push("markReconnectNeeded"); seen.refused.push(refused); if (store.envelope !== refused) return; store.status = "reconnect_needed"; store.leased = false; store.leaseId = null; },
    fetchReport: async (_e, _r, token) => { calls.push("fetchReport"); seen.fetchToken = token; return { status: 200, text: opts.text ?? GB_TEXT }; },
    sha256Hex,
    summarise: async (csv, currency, year) => (calls.push("summarise"), summariseCanonicalCsv(csv, currency, year)),
    reserve: async () => (calls.push("reserve"), { ok: true, reservationId: "55555555-5555-5555-5555-555555555555", objectPath: `workspaces/${COMPANY}/source/quickbooks.csv` }),
    putObject: async (_p, bytes) => { calls.push("putObject"); seen.object = bytes; return true; },
    removeObject: async (p) => { calls.push("removeObject"); seen.removed.push(p); },
    register: async (...a) => { calls.push("register"); seen.registered.push(a); return { outcome: "registered", uploadId: UPLOAD }; },
    recordIntent: async (r) => { calls.push("recordIntent"); seen.recorded = r as unknown as Record<string, unknown>; },
    completePull: async () => (calls.push("completePull"), "completed" as const),
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
  it("runs the steps in the safe order: BOTH rights first, the lease before Intuit, rotation BEFORE the report is fetched, the evidence BEFORE anything is stored, the link last", async () => {
    const w = await world();
    const r = await runQboPull(w.deps, REQ);
    expect(r).toMatchObject({ status: 200, outcome: "imported", uploadId: UPLOAD, currency: "GBP", startDate: "2026-01-01", endDate: "2026-10-31" });
    expect(w.calls).toEqual(["authenticate", "canPrepare", "canManageSources", "findConnection", "open", "acquireLease", "refresh", "rotate", "fetchReport", "summarise", "reserve", "recordIntent", "putObject", "register", "completePull"]);
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
  it("records the evidence: the reservation, the request, the currency, three fingerprints, the minor version, and no secret", async () => {
    const w = await world();
    await runQboPull(w.deps, REQ);
    const rec = w.seen.recorded as Record<string, unknown>;
    expect(rec).toMatchObject({ reservationId: "55555555-5555-5555-5555-555555555555", connectionId: CONN, actorUserId: ACTOR, realmId: REALM, environment: "sandbox", startDate: "2026-01-01", endDate: "2026-10-31",
      accountingMethod: null, minorVersion: 75, currency: "GBP", accountCount: 30 });
    expect(rec.rawSha256).toBe(await sha256Hex(GB_TEXT));
    expect(rec.canonicalSha256).toBe(await sha256Hex(w.seen.object));
    for (const k of ["rawSha256", "canonicalSha256", "resultSha256"]) expect(rec[k]).toMatch(/^[0-9a-f]{64}$/);
    noSecrets(rec);
    expect(rec).not.toHaveProperty("uploadId");   // the upload id is the reservation's own record, never supplied by this function
    expect(rec).not.toHaveProperty("companyId");  // the workspace comes from the reservation, never from here
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
  it("no login", async () => { await stops({ authenticate: async () => null }, 401, "unauthenticated", ["canPrepare", "canManageSources", "findConnection", "acquireLease", "refresh"]); });
  it("no right to prepare a trial balance", async () => { await stops({ canPrepare: async () => false }, 403, "forbidden", ["canManageSources", "findConnection", "acquireLease", "refresh", "fetchReport"]); });
  it("the right to prepare but NOT to manage source files: refused BEFORE Intuit is touched, so no token is refreshed or rotated for an import that could only be refused", async () => {
    const asked: string[] = [];
    const { w } = await stops({ canManageSources: async () => (asked.push("manage"), false) }, 403, "forbidden", ["findConnection", "open", "acquireLease", "refresh", "rotate", "fetchReport", "reserve", "recordIntent", "putObject", "register"]);
    expect(asked).toEqual(["manage"]);
    expect(w.calls).toEqual(["authenticate", "canPrepare"]);   // nothing after the two rights was reached
    expect(await openSecret(w.store.envelope, [KEY], BINDING)).toBe("refresh-old-not-real");   // the stored token is untouched
  });
  it("the right to manage source files but NOT to prepare a trial balance: refused at once, the second right is not even asked", async () => {
    const asked: string[] = [];
    const { w } = await stops({ canPrepare: async () => false, canManageSources: async () => (asked.push("manage"), true) }, 403, "forbidden", ["findConnection", "refresh"]);
    expect(asked).toEqual([]);
    expect(w.calls).toEqual(["authenticate"]);
  });
  it("no connection", async () => { await stops({ findConnection: async () => null }, 404, "not_connected", ["refresh", "fetchReport"]); });
  it("a connection that needs reconnecting", async () => { await stops({ findConnection: async () => ({ id: CONN, status: "reconnect_needed", envelope: null }) }, 409, "reconnect_needed", ["refresh", "fetchReport"]); });
  it("a stored token that cannot be opened (a configuration problem, not a reconnect)", async () => { await stops({ openRefreshToken: async () => null }, 500, "token_unreadable", ["refresh", "markReconnectNeeded"]); });
  it("Intuit refuses the refresh token: the connection is marked reconnect-needed for exactly the token that was presented", async () => {
    const { w } = await stops({ refresh: async () => ({ ok: false, reason: "invalid_grant" }) }, 409, "reconnect_needed", ["rotate", "fetchReport"]);
    expect(w.calls).toContain("markReconnectNeeded");
    expect(w.seen.refused).toEqual([w.store.envelope]);
    expect(w.store.status).toBe("reconnect_needed"); expect(w.store.leased).toBe(false);
    expect(w.seen.released).toEqual(["lease-1"]);   // given back by its own id: harmless here (the mark cleared it), needed when the mark changed nothing
  });
  it("a refusal of an out-of-date token never deletes a newer one another import stored meanwhile", async () => {
    const w = await world();
    const newer = await sealSecret("refresh-newer-not-real", KEY, BINDING);
    w.deps.refresh = async () => { w.store.envelope = newer; return { ok: false, reason: "invalid_grant" }; };   // another import rotated while ours was at Intuit
    const r = await runQboPull(w.deps, REQ);
    expect([r.status, r.outcome]).toEqual([409, "reconnect_needed"]);
    expect(w.store.status).toBe("active"); expect(w.store.envelope).toBe(newer);
  });
  it("Intuit is unavailable or rejects for another reason: nothing is marked, nothing is stored, and the lease is given back so the next attempt need not wait", async () => {
    for (const reason of ["unavailable", "rejected"] as const) {
      const { w } = await stops({ refresh: async () => ({ ok: false, reason }) }, reason === "unavailable" ? 503 : 502, reason === "unavailable" ? "quickbooks_unavailable" : "quickbooks_rejected", ["markReconnectNeeded", "rotate", "fetchReport"]);
      expect(w.calls).toContain("releaseLease"); expect(w.store.leased).toBe(false);
    }
  });
  it("another pull rotated the token first: busy, the report is NOT fetched with the lost token, and the lease is given back only by its own id", async () => {
    const { w } = await stops({ rotate: async () => false }, 409, "busy", ["fetchReport", "reserve"]);
    expect(w.calls).toContain("refresh");   // the lease was held, Intuit was called, and the swap was lost
    expect(w.seen.released).toEqual(["lease-1"]);
  });
  it("the swap fails for a moment (a database fault, or its answer is lost): it is retried, and the newest token is stored, not dropped", async () => {
    let tries = 0;
    const w = await world();
    const real = w.deps.rotate;
    w.deps.rotate = async (...a) => { tries++; if (tries === 1) { await real(...a); throw new Error("answer lost"); } return real(...a); };
    const r = await runQboPull(w.deps, REQ);
    expect(r.status).toBe(200);
    expect(tries).toBe(2);   // the retry finds its own earlier write and is told "stored"
    expect(await openSecret(w.store.envelope, [KEY], BINDING)).toBe("refresh-new-not-real");
    expect(w.seen.fetchToken).toBe("access-not-real");
  });
  it("the swap cannot be stored at all: nothing is fetched, the lease is given back by its own id, and the import fails without a secret in the outcome", async () => {
    const { w } = await stops({ rotate: async () => { throw new Error("db down"); } }, 500, "pull_failed", ["fetchReport", "reserve", "recordIntent"]);
    expect(w.seen.released).toEqual(["lease-1"]); expect(w.store.leased).toBe(false);
    expect(await openSecret(w.store.envelope, [KEY], BINDING)).toBe("refresh-old-not-real");
  });
  it("an import whose lease lapsed gives back only its own lease, never the one another import has taken since", async () => {
    const w = await world();
    w.deps.refresh = async () => {
      w.store.leaseId = "lease-of-the-next-import";   // ours lapsed while Intuit was slow, and the next import took it
      return { ok: false, reason: "unavailable" };
    };
    const r = await runQboPull(w.deps, REQ);
    expect(r.outcome).toBe("quickbooks_unavailable");
    expect(w.seen.released).toEqual(["lease-1"]);
    expect(w.store.leaseId).toBe("lease-of-the-next-import"); expect(w.store.leased).toBe(true);
  });
  it("no call to Intuit can outlast the refresh lease: the token call is abandoned well inside it", () => {
    expect(QBO_TIMEOUTS_MS.token * 3).toBeLessThanOrEqual(REFRESH_LEASE_SECONDS * 1000);
    expect(QBO_TIMEOUTS_MS.report).toBeGreaterThan(0);
  });
  it("something throws between the lease and the rotation: the lease is given back before the error leaves", async () => {
    const w = await world({ sealRefreshToken: async () => { throw new Error("key unavailable"); } });
    await expect(runQboPull(w.deps, REQ)).rejects.toThrow("key unavailable");
    expect(w.calls).toContain("releaseLease"); expect(w.store.leased).toBe(false);
    expect(await openSecret(w.store.envelope, [KEY], BINDING)).toBe("refresh-old-not-real");   // nothing was rotated
  });
  it("the lease is held by someone else: busy, and Intuit is never called", async () => {
    const { w } = await stops({ acquireRefreshLease: async () => null }, 409, "busy", ["refresh", "rotate", "fetchReport", "reserve", "recordIntent", "releaseLease"]);
    expect(w.calls).toContain("open");
  });
  it.each<[string, { status: number; text: string }, number, string]>([
    ["rate limited", { status: 429, text: "" }, 429, "rate_limited"],
    ["a server error", { status: 503, text: "" }, 503, "quickbooks_unavailable"],
    ["another status", { status: 401, text: "" }, 502, "report_failed"],
    ["not JSON", { status: 200, text: "<html>" }, 502, "report_unreadable"],
    ["too large", { status: 200, text: "x".repeat(5_000_001) }, 502, "report_too_large"],
  ])("the report is %s", async (_l, res, status, outcome) => { await stops({ fetchReport: async () => res }, status, outcome, ["reserve", "putObject", "register", "recordIntent"]); });
  it("a report that is not exactly the recorded shape is refused with its reason, never repaired", async () => {
    const j = JSON.parse(GB_TEXT); j.Rows.Row.at(-1).Summary.ColData[1].value = "164377.78";
    const { r } = await stops({}, 422, "report_refused", ["reserve", "putObject", "register", "recordIntent"], { text: JSON.stringify(j) });
    expect(r).toMatchObject({ code: "CONTROL_TOTAL_MISMATCH" });
  });
  it("QuickBooks answering a different period than was asked for is refused", async () => {
    const j = JSON.parse(GB_TEXT); j.Header.StartPeriod = "2026-10-01";
    await stops({}, 422, "period_mismatch", ["reserve", "register", "recordIntent"], { text: JSON.stringify(j) });
  });
  it("the upload steps refuse: no permission to manage source files, a failed reservation, a failed store", async () => {
    await stops({ reserve: async () => ({ ok: false, reason: "forbidden" }) }, 403, "forbidden", ["putObject", "register", "recordIntent", "completePull"]);
    await stops({ reserve: async () => ({ ok: false, reason: "failed" }) }, 500, "reserve_failed", ["putObject", "register", "recordIntent", "completePull"]);
    await stops({ putObject: async () => false }, 500, "store_failed", ["register", "completePull"]);
  });
  it("an active upload already exists for the period: the stored object is removed, the fetched-not-imported evidence stays, and nothing is linked", async () => {
    const { w } = await stops({ register: async () => ({ outcome: "active_upload_exists", uploadId: null }) }, 409, "active_upload_exists", ["completePull"]);
    expect(w.seen.removed).toEqual([`workspaces/${COMPANY}/source/quickbooks.csv`]);
    expect(w.calls).toContain("recordIntent");
  });
  it("registration refused or failed: removed, nothing linked", async () => {
    const a = await stops({ register: async () => ({ outcome: "forbidden", uploadId: null }) }, 403, "forbidden", ["completePull"]); expect(a.w.seen.removed).toHaveLength(1);
    const b = await stops({ register: async () => ({ outcome: "object_missing", uploadId: null }) }, 500, "register_failed", ["completePull"]); expect(b.w.seen.removed).toHaveLength(1);
  });
});

describe("the evidence cannot be lost: written first, linked after, recoverable (review finding 2)", () => {
  const idx = (calls: string[], name: string) => calls.indexOf(name);
  it("the facts are on record BEFORE the file is stored or registered, in every successful run", async () => {
    const w = await world();
    await runQboPull(w.deps, REQ);
    expect(idx(w.calls, "recordIntent")).toBeGreaterThan(idx(w.calls, "reserve"));
    expect(idx(w.calls, "recordIntent")).toBeLessThan(idx(w.calls, "putObject"));
    expect(idx(w.calls, "recordIntent")).toBeLessThan(idx(w.calls, "register"));
    expect(idx(w.calls, "completePull")).toBeGreaterThan(idx(w.calls, "register"));
  });
  it("the evidence cannot be written at all: NOTHING is stored or registered, so no upload exists without its evidence, and no upload id is reported", async () => {
    const w = await world({ recordIntent: async () => { throw new Error("db down"); } });
    const r = await runQboPull(w.deps, REQ);
    expect([r.status, r.outcome]).toEqual([500, "provenance_failed"]);
    expect(w.calls.filter((c) => c === "putObject" || c === "register" || c === "completePull")).toEqual([]);
    expect(r).not.toHaveProperty("uploadId");
    noSecrets(r);
  });
  it("a transient failure to write the evidence is retried (idempotent) and the import then succeeds; three failures stop it", async () => {
    let n = 0;
    const flaky = await world({ recordIntent: async () => { n++; if (n < 3) throw new Error("blip"); } });
    expect((await runQboPull(flaky.deps, REQ)).outcome).toBe("imported");
    expect(n).toBe(3);
    let m = 0;
    const dead = await world({ recordIntent: async () => { m++; throw new Error("down"); } });
    expect((await runQboPull(dead.deps, REQ)).outcome).toBe("provenance_failed");
    expect(m).toBe(3);
  });
  it("the upload exists and only the LINK fails: the outcome is the distinct, honest 'imported_record_pending' (HTTP 202) with the upload id, never 'imported' and never an error that hides the upload", async () => {
    let n = 0;
    const w = await world({ completePull: async () => { n++; throw new Error("db down"); } });
    const r = await runQboPull(w.deps, REQ);
    expect(r).toMatchObject({ status: 202, outcome: "imported_record_pending", uploadId: UPLOAD, currency: "GBP", accountCount: 30 });
    expect(n).toBe(3);
    expect(w.calls).toContain("recordIntent");   // the evidence was complete before the upload existed
    expect(w.seen.removed).toEqual([]);          // the upload is NOT rolled back: it is real, and its evidence is on record
    noSecrets(r);
  });
  it("the link answers something other than completed or already (the upload is not seen): pending, never imported", async () => {
    for (const answer of ["not_registered", "no_intent", "no_reservation"] as const) {
      const w = await world({ completePull: async () => answer });
      expect(await runQboPull(w.deps, REQ)).toMatchObject({ status: 202, outcome: "imported_record_pending" });
    }
  });
  it("the link fails once and then succeeds, or was already done by an earlier recovery: a plain 200", async () => {
    let n = 0;
    expect((await runQboPull((await world({ completePull: async () => { n++; if (n === 1) throw new Error("blip"); return "completed"; } })).deps, REQ)).status).toBe(200);
    expect((await runQboPull((await world({ completePull: async () => "already" })).deps, REQ)).status).toBe(200);
  });
  it("earlier imports whose link is missing are recovered at the start of the next import, and a failure of that recovery never stops the import", async () => {
    let recovered = 0;
    const ok = await world({ completePending: async () => { recovered++; } });
    expect((await runQboPull(ok.deps, REQ)).status).toBe(200);
    expect(recovered).toBe(1);
    const broken = await world({ completePending: async () => { throw new Error("db down"); } });
    expect((await runQboPull(broken.deps, REQ)).status).toBe(200);
  });
});

describe("two pulls at once (review finding 6)", () => {
  const counting = (w: Awaited<ReturnType<typeof world>>) => {
    const refreshes: string[] = [], fetches: string[] = [], rotated: string[] = [];
    const mk = (): PullDeps => ({ ...w.deps,
      refresh: async (...x) => { refreshes.push("r"); return w.deps.refresh(...x); },
      rotate: async (_id, expected, next) => { if (w.store.envelope !== expected) return false; w.store.envelope = next; w.store.leased = false; w.store.leaseId = null; rotated.push(next); return true; },
      fetchReport: async (...x) => { fetches.push("f"); return w.deps.fetchReport(...x); },
      findConnection: async () => ({ id: CONN, status: "active", envelope: w.store.envelope }) });
    return { a: mk(), b: mk(), refreshes, fetches, rotated };
  };
  it("with the lease, the second is told busy BEFORE Intuit is called: Intuit sees exactly ONE refresh with that token", async () => {
    const w = await world();
    const c = counting(w);
    const [r1, r2] = await Promise.all([runQboPull(c.a, REQ), runQboPull(c.b, REQ)]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(["busy", "imported"]);
    expect(c.refreshes).toHaveLength(1); expect(c.fetches).toHaveLength(1); expect(c.rotated).toHaveLength(1);
  });
  it("a third request after the first has finished is not blocked: the lease was cleared by the rotation", async () => {
    const w = await world();
    const c = counting(w);
    expect((await runQboPull(c.a, REQ)).outcome).toBe("imported");
    expect(w.store.leased).toBe(false);
  });
  it("if the lease had lapsed (a crashed import) and two refreshes did happen, the compare-and-swap still lets exactly one store its token and fetch; the other is told busy and never fetches", async () => {
    const w = await world();
    const c = counting(w);
    c.a.acquireRefreshLease = async () => "lease-a"; c.b.acquireRefreshLease = async () => "lease-b";
    const [r1, r2] = await Promise.all([runQboPull(c.a, REQ), runQboPull(c.b, REQ)]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(["busy", "imported"]);
    expect(c.refreshes).toHaveLength(2); expect(c.rotated).toHaveLength(1); expect(c.fetches).toHaveLength(1);
  });
});
