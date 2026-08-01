/**
 * MappingSourcePreview — side-by-side view of mapped statement lines and the
 * source trial balance rows behind each mapping.
 *
 * READ-ONLY. Reads only from the upload's processing_result payload written by
 * the process-trial-balance edge function. No writes, no derivation of new
 * financial values.
 */

import { useMemo, useState } from "react";
import { ArrowLeftRight, Search, X } from "lucide-react";
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

const STATEMENT_OPTIONS = [
  { key: "all", label: "All statements" },
  { key: "balance_sheet", label: "Balance Sheet" },
  { key: "income_statement", label: "Income Statement" },
  { key: "cash_flow", label: "Cash Flow" },
] as const;

const humanize = (key: string) =>
  key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processingResult: any;
  fileName?: string | null;
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
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
  const [query, setQuery] = useState("");
  const [statementFilter, setStatementFilter] = useState<string>("all");

  const normalizedQuery = normalizeSearch(query);

  const filteredLines = useMemo(() => {
    return lines.filter((line) => {
      const matchesStatement =
        statementFilter === "all" || line.id.startsWith(`${statementFilter}.`);
      if (!matchesStatement) return false;
      if (!normalizedQuery) return true;

      const haystack = [
        line.classification,
        line.statement,
        line.accounts
          .map((a) => [a.account_code, a.account_name, a.name].filter(Boolean).join(" "))
          .join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [lines, normalizedQuery, statementFilter]);

  const active = filteredLines.find((l) => l.id === activeId) ?? filteredLines[0] ?? null;

  const filteredActiveAccounts = useMemo(() => {
    if (!active) return [];
    if (!normalizedQuery) return active.accounts;
    return active.accounts.filter((row) => {
      const haystack = [
        row.account_code,
        row.account_name,
        row.name,
        active.classification,
        active.statement,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [active, normalizedQuery]);

  if (lines.length === 0) return null;

  return (
    <section className="border border-border bg-card">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">
            Mapped statements vs source trial balance
          </h2>
        </div>

        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search code, account, or statement"
              className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-7 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary sm:w-64"
              aria-label="Search mappings and source rows"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1">
            {STATEMENT_OPTIONS.map((opt) => {
              const activeFilter = statementFilter === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setStatementFilter(opt.key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    activeFilter
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                  }`}
                  aria-pressed={activeFilter}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {fileName && (
            <span className="hidden truncate text-xs text-muted-foreground sm:block sm:max-w-[12rem]">
              {fileName}
            </span>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
        {/* Left — mapped statement lines */}
        <div>
          <div className="flex items-center justify-between border-b border-border px-6 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <span>Mapped statement lines</span>
            <span className="tabular-nums">{filteredLines.length}</span>
          </div>
          <ul className="max-h-[26rem] overflow-y-auto">
            {filteredLines.length === 0 && (
              <li className="px-6 py-8 text-center text-sm text-muted-foreground">
                No mappings match your filters.
              </li>
            )}
            {filteredLines.map((line) => {
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
          <div className="flex items-center justify-between border-b border-border px-6 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <span>Source rows — {active?.classification ?? "—"}</span>
            <span className="tabular-nums">{filteredActiveAccounts.length}</span>
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
                {filteredActiveAccounts.length === 0 && active && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-6 py-8 text-center text-sm text-muted-foreground"
                    >
                      No source rows match your search.
                    </td>
                  </tr>
                )}
                {!active && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-6 py-8 text-center text-sm text-muted-foreground"
                    >
                      Select a mapped statement line to view its source rows.
                    </td>
                  </tr>
                )}
                {filteredActiveAccounts.map((row, i) => (
                  <tr
                    key={`${row.account_code ?? ""}-${i}`}
                    className="border-b border-border last:border-0"
                  >
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
              {active && filteredActiveAccounts.length > 0 && (
                <tfoot>
                  <tr className="border-t border-border">
                    <td
                      className="px-6 py-2.5 text-xs uppercase tracking-wider text-muted-foreground"
                      colSpan={4}
                    >
                      Mapped total
                    </td>
                    <td className="px-6 py-2.5 text-right text-sm font-semibold tabular-nums text-foreground">
                      {fmtNum(
                        filteredActiveAccounts.reduce((sum, r) => sum + (r.balance ?? 0), 0),
                        2
                      )}
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
