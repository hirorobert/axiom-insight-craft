// The submit-service-enquiry request handler and the notification dispatcher, written against injected dependencies so
// every behaviour is unit-testable without a Deno runtime (see src/lib/serviceEnquiry/submitHandler.test.ts). The Edge
// Function entry points only wire real dependencies (service-role client, JWT verification, HMAC, email transport).
//
// Guarantees enforced here (each has a test):
//   * identity comes ONLY from a verified JWT — there is no client-supplied user id field, and an unverifiable token means
//     "anonymous", never a guess;
//   * the body is size-capped while it is read, unknown fields are rejected, and errors never echo a submitted value;
//   * a filled honeypot stores nothing and is not told why;
//   * rate limiting keys are HMACs of the client address / email — a raw address is never stored or logged;
//   * the enquiry commits atomically in the database BEFORE any email is attempted; email trouble can never lose or roll it back;
//   * nothing about the request (message, email, tokens, payload, IP) is ever logged — events carry codes and a correlation id only.

import {
  HONEYPOT_FIELD,
  MAX_REQUEST_BODY_BYTES,
  RATE_POLICY,
  hasHoneypot,
  requestFingerprint,
  validateEnquiryRequest,
  type AcknowledgementState,
  type EnquiryErrorCode,
  type EnquiryReceipt,
  type FieldError,
  type NormalizedEnquiry,
} from "./serviceEnquiryContract.ts";
import { buildRequesterAcknowledgement, buildStaffNotification, type OutboundEmail } from "./serviceEnquiryEmail.ts";

export interface RpcResult {
  readonly data: unknown;
  readonly error: { readonly code?: string; readonly message?: string } | null;
}

export interface EnquiryDeps {
  rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult>;
  /** Returns the verified user id for a real user JWT, or null (anon key, expired, forged, malformed). Never throws upstream. */
  verifyUserId(token: string): Promise<string | null>;
  /** Keyed hash (hex) of a value under a server secret; the raw value is never persisted or logged. */
  hmacHex(purpose: string, value: string): Promise<string>;
  /** Undefined when application email delivery is not configured: nothing is sent and the receipt says so. */
  sendEmail?: (email: OutboundEmail) => Promise<{ providerMessageId?: string | null }>;
  /** The internal notification destination. Never guessed: absent means no internal email is attempted. */
  internalRecipient?: string | null;
  log(event: Record<string, unknown>): void;
  correlationId(): string;
  emailTimeoutMs?: number;
}

export interface DispatchDeps extends EnquiryDeps {
  isPlatformStaff(token: string): Promise<boolean>;
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } as const;

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });

const ERROR_MESSAGES: Readonly<Record<EnquiryErrorCode, string>> = {
  method_not_allowed: "This endpoint accepts POST requests only.",
  unsupported_media_type: "Send the request as application/json.",
  payload_too_large: "The request is too large.",
  invalid_json: "The request body is not valid JSON.",
  validation_failed: "Some fields need attention.",
  idempotency_key_reuse: "This submission key was already used with different content. Start a new enquiry.",
  rate_limited: "Too many enquiries have been sent. Please try again later.",
  internal_error: "We could not record your enquiry right now. Please try again shortly.",
};

const fail = (status: number, code: EnquiryErrorCode, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response =>
  json(status, { error: { code, message: ERROR_MESSAGES[code] }, ...extra }, headers);

async function readBodyCapped(req: Request, max: number): Promise<{ text: string } | { tooLarge: true }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  if (!req.body) return { text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > max) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(all) };
}

const bearerToken = (req: Request): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
};

function clientAddress(req: Request): string | null {
  const direct = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip");
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const v = (direct ?? forwarded ?? "").trim();
  return v === "" ? null : v;
}

function decoyReceipt(): EnquiryReceipt {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return { reference: `CFQ-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`, submitted_at: new Date().toISOString(), status: "submitted", acknowledgement: "pending", replayed: false };
}

// ── notification dispatch (used inline after commit, and by the staff-triggered retry) ──────────────────────────────────

export interface ClaimedNotification {
  readonly id: string;
  readonly kind: "requester_acknowledgement" | "staff_notification";
  readonly attempt: number;
  readonly reference: string;
  readonly service_code: string;
  readonly source_context: string;
  readonly country_code: string | null;
  readonly requester_email: string | null;
  readonly requester_name: string | null;
}

