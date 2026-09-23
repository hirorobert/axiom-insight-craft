/**
 * sessionGuard — the ONE place the authenticated read surfaces agree on whether a
 * usable session exists before they query the database, and what to do when the
 * database refuses a read. A refusal because the JWT is missing or expired ends the
 * session. A refusal because a valid session lacks permission (42501 / 403) does not:
 * that is reported as an authorization denial and the user stays signed in.
 *
 * Iron Dome: an unauthenticated read is never silently treated as "no data".
 * Every guarded caller either has a live session or is signed out and returned to
 * the sign-in screen with a plain-language message — never left on an
 * authenticated-looking screen with empty panels.
 *
 * Pure-ish and side-effect-free apart from the explicit sign-out path. No
 * financial data is read or written here.
 */

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

/**
 * Resolves the caller's live access token, refreshing once when the stored
 * session has already expired. Returns null when no usable session exists —
 * never throws, never returns a stale token.
 */
export async function resolveActiveSession(): Promise<string | null> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) return null;

  const expiresAtMs = session.expires_at ? session.expires_at * 1000 : null;
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr || !refreshed.session) return null;
    return refreshed.session.access_token;
  }

  return session.access_token;
}

type ErrorShape = { code?: string; status?: number; message?: string; name?: string };
const asShape = (error: unknown): ErrorShape | null => (error && typeof error === "object" ? (error as ErrorShape) : null);

/**
 * True only when the error PROVES the session itself is unusable: an expired, malformed or unknown JWT.
 * PostgREST reports these as HTTP 401 / PGRST301-302; GoTrue as 401, session_not_found or bad_jwt.
 * SQLSTATE 42501 is deliberately NOT here. It means "this valid session is not allowed to do that",
 * which is a normal authorization answer and no reason to sign anyone out.
 */
export function isSessionInvalid(error: unknown): boolean {
  const e = asShape(error);
  if (!e) return false;
  if (e.status === 401) return true;
  if (e.code === "PGRST301" || e.code === "PGRST302" || e.code === "bad_jwt" || e.code === "session_not_found" || e.code === "refresh_token_not_found" || e.code === "user_not_found") return true;
  if (e.name === "AuthSessionMissingError") return true;
  const msg = (e.message ?? "").toLowerCase();
  return (
    msg.includes("jwt expired") ||
    msg.includes("invalid jwt") ||
    msg.includes("invalid claim") ||
    msg.includes("missing sub claim") ||
    msg.includes("valid bearer token") ||
    msg.includes("sub claim in jwt does not exist")
  );
}

/** True when the database or API refused the request for a session it accepted (SQLSTATE 42501 / HTTP 403). */
export function isAuthorizationDenied(error: unknown): boolean {
  const e = asShape(error);
  if (!e || isSessionInvalid(e)) return false;
  if (e.code === "42501" || e.status === 403) return true;
  return (e.message ?? "").toLowerCase().includes("permission denied");
}

/** Either of the two above. Kept for callers that only need to know the error is auth-related. */
export function isAuthorizationFailure(error: unknown): boolean {
  return isSessionInvalid(error) || isAuthorizationDenied(error);
}

let endingSession = false;

/**
 * Ends an unusable session: one toast, a local sign-out, and a return to the
 * sign-in screen. Deduplicated so several panels failing in the same burst
 * cannot stack toasts or fight over navigation.
 */
export async function endExpiredSession(
  message = "Your session has expired. Please sign in again.",
): Promise<void> {
  if (endingSession) return;
  endingSession = true;
  try {
    toast.error(message);
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    if (typeof window !== "undefined" && window.location.pathname !== "/auth") {
      window.location.assign("/auth");
    }
  } finally {
    endingSession = false;
  }
}

let deniedToastShown = false;

/**
 * Handles an auth-related error without ever destroying a valid session:
 *   - proven session invalidation -> one toast, local sign-out, back to sign-in;
 *   - an authorization denial (42501 / 403) -> the session is confirmed with the auth server first.
 *     If it is really gone, sign out as above; if it is still valid, say plainly that access was denied
 *     and keep the user signed in. A network failure during that check is not proof of anything, so it
 *     never signs anyone out.
 * Returns true when the error was auth-related and has been handled, and false for anything else,
 * which the caller then treats as an ordinary data error.
 */
export async function handleIfAuthorizationFailure(error: unknown): Promise<boolean> {
  if (isSessionInvalid(error)) {
    await endExpiredSession();
    return true;
  }
  if (!isAuthorizationDenied(error)) return false;

  const { data, error: userError } = await supabase.auth.getUser();
  if (!data?.user && (!userError || isSessionInvalid(userError))) {
    await endExpiredSession();
    return true;
  }
  if (!deniedToastShown) {
    deniedToastShown = true;
    toast.error("You don't have permission to view part of this workspace. You are still signed in.");
    setTimeout(() => { deniedToastShown = false; }, 4000);
  }
  return true;
}
