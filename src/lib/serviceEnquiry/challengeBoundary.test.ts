// The anti-abuse challenge for anonymous enquiries: configuration that fails closed, a server-side Turnstile verification that
// never trusts the browser, every failure state ending in a refusal, and the handler enforcing it for anonymous callers only.
// Every provider call here is a fake fetch — nothing reaches the network. Identities are synthetic.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BYPASS_MODE_VALUE,
  TURNSTILE_VERIFY_URL,
  createChallengeVerifier,
  createLocalBypassVerifier,
  createTurnstileVerifier,
  createUnconfiguredVerifier,
  isLocalStack,
  resolveChallengeConfig,
  type ChallengeVerifier,
  type EnvReader,
  type FetchLike,
} from "../../../supabase/functions/_shared/serviceEnquiryChallenge";
import { handleSubmitEnquiry, type EnquiryDeps, type RpcResult } from "../../../supabase/functions/_shared/serviceEnquiryHandler";
import { CHALLENGE_ACTION, CHALLENGE_FIELD, CHALLENGE_TOKEN_MAX_LENGTH, extractChallengeToken, requestFingerprint, validateEnquiryRequest } from "../../../supabase/functions/_shared/serviceEnquiryContract";
import { CHALLENGE_AUTO_RETRY_LIMIT, challengeState, readSiteKey, shouldAutoRetryChallenge } from "./challenge";
import { buildWireRequest, EMPTY_FORM_VALUES } from "./formModel";
import { interpretResponse } from "./client";

// The real client is built from Vite env variables; these tests only exercise how responses are interpreted.
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

const HOSTED = "https://abcdefghijklmnop.supabase.co";
const LOCAL = "http://127.0.0.1:54321";
const SECRET = "0x4AAAAAAA_this_is_a_server_secret_value_9f3c";
const TOKEN = "TOKEN.abc123.SECRET-CHALLENGE-RESPONSE";
const ADDRESS = "198.51.100.23";
const EMAIL = "ada.example@fixture-mail.dev";
const KEY = "0b2f3c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const USER = "5c1d7e2a-3b4c-4d5e-8f60-71829a0b1c2d";

const env = (vars: Record<string, string>): EnvReader => ({ get: (n) => vars[n] });

interface ProviderReply {
  ok?: boolean;
  status?: number;
  body?: unknown;
  raw?: string;
  throws?: Error;
  hang?: boolean;
}
function fakeFetch(reply: ProviderReply) {
  const calls: { url: string; body: string; method: string }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, method: init.method });
    if (reply.hang) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    if (reply.throws) throw reply.throws;
    const raw = reply.raw ?? JSON.stringify(reply.body ?? { success: true });
    return { ok: reply.ok ?? true, status: reply.status ?? 200, text: async () => raw };
  };
  return { fn, calls };
}
const verifierWith = (reply: ProviderReply, timeoutMs = 100, hostnames: string[] = []) => {
  const f = fakeFetch(reply);
  return { verifier: createTurnstileVerifier({ secret: SECRET, expectedHostnames: hostnames }, f.fn, timeoutMs), ...f };
};