export interface DispatchOutcome {
  readonly id: string;
  readonly kind: ClaimedNotification["kind"];
  readonly outcome: "sent" | "retry" | "failed" | "blocked";
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Attempts each claimed notification exactly once and records the outcome. Never throws. */
export async function dispatchClaimed(rows: readonly ClaimedNotification[], deps: EnquiryDeps): Promise<DispatchOutcome[]> {
  const outcomes: DispatchOutcome[] = [];
  for (const row of rows) {
    let outcome: DispatchOutcome["outcome"];
    let code: string | null = null;
    let providerId: string | null = null;
    try {
      let email: OutboundEmail | null = null;
      if (!deps.sendEmail) {
        outcome = "blocked";
        code = "EMAIL_NOT_CONFIGURED";
      } else if (row.kind === "requester_acknowledgement") {
        if (!row.requester_email) {
          outcome = "failed";
          code = "NO_RECIPIENT";
        } else {
          email = buildRequesterAcknowledgement({ reference: row.reference, to: row.requester_email, notificationId: row.id });
          outcome = "retry";
        }
      } else if (!deps.internalRecipient) {
        outcome = "blocked";
        code = "INTERNAL_RECIPIENT_NOT_CONFIGURED";
      } else {
        email = buildStaffNotification({ reference: row.reference, serviceCode: row.service_code, countryCode: row.country_code, sourceContext: row.source_context, to: deps.internalRecipient, notificationId: row.id });
        outcome = "retry";
      }
      if (email && deps.sendEmail) {
        try {
          const sent = await withTimeout(deps.sendEmail(email), deps.emailTimeoutMs ?? 4000);
          outcome = "sent";
          providerId = sent.providerMessageId ?? null;
        } catch (e) {
          outcome = "retry";
          code = e instanceof Error && e.message === "timeout" ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR"; // a code only — provider text may echo an address
        }
      }
    } catch {
      outcome = "retry";
      code = "DISPATCH_ERROR";
    }
    try {
      await deps.rpc("enquiry_notification_complete", { p_id: row.id, p_outcome: outcome, p_provider_message_id: providerId, p_error_code: code });
    } catch {
      /* the row stays pending and is retried; the enquiry is unaffected */
    }
    deps.log({ event: "enquiry.notification", kind: row.kind, outcome, code });
    outcomes.push({ id: row.id, kind: row.kind, outcome });
  }
  return outcomes;
}

async function notifyAfterCommit(enquiryId: string, deps: EnquiryDeps): Promise<AcknowledgementState> {
  try {
    const claim = await deps.rpc("enquiry_notification_claim", { p_limit: 5, p_enquiry_id: enquiryId });
    if (claim.error || !Array.isArray(claim.data)) return deps.sendEmail ? "pending" : "unavailable";
    const outcomes = await dispatchClaimed(claim.data as ClaimedNotification[], deps);
    const ack = outcomes.find((o) => o.kind === "requester_acknowledgement");
    if (!ack) return deps.sendEmail ? "pending" : "unavailable";
    return ack.outcome === "sent" ? "sent" : ack.outcome === "blocked" || ack.outcome === "failed" ? "unavailable" : "pending";
  } catch {
    return deps.sendEmail ? "pending" : "unavailable";
  }
}

const receiptAck = (stored: unknown, deps: EnquiryDeps): AcknowledgementState =>
  stored === "sent" ? "sent" : !deps.sendEmail || stored === "unavailable" ? "unavailable" : "pending";

// ── the endpoint ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function handleSubmitEnquiry(req: Request, deps: EnquiryDeps): Promise<Response> {
  const correlationId = deps.correlationId();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return fail(415, "unsupported_media_type");

