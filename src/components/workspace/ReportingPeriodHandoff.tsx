import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useWorkspaceRefresh } from "@/hooks/useWorkspaceRefresh";
import { fetchWorkspaceSnapshot } from "@/lib/workspace/fetchWorkspaceSnapshot";
import { openEngagementWithScope, type RpcClient } from "@/lib/workspace/workspaceSetupClient";
import { supabase } from "@/integrations/supabase/client";
import { ManagementLink } from "@/components/account/ManagementNavigation";
import { WORKSPACE_SETTINGS_SAVED } from "@/lib/workspace/settingsContinuity";
import { resolvePeriodHandoff, type PeriodHandoff, type SavedPeriodRow } from "@/lib/workspace/periodHandoff";

/** In-flow navigation from saved, RLS-scoped period records; never moves an uploaded file. */
export function ReportingPeriodHandoff({ companyId, periodYear, currentFile }: { companyId: string; periodYear: number; currentFile?: string | null }) {
  const navigate=useNavigate();
  const opening=useRef(false);
  const [busy,setBusy]=useState(false), [openError,setOpenError]=useState("");
  const [priorFile,setPriorFile]=useState<{key:string;file:string|null;reviewed:boolean}|null>(null);
  const key = `${companyId}:${periodYear}`;
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{ key: string; status: "ready" | "error"; value: PeriodHandoff | null } | null>(null);
  useEffect(() => {
    const changed = (e: Event) => { if ((e as CustomEvent).detail?.companyId === companyId) setRevision((v) => v + 1); };
    window.addEventListener(WORKSPACE_SETTINGS_SAVED, changed);
    return () => window.removeEventListener(WORKSPACE_SETTINGS_SAVED, changed);
  }, [companyId]);
  const sequence=useRef(0);
  const load=useCallback(async () => {
    const mine=++sequence.current;
    try {
      const {data,error}=await supabase.from("fiscal_periods")
        .select("id, reporting_start, reporting_end, fiscal_year_end, reporting_currency, prior_period_id").eq("company_id",companyId);
      if(error || !data)throw Error("Period read unavailable");
      const value=resolvePeriodHandoff(data as SavedPeriodRow[],periodYear);
      if(mine!==sequence.current)return false;
      setRead({key,status:"ready",value});
      if(value?.prior){
        try {
          const snapshot=await fetchWorkspaceSnapshot({companyId,periodYear:value.prior.year,requireFresh:true});
          if(mine===sequence.current)setPriorFile({key,file:snapshot.upload?.file_name ?? null,reviewed:snapshot.workspaceState.missions.prepare.status === "passed"});
        } catch {if(mine===sequence.current)setPriorFile(null);return false;}
      }
      return true;
    } catch {if(mine===sequence.current)setRead({key,status:"error",value:null});return false;}
  },[companyId,periodYear,key]);
  useEffect(()=>{setRead(null);setPriorFile(null);setOpenError("");void load();return()=>{++sequence.current;};},[load,revision]);
  useWorkspaceRefresh(companyId,load,periodYear);
  const openPrior=async(year:number)=>{
    if(opening.current)return;opening.current=true;setBusy(true);setOpenError("");
    try{
      // Explicit click only. The existing idempotent server command checks current authority and creates/reuses the review.
      await openEngagementWithScope(supabase as unknown as RpcClient,{companyId,year,capabilities:["FINANCIAL_STATEMENTS"]});
      navigate(`/workspace/${companyId}/${year}/trial-balance/review`);
    }catch{setOpenError("The prior-year review could not be opened. Your files are unchanged. Retry, or ask the company owner to check service permissions.");}
    finally{opening.current=false;setBusy(false);}
  };
  const value = read?.key === key ? read.value : null;
  return <section className="space-y-2 border border-border bg-muted/20 px-4 py-3 text-sm" aria-label="Reporting periods" data-testid="reporting-period-handoff">
    <p className="font-medium">You are working in FY{periodYear}</p>
    {!read || read.key !== key ? <p role="status">Reading saved period dates…</p>
      : read.status === "error" ? <p role="status">Saved period details could not be read. No other year has been selected. <button type="button" className="underline" onClick={() => setRevision((v) => v + 1)}>Retry period details</button></p>
      : value ? <>
        <p>{value.current.start} to {value.current.end} · {value.current.currency}. Upload or replace only this period’s trial balance here.</p>
        {value.prior ? <div className="grid gap-3 sm:grid-cols-2" aria-label="Current and comparative trial balances">
          <div className="border border-border bg-background p-3"><h3 className="font-semibold">Current-year trial balance · FY{periodYear}</h3>
            <p>{value.current.start} to {value.current.end} · {value.current.currency}</p>
            <p className="mt-2 break-words">{currentFile === undefined ? "Current file and upload controls are below." : currentFile ?? "No current-year file selected."}</p>
            <a className="mt-2 inline-flex min-h-11 items-center font-medium underline" href="#current-trial-balance">Upload or review FY{periodYear}</a>
          </div>
          <div className="border border-border bg-background p-3"><h3 className="font-semibold">Prior-year comparative · FY{value.prior.year}</h3>
            <p>{value.prior.start} to {value.prior.end} · {value.prior.currency}</p>
            <p className="mt-2 break-words" role="status">{priorFile?.key !== key ? "Prior-year file status unavailable or still loading." : priorFile.file ? `${priorFile.file} · ${priorFile.reviewed ? "Reviewed" : "Review required"}` : "No prior-year trial balance uploaded."}</p>
            <button type="button" disabled={busy} className="mt-2 inline-flex min-h-11 items-center bg-primary px-3 font-medium text-primary-foreground disabled:opacity-50" onClick={()=>void openPrior(value.prior!.year)}>{busy ? "Opening prior year…" : `Upload or review FY${value.prior.year}`}</button>
            <Link className="mt-2 block underline" to={`/workspace/${companyId}/${value.prior.year}/trial-balance/review`}>Open FY{value.prior.year} trial balance</Link>
          </div>
        </div> : value.following ? <p>This is the comparative year for FY{value.following.year}. Add an earlier year only if your reporting scope requires it.</p>
          : <p>No prior period is linked. <ManagementLink className="underline" to="/settings?section=engagement">Add a comparative period</ManagementLink></p>}
        {openError && <p role="alert">{openError}</p>}
        {value.following && <p><Link className="underline" to={`/workspace/${companyId}/${value.following.year}/trial-balance/review`}>Return to FY{value.following.year} trial balance</Link></p>}
      </> : <p>Reporting dates are not set up for FY{periodYear}. <ManagementLink className="underline" to="/settings?section=engagement">Set up reporting dates and currency</ManagementLink></p>}
    <p className="text-xs text-muted-foreground">Setting up a prior period does not move your current file. A filename alone does not establish its reporting period.</p>

  </section>;
}
