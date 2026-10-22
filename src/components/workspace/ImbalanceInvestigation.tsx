/**
 * ImbalanceInvestigation — "Look for likely causes in this file" for an out-of-balance trial balance.
 *
 * One request to the server (trial-balance-layout investigate), for the result on screen only; the server holds one
 * investigation per upload at a time and reuses a finished one. The answer says what the file shows: the totals of the
 * rows read beside the file's own printed totals, the possible cause that comparison points to (labelled as possible),
 * leads by row, and every row the reader saw — included and excluded, with its source row, exact amounts and why a row was
 * left out — read page by page from what the server stored once (investigationRows; the file is never parsed again).
 * Leads, never a correction: nothing here proposes an amount, an adjusting entry or a plug, and nothing claims the ledger
 * itself is out of balance. The fix stays where it belongs: correct the source and upload it again.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import type { InvestigationResult, LayoutClient } from "@/lib/workbench/intake/layoutClient";
import { fetchInvestigationRows, formatMinor, ROW_FILTERS, ROWS_PAGE, type InvestigationRowView, type RowFilter } from "@/lib/workspace/investigationRows";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
const defaultRpc: Rpc = (fn, args) => (supabase.rpc as unknown as Rpc)(fn, args);

type State =
  | { kind: "idle" } | { kind: "running" } | { kind: "busy" } | { kind: "done"; result: InvestigationResult; investigationId: string | null }
  | { kind: "error"; message: string };

const CAUSE_LABEL: Record<InvestigationResult["cause"], string> = {
  export_totals_do_not_balance: "Possible cause: the export itself does not balance",
  reading_differs_from_printed_totals: "Possible cause: rows were read differently from how the report adds them",
  reading_agrees_with_printed_totals: "The rows read agree with the file's printed totals",
  no_printed_totals: "No printed totals to compare with",
};
const FILTER_LABEL: Record<RowFilter, string> = { all: "All rows", included: "Included", excluded: "Excluded" };

export function ImbalanceInvestigation({ client, uploadId, certificationId, rpc = defaultRpc }: {
  client: Pick<LayoutClient, "investigate">; uploadId: string; certificationId: string; rpc?: Rpc;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const requestId = useRef(crypto.randomUUID());

  const run = async () => {
    setState({ kind: "running" });
    try {
      const a = await client.investigate(uploadId, certificationId, requestId.current);
      if (a.kind === "ok" && a.value.status === "completed" && a.value.result) { setState({ kind: "done", result: a.value.result, investigationId: a.value.investigationId }); return; }
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
    const last = r.printed[r.printed.length - 1] ?? null;
    return (
      <section aria-labelledby="investigation-title" className="space-y-3 text-[13px]" data-testid="imbalance-investigation">
        <h3 id="investigation-title" className="font-medium text-foreground">Likely causes in this file</h3>
        <p className="text-muted-foreground">The difference is {r.difference}; the {r.larger} are larger.</p>

        <table className="w-full max-w-md border-collapse text-[12px]" data-testid="investigation-totals">
          <caption className="sr-only">Totals of the rows read and the file's printed totals</caption>
          <thead><tr className="text-left text-muted-foreground"><th scope="col" className="py-1 pr-3 font-normal"></th><th scope="col" className="py-1 pr-3 text-right font-normal">Debit</th><th scope="col" className="py-1 text-right font-normal">Credit</th></tr></thead>
          <tbody>
            <tr><th scope="row" className="py-1 pr-3 text-left font-normal">Rows read as accounts</th><td className="py-1 pr-3 text-right tabular-nums">{r.read.debit}</td><td className="py-1 text-right tabular-nums">{r.read.credit}</td></tr>
            <tr><th scope="row" className="py-1 pr-3 text-left font-normal">{last ? `Printed totals (row ${last.row})` : "Printed totals"}</th>
              {last ? <><td className="py-1 pr-3 text-right tabular-nums">{last.debit}</td><td className="py-1 text-right tabular-nums">{last.credit}</td></>
                : <td colSpan={2} className="py-1 text-right text-muted-foreground">None in the file</td>}</tr>
          </tbody>
        </table>
        <div className="border-l-2 border-border pl-3" data-testid="investigation-cause" data-cause={r.cause}>
          <p className="font-medium text-foreground">{CAUSE_LABEL[r.cause]}</p>
          <p className="text-muted-foreground">{r.causeText}</p>
        </div>

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
        {state.investigationId && (
          <InvestigationRows rpc={rpc} investigationId={state.investigationId} exponent={r.exponent}
            counts={{ all: r.row_count, included: r.included_count, excluded: r.excluded_count }} />
        )}
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

/** Every row the reader saw, page by page from the stored rows (keyset; never a re-parse), filterable by included/excluded. */
function InvestigationRows({ rpc, investigationId, exponent, counts }: {
  rpc: Rpc; investigationId: string; exponent: number; counts: Record<RowFilter, number>;
}) {
  const ids = { heading: useId(), filter: useId() };
  const [filter, setFilter] = useState<RowFilter>("all");
  const [rows, setRows] = useState<InvestigationRowView[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = async (f: RowFilter, after: number, append: boolean, live: () => boolean = () => true) => {
    setStatus("loading");
    const p = await fetchInvestigationRows(rpc, investigationId, f, after, ROWS_PAGE);
    if (!live()) return;
    if (p.kind !== "ok") { setStatus("error"); return; }
    setRows((cur) => (append ? [...cur, ...p.rows] : p.rows));
    setNext(p.nextAfter); setTotal(p.total); setStatus("ready");
  };
  useEffect(() => {
    let alive = true;
    void load(filter, 0, false, () => alive);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload exactly when the investigation or the filter changes
  }, [investigationId, filter]);

  return (
    <section aria-labelledby={ids.heading} className="space-y-2" data-testid="investigation-rows">
      <h4 id={ids.heading} className="font-medium text-foreground">Rows in this file</h4>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
        <legend className="sr-only">Show</legend>
        {ROW_FILTERS.map((f) => (
          <label key={f} className="flex items-center gap-1.5">
            <input type="radio" name={ids.filter} checked={filter === f} onChange={() => setFilter(f)} data-testid={`investigation-filter-${f}`} />
            {FILTER_LABEL[f]} ({counts[f]})
          </label>
        ))}
      </fieldset>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-[12px]">
          <caption className="sr-only">{FILTER_LABEL[filter]} — source row, account, amounts as read, and whether the row was included</caption>
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th scope="col" className="py-1 pr-2 font-normal">Row</th><th scope="col" className="py-1 pr-2 font-normal">Account</th>
              <th scope="col" className="py-1 pr-2 text-right font-normal">Debit</th><th scope="col" className="py-1 pr-2 text-right font-normal">Credit</th>
              <th scope="col" className="py-1 font-normal">Read as</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.ordinal} className="border-b border-border/60 align-top" data-testid={`investigation-row-${x.rowNumber}`} data-included={x.included}>
                <td className="py-1 pr-2 tabular-nums">{x.rowNumber}</td>
                <td className="py-1 pr-2">{[x.accountCode, x.accountName].filter(Boolean).join(" ") || "—"}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{formatMinor(x.debitMinor, exponent)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{formatMinor(x.creditMinor, exponent)}</td>
                <td className="py-1">{x.included ? "Included as an account" : `Excluded${x.reason ? ` — ${x.reason}` : ` (${x.disposition})`}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div aria-live="polite" className="text-[12px] text-muted-foreground">
        {status === "error" && <p role="alert" className="text-destructive" data-testid="investigation-rows-error">The rows could not be loaded. The findings above are unchanged.</p>}
        {status !== "error" && total !== null && <p data-testid="investigation-rows-count">Showing {rows.length} of {total}.</p>}
      </div>
      {next !== null && status !== "loading" && (
        <Button type="button" variant="outline" className="h-9 rounded-none" onClick={() => void load(filter, next, true)} data-testid="investigation-rows-more">
          Show the next {ROWS_PAGE}
        </Button>
      )}
    </section>
  );
}
