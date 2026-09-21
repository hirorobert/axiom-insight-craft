// Durable receipt + in-flight attempt, kept in sessionStorage per form so that:
//   * a page refresh after success shows the receipt again and never silently resubmits;
//   * a retry after a network failure re-uses the SAME idempotency key for the SAME content, so the server can return the
//     original receipt instead of creating a second enquiry (and a different content gets a different key).
// Only the receipt (reference, time, acknowledgement state) and a content fingerprint are stored — never any form text.
// Storage can be unavailable (privacy modes, blocked site data): every access is guarded and the form still works.

import { z } from "zod";
import type { EnquiryReceipt } from "./contract";
import { parseReceipt } from "./client";

const receiptKey = (formKey: string) => `cfoclose:enquiry-receipt:v1:${formKey}`;
const attemptKey = (formKey: string) => `cfoclose:enquiry-attempt:v1:${formKey}`;

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): unknown {
  try {
    const raw = store()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    store()?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the receipt still shows for this page view */
  }
}

function remove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const loadReceipt = (formKey: string): EnquiryReceipt | null => parseReceipt(read(receiptKey(formKey)));
export const saveReceipt = (formKey: string, receipt: EnquiryReceipt): void => write(receiptKey(formKey), receipt);
export const clearReceipt = (formKey: string): void => remove(receiptKey(formKey));

const attemptSchema = z.object({ key: z.string().uuid(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) });
export interface EnquiryAttempt {
  readonly key: string;
  readonly fingerprint: string;
}

export function loadAttempt(formKey: string): EnquiryAttempt | null {
  const parsed = attemptSchema.safeParse(read(attemptKey(formKey)));
  return parsed.success ? { key: parsed.data.key, fingerprint: parsed.data.fingerprint } : null;
}
export const saveAttempt = (formKey: string, attempt: EnquiryAttempt): void => write(attemptKey(formKey), attempt);
export const clearAttempt = (formKey: string): void => remove(attemptKey(formKey));

/** Same content → same key (a safe replay); changed content → a new key (a new enquiry). */
export function resolveAttempt(previous: EnquiryAttempt | null, fingerprint: string, newKey: () => string): EnquiryAttempt {
  return previous && previous.fingerprint === fingerprint ? previous : { key: newKey(), fingerprint };
}
