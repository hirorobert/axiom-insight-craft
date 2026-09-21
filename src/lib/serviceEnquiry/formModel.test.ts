// The pure form model, the client's response interpretation, and the receipt/attempt store — the behaviours behind
// "focus moves to the first invalid field", "double submission is safe" and "a refresh never silently resubmits".

import { FunctionsHttpError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real client is built from Vite env variables; the tests exercise only how its responses are interpreted.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));
import { interpretResponse, parseReceipt, submitServiceEnquiry, type EnquiryWireRequest } from "./client";
import {
  EMPTY_FORM_VALUES,
  buildErrorSummary,
  buildWireRequest,
  checkForm,
  describeFieldError,
  errorElementId,
  fieldElementId,
  firstInvalidElementId,
  type EnquiryFormValues,
} from "./formModel";
import { clearAttempt, clearReceipt, loadAttempt, loadReceipt, resolveAttempt, saveAttempt, saveReceipt } from "./receiptStore";

const CTX = { serviceCode: "general", sourceContext: "contact_page" } as const;
const KEY = "0b2f3c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

const filled = (over: Partial<EnquiryFormValues> = {}): EnquiryFormValues => ({
  ...EMPTY_FORM_VALUES,
  name: "Test Requester",
  email: "requester@example.test",
  subject: "Question about reporting",
  message: "A synthetic message that is long enough to pass.",
  privacy: true,
  ...over,
});

describe("buildWireRequest", () => {
  it("sends the versioned wire shape with only the fields that were filled", () => {
    const wire = buildWireRequest(filled({ payload: { report_type: "other", donor_name: "  " } }), CTX, KEY);
    expect(wire).toMatchObject({ schema_version: 1, idempotency_key: KEY, service_code: "general", source_context: "contact_page", privacy_acknowledged: true });
    expect(wire.payload).toEqual({ report_type: "other" });
    expect("organization" in wire).toBe(false);
    expect("country" in wire).toBe(false);
    expect("enquiry_hp" in wire).toBe(false);
    expect(buildWireRequest(filled({ honeypot: "bot" }), CTX, KEY).enquiry_hp).toBe("bot");
  });

  it("email is the ONLY contact channel: there is no phone or preferred-contact-method field anywhere in the model", () => {
    const keys = [...Object.keys(EMPTY_FORM_VALUES), ...Object.keys(buildWireRequest(filled({ organization: "Org", country: "KE" }), CTX, KEY))].join(" ");
    expect(keys).not.toMatch(/phone|mobile|tel|whatsapp|preferred|contact_method|callback/i);
  });

  it("never carries a user id — identity is decided by the server from the verified token", () => {
    expect(Object.keys(buildWireRequest(filled(), CTX, KEY)).join(" ")).not.toMatch(/user|uid|owner|staff/i);
  });
});

describe("checkForm", () => {
  it("accepts a complete valid form and returns normalised content", () => {
    const r = checkForm(filled({ email: "  Requester@Example.TEST " }), CTX);
    expect(r.kind).toBe("valid");
    if (r.kind === "valid") expect(r.normalized.requester_email).toBe("requester@example.test");
  });

  it("uses the SAME rules as the server: unknown country, missing consent and short message are all caught client-side", () => {
    const r = checkForm(filled({ country: "XX", privacy: false, message: "short" }), CTX);
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.errors.map((e) => `${e.field}:${e.code}`).sort()).toEqual(["country:invalid_format", "message:too_short", "privacy_acknowledged:consent_required"]);
  });

  it("a donor form with a bad deadline is refused with the field named", () => {
    const r = checkForm(filled({ payload: { deadline: "2026-02-30" } }), { serviceCode: "donor_reporting", sourceContext: "workflow_donor" });
    expect(r.kind === "invalid" && r.errors.some((e) => e.field === "payload.deadline")).toBe(true);
  });
});

