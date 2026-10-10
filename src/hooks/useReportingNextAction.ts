/**
 * useReportingNextAction — for a company the server reports as enabled for reporting, the ONE next action of the reporting
 * journey (src/lib/reporting/nextAction.ts over reportingState.ts), with the canonical route of the page that owns it.
 * The workspace shell and the Overview use it instead of the legacy engine's statement step (which names a withheld stage
 * and knows nothing of Close Review, comparatives, notes or the saved version). Reads only; null until read or when
 * reporting is not enabled.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { NextAction } from "@/lib/reporting/nextAction";
import { WORKBENCH_GROUPS } from "@/lib/workbench/routes";

const SEGMENT = Object.fromEntries(WORKBENCH_GROUPS.flatMap((g) => g.pages.map((p) => [p.id, p.segment]))) as Record<string, string>;

export interface ReportingNextAction { readonly action: NextAction; readonly href: string }

export function useReportingNextAction(companyId: string | null | undefined, periodYear: number | null | undefined, enabled: boolean,
  allowed: readonly string[] | null, refreshKey?: string): ReportingNextAction | null {
  const [result, setResult] = useState<ReportingNextAction | null>(null);
  const allowedKey = (allowed ?? []).join(",");
  useEffect(() => {
    let live = true;
    if (!enabled || !companyId || !periodYear || allowed === null) { setResult(null); return; }
    // Loaded on demand: the reporting reader (and the sign-off client it uses) stays out of the entry chunk, in the
    // reporting chunk where it belongs (harnessIsolation.test.ts); only reporting-enabled companies ever load it.
    Promise.all([import("@/lib/reporting/reportingState"), import("@/lib/reporting/supabaseDb")]).then(async ([rs, sdb]) => {
      const db = sdb.supabaseReportingDb(supabase);
      return { s: await rs.readReportingSnapshot(db, rs.reportingClients(db), companyId, periodYear), nextActionFor: rs.nextActionFor };
    }).then(
      ({ s, nextActionFor }) => {
        if (!live) return;
        const action = nextActionFor(s, allowed);
        setResult({ action, href: `/workspace/${companyId}/${periodYear}/${SEGMENT[action.page] ?? ""}`.replace(/\/$/, "") });
      },
      () => { if (live) setResult(null); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- allowed is keyed by its contents
  }, [companyId, periodYear, enabled, allowedKey, refreshKey]);
  return result;
}
