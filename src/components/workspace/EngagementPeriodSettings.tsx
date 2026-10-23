import { useEffect, useState } from "react";
import { useEngagementMandate } from "@/hooks/useEngagementMandate";
import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import { canExercise } from "@/lib/auth/workspaceCapabilities";
import { useManagementEditGuard } from "@/components/account/managementState";
import { supabase } from "@/integrations/supabase/client";
import { PeriodSetup } from "@/components/workbench/intake/PeriodSetup";
import type { RpcClient } from "@/lib/workspace/workspaceSetupClient";
import { settingsSaved } from "@/lib/workspace/settingsContinuity";

/** Hosted by #187's route-backed window: one navigation blocker, no nested dialog or duplicate writer. */
export function EngagementPeriodSettings({ companyId, periodYear, onDone }: { companyId: string; periodYear: number; onDone: () => void }) {
  const { state, loading } = useWorkspaceCapabilities(companyId);
  const engagement = useEngagementMandate(companyId, periodYear);
  const [done, setDone] = useState(false);
  // Defer the return until the child's clean/busy guard has committed to the shared edit registry.
  useEffect(() => { if (done) onDone(); }, [done, onDone]);
  useManagementEditGuard(false, false);
  if (loading || engagement.loading) return <p role="status">Reading engagement settings…</p>;
  if (!canExercise(state, "prepare_close")) return <p role="status">Reporting period setup requires preparation access and a current plan. Your saved work remains accessible.</p>;
  if (!engagement.mandate?.granted?.length) return <p role="status">The engagement scope could not be confirmed. Return to the engagement and start its service before changing the reporting period.</p>;
  return <section className="max-w-2xl space-y-5" aria-label="Engagement settings">
    <h1 className="text-xl font-semibold">Reporting period and currency · FY{periodYear}</h1>
    <p className="text-sm text-muted-foreground">Save to return to the same task. Currency changes do not convert amounts. Accepted figures retain their existing protection.</p>
    <PeriodSetup key={`${companyId}:${periodYear}`} client={supabase as unknown as RpcClient} companyId={companyId} periodYear={periodYear}
      capabilities={engagement.mandate.granted}
      onOpened={() => { settingsSaved(companyId); setDone(true); }} />
  </section>;
}