describe("focus and the error summary", () => {
  const errs = (fields: string[]) => fields.map((field) => ({ field, code: "required" as const }));

  it("focus goes to the FIRST invalid field in page order, whatever order the errors arrive in", () => {
    expect(firstInvalidElementId(errs(["privacy_acknowledged", "message", "email", "subject"]), "enq-contact")).toBe("enq-contact-email");
    expect(firstInvalidElementId(errs(["message", "privacy_acknowledged"]), "enq-contact")).toBe("enq-contact-message");
    expect(firstInvalidElementId(errs(["payload.deadline", "payload.donor_name", "name"]), "enq-donor")).toBe("enq-donor-name");
    expect(firstInvalidElementId([], "enq-contact")).toBeNull();
  });

  it("the summary has one entry per field (first error wins), in page order, each pointing at a real element id", () => {
    const summary = buildErrorSummary([{ field: "message", code: "too_short" }, { field: "email", code: "invalid_format" }, { field: "email", code: "required" }], "enq-contact");
    expect(summary.map((s) => s.field)).toEqual(["email", "message"]);
    expect(summary[0].elementId).toBe(fieldElementId("enq-contact", "email"));
    expect(summary[0].message).toBe("Enter a valid email address, such as name@company.com.");
  });

  it("dotted payload field names become safe DOM ids and error ids are distinct", () => {
    expect(fieldElementId("enq-donor", "payload.report_type")).toBe("enq-donor-payload-report-type");
    expect(errorElementId("enq-donor", "payload.report_type")).toBe("enq-donor-payload-report-type-error");
  });

  it("error wording is specific and never echoes a value", () => {
    expect(describeFieldError("email", "invalid_format")).toMatch(/valid email address/);
    expect(describeFieldError("privacy_acknowledged", "consent_required")).toMatch(/privacy notice/);
    expect(describeFieldError("payload.currency", "invalid_format")).toMatch(/three-letter/);
    expect(describeFieldError("payload.report_type", "required")).toMatch(/^Select /);
    expect(describeFieldError("name", "required")).toMatch(/^Enter /);
  });
});

describe("interpretResponse", () => {
  const receipt = { reference: "CFQ-9F2A-71C0-3BDE", submitted_at: "2026-09-21T08:00:00.000Z", status: "submitted", acknowledgement: "pending", replayed: false };

  it("a 200 or 201 with a well-formed receipt is success", () => {
    for (const status of [200, 201]) expect(interpretResponse(status, receipt)).toEqual({ kind: "receipt", receipt });
  });

  it("a success status with a malformed body is NOT success", () => {
    for (const bad of [null, {}, { ...receipt, reference: "not-a-reference" }, { ...receipt, acknowledgement: "delivered" }, { ...receipt, status: "accepted" }]) expect(interpretResponse(201, bad)).toEqual({ kind: "unavailable" });
  });

  it("maps 400 (with or without fields), 409, 429 and everything else", () => {
    expect(interpretResponse(400, { error: { code: "validation_failed" }, fields: [{ field: "email", code: "invalid_format" }] })).toEqual({ kind: "invalid", fields: [{ field: "email", code: "invalid_format" }] });
    expect(interpretResponse(400, "garbage")).toEqual({ kind: "invalid", fields: [] });
    expect(interpretResponse(409, { error: { code: "idempotency_key_reuse" } })).toEqual({ kind: "conflict" });
    expect(interpretResponse(429, { retry_after_seconds: 120.4 })).toEqual({ kind: "rate_limited", retryAfterSeconds: 120 });
    expect(interpretResponse(429, null)).toEqual({ kind: "rate_limited", retryAfterSeconds: 60 });
    for (const s of [0, 401, 413, 500, 502, 503]) expect(interpretResponse(s, {})).toEqual({ kind: "unavailable" });
  });

  it("parseReceipt accepts only the exact receipt shape", () => {
    expect(parseReceipt(receipt)).toEqual(receipt);
    expect(parseReceipt({ ...receipt, extra: 1 })).toEqual(receipt);
    expect(parseReceipt({ ...receipt, submitted_at: "" })).toBeNull();
    expect(parseReceipt("nope")).toBeNull();
  });
});

