// The shared enquiry contract: validation, normalisation, fingerprinting — and static PARITY with the SQL migration, so the
// TypeScript rules and the database's own constraints can never silently drift apart.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import corpus from "../../../supabase/functions/_shared/serviceEnquiryEmailCorpus.json";
import { ISO_REGION_CODES } from "@/lib/jurisdiction/registry";
import {
  HONEYPOT_FIELD,
  ISO_3166_ALPHA2,
  LIMITS,
  REPORTING_FREQUENCIES,
  REPORT_TYPES,
  SERVICE_CODES,
  SOURCE_CONTEXTS,
  enquiryEmailIsValid,
  hasHoneypot,
  requestFingerprint,
  stableStringify,
  validateEnquiryRequest,
  type NormalizedEnquiry,
} from "./contract";

const ROOT = path.resolve(__dirname, "../../..");
const SQL = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260921100000_service_enquiry_intake.sql"), "utf8");
const KEY = "0b2f3c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

const base = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  idempotency_key: KEY,
  service_code: "general",
  source_context: "contact_page",
  name: "Test Requester",
  email: "requester@example.test",
  subject: "Question about reporting",
  message: "A synthetic message that is long enough to pass.",
  privacy_acknowledged: true,
  ...over,
});

const errorsOf = (input: unknown) => {
  const r = validateEnquiryRequest(input);
  return r.kind === "invalid" ? r.errors : [];
};
const hasError = (input: unknown, field: string, code?: string) => errorsOf(input).some((e) => e.field === field && (code === undefined || e.code === code));

describe("validateEnquiryRequest — accepted requests", () => {
  it("accepts a minimal general enquiry and normalises it", () => {
    const r = validateEnquiryRequest(base({ email: "  Requester@Example.TEST ", name: "  Test Requester  ", country: " ke ", organization: "  " }));
    expect(r.kind).toBe("valid");
    if (r.kind !== "valid") return;
    expect(r.value.requester_email).toBe("requester@example.test");
    expect(r.value.requester_name).toBe("Test Requester");
    expect(r.value.country_code).toBe("KE");
    expect(r.value.organization).toBeNull();
    expect(r.value.payload).toEqual({});
    expect(r.value.payload_schema_version).toBe(1);
    expect(r.honeypot).toBe(false);
  });

  it("accepts a full donor payload and keeps only the fields that were filled", () => {
    const r = validateEnquiryRequest(
      base({ service_code: "donor_reporting", source_context: "workflow_donor", payload: { report_type: "fund_accountability", donor_name: "Example Fund", project_name: "", reporting_frequency: "quarterly", currency: "USD", deadline: "2026-12-31", additional_context: "Line one\nLine two" } }),
    );
    expect(r.kind).toBe("valid");
    if (r.kind !== "valid") return;
    expect(Object.keys(r.value.payload).sort()).toEqual(["additional_context", "currency", "deadline", "donor_name", "report_type", "reporting_frequency"]);
  });

  it("accepts the preview-jurisdiction tax request and the general tax request", () => {
    expect(validateEnquiryRequest(base({ service_code: "tax_tanzania_preview", source_context: "workflow_tax", country: "TZ", payload: { jurisdiction_source: "user_selected" } })).kind).toBe("valid");
    expect(validateEnquiryRequest(base({ service_code: "tax_general", source_context: "workflow_tax", country: "KE", payload: { jurisdiction_source: "company_setting_confirmed", tax_period: "FY2025" } })).kind).toBe("valid");
  });
});

