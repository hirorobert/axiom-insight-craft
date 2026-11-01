// @vitest-environment node
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { OAUTH_STATE_TTL_SECONDS, oauthReturnBinding, parseCallbackQuery, parseConnectStartRequest, parseFinishRequest, runQboCallback, runQboConnectStart, runQboFinish, type CallbackDeps, type ConnectStartDeps, type FinishDeps, type ReturnBack } from "../../../supabase/functions/_shared/qboConnect";
import { connectionBinding, openSecret, sealSecret, type EnvelopeKey } from "../../../supabase/functions/_shared/qboTokenEnvelope";
import type { TokenResult } from "../../../supabase/functions/_shared/qboTokenClient";

// Invented values only: no real client id, code, state or token appears here.
const COMPANY = "11111111-1111-1111-1111-111111111111";
const ACTOR = "22222222-2222-2222-2222-222222222222";
const CFG = { clientId: "ABtestclientidtestclientidtestclientid00", redirectUri: "https://app.example.test/functions/v1/qbo-oauth-callback" };
const KEY: EnvelopeKey = { id: "k1", bytes: new Uint8Array(32).fill(5) };
const sha = async (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const STATE = "ab".repeat(32);

function startDeps(over: Partial<ConnectStartDeps> = {}) {
  const started: unknown[][] = [];
  const deps: ConnectStartDeps = {
    authenticate: async () => ACTOR,
    oauthConfig: () => CFG,
    randomState: () => STATE,
    sha256Hex: sha,
    startState: async (...a) => { started.push(a); return "created"; },
    ...over,
  };
  return { deps, started };
}

describe("connect start", () => {
  it("parses exactly companyId and environment", () => {
    expect(parseConnectStartRequest({ companyId: COMPANY, environment: "sandbox", periodYear: 2026 })).toEqual({ companyId: COMPANY, environment: "sandbox", periodYear: 2026 });
    for (const bad of [null, [], {}, { companyId: COMPANY }, { companyId: COMPANY, environment: "sandbox" }, { companyId: COMPANY, environment: "staging", periodYear: 2026 }, { companyId: "x", environment: "sandbox", periodYear: 2026 },
      { companyId: COMPANY, environment: "sandbox", periodYear: 1999 }, { companyId: COMPANY, environment: "sandbox", periodYear: 2026.5 }, { companyId: COMPANY, environment: "sandbox", periodYear: "2026" },
      { companyId: COMPANY, environment: "sandbox", periodYear: 2026, actor: ACTOR }, { companyId: COMPANY, environment: "sandbox", periodYear: 2026, realmId: "1" }]) {
      expect(parseConnectStartRequest(bad)).toBeNull();
    }
  });
  it("stores only the hash of the state and returns the authorisation address that carries the state", async () => {
    const { deps, started } = startDeps();
    const r = await runQboConnectStart(deps, { companyId: COMPANY, environment: "sandbox", periodYear: 2026 });
    expect(r.status).toBe(200);
    if (r.outcome !== "authorize") throw new Error("expected authorize");
    const u = new URL(r.authorizeUrl);
    expect(u.searchParams.get("state")).toBe(STATE);
    expect(u.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(started).toEqual([[await sha(STATE), COMPANY, ACTOR, "sandbox", OAUTH_STATE_TTL_SECONDS, 2026]]);
    expect(JSON.stringify(started)).not.toContain(STATE);
  });
  it.each<[string, Partial<ConnectStartDeps>, number, string]>([
    ["no login", { authenticate: async () => null }, 401, "unauthenticated"],
    ["the app is not configured for that environment", { oauthConfig: () => null }, 503, "not_configured"],
    ["the person lacks the right", { startState: async () => "forbidden" }, 403, "forbidden"],
    ["the database refuses the state", { startState: async () => "invalid" }, 500, "state_failed"],
    ["a weak random state", { randomState: () => "short" }, 500, "state_failed"],
  ])("%s", async (_l, over, status, outcome) => {
    const { deps, started } = startDeps(over);
    const r = await runQboConnectStart(deps, { companyId: COMPANY, environment: "production", periodYear: 2026 });
    expect([r.status, r.outcome]).toEqual([status, outcome]);
    // nothing reaches the database unless there is a login, a configured app and a strong state
    if (["unauthenticated", "not_configured"].includes(outcome) || over.randomState) expect(started).toHaveLength(0);
  });
  it("never calls the database without a login", async () => {
    const { deps, started } = startDeps({ authenticate: async () => null });
    await runQboConnectStart(deps, { companyId: COMPANY, environment: "sandbox", periodYear: 2026 });
    expect(started).toHaveLength(0);
  });
});

describe("callback query", () => {
  const q = (s: string) => parseCallbackQuery(new URLSearchParams(s));
  it("reads the parameters Intuit sends", () => {
    expect(q(`code=abc123&state=${STATE}&realmId=9341458604136919`)).toEqual({ state: STATE, code: "abc123", realmId: "9341458604136919", denied: false });
    expect(q(`state=${STATE}&error=access_denied`)).toEqual({ state: STATE, code: null, realmId: null, denied: true });
    expect(q(`code=abc&state=${STATE}&realmId=1&extra=ignored`)?.code).toBe("abc");
  });
  it("refuses a missing or malformed state, code or realm", () => {
    for (const bad of ["code=abc", `state=short&code=abc`, `state=${STATE}&code=`, `state=${STATE}&code=a%20b`, `state=${STATE}&code=${"x".repeat(513)}`, `state=${STATE}&realmId=12ab`, `state=${"!".repeat(40)}`]) {
      expect(q(bad)).toBeNull();
    }
  });
});

const HANDOFF = "cd".repeat(32);
const RETURN_URL = (c: string, y: number, back: ReturnBack) => `https://app.example.test/workspace/${c}/${y}/trial-balance/review${"handoff" in back ? `#qbo_handoff=${back.handoff}` : `?qbo=${back.status}`}`;
function callbackDeps(over: Partial<CallbackDeps> = {}) {
  const log = { recorded: [] as unknown[][], sealed: [] as unknown[][] };
  const deps: CallbackDeps = {
    sha256Hex: sha,
    randomHandoff: () => HANDOFF,
    sealCode: async (c, b) => { log.sealed.push([c, b]); return sealSecret(c, KEY, b); },
    recordReturn: async (...a) => { log.recorded.push(a); return { companyId: COMPANY, environment: "sandbox", returnPeriodYear: 2026 }; },
    returnTo: RETURN_URL,
    ...over,
  };
  return { deps, log };
}
const QUERY = { state: STATE, code: "code-not-real", realmId: "9341458604136919", denied: false };

describe("callback: the code is parked, never exchanged, and the browser carries a one-time handoff back (review r2, S4)", () => {
  it("refuses a malformed request without touching anything", async () => {
    const { deps, log } = callbackDeps();
    expect(await runQboCallback(deps, null)).toEqual({ status: 400, outcome: "invalid_request" });
    expect(log.recorded).toHaveLength(0);
  });
  it("refuses an unknown, expired or used state (or a starter who lost a right): a plain 400 with no redirect", async () => {
    const { deps } = callbackDeps({ recordReturn: async () => null });
    expect(await runQboCallback(deps, QUERY)).toEqual({ status: 400, outcome: "unknown_state" });
  });
  it("parks the code sealed to its handoff, with the realm, and sends the browser back with the handoff in the FRAGMENT only", async () => {
    const { deps, log } = callbackDeps();
    const r = await runQboCallback(deps, QUERY);
    expect(r).toEqual({ status: 302, outcome: "handed_back", location: `https://app.example.test/workspace/${COMPANY}/2026/trial-balance/review#qbo_handoff=${HANDOFF}` });
    const u = new URL((r as { location: string }).location);
    expect(u.search).toBe(""); expect(u.hash).toBe(`#qbo_handoff=${HANDOFF}`);   // a browser never sends the fragment to a server
    const [stateHash, parked] = log.recorded[0] as [string, { realmId: string; codeEnvelope: string; handoffHash: string }];
    expect(stateHash).toBe(await sha(STATE));
    expect(parked.realmId).toBe(QUERY.realmId); expect(parked.handoffHash).toBe(await sha(HANDOFF));
    expect(parked.codeEnvelope).not.toContain("code-not-real");
    expect(await openSecret(parked.codeEnvelope, [KEY], oauthReturnBinding(await sha(HANDOFF)))).toBe("code-not-real");
    await expect(openSecret(parked.codeEnvelope, [KEY], oauthReturnBinding(await sha("other")))).rejects.toThrow();   // it opens for no other handoff
    expect(JSON.stringify(log.recorded)).not.toContain(HANDOFF);   // the database holds only the handoff's hash
  });
  it("never puts the code, the state, a token or an envelope in the redirect", async () => {
    const { deps } = callbackDeps();
    const text = JSON.stringify(await runQboCallback(deps, QUERY));
    for (const secret of [QUERY.code, STATE, "v1.k1."]) expect(text).not.toContain(secret);
  });
  it("a person who declined at QuickBooks: the state is consumed, nothing is parked, the browser learns 'denied'", async () => {
    const { deps, log } = callbackDeps();
    const r = await runQboCallback(deps, { state: STATE, code: null, realmId: null, denied: true });
    expect(r).toEqual({ status: 302, outcome: "denied", location: `https://app.example.test/workspace/${COMPANY}/2026/trial-balance/review?qbo=denied` });
    expect(log.recorded).toEqual([[await sha(STATE), null]]); expect(log.sealed).toHaveLength(0);
  });
  it.each<[string, Partial<CallbackDeps>, Partial<typeof QUERY>]>([
    ["no code", {}, { code: null as never }],
    ["no realm", {}, { realmId: null as never }],
    ["a weak random handoff", { randomHandoff: () => "short" }, {}],
  ])("%s -> the state is consumed, nothing is parked, 'failed'", async (_l, over, q) => {
    const { deps, log } = callbackDeps(over);
    const r = await runQboCallback(deps, { ...QUERY, ...q });
    expect(r).toMatchObject({ status: 302, outcome: "failed" });
    expect(log.recorded).toEqual([[await sha(STATE), null]]); expect(log.sealed).toHaveLength(0);
  });
  it("sealing fails (no key): nothing is consumed or parked, and the error leaves (the function answers a plain 400)", async () => {
    const { deps, log } = callbackDeps({ sealCode: async () => { throw new Error("no key"); } });
    await expect(runQboCallback(deps, QUERY)).rejects.toThrow("no key");
    expect(log.recorded).toHaveLength(0);
  });
  it("the callback's dependencies offer no way to reach Intuit", () => {
    const { deps } = callbackDeps();
    expect(Object.keys(deps).sort()).toEqual(["randomHandoff", "recordReturn", "returnTo", "sealCode", "sha256Hex"]);
  });
});

const GOOD: TokenResult = { ok: true, tokens: { accessToken: "access-not-real", refreshToken: "refresh-not-real-0001", accessExpiresInSeconds: 3600, refreshExpiresAt: "2027-02-09T12:00:00.000Z", hardExpiresAt: "2031-11-01T12:00:00.000Z" } };
const OTHER = "55555555-5555-5555-5555-555555555555";
async function finishDeps(over: Partial<FinishDeps> = {}, who: string = ACTOR) {
  const handoffHash = await sha(HANDOFF);
  const parked = { starter: ACTOR, envelope: await sealSecret("code-not-real", KEY, oauthReturnBinding(handoffHash)), open: true };
  const log = { taken: [] as unknown[][], exchanged: [] as unknown[][], stored: [] as unknown[][], sealed: [] as unknown[][] };
  const deps: FinishDeps = {
    authenticate: async () => who,
    sha256Hex: sha,
    // As the database does: single use, and the code only for the starter.
    takeReturn: async (h, actor) => {
      log.taken.push([h, actor]);
      if (h !== handoffHash || !parked.open) return { outcome: "unknown" };
      parked.open = false;
      return actor === parked.starter ? { outcome: "taken", companyId: COMPANY, environment: "sandbox", realmId: "9341458604136919", codeEnvelope: parked.envelope } : { outcome: "not_yours" };
    },
    openCode: async (e, b) => { try { return await openSecret(e, [KEY], b); } catch { return null; } },
    oauthConfig: () => CFG,
    exchangeCode: async (...a) => { log.exchanged.push(a); return GOOD; },
    sealRefreshToken: async (t, b) => { log.sealed.push([t, b]); return sealSecret(t, KEY, b); },
    storeConnection: async (...a) => { log.stored.push(a); return "33333333-3333-3333-3333-333333333333"; },
    ...over,
  };
  return { deps, log };
}

describe("finish: only the signed-in person who started the attempt connects anything (review r2, S4)", () => {
  it("reads exactly { handoff }, 64 hex characters", () => {
    expect(parseFinishRequest({ handoff: HANDOFF })).toEqual({ handoff: HANDOFF });
    for (const bad of [null, [], {}, { handoff: "short" }, { handoff: HANDOFF.toUpperCase() }, { handoff: HANDOFF, companyId: COMPANY }, { handoff: HANDOFF, actor: ACTOR }, { code: "x" }]) expect(parseFinishRequest(bad)).toBeNull();
  });
  it("the starter: the code is exchanged once, the refresh token sealed to workspace + environment + realm, only the envelope stored, as that person", async () => {
    const { deps, log } = await finishDeps();
    expect(await runQboFinish(deps, { handoff: HANDOFF })).toEqual({ status: 200, outcome: "connected" });
    expect(log.taken).toEqual([[await sha(HANDOFF), ACTOR]]);
    expect(log.exchanged).toEqual([["sandbox", "code-not-real", CFG.redirectUri]]);
    const binding = connectionBinding(COMPANY, "9341458604136919", "sandbox");
    expect(log.sealed).toEqual([["refresh-not-real-0001", binding]]);
    const [company, actor, realm, env, envelope] = log.stored[0] as string[];
    expect([company, actor, realm, env]).toEqual([COMPANY, ACTOR, "9341458604136919", "sandbox"]);
    expect(await openSecret(envelope, [KEY], binding)).toBe("refresh-not-real-0001");
  });
  it("THE ATTACK: someone else finishes an attempt another person started. Refused before Intuit is touched; no token ever exists; the attempt is over", async () => {
    const { deps, log } = await finishDeps({}, OTHER);
    expect(await runQboFinish(deps, { handoff: HANDOFF })).toEqual({ status: 403, outcome: "not_yours" });
    expect(log.exchanged).toHaveLength(0); expect(log.sealed).toHaveLength(0); expect(log.stored).toHaveLength(0);
    const starter = await finishDeps();
    const shared = { ...starter.deps, takeReturn: deps.takeReturn };   // the same parked return, now tried by the starter
    expect(await runQboFinish(shared, { handoff: HANDOFF })).toEqual({ status: 410, outcome: "expired" });   // already ended: single use
  });
  it("single use: a second finish by the starter gets nothing", async () => {
    const { deps, log } = await finishDeps();
    await runQboFinish(deps, { handoff: HANDOFF });
    expect(await runQboFinish(deps, { handoff: HANDOFF })).toEqual({ status: 410, outcome: "expired" });
    expect(log.exchanged).toHaveLength(1);
  });
  it.each<[string, Partial<FinishDeps>, number, string, boolean]>([
    ["no login", { authenticate: async () => null }, 401, "unauthenticated", false],
    ["the starter lost a right", { takeReturn: async () => ({ outcome: "forbidden" }) }, 403, "forbidden", true],
    ["the handoff expired", { takeReturn: async () => ({ outcome: "expired" }) }, 410, "expired", true],
    ["the app is no longer configured", { oauthConfig: () => null }, 503, "not_configured", true],
    ["the parked code cannot be opened", { openCode: async () => null }, 500, "failed", true],
    ["QuickBooks no longer accepts the code", { exchangeCode: async () => ({ ok: false, reason: "invalid_grant" }) }, 410, "expired", true],
    ["QuickBooks is unavailable", { exchangeCode: async () => ({ ok: false, reason: "unavailable" }) }, 503, "quickbooks_unavailable", true],
    ["QuickBooks rejects for another reason", { exchangeCode: async () => ({ ok: false, reason: "rejected" }) }, 502, "failed", true],
  ])("%s -> %i %s, nothing stored", async (_l, over, status, outcome, tookIt) => {
    const { deps, log } = await finishDeps(over);
    expect(await runQboFinish(deps, { handoff: HANDOFF })).toEqual({ status, outcome });
    expect(log.stored).toHaveLength(0);
    if (!tookIt) expect(log.taken).toHaveLength(0);   // without a login the database is never asked
  });
  it("a malformed request reaches nothing", async () => {
    const { deps, log } = await finishDeps();
    expect(await runQboFinish(deps, parseFinishRequest({ handoff: "x" }))).toEqual({ status: 400, outcome: "invalid_request" });
    expect(log.taken).toHaveLength(0);
  });
  it("no outcome carries the handoff, the code, a token or an envelope", async () => {
    const { deps } = await finishDeps();
    const text = JSON.stringify(await runQboFinish(deps, { handoff: HANDOFF }));
    for (const secret of [HANDOFF, "code-not-real", "refresh-not-real", "access-not-real", "v1.k1."]) expect(text).not.toContain(secret);
  });
});
