/**
 * BalanceSheetEquationCard — what the engine RECORDED about the statement equation, and nothing it did not prove.
 *
 * No stored result proves the equation exactly: the earlier engine compared floating-point amounts rounded to the minor
 * unit, so its `passed: true` cannot establish equality and is shown as "Not exactly verified", never "Balanced". A
 * recorded failure (`passed: false`) is always shown as a failure, with the recorded difference: hiding a recorded
 * failure is never safe. Nothing here adds, subtracts or compares amounts — every figure is shown as recorded, at the
 * currency precision the engine recorded when it recorded one (two decimal places otherwise).
 */
import { AlertTriangle, Minus } from "lucide-react";
import { CertUpload } from "./types";

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

export function BalanceSheetEquationCard({ upload }: Props) {
  const pr = upload.processing_result;
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
