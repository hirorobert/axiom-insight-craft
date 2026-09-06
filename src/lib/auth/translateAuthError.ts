/**
 * PPG-1 Finding 2 — centralized auth-error translation boundary.
 *
 * Users must never see a raw Supabase/provider error string (technical
 * jargon, internal codes, or wording that assumes engineering context).
 * This is deliberately a substring-match classifier, not an error-code
 * lookup: Supabase's JS client does not consistently expose a stable
 * machine-readable code for every one of these cases across versions, and
 * the pre-existing (already shipped) signup rate-limit fix in this
 * codebase established the same pattern — this file generalizes it into
 * one shared boundary instead of leaving it duplicated and inconsistent
 * per call site (signup handled it; resend-confirmation did not, and
 * still showed the raw provider message on a rate-limited resend).
 *
 * Never invents cause: an error that doesn't match a known shape falls
 * through to a calm, generic, actionable message — never the original
 * string, and never a guess dressed up as a specific diagnosis.
 */

export type AuthErrorCategory =
  | "rate_limited"
  | "already_registered"
  | "invalid_email"
  | "weak_password"
  | "network_error"
  | "unknown";

export interface TranslatedAuthError {
  category: AuthErrorCategory;
  /** Calm, actionable, non-technical — safe to show directly to the user. */
  message: string;
}

interface AuthErrorLike {
  message?: string | null;
  status?: number | null;
}

const RATE_LIMIT_MESSAGE =
  "We couldn't send the confirmation email right now. Please wait a little and try again. If you already created the account, use Resend confirmation instead of creating another account.";

export function translateAuthError(error: AuthErrorLike | null | undefined): TranslatedAuthError {
  const raw = (error?.message ?? "").toLowerCase();
  const status = error?.status ?? null;

  if (!raw) {
    return { category: "unknown", message: "Something went wrong. Please try again." };
  }

  if (
    status === 429 ||
    raw.includes("rate limit") ||
    raw.includes("too many requests") ||
    raw.includes("over_email_send_rate_limit")
  ) {
    return { category: "rate_limited", message: RATE_LIMIT_MESSAGE };
  }

  if (
    raw.includes("user already registered") ||
    raw.includes("already registered") ||
    raw.includes("already exists")
  ) {
    return {
      category: "already_registered",
      message: "This email is already registered. Please sign in instead.",
    };
  }

  if (raw.includes("email") && (raw.includes("invalid") || raw.includes("unable to validate"))) {
    return {
      category: "invalid_email",
      message: "That doesn't look like a valid email address. Please check it and try again.",
    };
  }

  if (
    raw.includes("password") &&
    (raw.includes("weak") || raw.includes("short") || raw.includes("at least") || raw.includes("should be"))
  ) {
    return {
      category: "weak_password",
      message: "That password is too weak. Please use at least 6 characters.",
    };
  }

  if (
    raw.includes("network") ||
    raw.includes("failed to fetch") ||
    raw.includes("fetch failed") ||
    raw.includes("timeout")
  ) {
    return {
      category: "network_error",
      message: "We couldn't reach the server. Please check your connection and try again.",
    };
  }

  // Generic, deliberately non-specific fallback — never the raw provider
  // string. A truthful "something failed", not a fabricated specific cause.
  return { category: "unknown", message: "We couldn't complete that request right now. Please try again." };
}
