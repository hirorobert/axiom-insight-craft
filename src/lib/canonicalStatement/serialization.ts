// canonicalStatement/serialization.ts — deterministic serialization and
// identifier hashing.
//
// `hashDeterministic` is intentionally a fast, synchronous, non-cryptographic
// hash (FNV-1a, 64-bit, via BigInt). It exists to produce stable identifiers
// (finding IDs) and to compare two result sets for byte-identical replay —
// it is never used as a security boundary, unlike the sha256 content hashes
// used for source-artifact identity (SourceArtifact.sourceHash), which come
// from real file bytes and follow the same sha256 discipline as the
// financial-statement-intake Edge Function.

/** Recursively sorts object keys and renders bigint exactly, so two structurally-equal values always serialize identically regardless of key insertion order. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __bigint__: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export function hashDeterministic(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Strips the one field every deterministic-replay comparison in this module tree must ignore. */
export function withoutCreatedAt<T extends { createdAt: string }>(value: T): Omit<T, "createdAt"> {
  const { createdAt: _createdAt, ...rest } = value;
  return rest;
}
