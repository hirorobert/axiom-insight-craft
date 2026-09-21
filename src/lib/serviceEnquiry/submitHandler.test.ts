// The submit-service-enquiry endpoint and the notification dispatcher, exercised through their real request handlers with
// injected fake dependencies (no Deno runtime is needed). Test identities are synthetic `.test` addresses.

import { describe, expect, it, vi } from "vitest";
import {
  handleDispatchNotifications,
  handleSubmitEnquiry,
  type ClaimedNotification,
  type DispatchDeps,
  type EnquiryDeps,
  type RpcResult,
} from "../../../supabase/functions/_shared/serviceEnquiryHandler";
import { buildRequesterAcknowledgement, buildStaffNotification, ENQUIRY_EMAIL_FROM } from "../../../supabase/functions/_shared/serviceEnquiryEmail";
import { MAX_REQUEST_BODY_BYTES, RATE_POLICY } from "../../../supabase/functions/_shared/serviceEnquiryContract";

const KEY = "0b2f3c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const REFERENCE = "CFQ-9F2A-71C0-3BDE";
const SUBMITTED = "2026-09-21T08:00:00.000Z";
const USER = "5c1d7e2a-3b4c-4d5e-8f60-71829a0b1c2d";
const SECRET_MESSAGE = "Confidential message body ZEBRA-7781 that must never be logged.";
const SECRET_EMAIL = "grace.hopper@example.test";
const SECRET_IP = "203.0.113.77";
const SECRET_TOKEN = "eyJ.header.SECRET-TOKEN-SIGNATURE";

const body = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  idempotency_key: KEY,
  service_code: "general",
  source_context: "contact_page",
  name: "Grace Example",
  email: SECRET_EMAIL,
  subject: "Question about reporting",
  message: SECRET_MESSAGE,
  privacy_acknowledged: true,
  ...over,
});

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request("https://fn.test/submit-service-enquiry", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const created = { outcome: "created", reference: REFERENCE, submitted_at: SUBMITTED, status: "submitted", acknowledgement: "pending", enquiry_id: "e1e1e1e1-0000-4000-8000-000000000001", notification_ids: { requester_acknowledgement: "n1", staff_notification: "n2" } };

interface Harness {
  deps: EnquiryDeps & { rpc: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> };
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  logs: unknown[];
}

function harness(opts: { submit?: RpcResult; claimed?: ClaimedNotification[]; verify?: (t: string) => Promise<string | null>; sendEmail?: EnquiryDeps["sendEmail"] | null; internalRecipient?: string | null } = {}): Harness {
  const rpcCalls: Harness["rpcCalls"] = [];
  const logs: unknown[] = [];
  const claimed: ClaimedNotification[] = opts.claimed ?? [
    { id: "n1", kind: "requester_acknowledgement", attempt: 1, reference: REFERENCE, service_code: "general", source_context: "contact_page", country_code: null, requester_email: SECRET_EMAIL, requester_name: "Grace Example" },
    { id: "n2", kind: "staff_notification", attempt: 1, reference: REFERENCE, service_code: "general", source_context: "contact_page", country_code: null, requester_email: null, requester_name: null },
  ];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<RpcResult> => {
    rpcCalls.push({ fn, args });
    if (fn === "submit_service_enquiry") return opts.submit ?? { data: created, error: null };
    if (fn === "enquiry_notification_claim") return { data: claimed, error: null };
    if (fn === "enquiry_notification_complete") return { data: { status: "sent", changed: true }, error: null };
    return { data: null, error: null };
  });
  const log = vi.fn((e: Record<string, unknown>) => void logs.push(e));
  const deps = {
    rpc,
    log,
    verifyUserId: opts.verify ?? (async () => null),
    hmacHex: async (purpose: string, value: string) => `${purpose === "ip" ? "a" : "b"}${"0".repeat(31)}${value.length.toString(16).padStart(32, "0")}`.slice(0, 64),
    correlationId: () => "enq-test-1",
    sendEmail: opts.sendEmail === null ? undefined : (opts.sendEmail ?? (async () => ({ providerMessageId: "prov-1" }))),
    internalRecipient: opts.internalRecipient === undefined ? "triage@example.test" : opts.internalRecipient,
    emailTimeoutMs: 200,
  } as Harness["deps"];
  return { deps, rpcCalls, logs };
}

