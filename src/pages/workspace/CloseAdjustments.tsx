/**
 * Close Review › Adjustments (workbench page `close-adjustments`). Registered only once released
 * (RELEASED_WORKBENCH_PAGES); releasing it also retires the legacy adjusting-journal panel in Reconcile (one adjustment
 * path). Reads only; every write is a server function.
 */
import { useMemo } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import { supabase } from "@/integrations/supabase/client";
import { AdjustmentsView } from "@/components/closeReview/AdjustmentsView";
import { adjustmentsClient } from "@/lib/closeReview/adjustments";

export default function CloseAdjustments() {
  const { companyId, periodYear } = useWorkspace();
  const { user } = useAuth();
  const { state: caps } = useWorkspaceCapabilities(companyId);
  const client = useMemo(() => adjustmentsClient(supabase as unknown as Parameters<typeof adjustmentsClient>[0]), []);
  return (
    <div className="space-y-6 p-4">
      <h1 className="text-lg font-semibold">Close Review — Adjustments · FY{periodYear}</h1>
      <AdjustmentsView companyId={companyId} periodYear={periodYear} client={client} allowed={caps?.allowed ?? []} currentUserId={user?.id ?? null} />
    </div>
  );
}
