/**
 * Pure parser for Supabase Auth error fragments in the URL hash — the redirect
 * a user lands on after clicking an already-consumed or expired email link:
 *   /#error=access_denied&error_code=otp_expired&error_description=...
 * Kept free of browser/client imports so it is unit-testable in node.
 */

export interface AuthLinkError {
  error: string;
  errorCode: string | null;
  errorDescription: string | null;
}

export function getAuthLinkError(hash: string): AuthLinkError | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const error = params.get("error");
  if (!error) return null;
  return {
    error,
    errorCode: params.get("error_code"),
    errorDescription: params.get("error_description"),
  };
}