const submitArgs = (h: Harness) => h.rpcCalls.find((c) => c.fn === "submit_service_enquiry")?.args.p_request as Record<string, unknown>;
const completes = (h: Harness) => h.rpcCalls.filter((c) => c.fn === "enquiry_notification_complete").map((c) => c.args);
const jsonOf = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("submit-service-enquiry — success paths", () => {
  it("anonymous success: 201 with ONLY the public receipt (reference, time, status, acknowledgement, replayed)", async () => {
    const h = harness();
    const res = await handleSubmitEnquiry(post(body()), h.deps);
    expect(res.status).toBe(201);
    const b = await jsonOf(res);
    expect(Object.keys(b).sort()).toEqual(["acknowledgement", "reference", "replayed", "status", "submitted_at"]);
    expect(b).toMatchObject({ reference: REFERENCE, submitted_at: SUBMITTED, status: "submitted", replayed: false });
    expect(JSON.stringify(b)).not.toMatch(/enquiry_id|notification_ids|e1e1e1e1|"n1"/);
    expect(submitArgs(h).requester_user_id).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("authenticated success: the user id is derived from the VERIFIED token and passed to the database", async () => {
    const verify = vi.fn(async (t: string) => (t === SECRET_TOKEN ? USER : null));
    const h = harness({ verify });
    const res = await handleSubmitEnquiry(post(body(), { authorization: `Bearer ${SECRET_TOKEN}` }), h.deps);
    expect(res.status).toBe(201);
    expect(verify).toHaveBeenCalledWith(SECRET_TOKEN);
    expect(submitArgs(h).requester_user_id).toBe(USER);
  });

  it("a client-supplied user id is refused as an unknown field — identity is never taken from the body", async () => {
    const h = harness({ verify: async () => USER });
    const res = await handleSubmitEnquiry(post(body({ requester_user_id: "00000000-0000-4000-8000-000000000099" }), { authorization: "Bearer x.y.z" }), h.deps);
    expect(res.status).toBe(400);
    expect(h.rpcCalls.find((c) => c.fn === "submit_service_enquiry")).toBeUndefined();
  });

  it("an unverifiable token (anon key, expired, forged) is treated as anonymous — never trusted, never a guess", async () => {
    for (const verify of [async () => null, async () => { throw new Error("jwks unreachable"); }]) {
      const h = harness({ verify });
      const res = await handleSubmitEnquiry(post(body(), { authorization: "Bearer anon.key.value" }), h.deps);
      expect(res.status).toBe(201);
      expect(submitArgs(h).requester_user_id).toBeNull();
    }
  });

  it("sends the normalised content and a request fingerprint that is stable for the same content and different for changed content", async () => {
    const a = harness(); const b = harness(); const c = harness();
    await handleSubmitEnquiry(post(body({ email: "  GRACE.HOPPER@Example.TEST " })), a.deps);
    await handleSubmitEnquiry(post(body({ idempotency_key: "11111111-2222-4333-8444-555555555555" })), b.deps);
    await handleSubmitEnquiry(post(body({ message: `${SECRET_MESSAGE} (edited)` })), c.deps);
    expect(submitArgs(a).requester_email).toBe(SECRET_EMAIL);
    expect(submitArgs(a).request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(submitArgs(a).request_fingerprint).toBe(submitArgs(b).request_fingerprint);
    expect(submitArgs(a).request_fingerprint).not.toBe(submitArgs(c).request_fingerprint);
  });
});

describe("submit-service-enquiry — validation and limits", () => {
  it("rejects unknown fields, invalid email and invalid country with field-level codes and NEVER echoes a value", async () => {
    const h = harness();
    const res = await handleSubmitEnquiry(post(body({ email: "not-an-email", country: "XX", surprise: SECRET_MESSAGE })), h.deps);
    expect(res.status).toBe(400);
    const b = await jsonOf(res);
    expect((b.error as { code: string }).code).toBe("validation_failed");
    const fields = (b.fields as { field: string; code: string }[]).map((f) => `${f.field}:${f.code}`).sort();
    expect(fields).toEqual(["country:invalid_format", "email:invalid_format", "surprise:unknown_field"]);
    expect(JSON.stringify(b)).not.toContain("not-an-email");
    expect(JSON.stringify(b)).not.toContain("ZEBRA-7781");
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("rejects an oversized body by Content-Length and while streaming (no Content-Length)", async () => {
    const h = harness();
    const big = JSON.stringify(body({ message: "m".repeat(MAX_REQUEST_BODY_BYTES) }));
    const declared = await handleSubmitEnquiry(post(big, { "content-length": String(big.length) }), h.deps);
    expect(declared.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const streamed = await handleSubmitEnquiry(new Request("https://fn.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit), h.deps);
    expect(streamed.status).toBe(413);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("rejects a non-JSON content type (415), invalid JSON (400) and a non-POST method (405); answers CORS preflight", async () => {
    const h = harness();
    expect((await handleSubmitEnquiry(new Request("https://fn.test/x", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }), h.deps)).status).toBe(415);
    expect((await handleSubmitEnquiry(post("{not json"), h.deps)).status).toBe(400);
    expect((await handleSubmitEnquiry(new Request("https://fn.test/x", { method: "GET" }), h.deps)).status).toBe(405);
    const pre = await handleSubmitEnquiry(new Request("https://fn.test/x", { method: "OPTIONS" }), h.deps);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("maps database constraint failures to a safe 400 and other failures to a generic 500 that exposes no database detail", async () => {
    const constraint = harness({ submit: { data: null, error: { code: "23514", message: 'violates check constraint "chk_secret_internal_name"' } } });
    const r1 = await handleSubmitEnquiry(post(body()), constraint.deps);
    expect(r1.status).toBe(400);
    const outage = harness({ submit: { data: null, error: { code: "XX000", message: "connection to server at 10.0.0.5 failed, password authentication failed for user postgres" } } });
    const r2 = await handleSubmitEnquiry(post(body()), outage.deps);
    expect(r2.status).toBe(500);
    const text = JSON.stringify(await jsonOf(r2));
    expect(text).not.toMatch(/10\.0\.0\.5|password|postgres|chk_secret/);
    expect(text).toContain("internal_error");
  });
});

describe("submit-service-enquiry — honeypot", () => {
  it("a filled honeypot stores NOTHING, sends nothing and receives a plausible receipt", async () => {
    const h = harness();
    const res = await handleSubmitEnquiry(post(body({ enquiry_hp: "http://spam.example.test" })), h.deps);
    expect(res.status).toBe(200);
    expect(((await jsonOf(res)).reference as string)).toMatch(/^CFQ-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(h.rpcCalls).toHaveLength(0);
    expect(h.logs).toEqual([{ event: "enquiry.honeypot", correlationId: "enq-test-1" }]);
  });

  it("is checked BEFORE validation, so a bot learns nothing from field errors", async () => {
    const h = harness();
    const res = await handleSubmitEnquiry(post({ enquiry_hp: "x", name: 5 }), h.deps);
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toHaveLength(0);
  });
});

describe("submit-service-enquiry — rate limiting and idempotency", () => {
  it("sends HASHED bucket keys (ip, email, global) — never the raw address or IP", async () => {
    const h = harness();
    await handleSubmitEnquiry(post(body(), { "x-forwarded-for": `${SECRET_IP}, 10.0.0.1` }), h.deps);
    const rate = submitArgs(h).rate as { bucket: string; limit: number; window_seconds: number }[];
    expect(rate.map((r) => r.bucket.split(":")[0])).toEqual(["ip", "email", "global"]);
    expect(rate[0]).toMatchObject({ limit: RATE_POLICY.ip.limit, window_seconds: RATE_POLICY.ip.windowSeconds });
    expect(rate[1]).toMatchObject({ limit: RATE_POLICY.email.limit, window_seconds: RATE_POLICY.email.windowSeconds });
    expect(rate[2]).toMatchObject({ bucket: "global:all", limit: RATE_POLICY.global.limit });
    const serialised = JSON.stringify(h.rpcCalls.map((c) => c.args.rate));
    expect(serialised).not.toContain(SECRET_IP);
    expect(serialised).not.toContain(SECRET_EMAIL);
    expect(rate[0].bucket).toMatch(/^ip:[0-9a-f]{32}$/);
    expect(rate[1].bucket).toMatch(/^email:[0-9a-f]{32}$/);
  });

  it("without any client address only the email and global buckets are used (no shared 'unknown' bucket that could lock everyone out)", async () => {
    const h = harness();
    await handleSubmitEnquiry(post(body()), h.deps);
    expect((submitArgs(h).rate as { bucket: string }[]).map((r) => r.bucket.split(":")[0])).toEqual(["email", "global"]);
  });

  it("a rate-limited outcome is a 429 with Retry-After and a retry_after_seconds field, and sends no email", async () => {
    const h = harness({ submit: { data: { outcome: "rate_limited", retry_after_seconds: 321 }, error: null } });
    const res = await handleSubmitEnquiry(post(body()), h.deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("321");
    expect((await jsonOf(res)).retry_after_seconds).toBe(321);
    expect(h.rpcCalls.filter((c) => c.fn.startsWith("enquiry_notification"))).toHaveLength(0);
  });

  it("a duplicate click / idempotent replay returns the ORIGINAL receipt (200, replayed: true) without a second email", async () => {
    const replay = { outcome: "replayed", reference: REFERENCE, submitted_at: SUBMITTED, status: "submitted", acknowledgement: "sent", enquiry_id: "e1e1e1e1-0000-4000-8000-000000000001" };
    const h = harness({ submit: { data: replay, error: null } });
    const res = await handleSubmitEnquiry(post(body()), h.deps);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ reference: REFERENCE, submitted_at: SUBMITTED, status: "submitted", acknowledgement: "sent", replayed: true });
    expect(h.rpcCalls.filter((c) => c.fn.startsWith("enquiry_notification"))).toHaveLength(0);
  });

  it("re-using an idempotency key with changed content is refused (409) and reveals nothing about the original", async () => {
    const h = harness({ submit: { data: { outcome: "idempotency_conflict" }, error: null } });
    const res = await handleSubmitEnquiry(post(body({ message: "A different message entirely, long enough." })), h.deps);
    expect(res.status).toBe(409);
    const b = JSON.stringify(await jsonOf(res));
    expect(b).toContain("idempotency_key_reuse");
    expect(b).not.toContain(REFERENCE);
  });
});

describe("submit-service-enquiry — logging never contains personal data", () => {
  it("across success, replay, rate limit, validation failure, database failure and email failure, no log line contains the message, email, IP or token", async () => {
    const scenarios: [Harness, Request][] = [
      [harness(), post(body(), { authorization: `Bearer ${SECRET_TOKEN}`, "x-forwarded-for": SECRET_IP })],
      [harness({ submit: { data: { outcome: "replayed", reference: REFERENCE, submitted_at: SUBMITTED, status: "submitted", acknowledgement: "pending", enquiry_id: "x" }, error: null } }), post(body(), { "x-forwarded-for": SECRET_IP })],
      [harness({ submit: { data: { outcome: "rate_limited", retry_after_seconds: 5 }, error: null } }), post(body(), { "x-forwarded-for": SECRET_IP })],
      [harness(), post(body({ email: SECRET_EMAIL + "!!", surprise: SECRET_MESSAGE }), { "x-forwarded-for": SECRET_IP })],
      [harness({ submit: { data: null, error: { code: "XX000", message: `boom ${SECRET_EMAIL} ${SECRET_MESSAGE}` } } }), post(body(), { authorization: `Bearer ${SECRET_TOKEN}` })],
      [harness({ sendEmail: async () => { throw new Error(`smtp rejected ${SECRET_EMAIL} ${SECRET_MESSAGE}`); } }), post(body(), { "x-forwarded-for": SECRET_IP })],
      [harness(), post({ enquiry_hp: SECRET_MESSAGE })],
    ];
    for (const [h, req] of scenarios) await handleSubmitEnquiry(req, h.deps);
    const all = scenarios.map(([h]) => JSON.stringify(h.logs)).join("\n") + scenarios.map(([h]) => JSON.stringify(completes(h))).join("\n");
    for (const secret of [SECRET_MESSAGE, "ZEBRA-7781", SECRET_EMAIL, SECRET_IP, "SECRET-TOKEN", "Grace Example", "smtp rejected"]) expect(all, secret).not.toContain(secret);
    expect(scenarios[0][0].logs.length).toBeGreaterThan(0);
  });
});

describe("submit-service-enquiry — notifications never lose or roll back the enquiry", () => {
  it("email configured and working: the acknowledgement state becomes 'sent' and the outbox rows are completed", async () => {
    const send = vi.fn(async () => ({ providerMessageId: "prov-9" }));
    const h = harness({ sendEmail: send });
    const b = await jsonOf(await handleSubmitEnquiry(post(body()), h.deps));
    expect(b.acknowledgement).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
    expect(completes(h).map((c) => c.p_outcome)).toEqual(["sent", "sent"]);
  });

  it("the email provider FAILS: the enquiry is still recorded (201), the receipt says 'pending', the row is retried, and only a machine code is stored", async () => {
    const h = harness({ sendEmail: async () => { throw new Error(`provider said no to ${SECRET_EMAIL}`); } });
    const res = await handleSubmitEnquiry(post(body()), h.deps);
    expect(res.status).toBe(201);
    expect((await jsonOf(res)).acknowledgement).toBe("pending");
    expect(completes(h)).toEqual([
      { p_id: "n1", p_outcome: "retry", p_provider_message_id: null, p_error_code: "PROVIDER_ERROR" },
      { p_id: "n2", p_outcome: "retry", p_provider_message_id: null, p_error_code: "PROVIDER_ERROR" },
    ]);
    expect(JSON.stringify(completes(h))).not.toContain(SECRET_EMAIL);
  });

  it("the provider HANGS: a timeout is recorded, the response still arrives, the enquiry stands", async () => {
    const h = harness({ sendEmail: () => new Promise(() => undefined) });
    const res = await handleSubmitEnquiry(post(body()), h.deps);
    expect(res.status).toBe(201);
    expect((await jsonOf(res)).acknowledgement).toBe("pending");
    expect(completes(h).every((c) => c.p_error_code === "PROVIDER_TIMEOUT")).toBe(true);
  });

  it("application email NOT configured: the receipt says 'unavailable' (never 'sent'), rows are marked blocked, nothing is guessed", async () => {
    const h = harness({ sendEmail: null });
    const res = await handleSubmitEnquiry(post(body()), h.deps);
    expect(res.status).toBe(201);
    expect((await jsonOf(res)).acknowledgement).toBe("unavailable");
    expect(completes(h)).toEqual([
      { p_id: "n1", p_outcome: "blocked", p_provider_message_id: null, p_error_code: "EMAIL_NOT_CONFIGURED" },
      { p_id: "n2", p_outcome: "blocked", p_provider_message_id: null, p_error_code: "EMAIL_NOT_CONFIGURED" },
    ]);
  });

  it("no internal recipient configured: the acknowledgement is still sent, the internal notice is blocked — the recipient is never guessed", async () => {
    const send = vi.fn(async () => ({ providerMessageId: "p" }));
    const h = harness({ sendEmail: send, internalRecipient: null });
    const b = await jsonOf(await handleSubmitEnquiry(post(body()), h.deps));
    expect(b.acknowledgement).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(completes(h).map((c) => `${c.p_outcome}:${c.p_error_code ?? ""}`)).toEqual(["sent:", "blocked:INTERNAL_RECIPIENT_NOT_CONFIGURED"]);
  });

  it("the claim RPC itself failing still returns the receipt", async () => {
    const h = harness();
    h.deps.rpc.mockImplementation(async (fn: string) => (fn === "submit_service_enquiry" ? { data: created, error: null } : { data: null, error: { code: "XX000" } }));
    const res = await handleSubmitEnquiry(post(body()), h.deps);
    expect(res.status).toBe(201);
    expect((await jsonOf(res)).acknowledgement).toBe("pending");
  });
});

describe("notification content", () => {
  it("the requester acknowledgement carries the reference and 'not acceptance' language and NOTHING from the enquiry", () => {
    const m = buildRequesterAcknowledgement({ reference: REFERENCE, to: SECRET_EMAIL, notificationId: "n1" });
    expect(m.from).toBe("CFOClose <noreply@notify.cfoclose.com>");
    expect(m.senderDomain).toBe("notify.cfoclose.com");
    expect(m.purpose).toBe("transactional");
    expect(m.idempotencyKey).toBe("n1");
    for (const part of [m.subject, m.text, m.html]) {
      expect(part).toContain(REFERENCE);
      expect(part).not.toMatch(/ZEBRA|Confidential|Question about reporting|Grace/);
    }
    expect(m.text).toMatch(/not acceptance of an engagement/i);
    expect(m.text).toMatch(/do not send passwords/i);
  });

  it("the internal notification carries reference, service, country code and source only — no requester details", () => {
    const m = buildStaffNotification({ reference: REFERENCE, serviceCode: "donor_reporting", countryCode: null, sourceContext: "workflow_donor", to: "triage@example.test", notificationId: "n2" });
    expect(m.text).toContain(REFERENCE);
    expect(m.text).toContain("donor_reporting");
    expect(m.text).not.toMatch(/@|Grace|ZEBRA/);
    expect(m.text).toContain("https://cfoclose.com/admin/enquiries");
  });

  it("the sender is the verified application domain used by the authentication emails", () => {
    expect(ENQUIRY_EMAIL_FROM).toBe("CFOClose <noreply@notify.cfoclose.com>");
  });

  it("HTML-escapes anything it interpolates", () => {
    const m = buildRequesterAcknowledgement({ reference: '<script>alert("x")</script>', to: "a@example.test", notificationId: "n" });
    expect(m.html).not.toContain("<script>");
  });
});

describe("dispatch-enquiry-notifications (staff-triggered retry)", () => {
  const dispatchDeps = (staff: boolean, check?: () => Promise<boolean>) => {
    const h = harness();
    const deps: DispatchDeps = { ...h.deps, isPlatformStaff: check ?? (async () => staff) };
    return { h, deps };
  };
  const req = (headers: Record<string, string> = {}) => new Request("https://fn.test/dispatch", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

  it("refuses everyone who is not verified ACTIVE platform staff (403) and touches nothing", async () => {
    for (const headers of [{}, { authorization: "Bearer a.b.c" }]) {
      const { h, deps } = dispatchDeps(false);
      const res = await handleDispatchNotifications(req(headers), deps);
      expect(res.status).toBe(403);
      expect(h.rpcCalls).toHaveLength(0);
    }
  });

  it("staff can retry: it claims, sends, and returns only counts", async () => {
    const { h, deps } = dispatchDeps(true);
    const res = await handleDispatchNotifications(req({ authorization: "Bearer a.b.c" }), deps);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ claimed: 2, sent: 2, retry: 0, failed: 0, blocked: 0 });
    expect(h.rpcCalls[0]).toMatchObject({ fn: "enquiry_notification_claim", args: { p_limit: 25, p_enquiry_id: null } });
  });

  it("a staff-check that throws is treated as 'not staff'", async () => {
    const { deps } = dispatchDeps(true, async () => { throw new Error("boom"); });
    expect((await handleDispatchNotifications(req({ authorization: "Bearer a.b.c" }), deps)).status).toBe(403);
  });
});
