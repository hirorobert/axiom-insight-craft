import { Check } from "lucide-react";
import { CertUpload, fmtNum } from "./types";

interface Props { upload: CertUpload }

const TOLERANCE = 0.01;

export function BalanceSheetEquationCard({ upload }: Props) {
  const eq = upload.processing_result?.validation_report?.balance_sheet_equation;
  if (!eq) return null;

  const assets      = eq.assets;
  const liabilities = eq.liabilities;
  const equity      = eq.equity;
  const netIncome     = typeof eq.net_income     === "number" ? eq.net_income     : undefined;
  const closingEquity = typeof eq.closing_equity === "number" ? eq.closing_equity : undefined;

  if (
    typeof assets !== "number" ||
    typeof liabilities !== "number" ||
    typeof equity !== "number"
  ) return null;

  const fullMode = netIncome !== undefined && closingEquity !== undefined;

  return (
    <section className="border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">
          Accounting Equation
        </h2>
        {fullMode ? (
          <FullStatus assets={assets} rhs={liabilities + equity + (netIncome ?? 0)} />
        ) : (
          <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
            Net income disclosure pending
          </span>
        )}
      </header>

      {fullMode ? (
        <div className="px-6 py-5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Assets = Liabilities + Opening Equity + Net Income
          </p>
          <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
            <Side title="Assets" rows={[{ label: "Total assets", value: assets }]} total={assets} />
            <Side
              title="Liabilities + Equity + Net Income"
              rows={[
                { label: "Liabilities",                value: liabilities },
                { label: "Opening equity (pre-close)", value: equity      },
                { label: "Net income",                 value: netIncome!  },
              ]}
              total={liabilities + equity + (netIncome ?? 0)}
              extraRow={{ label: "Closing equity", value: closingEquity! }}
            />
          </div>
        </div>
      ) : (
        <div className="px-6 py-5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Assets vs Liabilities + Opening Equity
          </p>
          <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
            <Side title="Assets" rows={[{ label: "Total assets", value: assets }]} total={assets} />
            <Side
              title="Liabilities + Opening Equity"
              rows={[
                { label: "Liabilities",                value: liabilities },
                { label: "Opening equity (pre-close)", value: equity      },
              ]}
              total={liabilities + equity}
            />
          </div>
          <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
            <span className="text-sm text-muted-foreground">Difference</span>
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {fmtNum(eq.difference ?? Math.abs(assets - (liabilities + equity)), 2)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function FullStatus({ assets, rhs }: { assets: number; rhs: number }) {
  const diff = Math.abs(assets - rhs);
  if (diff <= TOLERANCE) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        <Check className="h-4 w-4" strokeWidth={2.5} /> Balanced
      </span>
    );
  }
  return (
    <span className="text-xs font-medium text-red-700 dark:text-red-300">
      Difference {fmtNum(diff, 2)}
    </span>
  );
}

interface Row { label: string; value: number }

function Side({
  title,
  rows,
  total,
  extraRow,
}: {
  title: string;
  rows: Row[];
  total: number;
  extraRow?: Row;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <dl className="mt-3 space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between text-sm">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="font-medium tabular-nums text-foreground">{fmtNum(r.value, 2)}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
        <span className="text-sm font-semibold text-foreground">Total</span>
        <span className="text-lg font-semibold tabular-nums text-foreground">{fmtNum(total, 2)}</span>
      </div>
      {extraRow && (
        <div className="mt-2 flex items-baseline justify-between text-xs text-muted-foreground">
          <span>{extraRow.label}</span>
          <span className="tabular-nums">{fmtNum(extraRow.value, 2)}</span>
        </div>
      )}
    </div>
  );
}