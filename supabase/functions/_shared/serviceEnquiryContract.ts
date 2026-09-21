// Service enquiry contract — the ONE definition of what an enquiry request may contain.
//
// Pure TypeScript: no imports, no Deno or DOM API beyond WebCrypto (crypto.subtle), so it runs unchanged in the Edge Function,
// in the browser form (through src/lib/serviceEnquiry/contract.ts) and in vitest. Every rule here is re-enforced by the
// database (constraints and validators in migration 20260921100000), which is the authority; this module gives the caller
// fast, field-level, never-value-echoing errors and normalises input so that the database's stricter canonical-form checks
// (trimmed, lower-case email, upper-case ISO code) always hold.

export const SERVICE_ENQUIRY_SCHEMA_VERSION = 1 as const;

export const SERVICE_CODES = ["general", "support", "donor_reporting", "tax_tanzania_preview", "tax_general"] as const;
export type ServiceCode = (typeof SERVICE_CODES)[number];

export const SOURCE_CONTEXTS = ["contact_page", "site_header", "site_footer", "help_support", "workflow_donor", "workflow_tax"] as const;
export type SourceContext = (typeof SOURCE_CONTEXTS)[number];

export const REPORT_TYPES = ["expenditure_report", "budget_vs_actual", "fund_accountability", "grant_financial_statement", "management_report", "other"] as const;
export const REPORTING_FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual", "one_off", "other"] as const;
export const JURISDICTION_SOURCES = ["user_selected", "company_setting_confirmed"] as const;

/** The jurisdiction whose tax pathway is a private preview. A code only — its name is rendered at runtime from ISO data. */
export const PREVIEW_JURISDICTION_CODE = "TZ" as const;

export const LIMITS = {
  name: { min: 1, max: 120 },
  email: { max: 254 },
  organization: { min: 1, max: 160 },
  subject: { min: 3, max: 150 },
  message: { min: 10, max: 4000 },
  donorName: { min: 1, max: 160 },
  projectName: { min: 1, max: 160 },
  reportingPeriod: { min: 1, max: 80 },
  taxPeriod: { min: 1, max: 80 },
  additionalContext: { min: 1, max: 2000 },
} as const;

export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

/** A field humans never see. Any value means an automated submission. It is an accepted key so bots are not told why they failed. */
export const HONEYPOT_FIELD = "enquiry_hp" as const;

/**
 * The anti-abuse challenge response (Cloudflare Turnstile today; the field is provider-neutral). It is read from the request
 * body but is NOT part of the enquiry: it is never validated into NormalizedEnquiry, never fingerprinted, never stored and
 * never logged. Only anonymous submissions need one; a verified signed-in user is protected by rate limits and idempotency.
 */
export const CHALLENGE_FIELD = "challenge_token" as const;
export const CHALLENGE_TOKEN_MAX_LENGTH = 2048; // Turnstile's documented maximum
/** The widget `action` the browser sets; the provider echoes it back and the server refuses a token minted for a different action. */
export const CHALLENGE_ACTION = "service_enquiry" as const;

/** Fixed-window limits, applied to keyed hashes (never raw identifiers). Enforced atomically inside submit_service_enquiry. */
export const RATE_POLICY = {
  ip: { limit: 8, windowSeconds: 600 },
  email: { limit: 5, windowSeconds: 3600 },
  global: { limit: 400, windowSeconds: 3600 },
} as const;

export const ENQUIRY_ERROR_CODES = [
  "method_not_allowed",
  "unsupported_media_type",
  "payload_too_large",
  "invalid_json",
  "validation_failed",
  "idempotency_key_reuse",
  "rate_limited",
  "challenge_required",
  "challenge_failed",
  "challenge_unavailable",
  "internal_error",
] as const;
export type EnquiryErrorCode = (typeof ENQUIRY_ERROR_CODES)[number];

export type FieldErrorCode =
  | "required"
  | "invalid_type"
  | "too_short"
  | "too_long"
  | "invalid_format"
  | "not_allowed"
  | "unknown_field"
  | "consent_required"
  | "mismatch";
export interface FieldError {
  readonly field: string;
  readonly code: FieldErrorCode;
}

/**
 * What the REQUESTER is told about the acknowledgement email. Deliberately coarse and truthful:
 *   sent        — the email provider ACCEPTED the message. This is not a claim of delivery.
 *   pending     — queued or in flight.
 *   unavailable — it will not be sent (not configured, failed, bounced, or a non-deliverable address).
 */
