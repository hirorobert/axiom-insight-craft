// Browser side of the first-party attestation (the backup security check). It asks the server for a signed challenge, spends a
// little CPU solving it, and submits the result in the SAME field as the widget's token — the server decides which leg minted it
// and re-verifies everything. Nothing here can weaken the check: the work is re-hashed server-side, and a browser that skips it
// simply gets refused.

import { supabase } from "@/integrations/supabase/client";

export const ATTESTATION_PREFIX = "cfoclose1";
export const ATTESTATION_FUNCTION = "issue-enquiry-challenge";
/** A hard ceiling on the work a visitor's device is asked to do. 15 bits averages ~32k hashes; this is ~16x that headroom. */
export const ATTESTATION_MAX_ITERATIONS = 500_000;
export const ATTESTATION_MAX_BITS = 24;

export interface IssuedChallenge {
  readonly challenge: string;
  readonly bits: number;
}

/** Accepts only a well-formed issued challenge. A malformed response is not "no protection" — it is a failure. */
export function parseIssuedChallenge(body: unknown): IssuedChallenge | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return null;
  const challenge = typeof b.challenge === "string" ? b.challenge : "";
  const bits = typeof b.bits === "number" ? b.bits : NaN;
  if (!challenge.startsWith(`${ATTESTATION_PREFIX}.`) || challenge.split(".").length !== 5) return null;
  if (!Number.isInteger(bits) || bits < 1 || bits > ATTESTATION_MAX_BITS) return null;
  return { challenge, bits };
}

export function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
  if (!Number.isInteger(bits) || bits < 0 || bits > digest.length * 8) return false;
  const wholeBytes = bits >> 3;
  for (let i = 0; i < wholeBytes; i += 1) if (digest[i] !== 0) return false;
  const remainder = bits & 7;
  return remainder === 0 || digest[wholeBytes] >> (8 - remainder) === 0;
}

/** Finds the counter the server will accept. Returns the complete token, or null when the budget is exhausted (never a fake). */
export async function solveChallenge(issued: IssuedChallenge, maxIterations: number = ATTESTATION_MAX_ITERATIONS): Promise<string | null> {
  const encoder = new TextEncoder();
  for (let counter = 0; counter < maxIterations; counter += 1) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${issued.challenge.slice(0, issued.challenge.lastIndexOf("."))}:${counter}`)));
    if (hasLeadingZeroBits(digest, issued.bits)) return `${issued.challenge}.${counter}`;
    if ((counter & 0x3ff) === 0x3ff) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive while working
  }
  return null;
}

/** The whole backup flow: mint → solve → token. Returns null on any failure, so the form stays refused rather than unprotected. */
export async function runAttestation(): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke(ATTESTATION_FUNCTION, { body: {} });
    if (error) return null;
    const issued = parseIssuedChallenge(data);
    return issued ? await solveChallenge(issued) : null;
  } catch {
    return null;
  }
}
