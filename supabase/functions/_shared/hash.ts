// Ω∞ Phase 0A — deterministic canonicalization and hashing.
// Pure functions. No DB, no auth, no Deno-specific API beyond WebCrypto
// (crypto.subtle), which is a standard API also available in modern
// browsers/Node — see src/lib/shared/canonicalHash.ts for the mirrored,
// vitest-testable copy used to prove this algorithm in an environment this
// project's tooling can actually execute (this file itself cannot be run
// here — no Deno runtime is available in this environment).
//
// CANONICAL_JSON_V1 — keep in sync with src/lib/shared/canonicalHash.ts.
// If you change this logic, change it there too.

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | Date
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Produces a deterministic string representation of `value`:
 *  - object keys sorted lexicographically (order-independent)
 *  - array element order preserved verbatim (order IS meaningful)
 *  - numbers rendered via a fixed, non-scientific-notation representation
 *  - Date values rendered as ISO 8601
 *  - `undefined` is REJECTED (throws) — it must never silently vanish
 *  - any other unsupported type (function, symbol, bigint, NaN, Infinity)
 *    is REJECTED (throws)
 *
 * No accounting rounding or normalization happens here. This canonicalizes
 * REPRESENTATION only — callers are responsible for ensuring the values they
 * pass already carry whatever accounting-domain rounding they need before
 * canonicalization, so no rounding decision is ever hidden inside hashing.
 */
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
    // Explicit decision: -0 canonicalizes identically to 0 — see the
    // mirrored copy's comment in src/lib/shared/canonicalHash.ts.
    const normalized = Object.is(value, -0) ? 0 : value;
    const rendered = Number.isInteger(normalized) ? normalized.toFixed(0) : normalized.toString();
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

/** SHA-256 of a UTF-8 string, lowercase hex. Uses standard WebCrypto — no
 *  environment-specific behavior. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convenience: canonicalize then hash in one call. */
export async function canonicalHash(value: CanonicalValue): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
