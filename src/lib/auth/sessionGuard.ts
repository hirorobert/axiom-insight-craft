/**
 * sessionGuard — the ONE place the authenticated read surfaces agree on whether a
 * usable session exists before they query the database, and what to do when the
 * database refuses a read because the JWT is missing or expired.
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

/** True when a PostgREST/Supabase error is an authorization failure rather than a data problem. */
export function isAuthorizationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; status?: number; message?: string };
  if (e.code === "42501" || e.code === "PGRST301") return true;
  if (e.status === 401 || e.status === 403) return true;
  const msg = (e.message ?? "").toLowerCase();
  return (
    msg.includes("permission denied") ||
    msg.includes("jwt expired") ||
    msg.includes("invalid claim") ||
    msg.includes("missing sub claim") ||
    msg.includes("valid bearer token")
  );
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

/** Convenience: sign out and redirect when the given error is an authorization failure. Returns true when handled. */
export async function handleIfAuthorizationFailure(error: unknown): Promise<boolean> {
  if (!isAuthorizationFailure(error)) return false;
  await endExpiredSession();
  return true;
}
