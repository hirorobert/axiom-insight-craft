import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ManagementLink } from "@/components/account/ManagementNavigation";
import { WORKSPACE_SETTINGS_SAVED } from "@/lib/workspace/settingsContinuity";
import { resolvePeriodHandoff, type PeriodHandoff, type SavedPeriodRow } from "@/lib/workspace/periodHandoff";

/** In-flow navigation from saved, RLS-scoped period records; never moves an uploaded file. */
export function ReportingPeriodHandoff({ companyId, periodYear }: { companyId: string; periodYear: number }) {
  const key = `${companyId}:${periodYear}`;
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{ key: string; status: "ready" | "error"; value: PeriodHandoff | null } | null>(null);
  useEffect(() => {
    const changed = (e: Event) => { if ((e as CustomEvent).detail?.companyId === companyId) setRevision((v) => v + 1); };
    window.addEventListener(WORKSPACE_SETTINGS_SAVED, changed);
    return () => window.removeEventListener(WORKSPACE_SETTINGS_SAVED, changed);
  }, [companyId]);
  useEffect(() => {
    let live = true;
    setRead(null);
    void (async () => {
      try {
        const { data, error } = await supabase.from("fiscal_periods")
          .select("id, reporting_start, reporting_end, fiscal_year_end, reporting_currency, prior_period_id").eq("company_id", companyId);
        if (error || !data) throw Error("Period read unavailable");
        const value = resolvePeriodHandoff(data as SavedPeriodRow[], periodYear);
        if (live) setRead({ key, status: "ready", value });
      } catch { if (live) setRead({ key, status: "error", value: null }); }
    })();
    return () => { live = false; };
  }, [companyId, periodYear, key, revision]);
  const value = read?.key === key ? read.value : null;
  return <section className="space-y-2 border border-border bg-muted/20 px-4 py-3 text-sm" aria-label="Reporting periods" data-testid="reporting-period-handoff">
    <p className="font-medium">You are working in FY{periodYear}</p>
    {!read || read.key !== key ? <p role="status">Reading saved period dates…</p>
      : read.status === "error" ? <p role="status">Saved period details could not be read. No other year has been selected. <button type="button" className="underline" onClick={() => setRevision((v) => v + 1)}>Retry period details</button></p>
      : value ? <>
        <p>{value.current.start} to {value.current.end} · {value.current.currency}. Upload or replace only this period’s trial balance here.</p>
        {value.prior ? <p>Linked prior period: FY{value.prior.year} · {value.prior.start} to {value.prior.end} · {value.prior.currency}.{" "}
          <Link className="underline" to={`/workspace/${companyId}/${value.prior.year}/trial-balance/review`}>Open FY{value.prior.year} trial balance</Link></p>
          : <p>No prior period is linked. <ManagementLink className="underline" to="/settings?section=engagement">Set up the prior period</ManagementLink></p>}
        {value.following && <p><Link className="underline" to={`/workspace/${companyId}/${value.following.year}/trial-balance/review`}>Return to FY{value.following.year} trial balance</Link></p>}
      </> : <p>Reporting dates are not set up for FY{periodYear}. <ManagementLink className="underline" to="/settings?section=engagement">Set up reporting dates and currency</ManagementLink></p>}
    <p className="text-xs text-muted-foreground">Setting up a prior period does not move your current file. A filename alone does not establish its reporting period.</p>
    {value?.prior && <p className="text-xs text-muted-foreground">If the prior year asks you to start its review, choose Trial Balance Review on that year’s Overview first.</p>}
  </section>;
}
