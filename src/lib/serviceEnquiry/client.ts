// The browser's ONLY way to submit an enquiry: the submit-service-enquiry Edge Function. The browser never inserts into the
// canonical tables (there is no privilege to — see migration 20260921100000). Responses are parsed, never trusted: a body that
// does not match the receipt shape is treated as "unavailable", not as success.

import { z } from "zod";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { EnquiryReceipt, FieldError } from "./contract";
import { SERVICE_ENQUIRY_SURFACES } from "./serviceEnquiryGate";

const receiptSchema = z.object({
  reference: z.string().regex(/^CFQ-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/),
  submitted_at: z.string().min(1),
  status: z.literal("submitted"),
  acknowledgement: z.enum(["sent", "pending", "unavailable"]),
  replayed: z.boolean(),
});

export function parseReceipt(value: unknown): EnquiryReceipt | null {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) return null;
  const r = parsed.data;
  return { reference: r.reference, submitted_at: r.submitted_at, status: r.status, acknowledgement: r.acknowledgement, replayed: r.replayed };
}

const fieldErrorSchema = z.object({
  field: z.string(),
  code: z.enum(["required", "invalid_type", "too_short", "too_long", "invalid_format", "not_allowed", "unknown_field", "consent_required", "mismatch"]),
});

const errorBodySchema = z.object({
  error: z.object({ code: z.string() }).optional(),
  fields: z.array(fieldErrorSchema).optional(),
  retry_after_seconds: z.number().optional(),
});

export type SubmitOutcome =
  | { readonly kind: "receipt"; readonly receipt: EnquiryReceipt }
  | { readonly kind: "invalid"; readonly fields: readonly FieldError[] }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "conflict" }
  /** The anti-abuse challenge was missing, wrong, expired or already used: the person must complete it again. */
  | { readonly kind: "challenge" }
  | { readonly kind: "unavailable" };

/** Pure: maps an HTTP status and parsed JSON body to what the form should do. */
export function interpretResponse(status: number, body: unknown): SubmitOutcome {
  if (status === 200 || status === 201) {
    const receipt = parseReceipt(body);
    return receipt ? { kind: "receipt", receipt } : { kind: "unavailable" };
  }
  const parsed = errorBodySchema.safeParse(body);
  const data = parsed.success ? parsed.data : {};
  if (status === 400) return { kind: "invalid", fields: (data.fields ?? []).map((f) => ({ field: f.field, code: f.code })) };
  if (status === 409) return { kind: "conflict" };
  if (status === 403 && (data.error?.code === "challenge_required" || data.error?.code === "challenge_failed")) return { kind: "challenge" };
  if (status === 429) return { kind: "rate_limited", retryAfterSeconds: Math.max(1, Math.round(data.retry_after_seconds ?? 60)) };
  return { kind: "unavailable" };
}

/** Wire shape of a submission; validated by the shared contract on both sides. */
export interface EnquiryWireRequest {
  schema_version: 1;
  idempotency_key: string;
  service_code: string;
  source_context: string;
  name: string;
  email: string;
  organization?: string;
  country?: string;
  subject: string;
  message: string;
  privacy_acknowledged: boolean;
  payload?: Record<string, string>;
  enquiry_hp?: string;
  /** Anti-abuse challenge response; required by the server for anonymous submissions only. */
  challenge_token?: string;
}

export async function submitServiceEnquiry(request: EnquiryWireRequest): Promise<SubmitOutcome> {
  // Rollout control, not authorization: while `service_enquiry_phase1` is OFF no request ever leaves the browser, even if a
  // component were somehow mounted. (The Edge Function still validates everything when the gate is ON.)
  if (!SERVICE_ENQUIRY_SURFACES.submissionAllowed) return { kind: "unavailable" };
  try {
    const { data, error } = await supabase.functions.invoke("submit-service-enquiry", { body: request });
    if (!error) return interpretResponse(200, data);
    if (error instanceof FunctionsHttpError) {
      let body: unknown = null;
      try {
        body = await error.context.json();
      } catch {
        body = null;
      }
      return interpretResponse(error.context.status, body);
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
