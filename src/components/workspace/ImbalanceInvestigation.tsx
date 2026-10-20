/**
 * ImbalanceInvestigation — "Look for likely causes in this file" for an out-of-balance trial balance.
 *
 * One request to the server (trial-balance-layout investigate), for the result on screen only; the server holds one
 * investigation per upload at a time and reuses a finished one. The answer is a list of rows to check — leads, never a
 * correction: nothing here proposes an amount, an adjusting entry or a plug, and nothing claims the ledger itself is out
 * of balance. The fix stays where it belongs: correct the source and upload it again.
 */
import { useRef, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InvestigationResult, LayoutClient } from "@/lib/workbench/intake/layoutClient";

type State =
  | { kind: "idle" } | { kind: "running" } | { kind: "busy" } | { kind: "done"; result: InvestigationResult }
  | { kind: "error"; message: string };

export function ImbalanceInvestigation({ client, uploadId, certificationId }: {
  client: Pick<LayoutClient, "investigate">; uploadId: string; certificationId: string;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const requestId = useRef(crypto.randomUUID());

  const run = async () => {
    setState({ kind: "running" });
    try {
      const a = await client.investigate(uploadId, certificationId, requestId.current);
      if (a.kind === "ok" && a.value.status === "completed" && a.value.result) { setState({ kind: "done", result: a.value.result }); return; }
      if (a.kind === "ok" && a.value.status === "in_progress") { setState({ kind: "busy" }); return; }
      if (a.kind === "unavailable") { setState({ kind: "error", message: "Looking for causes is not available yet. The figures and findings above are unchanged." }); return; }
      requestId.current = crypto.randomUUID();
      setState({ kind: "error", message: a.kind === "refused" || a.kind === "invalid" || a.kind === "conflict" ? a.message : "The search did not finish. Try again." });
    } catch {
      setState({ kind: "error", message: "The search could not be completed (connection problem). Try again." });
    }
  };

  if (state.kind === "done") {
    const r = state.result;
    return (
      <section aria-labelledby="investigation-title" className="space-y-3 text-[13px]" data-testid="imbalance-investigation">
        <h3 id="investigation-title" className="font-medium text-foreground">Likely causes in this file</h3>
        <p className="text-muted-foreground">The difference is {r.difference}; the {r.larger} are larger.</p>
        {r.leads.length === 0
          ? <p data-testid="investigation-no-leads">No single row explains the difference. Compare the file with your accounting system's trial balance, section by section.</p>
          : (
            <ul className="space-y-2" data-testid="investigation-leads">
              {r.leads.map((l, i) => (
                <li key={`${l.kind}-${i}`} className="border-l-2 border-amber-500/70 pl-3" data-kind={l.kind}>
                  <span className="font-medium">Row{l.rows.length === 1 ? "" : "s"} {l.rows.join(", ")}.</span> {l.check}
                </li>
              ))}
            </ul>
          )}
        {r.more > 0 && <p className="text-muted-foreground">And {r.more} more lead{r.more === 1 ? "" : "s"} of the same kinds.</p>}
        <p className="text-[12px] text-muted-foreground" data-testid="investigation-statement">{r.statement}</p>
      </section>
    );
  }
  return (
    <div className="space-y-2 text-[13px]" data-testid="imbalance-investigation">
      <Button type="button" variant="outline" className="h-10 rounded-none" onClick={() => void run()} disabled={state.kind === "running"}
        aria-busy={state.kind === "running"} data-testid="investigation-run">
        <Search className="mr-2 h-4 w-4" aria-hidden="true" />{state.kind === "running" ? "Looking…" : "Look for likely causes in this file"}
      </Button>
      <div aria-live="polite">
        {state.kind === "busy" && <p data-testid="investigation-busy">A search for this file is already running. Try again in a moment.</p>}
        {state.kind === "error" && <p role="alert" className="text-destructive" data-testid="investigation-error">{state.message}</p>}
      </div>
    </div>
  );
}
