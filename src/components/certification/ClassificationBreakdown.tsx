import { CertUpload, fmtNum, StatementSection } from "./types";

interface Props { upload: CertUpload }

interface Row {
  section: string;
  bucket: string;
  accounts: number;
  total: number;
}

const LABELS: Record<string, string> = {
  balance_sheet: "Balance Sheet",
  income_statement: "Income Statement",
  cash_flow: "Cash Flow",
};

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ClassificationBreakdown({ upload }: Props) {
  const stmts = upload.processing_result?.statements;
  if (!stmts) return null;

  const rows: Row[] = [];
  for (const section of ["balance_sheet", "income_statement", "cash_flow"] as const) {
    const group = stmts[section];
    if (!group) continue;
    for (const [key, sec] of Object.entries(group) as [string, StatementSection][]) {
      if (!sec || !Array.isArray(sec.accounts) || sec.accounts.length === 0) continue;
      rows.push({
        section: LABELS[section],
        bucket: humanize(key),
        accounts: sec.accounts.length,
        total: sec.total ?? 0,
      });
    }
  }

  if (rows.length === 0) return null;

  return (
    <section className="border border-border bg-card">
      <header className="border-b border-border px-6 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">
          Classification Breakdown
        </h2>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="px-6 py-2.5 font-medium">Statement</th>
              <th className="px-6 py-2.5 font-medium">Classification</th>
              <th className="px-6 py-2.5 text-right font-medium">Accounts</th>
              <th className="px-6 py-2.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="px-6 py-3 text-muted-foreground">{r.section}</td>
                <td className="px-6 py-3 font-medium text-foreground">{r.bucket}</td>
                <td className="px-6 py-3 text-right tabular-nums text-foreground">{fmtNum(r.accounts)}</td>
                <td className="px-6 py-3 text-right tabular-nums text-foreground">{fmtNum(r.total, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}