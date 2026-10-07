/**
 * BalanceSheetEquationCard — what the engine RECORDED about the statement equation, and nothing it did not prove.
 *
 * Since E1 the engine records exact amounts (processing_result.amounts, "tb-amounts/1"). When present they alone are
 * shown: validated on read (grammar and every relationship recomputed), formatted from the minor-unit strings with BigInt
 * — "Holds exactly" only for a valid document whose difference is zero. A malformed document is "Result unavailable",
 * never a pass and never a fallback to the legacy figures.
 *
 * A legacy result (no amounts):
 * No stored result proves the equation exactly: the earlier engine compared floating-point amounts rounded to the minor
 * unit, so its `passed: true` cannot establish equality and is shown as "Not exactly verified", never "Balanced". A
 * recorded failure (`passed: false`) is always shown as a failure, with the recorded difference: hiding a recorded
 * failure is never safe. Nothing here adds, subtracts or compares amounts — every figure is shown as recorded, at the
 * currency precision the engine recorded when it recorded one (two decimal places otherwise).
 */
import { AlertTriangle, CheckCircle2, Minus } from "lucide-react";
import { CertUpload } from "./types";
import { formatMinorString, readRecordedAmounts, type TbAmounts } from "@/lib/accounting/tbAmounts";

interface Props { upload: CertUpload }

export const EQUATION_NOT_EXACTLY_VERIFIED_TEXT = "Not exactly verified — recorded by an earlier engine; re-check after the engine update";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The currency exponent the engine recorded for this result (0–6), or 2 when none was recorded. */
function recordedExponent(pr: unknown): number {
  const r = (v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const candidates = [r(r(r(r(pr)?.validation_report)?.tb_balance_check)?.exact)?.currency_exponent, r(r(pr)?.ingestion)?.currency_exponent];
  const e = candidates.find((c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 6);
  return typeof e === "number" ? e : 2;
}

/** A recorded amount for display only, at the recorded precision. Never used to decide anything. */
function shown(v: number, exponent: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: exponent, maximumFractionDigits: exponent });
}

export const EQUATION_HOLDS_EXACTLY_TEXT = "Holds exactly — verified to the minor unit";
export const EQUATION_RESULT_UNAVAILABLE_TEXT = "Result unavailable — the recorded amounts could not be read";

function ExactEquation({ amounts }: { amounts: TbAmounts }) {
  const f = (minor: string) => formatMinorString(minor, amounts.exponent);
  const holds = amounts.equation.status === "balanced";
  const rows: { label: string; value: string }[] = [
    { label: "Assets", value: amounts.classes.assets_minor },
    { label: "Liabilities", value: amounts.classes.liabilities_minor },
    { label: "Equity (pre-close)", value: amounts.classes.equity_minor },
    { label: "Income", value: amounts.classes.income_minor },
    { label: "Expenses", value: amounts.classes.expenses_minor },
    { label: "Liabilities + equity + income − expenses", value: amounts.equation.rhs_minor },
  ];
  return (
    <section className="border border-border bg-card" data-testid="balance-sheet-equation-card" data-equation-state={holds ? "exact" : "failed"}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-6 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">Statement equation</h2>
        {holds ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300" data-testid="equation-status">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {EQUATION_HOLDS_EXACTLY_TEXT}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-300" data-testid="equation-status">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Does not hold — recorded failure
          </span>
        )}
      </header>
      <div className="px-6 py-5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Assets = Liabilities + Equity + Income − Expenses · exact amounts in {amounts.currency}
        </p>
        <dl className="mt-4 space-y-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="font-medium tabular-nums text-foreground">{f(r.value)}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3 text-sm">
            <dt className="font-semibold text-foreground">Difference</dt>
            <dd className={`font-semibold tabular-nums ${holds ? "text-foreground" : "text-red-700 dark:text-red-300"}`} data-testid="equation-difference">
              {f(amounts.equation.difference_minor)}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-[12px] text-muted-foreground">
          {holds
            ? "Recomputed from the recorded amounts on reading: the difference is exactly zero."
            : "The engine recorded that this equation does not hold; nothing was accepted."}
        </p>
      </div>
    </section>
  );
}

export function BalanceSheetEquationCard({ upload }: Props) {
  const pr = upload.processing_result;
  const recordedAmounts = readRecordedAmounts(pr);
  if (recordedAmounts.state === "exact") return <ExactEquation amounts={recordedAmounts.amounts} />;
  if (recordedAmounts.state === "malformed") {
    return (
      <section className="border border-border bg-card" data-testid="balance-sheet-equation-card" data-equation-state="unavailable">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-6 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">Statement equation</h2>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="equation-status">
            <Minus className="h-4 w-4" aria-hidden="true" /> {EQUATION_RESULT_UNAVAILABLE_TEXT}
          </span>
        </header>
      </section>
    );
  }
  const eq = pr?.validation_report?.balance_sheet_equation;
  if (!eq || typeof eq !== "object") return null;

  const assets = num(eq.assets);
  const liabilities = num(eq.liabilities);
  const equity = num(eq.equity);
  const netIncome = num(eq.net_income);
  const closingEquity = num(eq.closing_equity);
  const difference = num(eq.difference);
  if (assets === undefined || liabilities === undefined || equity === undefined) return null;

  const failed = eq.passed === false;
  const exponent = recordedExponent(pr);
  const rows: { label: string; value: number | undefined }[] = [
    { label: "Assets", value: assets },
    { label: "Liabilities", value: liabilities },
    { label: "Opening equity (pre-close)", value: equity },
    { label: "Net income", value: netIncome },
    { label: "Closing equity", value: closingEquity },
  ];

  return (
    <section className="border border-border bg-card" data-testid="balance-sheet-equation-card" data-equation-state={failed ? "failed" : "not_exactly_verified"}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-6 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">Statement equation</h2>
        {failed ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-300" data-testid="equation-status">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Does not hold — recorded failure
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground" data-testid="equation-status">
            <Minus className="h-4 w-4" aria-hidden="true" /> {EQUATION_NOT_EXACTLY_VERIFIED_TEXT}
          </span>
        )}
      </header>
      <div className="px-6 py-5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Assets = Liabilities + Opening Equity + Net Income · figures as recorded by the engine
        </p>
        <dl className="mt-4 space-y-2">
          {rows.filter((r) => r.value !== undefined).map((r) => (
            <div key={r.label} className="flex items-baseline justify-between text-sm">
              <dt className="text-muted-foreground">{r.label} (recorded)</dt>
              <dd className="font-medium tabular-nums text-foreground">{shown(r.value!, exponent)}</dd>
            </div>
          ))}
          {failed && difference !== undefined && (
            <div className="flex items-baseline justify-between border-t border-border pt-3 text-sm">
              <dt className="font-semibold text-foreground">Recorded difference</dt>
              <dd className="font-semibold tabular-nums text-red-700 dark:text-red-300">{shown(difference, exponent)}</dd>
            </div>
          )}
        </dl>
        <p className="mt-4 text-[12px] text-muted-foreground">
          {failed
            ? "The engine recorded that this equation does not hold."
            : "These figures are shown as recorded. They do not prove that the equation holds exactly."}
        </p>
      </div>
    </section>
  );
}
