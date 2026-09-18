/**
 * useCanonicalStatementPreview — Phase 4/6 data hook for the new canonical
 * financial-statements workspace surface.
 *
 * Reads (never writes) account_mappings + the already-loaded trial-balance
 * upload, joins them via mapWorkspaceTrialBalanceToReviewedLines, then runs
 * the pure prepareTrialBalanceReport / evaluateReport orchestrator
 * functions entirely in memory (financialStatementsWorkspace/*).
 *
 * IMPORTANT — this is a preview, not a persisted workspace stage: the
 * financial_statement_reports/_evaluations schema
 * (20260917000000_financial_statement_reports.sql) is authored but
 * deliberately UNAPPLIED, so there is nothing to durably save to yet. The
 * in-memory repository lives only for this hook instance's lifetime — a
 * page refresh recomputes from scratch. `isDraftOnly` is always true and
 * must be surfaced in the UI (never presented as saved). No financial
 * table is written by this hook (Iron Dome 4.2) — it only reads
 * account_mappings and computes locally.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  evaluateReport,
  prepareTrialBalanceReport,
  StaleTrialBalanceInputError,
  UnsupportedFrameworkForTrialBalanceAdapterError,
} from "@/lib/financialStatementsWorkspace/evaluationOrchestrator";
import { InMemoryFinancialStatementReportRepository, type EvaluationRunRecord, type StoredReportSnapshot } from "@/lib/financialStatementsWorkspace/reportRepository";
import { AdapterRejectedError, UnresolvedCurrencyError, UnresolvedFrameworkError } from "@/lib/financialStatementsWorkspace/adapterContract";
import { mapWorkspaceTrialBalanceToReviewedLines, type AccountMappingRow, type CanonicalStatementsLike, type UnmappedAccount } from "@/lib/financialStatementsWorkspace/mapWorkspaceTrialBalance";

export type CanonicalStatementPreviewStatus = "loading" | "unavailable" | "ready" | "error";

export interface UseCanonicalStatementPreviewResult {
  readonly status: CanonicalStatementPreviewStatus;
  readonly reason: string | null;
  readonly diagnostics: readonly string[];
  readonly unmappedAccounts: readonly UnmappedAccount[];
  readonly snapshot: StoredReportSnapshot | null;
  readonly evaluation: EvaluationRunRecord | null;
  readonly isDraftOnly: true;
  readonly rerun: () => void;
}

/** Explicit, non-guessy period bounds: fiscal_year_end's own month/day for periodYear, else calendar year — never a silent default of periodYear itself (that always comes from the route). */
function derivePeriodBounds(periodYear: number, fiscalYearEnd: string | null): { startDate: string; endDate: string } {
  if (!fiscalYearEnd) {
    return { startDate: `${periodYear}-01-01`, endDate: `${periodYear}-12-31` };
  }
  const fye = new Date(fiscalYearEnd);
  if (isNaN(fye.getTime())) {
    return { startDate: `${periodYear}-01-01`, endDate: `${periodYear}-12-31` };
  }
  const mm = String(fye.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(fye.getUTCDate()).padStart(2, "0");
  const endDate = `${periodYear}-${mm}-${dd}`;
  const startDateObj = new Date(Date.UTC(periodYear - 1, fye.getUTCMonth(), fye.getUTCDate() + 1));
  const startDate = startDateObj.toISOString().slice(0, 10);
  return { startDate, endDate };
}

export function useCanonicalStatementPreview(params: {
  readonly companyId: string;
  readonly periodYear: number;
  readonly companyName: string;
  readonly companyTin: string | null;
  readonly reportingFramework: string | null;
  readonly currency: string | null;
  readonly fiscalYearEnd: string | null;
  readonly uploadId: string | null;
  readonly processingResult: CanonicalStatementsLike | { statements?: CanonicalStatementsLike } | null;
}): UseCanonicalStatementPreviewResult {
  const [status, setStatus] = useState<CanonicalStatementPreviewStatus>("loading");
  const [reason, setReason] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly string[]>([]);
  const [unmappedAccounts, setUnmappedAccounts] = useState<readonly UnmappedAccount[]>([]);
  const [snapshot, setSnapshot] = useState<StoredReportSnapshot | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationRunRecord | null>(null);
  const [generation, setGeneration] = useState(0);

  const repoRef = useRef<InMemoryFinancialStatementReportRepository | null>(null);
  const repoKeyRef = useRef<string | null>(null);
  const repoKey = `${params.companyId}:${params.periodYear}`;
  if (repoKeyRef.current !== repoKey) {
    repoRef.current = new InMemoryFinancialStatementReportRepository();
    repoKeyRef.current = repoKey;
  }

  const statementsPayload: CanonicalStatementsLike | null = useMemo(() => {
    const raw = params.processingResult;
    if (!raw) return null;
    if ("statements" in raw && raw.statements) return raw.statements;
    if ("balance_sheet" in raw || "income_statement" in raw) return raw as CanonicalStatementsLike;
    return null;
  }, [params.processingResult]);

  const rerun = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setStatus("loading");
      setReason(null);
      setDiagnostics([]);

      if (!params.uploadId || !statementsPayload) {
        if (!cancelled) {
          setStatus("unavailable");
          setReason("No processed trial balance is available for this period yet.");
        }
        return;
      }

      const { data: mappingRows, error: mappingError } = await supabase
        .from("account_mappings")
        .select("account_key, account_code, account_name, normalized_account_name, statement, classification, normal_balance, is_cash_account, is_retained_earnings, is_payroll_account")
        .eq("company_id", params.companyId);

      if (cancelled) return;
      if (mappingError) {
        setStatus("error");
        setReason(`Could not load account mappings: ${mappingError.message}`);
        return;
      }

      const { lines, unmappedAccounts: unmapped } = mapWorkspaceTrialBalanceToReviewedLines({
        statements: statementsPayload,
        accountMappings: (mappingRows ?? []) as AccountMappingRow[],
        currency: params.currency ?? "",
        sourceUploadId: params.uploadId,
      });
      if (cancelled) return;
      setUnmappedAccounts(unmapped);

      if (lines.length === 0) {
        setStatus("unavailable");
        setReason(unmapped.length > 0 ? "None of this trial balance's accounts are mapped yet — review account mappings first." : "No accounts were found to prepare statements from.");
        return;
      }

      const { startDate, endDate } = derivePeriodBounds(params.periodYear, params.fiscalYearEnd);

      try {
        const repo = repoRef.current!;
        const prepareResult = await prepareTrialBalanceReport(
          {
            companyId: params.companyId,
            periodYear: params.periodYear,
            entityLegalName: params.companyName,
            taxIdentificationNumber: params.companyTin ?? undefined,
            framework: params.reportingFramework,
            currency: params.currency,
            currentPeriod: { startDate, endDate },
            reviewedAccountLines: lines,
          },
          repo,
        );
        if (cancelled) return;
        setSnapshot(prepareResult.snapshot);

        const run = await evaluateReport(prepareResult.snapshot, repo);
        if (cancelled) return;
        setEvaluation(run);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnresolvedFrameworkError) {
          setStatus("unavailable");
          setReason("This company has no reporting framework selected yet — choose one in company settings before preparing statements.");
        } else if (err instanceof UnresolvedCurrencyError) {
          setStatus("unavailable");
          setReason("This company has no presentation currency configured yet.");
        } else if (err instanceof UnsupportedFrameworkForTrialBalanceAdapterError) {
          setStatus("unavailable");
          setReason("IPSAS Cash Basis statements cannot be prepared from a trial balance yet — this requires a cash receipts and payments record this workspace does not yet capture.");
        } else if (err instanceof AdapterRejectedError) {
          setStatus("error");
          setReason("The reviewed trial balance could not be converted into statements.");
          setDiagnostics(err.diagnostics.map((d) => `[${d.code}] ${d.message}`));
        } else if (err instanceof StaleTrialBalanceInputError) {
          setStatus("error");
          setReason("The reviewed trial balance has changed since this preview was last prepared. Refresh to re-prepare, or correct individual figures through account review.");
        } else {
          setStatus("error");
          setReason(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [params.companyId, params.periodYear, params.uploadId, statementsPayload, params.reportingFramework, params.currency, params.fiscalYearEnd, params.companyName, params.companyTin, generation]);

  return { status, reason, diagnostics, unmappedAccounts, snapshot, evaluation, isDraftOnly: true, rerun };
}
