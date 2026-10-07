/**
 * Expected-version writes (workbench F3). Pure.
 *
 * A write carries the version the person last saw; the server refuses it when the record has changed since. The
 * browser never decides: it only recognises the server's refusal and offers a reload. Nothing is overwritten.
 */
export interface VersionConflict {
  readonly kind: "version_conflict";
  /** Server-supplied detail when available (who/when), never inferred. */
  readonly detail: string | null;
}

/** Recognised server refusals that mean "this record changed since you read it". */
const CONFLICT_CODES = new Set(["40001", "PT409"]);
const CONFLICT_TEXT = /\b(VERSION_CONFLICT|stale_version|CONTROL_VERSION_CONFLICT|EXPECTED_VERSION_MISMATCH)\b/i;

export function asVersionConflict(error: unknown): VersionConflict | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { code?: unknown; message?: unknown; details?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  const code = typeof e.code === "string" ? e.code : "";
  const isConflict = CONFLICT_TEXT.test(message) || (CONFLICT_CODES.has(code) && CONFLICT_TEXT.test(`${message} ${String(e.details ?? "")}`));
  if (!isConflict) return null;
  return { kind: "version_conflict", detail: typeof e.details === "string" && e.details.trim() ? e.details.trim() : null };
}

/** Adds the expected version to an RPC argument object (`p_expected_version`). */
export function withExpectedVersion<T extends Record<string, unknown>>(args: T, expectedVersion: number): T & { p_expected_version: number } {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error("expected version must be a non-negative integer");
  return { ...args, p_expected_version: expectedVersion };
}