export type AcknowledgementState = "sent" | "pending" | "unavailable";

/**
 * The outbox's own vocabulary — six different facts that must never be blended:
 *   queued / processing — not yet handed to the provider
 *   accepted            — the provider accepted the message (all a send call can prove)
 *   delivered / bounced — reported by a VERIFIED provider event; nothing writes these today
 *   failed              — permanent failure, exhausted retries or a non-deliverable address
 */
export const NOTIFICATION_STATUSES = ["queued", "processing", "accepted", "delivered", "failed", "bounced"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_TRANSITIONS: Readonly<Record<NotificationStatus, readonly NotificationStatus[]>> = {
  queued: ["processing"],
  processing: ["accepted", "queued", "failed"], // queued again = a transient failure or "not configured"
  accepted: ["delivered", "bounced"], // only ever on a verified provider event
  delivered: [],
  failed: [],
  bounced: [],
};

export const isNotificationStatus = (v: unknown): v is NotificationStatus => typeof v === "string" && (NOTIFICATION_STATUSES as readonly string[]).includes(v);

export const isValidNotificationTransition = (from: NotificationStatus, to: NotificationStatus): boolean => NOTIFICATION_TRANSITIONS[from].includes(to);

/** The requester-facing acknowledgement state for an outbox status. Acceptance is reported as "sent", never as delivery. */
export function acknowledgementFor(status: NotificationStatus | null): AcknowledgementState {
  switch (status) {
    case "queued":
    case "processing":
      return "pending";
    case "accepted":
    case "delivered":
      return "sent";
    default:
      return "unavailable"; // failed, bounced, or no acknowledgement row at all
  }
}
export interface EnquiryReceipt {
  readonly reference: string;
  readonly submitted_at: string;
  readonly status: "submitted";
  readonly acknowledgement: AcknowledgementState;
  readonly replayed: boolean;
}

export interface NormalizedEnquiry {
  readonly idempotency_key: string;
  readonly service_code: ServiceCode;
  readonly source_context: SourceContext;
  readonly requester_name: string;
  readonly requester_email: string;
  readonly organization: string | null;
  readonly country_code: string | null;
  readonly subject: string;
  readonly message: string;
  readonly payload_schema_version: typeof SERVICE_ENQUIRY_SCHEMA_VERSION;
  readonly payload: Readonly<Record<string, string>>;
}

export type ValidationResult =
  | { readonly kind: "valid"; readonly value: NormalizedEnquiry; readonly honeypot: boolean }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] };

// ── ISO 3166-1 alpha-2 (identical to public.is_iso_3166_alpha2 and to ISO_REGION_CODES in the app's jurisdiction registry;
// a test asserts all three lists agree) ─────────────────────────────────────────────────────────────────────────────────

export const ISO_3166_ALPHA2: readonly string[] =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");

export const isIsoCountryCode = (v: unknown): v is string => typeof v === "string" && ISO_3166_ALPHA2.includes(v);

// ── primitives ────────────────────────────────────────────────────────────────────────────────────────────────────────

const codePoints = (s: string): number => Array.from(s).length;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F]/;
const MULTI_LINE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Same rule as public.enquiry_email_is_valid — verified against a shared corpus in both places. */
export function enquiryEmailIsValid(email: string): boolean {
  return (
    email.length <= LIMITS.email.max &&
    email === email.trim().toLowerCase() &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email) &&
    !/^\.|\.$|\.\./.test(email.split("@")[0])
  );
}

export const normalizeEmail = (raw: string): string => raw.normalize("NFC").trim().toLowerCase();

type Bounds = { readonly min: number; readonly max: number };

function readText(raw: unknown, bounds: Bounds, multiline: boolean): { value: string } | { error: FieldErrorCode } {
  if (typeof raw !== "string") return { error: "invalid_type" };
  const value = raw.normalize("NFC").trim();
  if ((multiline ? MULTI_LINE_CONTROL : SINGLE_LINE_CONTROL).test(value)) return { error: "invalid_format" };
  const n = codePoints(value);
  if (n === 0) return { error: "required" };
  if (n < bounds.min) return { error: "too_short" };
  if (n > bounds.max) return { error: "too_long" };
  return { value };
}

const isRealDate = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const TOP_LEVEL_KEYS = ["schema_version", "idempotency_key", "service_code", "source_context", "name", "email", "organization", "country", "subject", "message", "privacy_acknowledged", "payload", HONEYPOT_FIELD, CHALLENGE_FIELD] as const;

