/**
 * computePreflight — SAFISHA pre-flight certification of an uploaded trial
 * balance. Pure projection of engine output. No writes, no inference of
 * success: a check with no engine evidence is NOT_COMPUTED ("pending"),
 * never "passed".
 *
 * Iron Dome: null means NOT COMPUTED. Never default to zero or to pass.
 */

export type PreflightCheckState = "passed" | "failed" | "review" | "pending";

export interface PreflightCheck {
  id: string;
  label: string;
  state: PreflightCheckState;
  /** Plain-language, one sentence. Never jargon. */
  detail: string;
}

export type PreflightVerdict = "certified" | "review" | "blocked" | "pending";

export interface PreflightResult {
  verdict: PreflightVerdict;
  headline: string;
  /** Why downstream stages are held, when they are. */
  blocker: string | null;
  checks: PreflightCheck[];
  passedCount: number;
  totalCount: number;
}

interface PreflightInput {
  status?: string | null;
  isValid?: boolean | null;
  processedAt?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processingResult?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validationReport?: any;
  accountingErrors?: unknown[] | null;
}

const fmt = (n: number) =>
  Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function computePreflight(input: PreflightInput | null): PreflightResult {
  if (!input) {
    return {
      verdict: "pending",
      headline: "No trial balance imported yet",
      blocker: "Import a trial balance to start the pre-flight check.",
      checks: [],
      passedCount: 0,
      totalCount: 0,
    };
  }

  const report = input.validationReport ?? input.processingResult?.validation_report ?? null;
  const status = input.status ?? "";
  const engineRan = !!input.processedAt || status === "complete" || status === "needs_review" || status === "failed";

  const checks: PreflightCheck[] = [];

  // 1 — Engine run
  checks.push({
    id: "engine",
    label: "Figures read and totalled",
    state: status === "failed" ? "failed" : engineRan ? "passed" : "pending",
    detail:
      status === "failed"
        ? "The import could not be read. Re-upload the file."
        : engineRan
          ? "Every row in the file was read and totalled."
          : "Still reading the file.",
  });

  // 2 — Debits equal credits
  const tb = report?.tb_balance_check ?? null;
  checks.push({
    id: "tb_balance",
    label: "Debits equal credits",
    state: tb ? (tb.passed ? "passed" : "failed") : "pending",
    detail: tb
      ? tb.passed
        ? "The trial balance balances exactly."
        : `Out by ${fmt(Number(tb.difference ?? 0))} — the file does not balance.`
      : "Not checked yet.",
  });

  // 3 — Balance sheet equation
  const eq = report?.balance_sheet_equation ?? null;
  checks.push({
    id: "bs_equation",
    label: "Assets equal liabilities plus equity",
    state: eq ? (eq.passed ? "passed" : "failed") : "pending",
    detail: eq
      ? eq.passed
        ? "The statement of financial position closes."
        : `Out by ${fmt(Number(eq.difference ?? 0))} — the position does not close.`
      : "Not checked yet.",
  });

  // 4 — Every account has a mapping decision
  const mc = report?.mapping_completeness ?? null;
  const total = Number(mc?.total_accounts ?? input.processingResult?.summary?.total_accounts ?? NaN);
  const mapped = Number(mc?.mapped_accounts ?? mc?.auto_classified ?? NaN);
  const haveMapping = Number.isFinite(total) && Number.isFinite(mapped) && total > 0;
  const unmapped = haveMapping ? total - mapped : null;
  checks.push({
    id: "mapping",
    label: "Every account has a decision",
    state: !haveMapping ? "pending" : unmapped === 0 ? "passed" : "review",
    detail: !haveMapping
      ? "Not checked yet."
      : unmapped === 0
        ? `All ${total.toLocaleString("en-US")} accounts are classified.`
        : `${unmapped.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} accounts still need a mapping decision.`,
  });

  // 5 — Accounting errors raised by the engine
  const errs = Array.isArray(input.accountingErrors)
    ? input.accountingErrors
    : Array.isArray(input.processingResult?.accounting_errors)
      ? input.processingResult.accounting_errors
      : null;
  checks.push({
    id: "errors",
    label: "No accounting errors raised",
    state: errs === null ? "pending" : errs.length === 0 ? "passed" : "review",
    detail:
      errs === null
        ? "Not checked yet."
        : errs.length === 0
          ? "The engine raised no accounting errors."
          : `${errs.length} item${errs.length === 1 ? "" : "s"} to look at before statements.`,
  });

  const failed = checks.filter((c) => c.state === "failed");
  const review = checks.filter((c) => c.state === "review");
  const pending = checks.filter((c) => c.state === "pending");
  const passedCount = checks.filter((c) => c.state === "passed").length;

  let verdict: PreflightVerdict;
  let headline: string;
  let blocker: string | null;

  if (failed.length > 0) {
    verdict = "blocked";
    headline = "Not certified — the trial balance does not hold";
    blocker = failed[0].detail;
  } else if (pending.length > 0 && review.length === 0) {
    verdict = "pending";
    headline = "Pre-flight check running";
    blocker = "Statements open once this trial balance is certified.";
  } else if (review.length > 0) {
    verdict = "review";
    headline = "Needs your decision before statements";
    blocker = review[0].detail;
  } else {
    verdict = "certified";
    headline = "Certified — safe to prepare statements";
    blocker = null;
  }

  return { verdict, headline, blocker, checks, passedCount, totalCount: checks.length };
}
