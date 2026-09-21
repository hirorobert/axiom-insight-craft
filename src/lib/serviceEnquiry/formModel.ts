// Pure form model: values → wire request, validation through the shared contract, and human error wording. No React, no I/O,
// so every behaviour (including "focus moves to the first invalid field") is unit-testable.

import {
  SERVICE_ENQUIRY_SCHEMA_VERSION,
  validateEnquiryRequest,
  type FieldError,
  type FieldErrorCode,
  type NormalizedEnquiry,
  type ServiceCode,
  type SourceContext,
} from "./contract";
import type { EnquiryWireRequest } from "./client";

export interface EnquiryFormValues {
  name: string;
  email: string;
  organization: string;
  country: string;
  subject: string;
  message: string;
  privacy: boolean;
  payload: Record<string, string>;
  honeypot: string;
}

export const EMPTY_FORM_VALUES: EnquiryFormValues = {
  name: "",
  email: "",
  organization: "",
  country: "",
  subject: "",
  message: "",
  privacy: false,
  payload: {},
  honeypot: "",
};

export interface EnquiryFormContext {
  readonly serviceCode: ServiceCode;
  readonly sourceContext: SourceContext;
}

/** A syntactically valid placeholder used only to validate content; the real key is chosen at send time. */
const PLACEHOLDER_KEY = "00000000-0000-4000-8000-000000000000";

export function buildWireRequest(values: EnquiryFormValues, ctx: EnquiryFormContext, idempotencyKey: string): EnquiryWireRequest {
  const payload: Record<string, string> = {};
  for (const [k, v] of Object.entries(values.payload)) if (v.trim() !== "") payload[k] = v;
  return {
    schema_version: SERVICE_ENQUIRY_SCHEMA_VERSION,
    idempotency_key: idempotencyKey,
    service_code: ctx.serviceCode,
    source_context: ctx.sourceContext,
    name: values.name,
    email: values.email,
    ...(values.organization.trim() !== "" ? { organization: values.organization } : {}),
    ...(values.country !== "" ? { country: values.country } : {}),
    subject: values.subject,
    message: values.message,
    privacy_acknowledged: values.privacy,
    payload,
    ...(values.honeypot !== "" ? { enquiry_hp: values.honeypot } : {}),
  };
}

export type FormCheck =
  | { readonly kind: "valid"; readonly normalized: NormalizedEnquiry }
  | { readonly kind: "invalid"; readonly errors: readonly FieldError[] };

/** Validates with the SAME contract the server applies. */
export function checkForm(values: EnquiryFormValues, ctx: EnquiryFormContext): FormCheck {
  const result = validateEnquiryRequest(buildWireRequest(values, ctx, PLACEHOLDER_KEY));
  return result.kind === "valid" ? { kind: "valid", normalized: result.value } : { kind: "invalid", errors: result.errors };
}

// ── wording ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "Your name",
  email: "Email address",
  organization: "Organisation",
  country: "Country",
  subject: "Subject",
  message: "Message",
  privacy_acknowledged: "Privacy acknowledgement",
  "payload.report_type": "Report type",
  "payload.donor_name": "Donor or funder name",
  "payload.project_name": "Project or programme name",
  "payload.reporting_period": "Reporting period",
  "payload.reporting_frequency": "Reporting frequency",
  "payload.currency": "Currency",
  "payload.deadline": "Deadline",
  "payload.additional_context": "Additional context",
  "payload.tax_period": "Tax period",
  "payload.jurisdiction_source": "Jurisdiction",
};

/** The order in which fields appear on the page — used to find the FIRST invalid field for focus. */
export const FIELD_ORDER: readonly string[] = [
  "name",
  "email",
  "organization",
  "country",
  "payload.report_type",
  "payload.donor_name",
  "payload.project_name",
  "payload.reporting_period",
  "payload.reporting_frequency",
  "payload.currency",
  "payload.deadline",
  "payload.tax_period",
  "payload.additional_context",
  "subject",
  "message",
  "privacy_acknowledged",
];

const labelOf = (field: string): string => FIELD_LABELS[field] ?? "This field";

export function describeFieldError(field: string, code: FieldErrorCode): string {
  const label = labelOf(field);
  switch (code) {
    case "required":
      return field === "country" || field.startsWith("payload.") && /report_type|reporting_frequency/.test(field) ? `Select ${label.toLowerCase()}.` : `Enter ${label.toLowerCase()}.`;
    case "invalid_format":
      if (field === "email") return "Enter a valid email address, such as name@company.com.";
      if (field === "payload.currency") return "Use a three-letter currency code, such as USD.";
      if (field === "payload.deadline") return "Enter a valid date.";
      return `Check the format of ${label.toLowerCase()}.`;
    case "too_short":
      return `${label} is too short.`;
    case "too_long":
      return `${label} is too long.`;
    case "not_allowed":
      return "Choose one of the listed options.";
    case "consent_required":
      return "Confirm that you have read the privacy notice.";
    case "mismatch":
      return "Choose a jurisdiction that matches this request.";
    default:
      return `Check ${label.toLowerCase()}.`;
  }
}

export const fieldElementId = (prefix: string, field: string): string => `${prefix}-${field.replace(/[^a-z0-9]+/gi, "-")}`;
export const errorElementId = (prefix: string, field: string): string => `${fieldElementId(prefix, field)}-error`;

export interface ErrorSummaryItem {
  readonly field: string;
  readonly elementId: string;
  readonly message: string;
}

/** One entry per field (the first error wins), in page order — for the programmatic error summary. */
export function buildErrorSummary(errors: readonly FieldError[], prefix: string): ErrorSummaryItem[] {
  const byField = new Map<string, FieldError>();
  for (const e of errors) if (!byField.has(e.field)) byField.set(e.field, e);
  const rank = (f: string) => {
    const i = FIELD_ORDER.indexOf(f);
    return i === -1 ? FIELD_ORDER.length : i;
  };
  return [...byField.values()]
    .sort((a, b) => rank(a.field) - rank(b.field))
    .map((e) => ({ field: e.field, elementId: fieldElementId(prefix, e.field), message: describeFieldError(e.field, e.code) }));
}

/** The element that should receive focus after a failed submit: the first invalid field in page order. */
export const firstInvalidElementId = (errors: readonly FieldError[], prefix: string): string | null => buildErrorSummary(errors, prefix)[0]?.elementId ?? null;
