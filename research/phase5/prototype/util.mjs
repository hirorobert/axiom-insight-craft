// Phase 5 prototype — small utilities. Pure; node built-ins only (no new dependencies, no lockfile change).
import crypto from "node:crypto";

/** Stable canonical JSON (sorted keys) — mirrors the canonicalJson used for request_hash / content digests in production. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** sha256 hex of a canonical object — the research surrogate for production request_hash / contentHash / source_file_hash. */
export function sha256Hex(obj) {
  return crypto.createHash("sha256").update(typeof obj === "string" ? obj : canonicalJson(obj)).digest("hex");
}
