/**
 * CommercialAdminLink — a Settings link to /commercial/admin, shown ONLY when the server's canonical predicate
 * public.is_commercial_admin() (an active commercial_admins row, the same check every admin RPC enforces) answers
 * exactly `true`. Loading, an error, or any other answer shows nothing. Navigation only: the route and every admin RPC
 * keep their own server enforcement.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";

/** Strict: only a literal `true` with no error is authority. */
export const isCommercialAdminAnswer = (data: unknown, error: unknown): boolean => !error && data === true;

export function useIsCommercialAdmin(userId: string | null | undefined): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    setAdmin(false);
    if (!userId) return;
    let live = true;
    import("@/integrations/supabase/client")
      .then(({ supabase }) => (supabase.rpc as unknown as (fn: string) => Promise<{ data: unknown; error: unknown }>)("is_commercial_admin"))
      .then(({ data, error }) => { if (live) setAdmin(isCommercialAdminAnswer(data, error)); }, () => { if (live) setAdmin(false); });
    return () => { live = false; };
  }, [userId]);
  return admin;
}

export function CommercialAdminLink({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <Link to="/commercial/admin" data-testid="settings-commercial-admin-link"
      className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-foreground underline underline-offset-4 hover:no-underline">
      <ShieldCheck className="h-4 w-4" aria-hidden="true" />Commercial administration
    </Link>
  );
}
