// Ω∞ Phase 0A — deterministic canonicalization and hashing.
//
// CANONICAL_JSON_V1 — mirrors supabase/functions/_shared/hash.ts exactly.
// This copy exists so the algorithm is provable via this project's vitest
// toolchain, which can run here; the Deno copy cannot be executed in this
// environment (no Deno runtime available). If you change this logic, change
// it in both places and re-run the tests in both suites, mirroring the
// existing normalizeAccountName precedent (src/lib/normalizeAccountName.ts).
//
// Uses crypto.subtle (WebCrypto) — a standard API, not Deno-specific,
// available in Node 20+/modern browsers/Deno identically, so this file's
// logic is expected to be byte-for-byte behaviorally identical to the Deno
// copy, unlike normalizeAccountName's documented JS/SQL regex discrepancy.

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | Date
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue | undefined): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === undefined) {
    throw new Error("canonicalJson: undefined is not permitted — use null or omit the field explicitly");
  }
  if (value === null) return "null";

  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number is not permitted (${value})`);
    }
    // Explicit decision: -0 canonicalizes identically to 0. Accounting has
    // no concept of a signed zero, and letting -0 hash differently from 0
    // would make two representations of "no value" collide inconsistently.
    const normalized = Object.is(value, -0) ? 0 : value;
    const rendered = Number.isInteger(normalized) ? normalized.toFixed(0) : normalized.toString();
    // JS falls back to scientific notation for |x| >= 1e21 (toFixed) or
    // very small magnitudes (toString) — no real accounting figure needs
    // that range, so this is rejected explicitly rather than silently
    // producing a "1e+21"-shaped canonical string. No rounding happens
    // here either way; this only guards representation, not precision.
    if (/e/i.test(rendered)) {
      throw new Error(`canonicalJson: number magnitude out of canonical range (${value})`);
    }
    return rendered;
  }

  if (typeof value === "string") return JSON.stringify(value);

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("canonicalJson: invalid Date is not permitted");
    }
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v)).join(",")}]`;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }

  throw new Error(`canonicalJson: unsupported value type (${typeof value})`);
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function canonicalHash(value: CanonicalValue): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
