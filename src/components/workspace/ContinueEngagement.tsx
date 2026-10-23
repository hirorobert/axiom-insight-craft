import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { readContinueEngagement } from "@/lib/workspace/continueEngagement";
import { PORTFOLIO_STATUS_VIEW, portfolioDestination, type PortfolioRow } from "@/lib/workspace/portfolioClient";

type Rpc = Parameters<typeof readContinueEngagement>[0];
const rpc: Rpc = async (fn, args) => {
  const { supabase } = await import("@/integrations/supabase/client");
  return (supabase.rpc as unknown as Rpc)(fn, args);
};
export function ContinueEngagement({ read = () => readContinueEngagement(rpc) }: { read?: () => ReturnType<typeof readContinueEngagement> }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "unavailable" } | { kind: "ok"; row: PortfolioRow | null }>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    void read().then((answer) => { if (live) setState(answer); }, () => { if (live) setState({ kind: "unavailable" }); });
    return () => { live = false; };
    // The read implementation is injected once in tests; account identities remount this component at the host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  if (state.kind === "ok" && !state.row) return null;
  return <section aria-labelledby="continue-heading" className="mb-6 border border-border bg-card p-4" data-testid="continue-engagement">
    <h2 id="continue-heading" className="text-sm font-semibold">Continue where you left off</h2>
    {state.kind === "loading" ? <p role="status" className="mt-2 text-sm">Checking saved progress…</p> : state.kind === "unavailable" ? <div className="mt-2 flex flex-wrap items-center gap-3"><p role="status" className="text-sm">Saved progress could not be confirmed.</p><Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>Try again</Button></div> : state.row && <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><p className="break-words text-sm font-medium">{state.row.companyName} · FY{state.row.periodYear}</p>
        <p data-testid="continue-status" className="mt-1 text-sm text-muted-foreground">{PORTFOLIO_STATUS_VIEW[state.row.status].label}</p>
        <p className="mt-1 text-xs text-muted-foreground">Most recently opened engagement. The workspace checks the next permitted step.</p></div>
      <Button asChild data-testid="continue-action"><Link to={portfolioDestination(state.row)}>{PORTFOLIO_STATUS_VIEW[state.row.status].action}</Link></Button>
    </div>}
  </section>;
}