describe("receipt and attempt store (sessionStorage)", () => {
  const stubStorage = () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    vi.stubGlobal("window", { sessionStorage: storage });
    return map;
  };
  afterEach(() => vi.unstubAllGlobals());

  const receipt = { reference: "CFQ-9F2A-71C0-3BDE", submitted_at: "2026-09-21T08:00:00.000Z", status: "submitted", acknowledgement: "pending", replayed: false } as const;

  it("a receipt survives a page refresh (reload reads it back) and 'send another' clears it", () => {
    stubStorage();
    expect(loadReceipt("contact")).toBeNull();
    saveReceipt("contact", receipt);
    expect(loadReceipt("contact")).toEqual(receipt); // what a remounted form reads — no blank, resubmittable form
    expect(loadReceipt("donor")).toBeNull(); // per form
    clearReceipt("contact");
    expect(loadReceipt("contact")).toBeNull();
  });

  it("stores only the receipt and a fingerprint — never any form text", () => {
    const map = stubStorage();
    saveReceipt("contact", receipt);
    saveAttempt("contact", { key: KEY, fingerprint: "a".repeat(64) });
    const stored = [...map.values()].join(" ");
    expect(stored).not.toMatch(/message|subject|email|name/i);
    expect([...map.keys()].every((k) => k.startsWith("cfoclose:enquiry-"))).toBe(true);
  });

  it("ignores corrupt or wrongly-shaped stored values instead of trusting them", () => {
    const map = stubStorage();
    map.set("cfoclose:enquiry-receipt:v1:contact", "{not json");
    expect(loadReceipt("contact")).toBeNull();
    map.set("cfoclose:enquiry-receipt:v1:contact", JSON.stringify({ reference: "x" }));
    expect(loadReceipt("contact")).toBeNull();
    map.set("cfoclose:enquiry-attempt:v1:contact", JSON.stringify({ key: "nope", fingerprint: "nope" }));
    expect(loadAttempt("contact")).toBeNull();
  });

  it("works when storage is unavailable or throws (private mode, blocked site data)", () => {
    vi.stubGlobal("window", { get sessionStorage(): Storage { throw new Error("blocked"); } });
    expect(() => saveReceipt("contact", receipt)).not.toThrow();
    expect(loadReceipt("contact")).toBeNull();
    vi.stubGlobal("window", { sessionStorage: { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } } });
    expect(() => { saveAttempt("contact", { key: KEY, fingerprint: "a".repeat(64) }); clearAttempt("contact"); clearReceipt("contact"); }).not.toThrow();
    expect(loadAttempt("contact")).toBeNull();
  });

  it("idempotency attempt: same content re-uses the key (a safe replay); changed content gets a NEW key", () => {
    stubStorage();
    const fresh = () => "11111111-2222-4333-8444-555555555555";
    const first = resolveAttempt(null, "a".repeat(64), () => KEY);
    expect(first.key).toBe(KEY);
    saveAttempt("contact", first);
    expect(resolveAttempt(loadAttempt("contact"), "a".repeat(64), fresh)).toEqual(first);
    expect(resolveAttempt(loadAttempt("contact"), "b".repeat(64), fresh)).toEqual({ key: fresh(), fingerprint: "b".repeat(64) });
    clearAttempt("contact");
    expect(loadAttempt("contact")).toBeNull();
  });
});

describe("submitServiceEnquiry — the one browser path to the backend", () => {
  const wire: EnquiryWireRequest = { schema_version: 1, idempotency_key: KEY, service_code: "general", source_context: "contact_page", name: "T", email: "t@example.test", subject: "Subject here", message: "Long enough message body", privacy_acknowledged: true };
  const receipt = { reference: "CFQ-9F2A-71C0-3BDE", submitted_at: "2026-09-21T08:00:00.000Z", status: "submitted", acknowledgement: "pending", replayed: false };
  beforeEach(() => invoke.mockReset());

  it("invokes ONLY the submit-service-enquiry Edge Function with the request as the body", async () => {
    invoke.mockResolvedValue({ data: receipt, error: null });
    expect(await submitServiceEnquiry(wire)).toEqual({ kind: "receipt", receipt });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("submit-service-enquiry", { body: wire });
  });

  it("turns an HTTP error from the function into the matching outcome (validation, rate limit, conflict)", async () => {
    const http = (status: number, body: unknown) => new FunctionsHttpError(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    invoke.mockResolvedValueOnce({ data: null, error: http(400, { error: { code: "validation_failed" }, fields: [{ field: "email", code: "invalid_format" }] }) });
    expect(await submitServiceEnquiry(wire)).toEqual({ kind: "invalid", fields: [{ field: "email", code: "invalid_format" }] });
    invoke.mockResolvedValueOnce({ data: null, error: http(429, { retry_after_seconds: 90 }) });
    expect(await submitServiceEnquiry(wire)).toEqual({ kind: "rate_limited", retryAfterSeconds: 90 });
    invoke.mockResolvedValueOnce({ data: null, error: http(409, {}) });
    expect(await submitServiceEnquiry(wire)).toEqual({ kind: "conflict" });
  });

  it("a network failure, a thrown error or a malformed success is UNAVAILABLE — never success", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: new Error("Failed to fetch") });
    expect(await submitServiceEnquiry(wire)).toEqual({ kind: "unavailable" });
    invoke.mockRejectedValueOnce(new Error("boom"));
    expect(await submitServiceEnquiry(wire)).toEqual({ kind: "unavailable" });
    invoke.mockResolvedValueOnce({ data: { ok: true }, error: null });
    expect(await submitServiceEnquiry(wire)).toEqual({ kind: "unavailable" });
  });
});
