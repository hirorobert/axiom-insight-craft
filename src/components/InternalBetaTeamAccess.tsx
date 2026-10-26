import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { settingsSaved } from "@/lib/workspace/settingsContinuity";
import { useWorkspaceRefresh } from "@/hooks/useWorkspaceRefresh";
type Member = {userId: string; displayName?: string; email?: string; role: string};
type Enrollment = {userId: string; enrolled: boolean};
/** The server checks current workspace authority, independent of prior beta enrollment. */
export function InternalBetaTeamAccess({companyId,members}: {companyId: string; members: Member[]}) {
  const [read,setRead]=useState<{companyId:string;rows:Enrollment[] | null;error:boolean} | null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const active=useRef(companyId); active.current=companyId;
  const running=useRef(false), sequence=useRef(0);
  const load=useCallback(async () => {
    const mine=++sequence.current;
    try {
      const {data,error}=await supabase.rpc("internal_beta_team_status" as never,{p_company_id:companyId} as never);
      const raw: unknown=data;
      const rows=Array.isArray(raw) && raw.every(r => r && typeof r.userId === "string" && typeof r.enrolled === "boolean") ? raw as Enrollment[] : null;
      if(mine===sequence.current && active.current===companyId) setRead({companyId,rows:error?null:rows,error:!!error || !rows});
      return !error && !!rows;
    } catch { if(mine===sequence.current && active.current===companyId) setRead({companyId,rows:null,error:true}); return false; }
  },[companyId]);
  const memberKey=members.map(m=>m.userId).join(",");
  useEffect(()=>{setRead(null);setMessage("");void load();return()=>{++sequence.current;};},[load,memberKey]);
  useWorkspaceRefresh(companyId,load);
  const enroll=async(userId:string)=>{
    if(running.current)return; running.current=true;setBusy(true);const company=companyId;
    try {
      const {data,error}=await supabase.rpc("internal_beta_enroll_member" as never,{
        p_company_id:company,p_user_id:userId,p_reason:"Workspace manager explicitly enrolled this accepted member for internal beta testing.",
      } as never);
      if(active.current!==company)return;
      setMessage(!error && (data as {outcome?:string}|null)?.outcome==="recorded"
        ? "Beta enrollment saved. Company reporting access is selected separately below; role permissions are unchanged."
        : "Enrollment could not be confirmed. Check the status before retrying.");
      await load(); settingsSaved(company);
    } catch { if(active.current===company){setMessage("Enrollment could not be confirmed. Check the status before retrying.");await load();} }
    finally{running.current=false;setBusy(false);}
  };
  const current=read?.companyId===companyId ? read:null;
  return <section className="space-y-3 border border-border p-4" aria-label="Internal beta team access">
    <h3 className="text-sm font-semibold">Internal beta access</h3>
    <p className="text-sm text-muted-foreground">Enroll accepted team members, then choose this company in reporting settings. Enrollment does not change roles, buy seats or enable AI spending.</p>
    {!current ? <p role="status">Checking beta enrollment…</p> : current.error ? <p role="status">Beta enrollment could not be read. You need current team-management permission and the latest backend update. <Button variant="outline" size="sm" onClick={()=>void load()}>Retry enrollment status</Button></p>
      : members.map(member=>{
        const row=current.rows?.find(r=>r.userId===member.userId);if(!row)return null;
        const label=member.displayName || member.email || member.userId.slice(0,8);
        return <div key={member.userId} className="flex items-center justify-between gap-3 text-sm"><span>{label}</span>
          {row.enrolled ? <span>Enrolled</span> : <Button variant="outline" size="sm" disabled={busy} onClick={()=>void enroll(member.userId)} aria-label={`Enable beta access for ${label}`}>Enable beta access</Button>}</div>;
      })}
    {message && <p role="status" className="text-sm">{message}</p>}
    {current?.rows?.some(r=>r.enrolled) && <Link className="inline-flex min-h-11 items-center text-sm underline" to="/commercial/admin?tab=internal-beta">Open reporting settings (commercial administrator)</Link>}
  </section>;
}
