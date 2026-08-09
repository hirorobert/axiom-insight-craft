/**
 * TrialBalanceTemplateGuide — the file contract, stated once, next to the
 * upload form.
 *
 * Presentation only. The column names and rules below mirror the header
 * matchers already implemented in process-trial-balance; nothing here parses,
 * validates, or writes anything.
 */

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FieldSpec {
  column: string;
  requirement: "Required" | "Optional";
  rule: string;
  accepted: string;
}

const FIELDS: FieldSpec[] = [
  {
    column: "Account Code",
    requirement: "Required",
    rule: "Your ledger code. Text or number, kept exactly as exported.",
    accepted: "Account Code · A/C No · GL Code · Code",
  },
  {
    column: "Account Name",
    requirement: "Required",
    rule: "The ledger description. Used to map the account to a statement line.",
    accepted: "Account Name · Description · Particulars · Name",
  },
  {
    column: "Debit",
    requirement: "Required",
    rule: "Debit amount, or blank when the account is a credit. Numbers only — no currency symbols.",
    accepted: "Debit · Debit (TZS) · Dr",
  },
  {
    column: "Credit",
    requirement: "Required",
    rule: "Credit amount, or blank when the account is a debit. Numbers only.",
    accepted: "Credit · Credit (TZS) · Cr",
  },
  {
    column: "Balance",
    requirement: "Optional",
    rule: "Only if your export has no separate debit/credit columns. Negatives as -1000, not (1000).",
    accepted: "Balance · Amount · Net Amount",
  },
];

const TEMPLATE_ROWS: string[][] = [
  ["Account Code", "Account Name", "Debit", "Credit"],
  ["1000", "Cash at Bank", "12500000", ""],
  ["1100", "Trade Receivables", "8400000", ""],
  ["1500", "Motor Vehicles", "31000000", ""],
  ["2000", "Trade Payables", "", "6200000"],
  ["2400", "PAYE Payable", "", "1150000"],
  ["3000", "Share Capital", "", "20000000"],
  ["3100", "Retained Earnings", "", "9550000"],
  ["4000", "Revenue", "", "48000000"],
  ["5000", "Cost of Sales", "19300000", ""],
  ["6010", "Staff Costs", "9700000", ""],
  ["6050", "SDL Expense", "340000", ""],
  ["6200", "Rent", "3260000", ""],
];

function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(","),
    )
    .join("\r\n");
}

export default function TrialBalanceTemplateGuide({
  companyName,
  periodYear,
}: {
  companyName?: string;
  periodYear?: number;
}) {
  const download = () => {
    const blob = new Blob([toCsv(TEMPLATE_ROWS)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const slug = (companyName ?? "trial-balance")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug || "trial-balance"}-template${periodYear ? `-${periodYear}` : ""}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section data-testid="tb-template-guide" className="border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          File requirements
        </h2>
        <Button variant="outline" size="sm" onClick={download} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          Download CSV template
        </Button>
      </header>

      <div className="px-5 py-4">
        <p className="text-sm leading-relaxed text-muted-foreground">
          One row per ledger account. CSV, XLSX or XLS. Header names are matched
          automatically, so an export from your accounting system usually needs no editing.
        </p>

        <ul className="mt-4 divide-y divide-border border-t border-border">
          {FIELDS.map((f) => (
            <li key={f.column} className="py-3">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="text-sm font-medium text-foreground">{f.column}</span>
                <span
                  className={`font-mono text-[10px] uppercase tracking-[0.16em] ${
                    f.requirement === "Required" ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {f.requirement}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{f.rule}</p>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
                Accepted headers: {f.accepted}
              </p>
            </li>
          ))}
        </ul>

        <div className="mt-4 border-t border-border pt-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Leave out
          </p>
          <ul className="mt-2 space-y-1 text-[12px] leading-relaxed text-muted-foreground">
            <li>Total, subtotal and balance-check rows — these are removed automatically.</li>
            <li>Merged cells, blank spacer rows and multi-row headers.</li>
            <li>Thousands separators, currency symbols and bracketed negatives.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
