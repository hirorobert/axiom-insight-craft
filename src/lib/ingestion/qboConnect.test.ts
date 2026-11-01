// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { OAUTH_STATE_TTL_SECONDS, parseCallbackQuery, parseConnectStartRequest, runQboCallback, runQboConnectStart, type CallbackDeps, type ConnectStartDeps } from "../../../supabase/functions/_shared/qboConnect";
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
    expect(parseConnectStartRequest({ companyId: COMPANY, environment: "sandbox" })).toEqual({ companyId: COMPANY, environment: "sandbox" });
    for (const bad of [null, [], {}, { companyId: COMPANY }, { companyId: COMPANY, environment: "staging" }, { companyId: "x", environment: "sandbox" },
      { companyId: COMPANY, environment: "sandbox", actor: ACTOR }, { companyId: COMPANY, environment: "sandbox", realmId: "1" }]) {
      expect(parseConnectStartRequest(bad)).toBeNull();
    }
  });
  it("stores only the hash of the state and returns the authorisation address that carries the state", async () => {
    const { deps, started } = startDeps();
    const r = await runQboConnectStart(deps, { companyId: COMPANY, environment: "sandbox" });
    expect(r.status).toBe(200);
    if (r.outcome !== "authorize") throw new Error("expected authorize");
    const u = new URL(r.authorizeUrl);
    expect(u.searchParams.get("state")).toBe(STATE);
    expect(u.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(started).toEqual([[await sha(STATE), COMPANY, ACTOR, "sandbox", OAUTH_STATE_TTL_SECONDS]]);
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
    const r = await runQboConnectStart(deps, { companyId: COMPANY, environment: "production" });
    expect([r.status, r.outcome]).toEqual([status, outcome]);
    // nothing reaches the database unless there is a login, a configured app and a strong state
    if (["unauthenticated", "not_configured"].includes(outcome) || over.randomState) expect(started).toHaveLength(0);
  });
  it("never calls the database without a login", async () => {
    const { deps, started } = startDeps({ authenticate: async () => null });
    await runQboConnectStart(deps, { companyId: COMPANY, environment: "sandbox" });
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

const GOOD: TokenResult = { ok: true, tokens: { accessToken: "access-not-real", refreshToken: "refresh-not-real-0001", accessExpiresInSeconds: 3600, refreshExpiresAt: "2027-02-09T12:00:00.000Z", hardExpiresAt: "2031-11-01T12:00:00.000Z" } };
function callbackDeps(over: Partial<CallbackDeps> = {}) {
  const log = { consumed: [] as string[], exchanged: [] as unknown[][], stored: [] as unknown[][], sealed: [] as unknown[][] };
  const deps: CallbackDeps = {
    sha256Hex: sha,
    consumeState: async (h) => { log.consumed.push(h); return { companyId: COMPANY, actorUserId: ACTOR, environment: "sandbox" }; },
    oauthConfig: () => CFG,
    exchangeCode: async (...a) => { log.exchanged.push(a); return GOOD; },
    sealRefreshToken: async (t, b) => { log.sealed.push([t, b]); return sealSecret(t, KEY, b); },
    storeConnection: async (...a) => { log.stored.push(a); return "33333333-3333-3333-3333-333333333333"; },
    returnTo: (c, s) => `https://app.example.test/workspace/${c}?qbo=${s}`,
    ...over,
  };
  return { deps, log };
}
const QUERY = { state: STATE, code: "code-not-real", realmId: "9341458604136919", denied: false };

describe("callback", () => {
  it("refuses a malformed request without touching anything", async () => {
    const { deps, log } = callbackDeps();
    expect(await runQboCallback(deps, null)).toEqual({ status: 400, outcome: "invalid_request" });
    expect(log.consumed).toHaveLength(0);
  });
  it("refuses an unknown, expired or used state: a plain 400 with no redirect and no exchange", async () => {
    const { deps, log } = callbackDeps({ consumeState: async () => null });
    expect(await runQboCallback(deps, QUERY)).toEqual({ status: 400, outcome: "unknown_state" });
    expect(log.exchanged).toHaveLength(0);
  });
  it("on success: consumes the state first, exchanges once, seals the refresh token bound to workspace + environment + realm, stores only the envelope", async () => {
    const { deps, log } = callbackDeps();
    const r = await runQboCallback(deps, QUERY);
    expect(r).toMatchObject({ status: 302, outcome: "connected", location: `https://app.example.test/workspace/${COMPANY}?qbo=connected` });
    expect(log.consumed).toEqual([await sha(STATE)]);
    expect(log.exchanged).toEqual([["sandbox", "code-not-real", CFG.redirectUri]]);
    const binding = connectionBinding(COMPANY, QUERY.realmId, "sandbox");
    expect(log.sealed).toEqual([["refresh-not-real-0001", binding]]);
    const [company, actor, realm, env, envelope, refreshExpiresAt, hardExpiresAt] = log.stored[0] as string[];
    expect([company, actor, realm, env, refreshExpiresAt, hardExpiresAt]).toEqual([COMPANY, ACTOR, QUERY.realmId, "sandbox", GOOD.ok && GOOD.tokens.refreshExpiresAt, GOOD.ok && GOOD.tokens.hardExpiresAt]);
    expect(envelope).not.toContain("refresh-not-real");
    expect(await openSecret(envelope, [KEY], binding)).toBe("refresh-not-real-0001");
    // the envelope opens for no other workspace, realm or environment
    for (const other of [connectionBinding(ACTOR, QUERY.realmId, "sandbox"), connectionBinding(COMPANY, "123", "sandbox"), connectionBinding(COMPANY, QUERY.realmId, "production")]) {
      await expect(openSecret(envelope, [KEY], other)).rejects.toThrow();
    }
  });
  it("the browser is sent back with a status word only: no code, state, token or envelope in the redirect or the result", async () => {
    const { deps } = callbackDeps();
    const r = await runQboCallback(deps, QUERY);
    const text = JSON.stringify(r);
    for (const secret of [QUERY.code, STATE, "refresh-not-real", "access-not-real", "v1.k1."]) expect(text).not.toContain(secret);
  });
  it("a person who declined at QuickBooks: the state is consumed, nothing is exchanged, the browser learns 'denied'", async () => {
    const { deps, log } = callbackDeps();
    const r = await runQboCallback(deps, { state: STATE, code: null, realmId: null, denied: true });
    expect(r).toMatchObject({ status: 302, outcome: "denied" });
    expect(log.consumed).toHaveLength(1); expect(log.exchanged).toHaveLength(0); expect(log.stored).toHaveLength(0);
  });
  it.each<[string, Partial<CallbackDeps>, Partial<typeof QUERY>]>([
    ["no code", {}, { code: null as never }],
    ["no realm", {}, { realmId: null as never }],
    ["the app is no longer configured", { oauthConfig: () => null }, {}],
    ["QuickBooks refuses the code", { exchangeCode: async () => ({ ok: false, reason: "invalid_grant" }) }, {}],
    ["QuickBooks is unavailable", { exchangeCode: async () => ({ ok: false, reason: "unavailable" }) }, {}],
    ["sealing fails (no key)", { sealRefreshToken: async () => { throw new Error("no key"); } }, {}],
    ["the database refuses the connection (the right was lost)", { storeConnection: async () => { throw new Error("FORBIDDEN"); } }, {}],
  ])("%s -> 'failed', nothing stored", async (_l, over, q) => {
    const { deps, log } = callbackDeps(over);
    const r = await runQboCallback(deps, { ...QUERY, ...q });
    expect(r).toMatchObject({ status: 302, outcome: "failed" });
    expect(log.consumed).toHaveLength(1);
    if (over.storeConnection === undefined) expect(log.stored).toHaveLength(0);
  });
  it("the state is consumed exactly once, even when the exchange throws", async () => {
    const { deps, log } = callbackDeps({ exchangeCode: vi.fn(async () => { throw new Error("network"); }) });
    const r = await runQboCallback(deps, QUERY);
    expect(r).toMatchObject({ outcome: "failed" });
    expect(log.consumed).toHaveLength(1);
  });
});
