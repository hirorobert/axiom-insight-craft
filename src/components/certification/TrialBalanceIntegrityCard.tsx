import { Check, X } from "lucide-react";
import { CertUpload, fmtNum } from "./types";

interface Props { upload: CertUpload }

export function TrialBalanceIntegrityCard({ upload }: Props) {
  const tb = upload.processing_result?.validation_report?.tb_balance_check;
  if (!tb) return null;

  const debits  = fmtNum(tb.total_debits,  2);
  const credits = fmtNum(tb.total_credits, 2);
  const diff    = fmtNum(tb.difference,    2);
  if (debits === null || credits === null || diff === null) return null;

  return (
    <section className="border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">
          Trial Balance Integrity
        </h2>
        {tb.passed ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <Check className="h-4 w-4" strokeWidth={2.5} /> Debits equal credits
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-300">
            <X className="h-4 w-4" strokeWidth={2.5} /> Out of balance
          </span>
        )}
      </header>
      <dl className="grid grid-cols-3 divide-x divide-border">
        <Cell label="Total debits"  value={debits} />
        <Cell label="Total credits" value={credits} />
        <Cell label="Difference"    value={diff} emphasize={!tb.passed} />
      </dl>
    </section>
  );
}

function Cell({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="px-6 py-5">
      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-xl font-semibold tabular-nums ${emphasize ? "text-red-700 dark:text-red-300" : "text-foreground"}`}>
        {value}
      </dd>
    </div>
  );
}