describe("configuration fails closed and development bypass cannot reach production", () => {
  it("a missing secret in production is UNCONFIGURED, and an unconfigured verifier refuses every anonymous token", async () => {
    const cfg = resolveChallengeConfig(env({ SUPABASE_URL: HOSTED }));
    expect(cfg).toEqual({ mode: "unconfigured", reason: "missing_secret" });
    const v = createChallengeVerifier(cfg, fakeFetch({}).fn);
    expect(await v.verify(TOKEN)).toEqual({ kind: "unavailable", reason: "not_configured" });
    expect(await v.verify(null)).toEqual({ kind: "unavailable", reason: "not_configured" });
  });

  it("a malformed secret, an unknown mode and blank values are UNCONFIGURED — never a silent default", () => {
    for (const bad of ["short", "has a space in the middle 123456", "x".repeat(201)]) {
      expect(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED, TURNSTILE_SECRET_KEY: bad })), bad.slice(0, 10)).toMatchObject({ mode: "unconfigured", reason: "invalid_secret" });
    }
    expect(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED, TURNSTILE_SECRET_KEY: "   " }))).toMatchObject({ mode: "unconfigured", reason: "missing_secret" });
    expect(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED, TURNSTILE_SECRET_KEY: SECRET, ENQUIRY_CHALLENGE_MODE: "off" }))).toMatchObject({ mode: "unconfigured", reason: "invalid_mode" });
    expect(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED, TURNSTILE_SECRET_KEY: SECRET, ENQUIRY_CHALLENGE_MODE: "disabled" }))).toMatchObject({ mode: "unconfigured", reason: "invalid_mode" });
  });

  it("a valid secret selects Turnstile, with optional expected hostnames normalised", () => {
    expect(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED, TURNSTILE_SECRET_KEY: SECRET }))).toEqual({ mode: "turnstile", secret: SECRET, expectedHostnames: [] });
    expect(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED, TURNSTILE_SECRET_KEY: ` ${SECRET} `, TURNSTILE_EXPECTED_HOSTNAMES: "CFOClose.com, www.cfoclose.com ,," }))).toEqual({
      mode: "turnstile",
      secret: SECRET,
      expectedHostnames: ["cfoclose.com", "www.cfoclose.com"],
    });
  });

  it("the development bypass is EXPLICIT and honoured only on a local stack; on a hosted project it is an error, not a bypass", () => {
    expect(resolveChallengeConfig(env({ SUPABASE_URL: LOCAL, ENQUIRY_CHALLENGE_MODE: BYPASS_MODE_VALUE }))).toEqual({ mode: "bypass_local_development" });
    expect(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED, ENQUIRY_CHALLENGE_MODE: BYPASS_MODE_VALUE }))).toEqual({ mode: "unconfigured", reason: "unsafe_bypass" });
    expect(resolveChallengeConfig(env({ ENQUIRY_CHALLENGE_MODE: BYPASS_MODE_VALUE }))).toEqual({ mode: "unconfigured", reason: "unsafe_bypass" }); // no URL at all
    // Being local is not enough by itself: without the explicit mode there is no bypass.
    expect(resolveChallengeConfig(env({ SUPABASE_URL: LOCAL }))).toEqual({ mode: "unconfigured", reason: "missing_secret" });
    // A bypass request never falls back to a secret-based mode by accident.
    expect(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED, ENQUIRY_CHALLENGE_MODE: BYPASS_MODE_VALUE, TURNSTILE_SECRET_KEY: SECRET }))).toEqual({ mode: "unconfigured", reason: "unsafe_bypass" });
  });

  it("recognises a local stack only by its host — a hosted look-alike is not local", () => {
    for (const u of ["http://localhost:54321", "http://127.0.0.1:54321", "http://kong:8000", "http://host.docker.internal:54321", "http://app.localhost:3000"]) expect(isLocalStack(u), u).toBe(true);
    for (const u of [HOSTED, "https://localhost.evil.example", "https://127.0.0.1.evil.example", "https://kong.example.com", "not a url", "", undefined]) expect(isLocalStack(u as string), String(u)).toBe(false);
  });

  it("Cloudflare's 'always passes' test secret is refused outside a local stack, and allowed locally", () => {
    for (const testSecret of ["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000FF"]) {
      expect(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED, TURNSTILE_SECRET_KEY: testSecret })), testSecret).toEqual({ mode: "unconfigured", reason: "test_secret_outside_local" });
      expect(resolveChallengeConfig(env({ SUPABASE_URL: LOCAL, TURNSTILE_SECRET_KEY: testSecret })).mode, testSecret).toBe("turnstile");
    }
  });

  it("the local bypass verifier still needs a token, so the whole flow is exercised", async () => {
    const v = createLocalBypassVerifier();
    expect(await v.verify(TOKEN)).toEqual({ kind: "passed" });
    expect(await v.verify(null)).toEqual({ kind: "rejected", reason: "missing" });
    expect(await v.verify("")).toEqual({ kind: "rejected", reason: "missing" });
  });
});

