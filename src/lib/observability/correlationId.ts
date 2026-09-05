/**
 * Ω1 — provider-neutral observability foundation.
 *
 * Deliberately NOT an integration with any named external provider (no
 * Sentry, no Datadog, etc.) — that decision belongs to a future wave with
 * its own evaluation, not to a side effect of the commercial foundation.
 * This module only standardizes the identity fields (correlation_id,
 * companyId, periodYear, engineRunId) that should travel together through
 * a request, so a future provider integration has a consistent shape to
 * plug into instead of ad hoc per-call logging.
 *
 * Never log raw financial rows, passwords, tokens, or payment secrets
 * through this module or its callers — logContext() only ever carries
 * identity/correlation fields, never row payloads.
 */

export function generateCorrelationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (older browsers, test runners).
  return `cid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface LogContext {
  correlationId: string;
  companyId?: string;
  periodYear?: number;
  engineRunId?: string;
}

export function buildLogContext(partial: Omit<LogContext, "correlationId"> & { correlationId?: string }): LogContext {
  return {
    correlationId: partial.correlationId ?? generateCorrelationId(),
    ...(partial.companyId ? { companyId: partial.companyId } : {}),
    ...(partial.periodYear !== undefined ? { periodYear: partial.periodYear } : {}),
    ...(partial.engineRunId ? { engineRunId: partial.engineRunId } : {}),
  };
}

/**
 * Structured, provider-neutral log line. Wraps console.* today; a future
 * wave can swap the sink without touching call sites, since every caller
 * already passes a LogContext rather than free-form strings.
 */
export function logWithContext(
  level: "info" | "warn" | "error",
  message: string,
  context: LogContext,
): void {
  const line = { message, ...context };
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}
