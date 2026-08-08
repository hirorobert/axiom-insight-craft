import { supabase } from "@/integrations/supabase/client";

/**
 * Guarantees the browser holds a *valid* access token before an edge function
 * is invoked. A revoked or expired session still lives in localStorage, so
 * supabase.functions.invoke happily sends a dead JWT and the function replies
 * 401 {"error":"Invalid or expired token"}.
 *
 * Strategy:
 *  1. Read the stored session. If none -> hard fail (user must sign in).
 *  2. Re-validate against the auth server with getUser(). If that fails, try
 *     one explicit refreshSession().
 *  3. If refresh also fails the session is revoked: sign out locally and throw
 *     a plain-language error so the caller can show it instead of blanking.
 */
export async function ensureFreshSession(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    throw new Error("Your session has ended. Please sign in again.");
  }

  const { error: userErr } = await supabase.auth.getUser();
  if (!userErr) return session.access_token;

  const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
  if (refreshErr || !refreshed.session) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    throw new Error("Your session expired. Please sign in again to continue.");
  }
  return refreshed.session.access_token;
}