describe("validateEnquiryRequest — refusals", () => {
  it("rejects a non-object body", () => {
    for (const v of [null, undefined, "x", 5, [], [base()]]) expect(validateEnquiryRequest(v).kind).toBe("invalid");
  });

  it("rejects unknown top-level fields — including a client-supplied user id, which is never a field", () => {
    for (const extra of ["user_id", "requester_user_id", "status", "assigned_to", "id", "is_staff", "phone", "preferred_contact_method"]) {
      expect(hasError(base({ [extra]: "x" }), extra, "unknown_field"), extra).toBe(true);
    }
  });

  it("rejects unknown payload keys and payload keys that belong to a different service", () => {
    expect(hasError(base({ service_code: "donor_reporting", payload: { secret: "x" } }), "payload.secret", "unknown_field")).toBe(true);
    expect(hasError(base({ service_code: "general", payload: { report_type: "other" } }), "payload.report_type", "unknown_field")).toBe(true);
    expect(hasError(base({ service_code: "donor_reporting", payload: { jurisdiction_source: "user_selected" } }), "payload.jurisdiction_source", "unknown_field")).toBe(true);
  });

  it("rejects an unsupported schema version, a missing key and a malformed key", () => {
    expect(hasError(base({ schema_version: 2 }), "schema_version")).toBe(true);
    expect(hasError(base({ idempotency_key: undefined }), "idempotency_key", "required")).toBe(true);
    expect(hasError(base({ idempotency_key: "not-a-uuid" }), "idempotency_key", "invalid_format")).toBe(true);
    expect(hasError(base({ idempotency_key: 7 }), "idempotency_key", "invalid_type")).toBe(true);
  });

  it("rejects unknown service codes and source contexts (the browser cannot invent either)", () => {
    expect(hasError(base({ service_code: "tax_kenya" }), "service_code", "not_allowed")).toBe(true);
    expect(hasError(base({ service_code: undefined }), "service_code", "required")).toBe(true);
    expect(hasError(base({ source_context: "popup" }), "source_context", "not_allowed")).toBe(true);
  });

  it("rejects invalid emails and countries", () => {
    for (const email of ["", "no-at", "a@b", "a@@b.test", "a b@example.test", "name <a@example.test>"]) expect(hasError(base({ email }), "email"), email).toBe(true);
    for (const country of ["XX", "TZA", "1", "T"]) expect(hasError(base({ country }), "country", "invalid_format"), country).toBe(true);
    expect(hasError(base({ country: 5 }), "country", "invalid_type")).toBe(true);
  });

  it("enforces every length limit with a too_short / too_long code (counted in characters, not bytes)", () => {
    expect(hasError(base({ name: "x".repeat(LIMITS.name.max + 1) }), "name", "too_long")).toBe(true);
    expect(hasError(base({ subject: "ab" }), "subject", "too_short")).toBe(true);
    expect(hasError(base({ subject: "s".repeat(LIMITS.subject.max + 1) }), "subject", "too_long")).toBe(true);
    expect(hasError(base({ message: "short" }), "message", "too_short")).toBe(true);
    expect(hasError(base({ message: "m".repeat(LIMITS.message.max + 1) }), "message", "too_long")).toBe(true);
    expect(hasError(base({ organization: "o".repeat(LIMITS.organization.max + 1) }), "organization", "too_long")).toBe(true);
    // 4000 astral characters is exactly at the limit even though it is 8000 UTF-16 units.
    expect(hasError(base({ message: "😀".repeat(LIMITS.message.max) }), "message")).toBe(false);
    expect(hasError(base({ message: "😀".repeat(LIMITS.message.max + 1) }), "message", "too_long")).toBe(true);
  });

  it("rejects control characters (a newline is allowed only in the message and additional context)", () => {
    expect(hasError(base({ subject: "Bad\u0007bell" }), "subject", "invalid_format")).toBe(true);
    expect(hasError(base({ subject: "Line\nbreak" }), "subject", "invalid_format")).toBe(true);
    expect(hasError(base({ message: "Body with a newline\nis fine here." }), "message")).toBe(false);
    expect(hasError(base({ message: "Body with a bell \u0007 is not." }), "message", "invalid_format")).toBe(true);
  });

  it("requires the privacy acknowledgement to be exactly true", () => {
    for (const v of [false, undefined, "true", 1]) expect(hasError(base({ privacy_acknowledged: v }), "privacy_acknowledged", "consent_required")).toBe(true);
  });

  it("validates donor payload values: enumerations, currency, a REAL calendar date", () => {
    const donor = (payload: Record<string, unknown>) => base({ service_code: "donor_reporting", source_context: "workflow_donor", payload });
    expect(hasError(donor({ report_type: "audit" }), "payload.report_type", "not_allowed")).toBe(true);
    expect(hasError(donor({ reporting_frequency: "daily" }), "payload.reporting_frequency", "not_allowed")).toBe(true);
    expect(hasError(donor({ currency: "usd" }), "payload.currency", "invalid_format")).toBe(true);
    expect(hasError(donor({ currency: "US" }), "payload.currency", "invalid_format")).toBe(true);
    expect(hasError(donor({ deadline: "2026-13-40" }), "payload.deadline", "invalid_format")).toBe(true);
    expect(hasError(donor({ deadline: "2026-02-30" }), "payload.deadline", "invalid_format")).toBe(true);
    expect(hasError(donor({ deadline: "31/12/2026" }), "payload.deadline", "invalid_format")).toBe(true);
    expect(hasError(donor({ deadline: "2028-02-29" }), "payload.deadline")).toBe(false);
    expect(hasError(donor({ project_name: 5 }), "payload.project_name", "invalid_type")).toBe(true);
    expect(hasError(donor({ additional_context: "a".repeat(LIMITS.additionalContext.max + 1) }), "payload.additional_context", "too_long")).toBe(true);
  });

  it("routes tax correctly: the preview code needs the preview jurisdiction, the general code any OTHER jurisdiction, both need a stated source", () => {
    const tax = (service: string, country: unknown, payload: Record<string, unknown> = { jurisdiction_source: "user_selected" }) => base({ service_code: service, source_context: "workflow_tax", country, payload });
    expect(hasError(tax("tax_tanzania_preview", undefined), "country", "required")).toBe(true);
    expect(hasError(tax("tax_tanzania_preview", "KE"), "country", "mismatch")).toBe(true);
    expect(hasError(tax("tax_general", "TZ"), "country", "mismatch")).toBe(true);
    expect(hasError(tax("tax_general", undefined), "country", "required")).toBe(true);
    expect(hasError(tax("tax_general", "KE", {}), "payload.jurisdiction_source", "required")).toBe(true);
    expect(hasError(tax("tax_general", "KE", { jurisdiction_source: "guessed" }), "payload.jurisdiction_source", "not_allowed")).toBe(true);
  });

  it("never echoes a submitted value in an error", () => {
    const secret = "TOPSECRET-VALUE-123";
    const r = validateEnquiryRequest(base({ email: secret, subject: secret.repeat(20), unknown_thing: secret }));
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe("honeypot", () => {
  it("is detected from any non-empty value, and an empty or absent field is not a trap", () => {
    expect(hasHoneypot(base({ [HONEYPOT_FIELD]: "http://spam.example.test" }))).toBe(true);
    expect(hasHoneypot(base({ [HONEYPOT_FIELD]: 1 }))).toBe(true);
    expect(hasHoneypot(base({ [HONEYPOT_FIELD]: "" }))).toBe(false);
    expect(hasHoneypot(base({ [HONEYPOT_FIELD]: "   " }))).toBe(false);
    expect(hasHoneypot(base())).toBe(false);
    expect(hasHoneypot(null)).toBe(false);
  });
});

describe("email rule — one corpus, two implementations", () => {
  it(`accepts all ${corpus.valid.length} valid and rejects all ${corpus.invalid.length} invalid corpus addresses`, () => {
    for (const e of corpus.valid) expect(enquiryEmailIsValid(e), e).toBe(true);
    for (const e of corpus.invalid) expect(enquiryEmailIsValid(e), e).toBe(false);
  });
});

describe("request fingerprint", () => {
  const norm = (over: Record<string, unknown> = {}): NormalizedEnquiry => {
    const r = validateEnquiryRequest(base(over));
    if (r.kind !== "valid") throw new Error("fixture invalid");
    return r.value;
  };

  it("is stable, 64 hex characters, and independent of key order", async () => {
    const a = await requestFingerprint(norm());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await requestFingerprint(norm())).toBe(a);
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("binds CONTENT, not the idempotency key: a different key with the same content has the same fingerprint", async () => {
    expect(await requestFingerprint(norm({ idempotency_key: "11111111-2222-4333-8444-555555555555" }))).toBe(await requestFingerprint(norm()));
  });

  it("changes when ANY part of the content changes (message, email, country, service, payload)", async () => {
    const f = await requestFingerprint(norm());
    const changed = [
      norm({ message: "A synthetic message that is long enough — edited." }),
      norm({ email: "other@example.test" }),
      norm({ country: "KE" }),
      norm({ service_code: "support" }),
      norm({ service_code: "donor_reporting", payload: { report_type: "other" } }),
      norm({ organization: "Another Org" }),
      norm({ source_context: "site_footer" }),
    ];
    for (const c of changed) expect(await requestFingerprint(c)).not.toBe(f);
  });
});

describe("parity with the migration (public.* constraints and validators)", () => {
  it("the ISO country list is identical in the contract, the app's jurisdiction registry and the SQL function", () => {
    const sqlList = /is_iso_3166_alpha2[\s\S]*?string_to_array\(\s*'([A-Z ]+)'/.exec(SQL)?.[1].split(" ") ?? [];
    expect([...ISO_3166_ALPHA2].sort()).toEqual([...ISO_REGION_CODES].sort());
    expect(sqlList.sort()).toEqual([...ISO_3166_ALPHA2].sort());
    expect(ISO_3166_ALPHA2).toHaveLength(249);
  });

  it("service codes and source contexts match the SQL CHECK lists exactly", () => {
    const list = (constraint: string) => new RegExp(`${constraint} CHECK \\((?:service_code|source_context) IN \\(([^)]*)\\)`).exec(SQL)?.[1].match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, "")) ?? [];
    expect(list("chk_service_enquiries_service").sort()).toEqual([...SERVICE_CODES].sort());
    expect(list("chk_service_enquiries_source").sort()).toEqual([...SOURCE_CONTEXTS].sort());
  });

  it("every text limit matches the SQL enquiry_text_ok bounds", () => {
    const bounds = (col: string) => {
      const m = new RegExp(`enquiry_text_ok\\(${col}, (\\d+), (\\d+), (true|false)\\)`).exec(SQL);
      return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
    };
    expect(bounds("requester_name")).toEqual(LIMITS.name);
    expect(bounds("organization")).toEqual(LIMITS.organization);
    expect(bounds("subject")).toEqual(LIMITS.subject);
    expect(bounds("message")).toEqual(LIMITS.message);
    expect(/char_length\(p_email\) <= 254|char_length\(p_email\) <= (\d+)/.exec(SQL)?.[0]).toContain(String(LIMITS.email.max));
  });

  it("payload enumerations match the SQL payload validator", () => {
    const fn = /FUNCTION public\.service_enquiry_payload_valid[\s\S]*?\$\$;/.exec(SQL)?.[0] ?? "";
    const setOf = (key: string) => new RegExp(`v_key = '${key}' THEN\\s+IF NOT \\(v_text = ANY \\(ARRAY\\[([^\\]]*)\\]`).exec(fn)?.[1].match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, "")) ?? [];
    expect(setOf("report_type").sort()).toEqual([...REPORT_TYPES].sort());
    expect(setOf("reporting_frequency").sort()).toEqual([...REPORTING_FREQUENCIES].sort());
    expect(setOf("jurisdiction_source").sort()).toEqual(["company_setting_confirmed", "user_selected"]);
  });

  it("the per-service payload key allowlists match the SQL validator", () => {
    const fn = /FUNCTION public\.service_enquiry_payload_valid[\s\S]*?\$\$;/.exec(SQL)?.[0] ?? "";
    const keys = (service: string) => new RegExp(`WHEN '${service}'\\s+THEN ARRAY\\[([^\\]]*)\\]`).exec(fn)?.[1].match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, "")) ?? [];
    expect(keys("donor_reporting").sort()).toEqual(["additional_context", "currency", "deadline", "donor_name", "project_name", "report_type", "reporting_frequency", "reporting_period"].sort());
    expect(keys("tax_tanzania_preview").sort()).toEqual(["jurisdiction_source", "tax_period"]);
    expect(keys("tax_general").sort()).toEqual(["jurisdiction_source", "tax_period"]);
  });
});
