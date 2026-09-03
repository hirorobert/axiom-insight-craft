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

export type PreflightVerdict =
  | "certified"
  | "review"
  | "blocked"
  | "pending"
  // Six-layer authoritative readiness only (computeCertificationReadiness.ts).
  // computePreflight() itself never returns these — additive, zero runtime
  // change to this function or its existing callers.
  | "stale"
  | "unknown"
  // A valid authoritative certification exists for this company/period, but
  // it belongs to a DIFFERENT upload than the one on screen. Distinct from
  // "stale" — this is not a claim about the displayed upload's own history,
  // only that authority currently lives elsewhere.
  | "superseded";

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

  // 3 — Statement equation. This can only be evaluated after every account has
  // a classification. It is not an upload-integrity prerequisite: Dr = Cr is.
  const eq = report?.balance_sheet_equation ?? null;
  if (eq) {
    checks.push({
      id: "bs_equation",
      label: "Statement equation",
      state: eq.passed ? "passed" : "review",
      detail: eq.passed
        ? "Assets equal liabilities plus closing equity."
        : `Out by ${fmt(Number(eq.difference ?? 0))} — review classifications in the draft statements.`,
    });
  }

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

  // 5 — Import errors raised by the engine. A statement-equation difference is
  // downstream review evidence, not proof that the source trial balance failed.
  const errs: unknown[] | null = Array.isArray(input.accountingErrors)
    ? input.accountingErrors
    : Array.isArray(input.processingResult?.accounting_errors)
      ? input.processingResult.accounting_errors
      : null;
  const blockingErrors = errs?.filter((error) => {
    if (!error || typeof error !== "object") return true;
    return (error as { code?: string }).code !== "BALANCE_SHEET_EQUATION_FAILED";
  }) ?? null;
  checks.push({
    id: "errors",
    label: "No import errors raised",
    state: blockingErrors === null ? "pending" : blockingErrors.length === 0 ? "passed" : "review",
    detail:
      blockingErrors === null
        ? "Not checked yet."
        : blockingErrors.length === 0
          ? "No errors prevent this trial balance from continuing."
          : `${blockingErrors.length} item${blockingErrors.length === 1 ? "" : "s"} to look at before statements.`,
  });

  const failed = checks.filter((c) => c.state === "failed");
  const review = checks.filter((c) => c.state === "review");
  const blockingReview = review.filter((c) => c.id !== "bs_equation");
  const pending = checks.filter((c) => c.state === "pending");
  const passedCount = checks.filter((c) => c.state === "passed").length;

  let verdict: PreflightVerdict;
  let headline: string;
  let blocker: string | null;

  if (failed.length > 0) {
    verdict = "blocked";
    headline = "Not certified — the trial balance does not hold";
    blocker = failed[0].detail;
  } else if (pending.length > 0 && blockingReview.length === 0) {
    verdict = "pending";
    headline = "Pre-flight check running";
    blocker = "Statements open once this trial balance is certified.";
  } else if (blockingReview.length > 0) {
    verdict = "review";
    headline = "Needs your decision before statements";
    blocker = blockingReview[0].detail;
  } else if (review.length > 0) {
    verdict = "review";
    headline = "Draft statement equation needs review";
    blocker = null;
  } else {
    verdict = "certified";
    headline = "Certified — safe to prepare statements";
    blocker = null;
  }

  return { verdict, headline, blocker, checks, passedCount, totalCount: checks.length };
}