  const body = await readBodyCapped(req, MAX_REQUEST_BODY_BYTES);
  if ("tooLarge" in body) {
    deps.log({ event: "enquiry.rejected", correlationId, code: "payload_too_large" });
    return fail(413, "payload_too_large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return fail(400, "invalid_json");
  }

  if (hasHoneypot(parsed)) {
    deps.log({ event: "enquiry.honeypot", correlationId });
    return json(200, decoyReceipt()); // nothing is stored; a bot is not told why
  }

  const validation = validateEnquiryRequest(parsed);
  if (validation.kind === "invalid") {
    deps.log({ event: "enquiry.rejected", correlationId, code: "validation_failed", fields: validation.errors.map((e: FieldError) => e.field) });
    return fail(400, "validation_failed", { fields: validation.errors });
  }
  const enquiry: NormalizedEnquiry = validation.value;

  const token = bearerToken(req);
  let userId: string | null = null;
  if (token) {
    try {
      userId = await deps.verifyUserId(token);
    } catch {
      userId = null; // an unverifiable token is anonymous — never trusted, never guessed
    }
  }

  const rate: { bucket: string; limit: number; window_seconds: number }[] = [];
  const address = clientAddress(req);
  if (address) rate.push({ bucket: `ip:${(await deps.hmacHex("ip", address)).slice(0, 32)}`, limit: RATE_POLICY.ip.limit, window_seconds: RATE_POLICY.ip.windowSeconds });
  rate.push({ bucket: `email:${(await deps.hmacHex("email", enquiry.requester_email)).slice(0, 32)}`, limit: RATE_POLICY.email.limit, window_seconds: RATE_POLICY.email.windowSeconds });
  rate.push({ bucket: "global:all", limit: RATE_POLICY.global.limit, window_seconds: RATE_POLICY.global.windowSeconds });

  const { data, error } = await deps.rpc("submit_service_enquiry", {
    p_request: {
      idempotency_key: enquiry.idempotency_key,
      request_fingerprint: await requestFingerprint(enquiry),
      requester_user_id: userId,
      requester_name: enquiry.requester_name,
      requester_email: enquiry.requester_email,
      organization: enquiry.organization,
      country_code: enquiry.country_code,
      service_code: enquiry.service_code,
      source_context: enquiry.source_context,
      subject: enquiry.subject,
      message: enquiry.message,
      payload_schema_version: enquiry.payload_schema_version,
      payload: enquiry.payload,
      rate,
    },
  });

  if (error || !data || typeof data !== "object") {
    const dbCode = error?.code ?? "unknown";
    deps.log({ event: "enquiry.failed", correlationId, code: dbCode });
    if (["22023", "23514", "22P02", "22007", "23502"].includes(dbCode)) return fail(400, "validation_failed");
    return fail(500, "internal_error");
  }

  const result = data as Record<string, unknown>;
  switch (result.outcome) {
    case "rate_limited": {
      const retryAfter = Math.max(1, Number(result.retry_after_seconds) || 60);
      deps.log({ event: "enquiry.rate_limited", correlationId });
      return fail(429, "rate_limited", { retry_after_seconds: retryAfter }, { "Retry-After": String(retryAfter) });
    }
    case "idempotency_conflict":
      deps.log({ event: "enquiry.rejected", correlationId, code: "idempotency_key_reuse" });
      return fail(409, "idempotency_key_reuse");
    case "created":
    case "replayed": {
      const replayed = result.outcome === "replayed";
      const enquiryId = typeof result.enquiry_id === "string" ? result.enquiry_id : null;
      let acknowledgement = receiptAck(result.acknowledgement, deps);
      // The enquiry is already committed. Email is attempted afterwards and its failure changes only the receipt's honesty.
      if (enquiryId && (!replayed || acknowledgement === "pending")) acknowledgement = await notifyAfterCommit(enquiryId, deps);
      const receipt: EnquiryReceipt = {
        reference: String(result.reference),
        submitted_at: String(result.submitted_at),
        status: "submitted",
        acknowledgement,
        replayed,
      };
      deps.log({ event: replayed ? "enquiry.replayed" : "enquiry.created", correlationId, acknowledgement, authenticated: userId !== null });
      return json(replayed ? 200 : 201, receipt);
    }
    default:
      deps.log({ event: "enquiry.failed", correlationId, code: "unknown_outcome" });
      return fail(500, "internal_error");
  }
}

// ── staff-triggered retry of pending notifications ──────────────────────────────────────────────────────────────────────

export async function handleDispatchNotifications(req: Request, deps: DispatchDeps): Promise<Response> {
  const correlationId = deps.correlationId();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");
  const token = bearerToken(req);
  let staff = false;
  if (token) {
    try {
      staff = await deps.isPlatformStaff(token);
    } catch {
      staff = false;
    }
  }
  if (!staff) {
    deps.log({ event: "enquiry.dispatch_denied", correlationId });
    return json(403, { error: { code: "forbidden", message: "Platform staff only." } });
  }
  const claim = await deps.rpc("enquiry_notification_claim", { p_limit: 25, p_enquiry_id: null });
  if (claim.error || !Array.isArray(claim.data)) {
    deps.log({ event: "enquiry.dispatch_failed", correlationId, code: claim.error?.code ?? "unknown" });
    return fail(500, "internal_error");
  }
  const outcomes = await dispatchClaimed(claim.data as ClaimedNotification[], deps);
  const tally = { claimed: outcomes.length, sent: 0, retry: 0, failed: 0, blocked: 0 };
  for (const o of outcomes) tally[o.outcome] += 1;
  deps.log({ event: "enquiry.dispatch", correlationId, ...tally });
  return json(200, tally);
}

export { HONEYPOT_FIELD };
