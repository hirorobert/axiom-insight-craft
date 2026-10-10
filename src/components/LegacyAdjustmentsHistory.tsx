/**
 * LegacyAdjustmentsHistory — the adjusting entries recorded by the retired journal panel, shown READ-ONLY.
 *
 * The retired panel wrote `adjusting_journal_entries` / `aje_lines` directly from the browser and recorded the signed-in
 * user as approver. That path is closed (20261026100000 revokes every client write and drops the write policies). There
 * is now one adjustment path: Close Review › Adjustments, where every proposal, decision and reversal is a server
 * function with separation of duties. This component only reads what was recorded before, so history stays visible.
 *
 * Nothing here writes, and nothing here assumes a currency or a framework: amounts are shown as recorded, and the
 * framework wording comes from the caller.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

interface HistoryLine {
  line_number: number;
  account_code: string;
  account_name: string;
  debit_tzs: number;
  credit_tzs: number;
}

interface HistoryEntry {
  id: string;
  aje_number: string;
  description: string;
  status: string;
  auto_generated: boolean;
  created_at: string;
  lines: HistoryLine[];
}

const LEGACY_ADJUSTMENTS_COPY = {
  heading: "Adjusting entries",
  /** Shown when Close Review › Adjustments is offered for this workspace. */
  movedOffered: "Adjustments are proposed, reviewed and approved in Close Review › Adjustments.",
  /** Shown when it is not (the workspace is not enabled for financial reporting). */
  movedNotOffered: "Adjustments are recorded in Close Review, which is part of the financial reporting pilot and is not enabled for this workspace.",
  openAction: "Open Adjustments",
  historyHeading: "Earlier entries (read-only)",
  historyNote: "Recorded with the previous journal tool. They are kept for reference and cannot be edited, approved or reversed here.",
  none: "No earlier entries were recorded for this period.",
  loadFailed: "Earlier entries could not be loaded.",
} as const;

const STATUS_LABEL: Record<string, string> = { draft: "Draft", approved: "Approved", reversed: "Reversed" };
const amount = (n: number) => (n ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "");

export function LegacyAdjustmentsHistory({ companyId, periodYear, adjustmentsHref }: {
  companyId: string;
  periodYear: number;
  /** Close Review › Adjustments for this workspace, or null when it is not offered. */
  adjustmentsHref: string | null;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data, error } = await supabase
        .from("adjusting_journal_entries")
        .select("id, aje_number, description, status, auto_generated, created_at")
        .eq("company_id", companyId)
        .eq("period_year", periodYear)
        .order("aje_number", { ascending: true });
      if (!live) return;
      if (error) { setFailed(true); return; }
      const rows = data ?? [];
      const lines = rows.length
        ? (await supabase.from("aje_lines").select("aje_id, line_number, account_code, account_name, debit_tzs, credit_tzs")
            .in("aje_id", rows.map((r) => r.id)).order("line_number", { ascending: true })).data ?? []
        : [];
      if (!live) return;
      setEntries(rows.map((r) => ({ ...r, lines: lines.filter((l) => l.aje_id === r.id) })) as HistoryEntry[]);
    })();
    return () => { live = false; };
  }, [companyId, periodYear]);

  return (
    <section aria-labelledby="legacy-adjustments-heading" className="space-y-4 rounded-md border border-border bg-card p-5" data-testid="legacy-adjustments">
      <div className="space-y-2">
        <h2 id="legacy-adjustments-heading" className="text-base font-semibold text-foreground">{LEGACY_ADJUSTMENTS_COPY.heading}</h2>
        <p className="text-sm text-muted-foreground" data-testid="legacy-adjustments-moved">
          {adjustmentsHref ? LEGACY_ADJUSTMENTS_COPY.movedOffered : LEGACY_ADJUSTMENTS_COPY.movedNotOffered}
        </p>
        {adjustmentsHref && (
          <Link to={adjustmentsHref} className="inline-flex text-sm font-semibold text-foreground underline underline-offset-4 hover:no-underline" data-testid="legacy-adjustments-open">
            {LEGACY_ADJUSTMENTS_COPY.openAction}
          </Link>
        )}
      </div>

      {failed ? (
        <p className="text-sm text-destructive" role="alert">{LEGACY_ADJUSTMENTS_COPY.loadFailed}</p>
      ) : entries === null ? null : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="legacy-adjustments-none">{LEGACY_ADJUSTMENTS_COPY.none}</p>
      ) : (
        <details className="group" data-testid="legacy-adjustments-history">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            {LEGACY_ADJUSTMENTS_COPY.historyHeading} · {entries.length}
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">{LEGACY_ADJUSTMENTS_COPY.historyNote}</p>
          <ul className="mt-3 space-y-3">
            {entries.map((e) => (
              <li key={e.id} className="rounded border border-border p-3">
                <p className="text-sm font-medium text-foreground">
                  {e.aje_number} · {STATUS_LABEL[e.status] ?? e.status}{e.auto_generated ? " · generated" : ""}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{e.description}</p>
                {e.lines.length > 0 && (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th scope="col" className="py-1 pr-3 font-medium">Account</th>
                          <th scope="col" className="py-1 pr-3 text-right font-medium">Debit</th>
                          <th scope="col" className="py-1 text-right font-medium">Credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {e.lines.map((l) => (
                          <tr key={l.line_number} className="border-t border-border">
                            <td className="py-1 pr-3">{l.account_code} {l.account_name}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{amount(l.debit_tzs)}</td>
                            <td className="py-1 text-right tabular-nums">{amount(l.credit_tzs)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
