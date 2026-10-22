/**
 * /upload — the focused upload page: one task, nothing else on the screen.
 *
 *   1. The upload card (FirstUpload, full size): the file, then entity, period and currency, then "Start trial balance
 *      check". Entities come from the server's bounded list (list_portfolio_entities), never from every upload; a new
 *      entity's name is pre-checked against them (entityPrecheck.ts).
 *   2. Saved uploads: files stored as drafts and not yet checked, from the server (list_trial_balance_drafts), each with
 *      an explicit "Remove" (delete_trial_balance_draft) — nothing is discarded silently. A draft being committed cannot
 *      be removed (the server says so).
 *
 * Every write goes through the existing authorities; this page reads and links.
 */
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountShell } from "@/components/account/AccountShell";
import FirstUpload from "@/components/workspace/FirstUpload";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useBillingSummary } from "@/hooks/useBillingSummary";
import { useMyEntityCapacity } from "@/hooks/useMyEntityCapacity";
import { companyCreation } from "@/lib/workspace/accountNextAction";
import { firstUploadResultRoute } from "@/lib/workspace/engagementNextAction";
import { fetchPortfolioEntities, type PortfolioEntity } from "@/lib/workspace/portfolioClient";
import { SavedDrafts } from "@/components/workspace/SavedDrafts";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
const rpc: Rpc = (fn, args) => (supabase.rpc as unknown as Rpc)(fn, args);

export default function UploadTrialBalance() {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const { summary: billing, loading: billingLoading, error: billingError } = useBillingSummary();
  const { capacity, loading: capacityLoading, error: capacityError } = useMyEntityCapacity(!!user);
  const [entities, setEntities] = useState<PortfolioEntity[] | null>(null);
  const [entityTotal, setEntityTotal] = useState(0);
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    void fetchPortfolioEntities(rpc).then((r) => { if (r.kind === "ok") { setEntities(r.entities); setEntityTotal(r.total); } else setEntities([]); });
  }, [userId]);

  if (!authLoading && !user) return <Navigate to="/auth" replace />;
  const creation = companyCreation({
    billing: { loading: billingLoading, error: !!billingError, summary: billing },
    capacity: { loading: capacityLoading, error: !!capacityError, answer: capacity },
  });
  const signOutHome = async () => { await signOut(); navigate("/auth", { replace: true }); };
  const ready = !authLoading && entities !== null && creation !== "checking";

  return (
    <AccountShell identity={{ name: user?.user_metadata?.display_name, email: user?.email }} onSignOut={signOutHome}>
      <Link to="/dashboard" className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground" data-testid="upload-back">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />Engagements
      </Link>
      {!ready ? (
        <div className="space-y-3" aria-busy="true"><Skeleton className="h-8 w-56" /><Skeleton className="h-40 w-full" /></div>
      ) : (
        <>
          <FirstUpload
            entities={entities!.map((e) => ({ id: e.id, name: e.name }))}
            canCreateEntity={creation === "allowed"}
            needsPlan={creation === "needs_plan"}
            onChoosePlan={() => navigate("/plans")}
            onOpenResult={(companyId, year, uploadId) => navigate(firstUploadResultRoute(companyId, year, uploadId))}
          />
          {entityTotal > entities!.length && (
            <p className="mt-3 text-[12px] text-muted-foreground" data-testid="upload-entities-truncated">
              Showing the first {entities!.length} of {entityTotal} entities by name. To upload for another, open it from Engagements.
            </p>
          )}
          <SavedDrafts rpc={rpc} />
        </>
      )}
    </AccountShell>
  );
}
