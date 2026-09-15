/**
 * workspaceCreateError.ts
 *
 * Typed, deterministic error classifier for workspace-create failures.
 *
 * Supabase PostgrestError is a PLAIN OBJECT — NOT an Error instance.
 * String(postgrestError) === "[object Object]" — calling String() on it
 * silently swallows all actionable fields (.code, .message, .details, .hint).
 * This module extracts and classifies those fields directly.
 *
 * Supported error shapes:
 *   - AuthError-like        (__isAuthError flag, or status 401)
 *   - FunctionsHttpError    (context.status 401/403)
 *   - PostgrestError        (plain object with code + message)
 *   - Standard Error        (message string, instanceof Error)
 *   - Unknown / null / string (generic fallback)
 */

// ── Typed shapes ─────────────────────────────────────────────────────────────

/** Supabase PostgrestError — a plain object, NOT an Error subclass. */
interface PostgrestLike {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/** Supabase AuthError carries .__isAuthError and .status. */
interface AuthErrorLike {
  __isAuthError?: boolean;
  status?: number;
  message?: string;
}

/** Supabase FunctionsHttpError carries .context.status. */
interface FunctionsHttpErrorLike {
  context?: { status?: number };
  message?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns a PostgrestLike view of `err` if it is a plain object with at least
 * one of `code` or `message` as a string. Returns null otherwise.
 */
function extractPostgrest(err: unknown): PostgrestLike | null {
  if (err !== null && typeof err === "object" && !Array.isArray(err) && !(err instanceof Error)) {
    const o = err as Record<string, unknown>;
    if (typeof o.code === "string" || typeof o.message === "string") {
      return {
        code:    typeof o.code    === "string" ? o.code    : undefined,
        message: typeof o.message === "string" ? o.message : undefined,
        details: typeof o.details === "string" ? o.details : undefined,
        hint:    typeof o.hint    === "string" ? o.hint    : undefined,
      };
    }
  }
  return null;
}

// ── Classifier ────────────────────────────────────────────────────────────────

export interface WorkspaceCreateErrorResult {
  message: string;
  canRetry: boolean;
}

/**
 * Classify a workspace-create error into a user-facing message + canRetry flag.
 *
 * Classification precedence:
 *   1. AuthError (session / JWT)
 *   2. FunctionsHttpError (Edge Function 401/403)
 *   3. PostgrestError plain object (by .code then .message)
 *   4. Standard Error instance (by .message substring)
 *   5. Unknown fallback
 */
export function classifyError(err: unknown): WorkspaceCreateErrorResult {
  // ── Dev-only logging — surfaces actual fields, never credentials ──────────
  if (import.meta.env.DEV) {
    console.error("[workspaceCreateError] workspace-create error:", err);
  }

  // ── 1. AuthError ──────────────────────────────────────────────────────────
  const maybeAuth = err as AuthErrorLike;
  if (maybeAuth?.__isAuthError || maybeAuth?.status === 401) {
    return {
      message: "Your session may have expired. Sign out and back in, then try again.",
      canRetry: false,
    };
  }

  // ── 2. FunctionsHttpError ─────────────────────────────────────────────────
  const maybeFn = err as FunctionsHttpErrorLike;
  if (
    typeof maybeFn?.context === "object" &&
    maybeFn.context !== null &&
    (maybeFn.context?.status === 401 || maybeFn.context?.status === 403)
  ) {
    return {
      message: "Your session may have expired. Sign out and back in, then try again.",
      canRetry: false,
    };
  }

  // ── 3. PostgrestError (plain object) ─────────────────────────────────────
  const pg = extractPostgrest(err);
  if (pg) {
    const code = pg.code ?? "";
    const msgLower = (pg.message ?? "").toLowerCase();

    // 23505 unique_violation
    if (code === "23505" || msgLower.includes("unique") || msgLower.includes("duplicate")) {
      return {
        message:
          "A workspace for this organization and period already exists. " +
          "Check the dashboard, or choose a different reporting year.",
        canRetry: false,
      };
    }

    // 42501 insufficient_privilege — RLS rejected the INSERT
    if (code === "42501") {
      return {
        message:
          "Permission denied. Your account may not be authorized to create a workspace. " +
          "Sign out and back in, then try again.",
        canRetry: false,
      };
    }

    // 23502 not_null_violation — required column received NULL
    if (code === "23502") {
      return {
        message:
          "A required field is missing. Refresh the page and try again. " +
          "If the problem persists, contact support.",
        canRetry: false,
      };
    }

    // 23P01 exclusion_violation — overlapping billing licence
    if (code === "23P01") {
      return {
        message:
          "The workspace could not be created due to a configuration conflict. " +
          "Please try again in a few moments.",
        canRetry: true,
      };
    }

    // JWT / auth surfaced through Postgrest message
    if (msgLower.includes("jwt") || msgLower.includes("unauthorized")) {
      return {
        message: "Your session may have expired. Sign out and back in, then try again.",
        canRetry: false,
      };
    }

    // Unknown Postgrest error
    return {
      message:
        "The workspace could not be created. This is usually temporary — " +
        "your details have been preserved. Try again or refresh the page.",
      canRetry: true,
    };
  }

  // ── 4. Standard Error instance ────────────────────────────────────────────
  if (err instanceof Error) {
    const r = err.message.toLowerCase();

    if (r.includes("unique") || r.includes("duplicate") || r.includes("already exists")) {
      return {
        message:
          "A workspace for this organization and period already exists. " +
          "Check the dashboard, or choose a different reporting year.",
        canRetry: false,
      };
    }
    if (r.includes("jwt") || r.includes("unauthorized") || r.includes("session expired")) {
      return {
        message: "Your session may have expired. Sign out and back in, then try again.",
        canRetry: false,
      };
    }
    if (
      r.includes("network") ||
      r.includes("fetch") ||
      r.includes("timeout") ||
      r.includes("failed to fetch")
    ) {
      return {
        message:
          "A network error occurred. Check your connection and try again — " +
          "your details have been preserved.",
        canRetry: true,
      };
    }
  }

  // ── 5. Unknown fallback ───────────────────────────────────────────────────
  return {
    message:
      "The workspace could not be created. This is usually temporary — " +
      "your details have been preserved. Try again or refresh the page.",
    canRetry: true,
  };
}
