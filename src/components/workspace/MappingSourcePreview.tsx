/**
 * MappingSourcePreview — side-by-side view of mapped statement lines and the
 * source trial balance rows behind each mapping.
 *
 * READ-ONLY. Reads only from the upload's processing_result payload written by
 * the process-trial-balance edge function. No writes, no derivation of new
 * financial values.
 */

import { useMemo, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { fmtNum } from "@/components/certification/types";

interface SourceRow {
  account_code?: string;
  account_name?: string;
  name?: string;
  debit?: number;
  credit?: number;
  balance?: number;
}

interface Section {
  accounts?: SourceRow[];
  total?: number;
}

interface MappingLine {
  id: string;
  statement: string;
  classification: string;
  accounts: SourceRow[];
  total: number;
}

const STATEMENT_LABELS: Record<string, string> = {
  balance_sheet: "Balance Sheet",
  income_statement: "Income Statement",
  cash_flow: "Cash Flow",
};

const humanize = (key: string) =>
  key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processingResult: any;
  fileName?: string | null;
}

export function MappingSourcePreview({ processingResult, fileName }: Props) {
  const lines = useMemo<MappingLine[]>(() => {
    const stmts = processingResult?.statements;
    if (!stmts) return [];
    const out: MappingLine[] = [];
    for (const stmt of ["balance_sheet", "income_statement", "cash_flow"] as const) {
      const group = stmts[stmt];
      if (!group) continue;
      for (const [key, sec] of Object.entries(group) as [string, Section][]) {
        if (!sec || !Array.isArray(sec.accounts) || sec.accounts.length === 0) continue;
        out.push({
          id: `${stmt}.${key}`,
          statement: STATEMENT_LABELS[stmt] ?? humanize(stmt),
          classification: humanize(key),
          accounts: sec.accounts,
          total: sec.total ?? 0,
        });
      }
    }
    return out;
  }, [processingResult]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const active = lines.find((l) => l.id === activeId) ?? lines[0] ?? null;

  if (lines.length === 0) return null;

  return (
    <section className="border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-6 py-3">
        <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">
          Mapped statements vs source trial balance
        </h2>
        {fileName && (
          <span className="ml-auto truncate text-xs text-muted-foreground">{fileName}</span>
        )}
      </header>

      <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
        {/* Left — mapped statement lines */}
        <div>
          <div className="border-b border-border px-6 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Mapped statement lines
          </div>
          <ul className="max-h-[26rem] overflow-y-auto">
            {lines.map((line) => {
              const isActive = active?.id === line.id;
              return (
                <li key={line.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(line.id)}
                    aria-current={isActive}
                    className={`flex w-full items-baseline gap-3 border-b border-border px-6 py-3 text-left transition-colors last:border-0 ${
                      isActive ? "bg-accent" : "hover:bg-muted/60"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {line.classification}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {line.statement} · {line.accounts.length} source row
                        {line.accounts.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-foreground">
                      {fmtNum(line.total, 2)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Right — source trial balance rows for the selected mapping */}
        <div>
          <div className="border-b border-border px-6 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Source rows — {active?.classification}
          </div>
          <div className="max-h-[26rem] overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-6 py-2 font-medium">Code</th>
                  <th className="px-6 py-2 font-medium">Account</th>
                  <th className="px-6 py-2 text-right font-medium">Debit</th>
                  <th className="px-6 py-2 text-right font-medium">Credit</th>
                  <th className="px-6 py-2 text-right font-medium">Mapped</th>
                </tr>
              </thead>
              <tbody>
                {(active?.accounts ?? []).map((row, i) => (
                  <tr key={`${row.account_code ?? ""}-${i}`} className="border-b border-border last:border-0">
                    <td className="px-6 py-2.5 tabular-nums text-muted-foreground">
                      {row.account_code || "—"}
                    </td>
                    <td className="px-6 py-2.5 text-foreground">
                      {row.account_name ?? row.name ?? "—"}
                    </td>
                    <td className="px-6 py-2.5 text-right tabular-nums text-muted-foreground">
                      {fmtNum(row.debit, 2) ?? "—"}
                    </td>
                    <td className="px-6 py-2.5 text-right tabular-nums text-muted-foreground">
                      {fmtNum(row.credit, 2) ?? "—"}
                    </td>
                    <td className="px-6 py-2.5 text-right tabular-nums text-foreground">
                      {fmtNum(row.balance, 2) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              {active && (
                <tfoot>
                  <tr className="border-t border-border">
                    <td className="px-6 py-2.5 text-xs uppercase tracking-wider text-muted-foreground" colSpan={4}>
                      Mapped total
                    </td>
                    <td className="px-6 py-2.5 text-right text-sm font-semibold tabular-nums text-foreground">
                      {fmtNum(active.total, 2)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}