describe("server-side Turnstile verification: the browser's token is only a claim", () => {
  it("calls the provider from the server with the secret and the token, and sends NO network identifier", async () => {
    const { verifier, calls } = verifierWith({ body: { success: true, hostname: "cfoclose.com", action: CHALLENGE_ACTION } });
    expect(await verifier.verify(TOKEN)).toEqual({ kind: "passed" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TURNSTILE_VERIFY_URL);
    expect(calls[0].method).toBe("POST");
    const sent = new URLSearchParams(calls[0].body);
    expect([...sent.keys()].sort()).toEqual(["response", "secret"]);
    expect(sent.get("secret")).toBe(SECRET);
    expect(sent.get("response")).toBe(TOKEN);
    expect(calls[0].body).not.toMatch(/remoteip|198\.51\.100/);
  });

  it("a missing token never reaches the provider", async () => {
    const { verifier, calls } = verifierWith({});
    for (const t of [null, ""]) expect(await verifier.verify(t as string | null)).toEqual({ kind: "rejected", reason: "missing" });
    expect(calls).toHaveLength(0);
  });

  it("a provider that says success:false is a rejection — invalid, missing, expired or REPLAYED", async () => {
    const cases: [string[], string][] = [
      [["invalid-input-response"], "invalid"],
      [["missing-input-response"], "missing"],
      [["timeout-or-duplicate"], "expired_or_replayed"],
      [["invalid-input-response", "timeout-or-duplicate"], "expired_or_replayed"],
    ];
    for (const [codes, reason] of cases) {
      const { verifier } = verifierWith({ body: { success: false, "error-codes": codes } });
      expect(await verifier.verify(TOKEN), codes.join()).toEqual({ kind: "rejected", reason });
    }
  });

  it("a wrong secret or a provider-side error is UNAVAILABLE (a configuration problem), never a pass and never blamed on the visitor", async () => {
    for (const codes of [["invalid-input-secret"], ["missing-input-secret"]]) {
      expect(await (await verifierWith({ body: { success: false, "error-codes": codes } })).verifier.verify(TOKEN)).toEqual({ kind: "unavailable", reason: "misconfigured" });
    }
    for (const codes of [["internal-error"], ["bad-request"], ["something-new"], []]) {
      expect(await (await verifierWith({ body: { success: false, "error-codes": codes } })).verifier.verify(TOKEN), codes.join()).toEqual({ kind: "unavailable", reason: "provider_error" });
    }
  });

  it("MALFORMED provider responses are unavailable, never a pass", async () => {
    const malformed: ProviderReply[] = [
      { raw: "<html>Bad gateway</html>" },
      { raw: "" },
      { raw: "null" },
      { raw: "[]" },
      { raw: "true" },
      { body: {} },
      { body: { success: "true" } },
      { body: { success: 1 } },
      { body: { ok: true } },
      { raw: "x".repeat(9000) },
    ];
    for (const m of malformed) expect(await (await verifierWith(m)).verifier.verify(TOKEN), JSON.stringify(m).slice(0, 40)).toMatchObject({ kind: "unavailable" });
  });

  it("an HTTP error is never a pass, even if the body claims success", async () => {
    expect(await verifierWith({ ok: false, status: 503, body: { success: true } }).verifier.verify(TOKEN)).toEqual({ kind: "unavailable", reason: "provider_error" });
    expect(await verifierWith({ ok: false, status: 502, raw: "Bad Gateway" }).verifier.verify(TOKEN)).toEqual({ kind: "unavailable", reason: "provider_error" });
  });

  it("a network failure and a provider that HANGS (timeout) are unavailable and the request is aborted", async () => {
    expect(await verifierWith({ throws: new Error("ECONNRESET 198.51.100.23") }).verifier.verify(TOKEN)).toEqual({ kind: "unavailable", reason: "provider_error" });
    const started = Date.now();
    expect(await verifierWith({ hang: true }, 40).verifier.verify(TOKEN)).toEqual({ kind: "unavailable", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a token minted for another widget action, or for another hostname, is refused", async () => {
    expect(await verifierWith({ body: { success: true, action: "login" } }).verifier.verify(TOKEN)).toEqual({ kind: "rejected", reason: "invalid" });
    expect(await verifierWith({ body: { success: true, action: CHALLENGE_ACTION, hostname: "evil.example" } }, 100, ["cfoclose.com"]).verifier.verify(TOKEN)).toEqual({ kind: "rejected", reason: "invalid" });
    expect(await verifierWith({ body: { success: true, action: CHALLENGE_ACTION } }, 100, ["cfoclose.com"]).verifier.verify(TOKEN)).toEqual({ kind: "rejected", reason: "invalid" }); // hostname absent
    expect(await verifierWith({ body: { success: true, action: CHALLENGE_ACTION, hostname: "CFOClose.com" } }, 100, ["cfoclose.com"]).verifier.verify(TOKEN)).toEqual({ kind: "passed" });
  });

  it("REPLAY: the same token verified twice passes once — the provider's duplicate answer becomes a rejection", async () => {
    let n = 0;
    const f: FetchLike = async () => {
      n += 1;
      const body = n === 1 ? { success: true, action: CHALLENGE_ACTION } : { success: false, "error-codes": ["timeout-or-duplicate"] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const v = createTurnstileVerifier({ secret: SECRET, expectedHostnames: [] }, f);
    expect(await v.verify(TOKEN)).toEqual({ kind: "passed" });
    expect(await v.verify(TOKEN)).toEqual({ kind: "rejected", reason: "expired_or_replayed" });
  });

  it("a verdict never contains the secret or the token", async () => {
    for (const reply of [{ body: { success: false, "error-codes": ["invalid-input-secret"] } }, { throws: new Error(`boom ${SECRET} ${TOKEN}`) }, { raw: `garbage ${SECRET} ${TOKEN}` }] as ProviderReply[]) {
      const out = JSON.stringify(await verifierWith(reply).verifier.verify(TOKEN));
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(TOKEN);
    }
  });
});

// ── the handler ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const created = { outcome: "created", reference: "CFQ-9F2A-71C0-3BDE", submitted_at: "2026-09-21T08:00:00.000Z", status: "submitted", acknowledgement: "pending", enquiry_id: "e1e1e1e1-0000-4000-8000-000000000001" };
const body = (over: Record<string, unknown> = {}) => ({ schema_version: 1, idempotency_key: KEY, service_code: "general", source_context: "contact_page", name: "Ada Example", email: EMAIL, subject: "A question about reporting", message: "A sufficiently long message body.", privacy_acknowledged: true, ...over });
const post = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request("https://fn.test/submit-service-enquiry", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ADDRESS, ...headers }, body: JSON.stringify(payload) });

function harness(verifier: ChallengeVerifier, opts: { userId?: string | null } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const logs: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<RpcResult> => {
    calls.push({ fn, args });
    if (fn === "submit_service_enquiry") return { data: created, error: null };
    if (fn === "enquiry_notification_claim") return { data: [], error: null };
    return { data: null, error: null };
  });
  const verify = vi.spyOn(verifier, "verify");
  const deps: EnquiryDeps = {
    rpc,
    log: (e) => void logs.push(e),
    verifyUserId: async () => opts.userId ?? null,
    hmacHex: async (_p, v) => `${"0".repeat(32)}${v.length.toString(16).padStart(32, "0")}`,
    correlationId: () => "enq-test-1",
    emailTimeoutMs: 100,
    challenge: verifier,
  };
  return { deps, calls, logs, verify, submitted: () => calls.some((c) => c.fn === "submit_service_enquiry") };
}
const errorCode = async (r: Response) => ((await r.json()) as { error?: { code?: string } }).error?.code;

describe("the endpoint enforces the challenge for anonymous submissions only", () => {
  const passing: ChallengeVerifier = { provider: "test", verify: async () => ({ kind: "passed" }) };

  it("ANONYMOUS without a token: 403 challenge_required, nothing is written and no rate-limit bucket is charged", async () => {
    const h = harness(createLocalBypassVerifier());
    const res = await handleSubmitEnquiry(post(body()), h.deps);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("challenge_required");
    expect(h.submitted()).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("ANONYMOUS with an invalid, expired or replayed token: 403 challenge_failed and nothing is written", async () => {
    for (const reason of ["invalid", "expired_or_replayed"] as const) {
      const h = harness({ provider: "test", verify: async () => ({ kind: "rejected", reason }) });
      const res = await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: TOKEN })), h.deps);
      expect(res.status, reason).toBe(403);
      expect(await errorCode(res), reason).toBe("challenge_failed");
      expect(h.submitted(), reason).toBe(false);
    }
  });

  it("ANONYMOUS when the challenge cannot be verified (timeout, outage, unconfigured): 503 challenge_unavailable — refused, never admitted", async () => {
    for (const reason of ["timeout", "provider_error", "malformed_response", "not_configured", "misconfigured"] as const) {
      const h = harness({ provider: "test", verify: async () => ({ kind: "unavailable", reason }) });
      const res = await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: TOKEN })), h.deps);
      expect(res.status, reason).toBe(503);
      expect(await errorCode(res), reason).toBe("challenge_unavailable");
      expect(res.headers.get("retry-after")).toBe("30");
      expect(h.submitted(), reason).toBe(false);
    }
  });

  it("a verifier that THROWS is a refusal, not a pass", async () => {
    const h = harness({ provider: "test", verify: async () => Promise.reject(new Error(`provider exploded ${TOKEN}`)) });
    const res = await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: TOKEN })), h.deps);
    expect(res.status).toBe(503);
    expect(h.submitted()).toBe(false);
    expect(JSON.stringify(await res.clone().text())).not.toContain(TOKEN);
  });

  it("an UNCONFIGURED production endpoint refuses anonymous enquiries end to end", async () => {
    const verifier = createChallengeVerifier(resolveChallengeConfig(env({ SUPABASE_URL: HOSTED })), fakeFetch({}).fn);
    const h = harness(verifier);
    const res = await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: TOKEN })), h.deps);
    expect(res.status).toBe(503);
    expect(h.submitted()).toBe(false);
  });

  it("ANONYMOUS with a token the provider confirms: the enquiry is recorded, and the token is NOT stored, fingerprinted or forwarded", async () => {
    const h = harness(passing);
    const res = await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: TOKEN })), h.deps);
    expect(res.status).toBe(201);
    expect(h.verify).toHaveBeenCalledWith(TOKEN);
    const stored = h.calls.find((c) => c.fn === "submit_service_enquiry")?.args.p_request as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(Object.keys(stored)).not.toContain(CHALLENGE_FIELD);
    // the fingerprint is the same with or without a token, so a retry with a fresh token replays instead of conflicting
    const withToken = validateEnquiryRequest(body({ [CHALLENGE_FIELD]: TOKEN }));
    const without = validateEnquiryRequest(body());
    expect(withToken.kind === "valid" && without.kind === "valid" && (await requestFingerprint(withToken.value)) === (await requestFingerprint(without.value))).toBe(true);
  });

  it("a SIGNED-IN user (verified JWT) is not challenged: rate limits and idempotency still apply", async () => {
    const verify = vi.fn(async () => ({ kind: "rejected", reason: "missing" }) as const);
    const h = harness({ provider: "test", verify }, { userId: USER });
    const res = await handleSubmitEnquiry(post(body(), { authorization: "Bearer a.b.c" }), h.deps);
    expect(res.status).toBe(201);
    expect(verify).not.toHaveBeenCalled();
    const req = h.calls.find((c) => c.fn === "submit_service_enquiry")?.args.p_request as { rate: { bucket: string }[]; idempotency_key: string; requester_user_id: string };
    expect(req.requester_user_id).toBe(USER);
    expect(req.idempotency_key).toBe(KEY);
    expect(req.rate.map((r) => r.bucket.split(":")[0])).toEqual(["ip", "email", "global"]);
  });

  it("an INVALID bearer token does not earn the exemption: it is anonymous and must pass the challenge", async () => {
    const h = harness(createLocalBypassVerifier(), { userId: null });
    const res = await handleSubmitEnquiry(post(body(), { authorization: "Bearer forged.jwt.value" }), h.deps);
    expect(res.status).toBe(403);
    expect(h.submitted()).toBe(false);
  });

  it("the honeypot, body limit, validation and rate limiting all remain in front of / behind the challenge", async () => {
    // honeypot: decoy receipt, no challenge call, nothing stored
    const trap = harness(passing);
    const decoy = await handleSubmitEnquiry(post(body({ enquiry_hp: "http://spam.invalid" })), trap.deps);
    expect(decoy.status).toBe(200);
    expect(trap.verify).not.toHaveBeenCalled();
    expect(trap.submitted()).toBe(false);
    // oversized body
    const big = harness(passing);
    expect((await handleSubmitEnquiry(post(body({ message: "x".repeat(20_000) })), big.deps)).status).toBe(413);
    expect(big.verify).not.toHaveBeenCalled();
    // validation failure never reaches the provider
    const bad = harness(passing);
    expect((await handleSubmitEnquiry(post(body({ email: "not-an-address" })), bad.deps)).status).toBe(400);
    expect(bad.verify).not.toHaveBeenCalled();
    // rate limiting still applies after a passed challenge
    const limited = harness(passing);
    limited.deps.rpc = vi.fn(async (fn) => (fn === "submit_service_enquiry" ? { data: { outcome: "rate_limited", retry_after_seconds: 120 }, error: null } : { data: null, error: null }));
    const res = await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: TOKEN })), limited.deps);
    expect(res.status).toBe(429);
    // idempotency still applies after a passed challenge
    const replay = harness(passing);
    replay.deps.rpc = vi.fn(async (fn) => (fn === "submit_service_enquiry" ? { data: { ...created, outcome: "replayed", acknowledgement: "sent" }, error: null } : { data: null, error: null }));
    const again = await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: TOKEN })), replay.deps);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
  });

  it("a malformed challenge field is a validation error that echoes nothing", async () => {
    for (const bad of [123, {}, ["x"], true, "x".repeat(CHALLENGE_TOKEN_MAX_LENGTH + 1)]) {
      const h = harness(passing);
      const res = await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: bad })), h.deps);
      expect(res.status, JSON.stringify(bad).slice(0, 20)).toBe(400);
      expect(await res.text()).not.toContain("xxxxxxxx");
      expect(h.submitted()).toBe(false);
    }
    expect(extractChallengeToken(body({ [CHALLENGE_FIELD]: "x".repeat(CHALLENGE_TOKEN_MAX_LENGTH + 1) }))).toBeNull();
    expect(extractChallengeToken(body())).toBeNull();
    expect(extractChallengeToken(body({ [CHALLENGE_FIELD]: TOKEN }))).toBe(TOKEN);
  });

  it("neither the token, the secret nor any address is ever logged — on success or on any refusal", async () => {
    const verifiers: ChallengeVerifier[] = [
      passing,
      { provider: "test", verify: async () => ({ kind: "rejected", reason: "invalid" }) },
      { provider: "test", verify: async () => ({ kind: "unavailable", reason: "timeout" }) },
      { provider: "test", verify: async () => Promise.reject(new Error(`leaky ${TOKEN} ${SECRET} ${ADDRESS}`)) },
    ];
    for (const v of verifiers) {
      const h = harness(v);
      const res = await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: TOKEN })), h.deps);
      await res.text();
      const everything = JSON.stringify(h.logs);
      for (const secret of [TOKEN, SECRET, ADDRESS, EMAIL]) expect(everything, `${v.provider}:${secret.slice(0, 8)}`).not.toContain(secret);
    }
    const refused = harness({ provider: "test", verify: async () => ({ kind: "rejected", reason: "expired_or_replayed" }) });
    await handleSubmitEnquiry(post(body({ [CHALLENGE_FIELD]: TOKEN })), refused.deps);
    expect(refused.logs).toContainEqual({ event: "enquiry.challenge", correlationId: "enq-test-1", provider: "test", outcome: "rejected", reason: "expired_or_replayed" });
  });
});