const PAYLOAD_KEYS: Readonly<Record<ServiceCode, readonly string[]>> = {
  general: [],
  support: [],
  donor_reporting: ["report_type", "donor_name", "project_name", "reporting_period", "reporting_frequency", "currency", "deadline", "additional_context"],
  tax_tanzania_preview: ["jurisdiction_source", "tax_period"],
  tax_general: ["jurisdiction_source", "tax_period"],
};

function validatePayload(service: ServiceCode, raw: unknown, errors: FieldError[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) {
    errors.push({ field: "payload", code: "invalid_type" });
    return out;
  }
  const allowed = PAYLOAD_KEYS[service];
  for (const [key, value] of Object.entries(raw)) {
    const field = `payload.${key}`;
    if (!allowed.includes(key)) {
      errors.push({ field, code: "unknown_field" });
      continue;
    }
    if (typeof value !== "string") {
      errors.push({ field, code: "invalid_type" });
      continue;
    }
    if (value.trim() === "") continue; // an untouched optional field is simply absent
    let bounds: Bounds | null = null;
    let multiline = false;
    switch (key) {
      case "donor_name": bounds = LIMITS.donorName; break;
      case "project_name": bounds = LIMITS.projectName; break;
      case "reporting_period": bounds = LIMITS.reportingPeriod; break;
      case "tax_period": bounds = LIMITS.taxPeriod; break;
      case "additional_context": bounds = LIMITS.additionalContext; multiline = true; break;
      default: break;
    }
    if (bounds) {
      const r = readText(value, bounds, multiline);
      if ("error" in r) errors.push({ field, code: r.error });
      else out[key] = r.value;
      continue;
    }
    const v = value.trim();
    const check = ENUMERATED_PAYLOAD_FIELDS[key];
    if (check) {
      const failure = check(v);
      if (failure) errors.push({ field, code: failure });
      else out[key] = v;
    }
  }
  return out;
}

/** Fields whose value is one of a fixed set, or a strict format. Each returns the failure code, or null when valid. */
const ENUMERATED_PAYLOAD_FIELDS: Readonly<Record<string, (v: string) => FieldErrorCode | null>> = {
  report_type: (v) => ((REPORT_TYPES as readonly string[]).includes(v) ? null : "not_allowed"),
  reporting_frequency: (v) => ((REPORTING_FREQUENCIES as readonly string[]).includes(v) ? null : "not_allowed"),
  jurisdiction_source: (v) => ((JURISDICTION_SOURCES as readonly string[]).includes(v) ? null : "not_allowed"),
  currency: (v) => (/^[A-Z]{3}$/.test(v) ? null : "invalid_format"),
  deadline: (v) => (isRealDate(v) ? null : "invalid_format"),
};

/**
 * The challenge response the browser supplied, or null. Never trusted on its own: it is only ever handed to the server-side
 * verifier. A non-string or oversized value is reported by validateEnquiryRequest and reads as absent here.
 */
export function extractChallengeToken(input: unknown): string | null {
  if (!isPlainObject(input)) return null;
  const t = input[CHALLENGE_FIELD];
  return typeof t === "string" && t.length > 0 && t.length <= CHALLENGE_TOKEN_MAX_LENGTH ? t : null;
}

/** True when the hidden field carries any value — read before validation, so a bot learns nothing from field errors. */
export function hasHoneypot(input: unknown): boolean {
  if (!isPlainObject(input)) return false;
  const trap = input[HONEYPOT_FIELD];
  return typeof trap === "string" ? trap.trim() !== "" : trap !== undefined && trap !== null;
}

/**
 * Validates and normalises an untrusted request. Rejects unknown fields at every level, never echoes a submitted value in an
 * error, and never trusts a client-supplied user id (there is no such field: identity comes only from a verified JWT).
 */
