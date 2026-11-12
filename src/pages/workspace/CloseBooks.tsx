/**
 * Close Review › Check my books (workbench page `close-books`). Registered only once released (RELEASED_WORKBENCH_PAGES).
 * Reads only; every write is a server function and the engine runs in the Edge Function rfr-check-books.
 */
import { useMemo } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import { supabase } from "@/integrations/supabase/client";
import { CheckBooksView } from "@/components/readiness/CheckBooksView";
import { readinessClient } from "@/lib/readiness/client";

export default function CloseBooks() {
  const { companyId, periodYear } = useWorkspace();
  const { state: caps } = useWorkspaceCapabilities(companyId);
  const client = useMemo(() => readinessClient(
    supabase as unknown as Parameters<typeof readinessClient>[0],
    (name, body) => supabase.functions.invoke(name, { body }),
  ), []);
  return (
    <div className="space-y-6 p-4">
      <h1 className="text-lg font-semibold">Close Review — Check my books · FY{periodYear}</h1>
      <CheckBooksView companyId={companyId} periodYear={periodYear} client={client} allowed={caps?.allowed ?? []} />
    </div>
  );
}