describe("the browser side: shows the widget, forwards the token, and cannot switch the check off", () => {
  it("only anonymous visitors (or a session the server refused) get the challenge; without a site key the form refuses to send", () => {
    expect(challengeState({ signedIn: false, forced: false, siteKey: "0x4AAAAAAAsitekey" })).toBe("required");
    expect(challengeState({ signedIn: true, forced: false, siteKey: "0x4AAAAAAAsitekey" })).toBe("not_needed");
    expect(challengeState({ signedIn: true, forced: true, siteKey: "0x4AAAAAAAsitekey" })).toBe("required");
    expect(challengeState({ signedIn: false, forced: false, siteKey: null })).toBe("unavailable");
    expect(challengeState({ signedIn: true, forced: true, siteKey: null })).toBe("unavailable");
  });

  it("the public site key is validated; anything else is treated as absent", () => {
    expect(readSiteKey("0x4AAAAAAAxxxxxxxxxxxxxx")).toBe("0x4AAAAAAAxxxxxxxxxxxxxx");
    expect(readSiteKey("1x00000000000000000000AA")).toBe("1x00000000000000000000AA");
    for (const bad of [undefined, null, "", "  ", "short", "has space in it 12345", "<script>alert(1)</script>", 42, {}]) expect(readSiteKey(bad), String(bad)).toBeNull();
  });

  it("the token travels in the wire request only when supplied, and is never part of the validated enquiry", () => {
    const values = { ...EMPTY_FORM_VALUES, name: "Ada", email: EMAIL, subject: "A question about reporting", message: "A sufficiently long message body.", privacy: true };
    const ctx = { serviceCode: "general", sourceContext: "contact_page" } as const;
    expect(buildWireRequest(values, ctx, KEY)).not.toHaveProperty(CHALLENGE_FIELD);
    expect(buildWireRequest(values, ctx, KEY, null)).not.toHaveProperty(CHALLENGE_FIELD);
    expect(buildWireRequest(values, ctx, KEY, TOKEN)).toMatchObject({ [CHALLENGE_FIELD]: TOKEN });
    const parsed = validateEnquiryRequest(buildWireRequest(values, ctx, KEY, TOKEN));
    expect(parsed.kind).toBe("valid");
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
  });

  it("a challenge refusal maps to its own outcome; other 403s and an unavailable verifier do not", () => {
    expect(interpretResponse(403, { error: { code: "challenge_required" } })).toEqual({ kind: "challenge" });
    expect(interpretResponse(403, { error: { code: "challenge_failed" } })).toEqual({ kind: "challenge" });
    expect(interpretResponse(403, { error: { code: "forbidden" } })).toEqual({ kind: "unavailable" });
    expect(interpretResponse(403, null)).toEqual({ kind: "unavailable" });
    expect(interpretResponse(503, { error: { code: "challenge_unavailable" } })).toEqual({ kind: "unavailable" });
  });

  it("no browser-side flag can bypass the check: the form has no 'skip' path and the secret key never appears in src/", () => {
    const ROOT = path.resolve(__dirname, "../../..");
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(path.join(ROOT, "src")).filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p))) {
      const text = fs.readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/TURNSTILE_SECRET_KEY|ENQUIRY_CHALLENGE_MODE|bypass_for_local_development/);
    }
    const form = fs.readFileSync(path.join(ROOT, "src/components/enquiry/ServiceEnquiryForm.tsx"), "utf8");
    expect(form).toMatch(/challenge === "unavailable"[\s\S]*?return;/);
    expect(form).toMatch(/challenge === "required" && !challengeToken[\s\S]*?return;/);
    expect(form).toMatch(/challenge === "required" \? challengeToken : null/);
    expect(form).toMatch(/case "challenge":\s*setForceChallenge\(true\)/);
  });

  it("the shared secret-handling modules never write a token or secret to a log call", () => {
    const ROOT = path.resolve(__dirname, "../../..");
    for (const f of ["supabase/functions/_shared/serviceEnquiryChallenge.ts", "supabase/functions/_shared/serviceEnquiryHandler.ts", "supabase/functions/_shared/serviceEnquiryWiring.ts"]) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const line of text.split("\n").filter((l) => /console\.|deps\.log\(/.test(l))) expect(line, `${f}: ${line.trim()}`).not.toMatch(/token|secret|challenge_token|remoteip|address|clientAddress|x-real-ip/i);
    }
    expect(fs.readFileSync(path.join(ROOT, "supabase/functions/_shared/serviceEnquiryChallenge.ts"), "utf8")).not.toMatch(/console\./);
  });

  it("the deployed function reads its secret only from the function environment", () => {
    const ROOT = path.resolve(__dirname, "../../..");
    const wiring = fs.readFileSync(path.join(ROOT, "supabase/functions/_shared/serviceEnquiryWiring.ts"), "utf8");
    expect(wiring).toMatch(/resolveChallengeConfig\(\{ get: \(name\) => Deno\.env\.get\(name\) \}\)/);
    expect(wiring).toMatch(/createChallengeVerifier\(/);
    expect(createUnconfiguredVerifier().provider).toBe("unconfigured");
  });
});