export function validateEnquiryRequest(input: unknown): ValidationResult {
  if (!isPlainObject(input)) return { kind: "invalid", errors: [{ field: "body", code: "invalid_type" }] };
  const errors: FieldError[] = [];

  for (const key of Object.keys(input)) if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) errors.push({ field: key, code: "unknown_field" });

  if (input.schema_version !== SERVICE_ENQUIRY_SCHEMA_VERSION) errors.push({ field: "schema_version", code: "not_allowed" });

  let idempotencyKey = "";
  if (typeof input.idempotency_key !== "string") errors.push({ field: "idempotency_key", code: input.idempotency_key === undefined ? "required" : "invalid_type" });
  else if (!UUID_RE.test(input.idempotency_key.toLowerCase())) errors.push({ field: "idempotency_key", code: "invalid_format" });
  else idempotencyKey = input.idempotency_key.toLowerCase();

  const service = (SERVICE_CODES as readonly unknown[]).includes(input.service_code) ? (input.service_code as ServiceCode) : null;
  if (!service) errors.push({ field: "service_code", code: input.service_code === undefined ? "required" : "not_allowed" });
  const source = (SOURCE_CONTEXTS as readonly unknown[]).includes(input.source_context) ? (input.source_context as SourceContext) : null;
  if (!source) errors.push({ field: "source_context", code: input.source_context === undefined ? "required" : "not_allowed" });

  const name = readText(input.name, LIMITS.name, false);
  if ("error" in name) errors.push({ field: "name", code: name.error });

  let email = "";
  if (typeof input.email !== "string") errors.push({ field: "email", code: input.email === undefined ? "required" : "invalid_type" });
  else {
    email = normalizeEmail(input.email);
    if (email === "") errors.push({ field: "email", code: "required" });
    else if (!enquiryEmailIsValid(email)) errors.push({ field: "email", code: "invalid_format" });
  }

  let organization: string | null = null;
  if (input.organization !== undefined && input.organization !== null && !(typeof input.organization === "string" && input.organization.trim() === "")) {
    const o = readText(input.organization, LIMITS.organization, false);
    if ("error" in o) errors.push({ field: "organization", code: o.error });
    else organization = o.value;
  }

  let country: string | null = null;
  if (input.country !== undefined && input.country !== null && !(typeof input.country === "string" && input.country.trim() === "")) {
    if (typeof input.country !== "string") errors.push({ field: "country", code: "invalid_type" });
    else {
      const c = input.country.trim().toUpperCase();
      if (isIsoCountryCode(c)) country = c;
      else errors.push({ field: "country", code: "invalid_format" });
    }
  }

  const subject = readText(input.subject, LIMITS.subject, false);
  if ("error" in subject) errors.push({ field: "subject", code: subject.error });
  const message = readText(input.message, LIMITS.message, true);
  if ("error" in message) errors.push({ field: "message", code: message.error });

  if (input.privacy_acknowledged !== true) errors.push({ field: "privacy_acknowledged", code: "consent_required" });

  const payload = service ? validatePayload(service, input.payload, errors) : {};

  if (service === "tax_tanzania_preview" || service === "tax_general") {
    if (!country) errors.push({ field: "country", code: "required" });
    else if (service === "tax_tanzania_preview" && country !== PREVIEW_JURISDICTION_CODE) errors.push({ field: "country", code: "mismatch" });
    else if (service === "tax_general" && country === PREVIEW_JURISDICTION_CODE) errors.push({ field: "country", code: "mismatch" });
    if (!payload.jurisdiction_source && !errors.some((e) => e.field === "payload.jurisdiction_source")) errors.push({ field: "payload.jurisdiction_source", code: "required" });
  }

  const trap = input[HONEYPOT_FIELD];
  if (trap !== undefined && trap !== null && typeof trap !== "string") errors.push({ field: HONEYPOT_FIELD, code: "invalid_type" });
  const honeypot = hasHoneypot(input);

  const challenge = input[CHALLENGE_FIELD];
  if (challenge !== undefined && challenge !== null) {
    if (typeof challenge !== "string") errors.push({ field: CHALLENGE_FIELD, code: "invalid_type" });
    else if (challenge.length > CHALLENGE_TOKEN_MAX_LENGTH) errors.push({ field: CHALLENGE_FIELD, code: "too_long" });
  }

  if (errors.length > 0 || !service || !source || "error" in name || "error" in subject || "error" in message) return { kind: "invalid", errors };

  return {
    kind: "valid",
    honeypot,
    value: {
      idempotency_key: idempotencyKey,
      service_code: service,
      source_context: source,
      requester_name: name.value,
      requester_email: email,
      organization,
      country_code: country,
      subject: subject.value,
      message: message.value,
      payload_schema_version: SERVICE_ENQUIRY_SCHEMA_VERSION,
      payload,
    },
  };
}

// ── fingerprint: binds an idempotency key to the request's normalised content ───────────────────────────────────────────

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** SHA-256 (hex) of the normalised request content. The idempotency key and the verified user id are deliberately excluded. */
export async function requestFingerprint(n: NormalizedEnquiry): Promise<string> {
  const { idempotency_key: _key, ...content } = n;
  void _key;
  const bytes = new TextEncoder().encode(stableStringify(content));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
