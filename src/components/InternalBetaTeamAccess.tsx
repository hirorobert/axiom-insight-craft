import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type Member = { userId: string; displayName?: string; email?: string; role: string };
type Enrollment = { userId: string; enrolled: boolean };

/** Normal Team settings. The database authorizes the manager and rechecks the target's accepted membership. */
export function InternalBetaTeamAccess({ companyId, members }: { companyId: string; members: Member[] }) {
  const [rows, setRows] = useState<Enrollment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const active = useRef(companyId);
  active.current = companyId;
  useEffect(() => {
    let live = true;
    setRows(null);
    void Promise.resolve(supabase.rpc("internal_beta_team_status" as never, { p_company_id: companyId } as never))
      .then(({ data, error }) => {
        if (live && !error && Array.isArray(data)) setRows(data as Enrollment[]);
      }).catch(() => {});
    return () => { live = false; };
  }, [companyId, retry, members.length]);

  const enroll = async (userId: string) => {
    if (busy) return;
    const company = companyId;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("internal_beta_enroll_member" as never, {
        p_company_id: company, p_user_id: userId,
        p_reason: "Workspace manager enabled this accepted team member for internal beta testing.",
      } as never);
      if (active.current !== company) return;
      if (error || (data as { outcome?: string } | null)?.outcome !== "recorded") {
        toast.error("Could not confirm beta access. Refresh the team before trying again.");
      } else {
        toast.success("Beta access enabled. Existing role permissions are unchanged.");
      }
      setRetry(n => n + 1);
    } catch {
      if (active.current === company) {
        toast.error("Could not confirm beta access. Refresh the team before trying again.");
        setRetry(n => n + 1);
      }
    } finally { setBusy(false); }
  };

  if (!rows) return null; // Older backends and unauthorized managers expose no action.
  return <section className="space-y-3 border-t border-border pt-4" aria-label="Internal beta team access">
    <h3 className="text-sm font-semibold">Internal beta access</h3>
    <p className="text-xs text-muted-foreground">Enable accepted colleagues to test reporting and advisory AI. Their existing roles still apply.</p>
    {members.map(member => {
      const row = rows.find(r => r.userId === member.userId);
      if (!row) return null;
      const label = member.displayName || member.email || member.userId.slice(0, 8);
      return <div key={member.userId} className="flex items-center justify-between gap-3 text-sm">
        <span>{label}</span>
        {row.enrolled ? <span className="text-muted-foreground">Enabled</span>
          : <Button variant="outline" size="sm" disabled={busy} onClick={() => void enroll(member.userId)}
            aria-label={`Enable beta access for ${label}`}>Enable beta access</Button>}
      </div>;
    })}
  </section>;
}
