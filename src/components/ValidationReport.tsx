import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileCheck,
  Banknote,
  FileSpreadsheet,
  ArrowRight,
  RotateCcw,
} from "lucide-react";

interface ValidationReportData {
  tb_balance_check: {
    passed: boolean;
    total_debits: number;
    total_credits: number;
    difference: number;
  };
  mapping_completeness: {
    passed: boolean;
    total_accounts: number;
    mapped_accounts: number;
    unmapped: string[];
  };
  balance_sheet_equation: {
    passed: boolean;
    assets: number;
    liabilities: number;
    equity: number;
    difference: number;
  } | null;
  profit_equity_linkage: {
    passed: boolean;
    details: string;
  } | null;
  cash_reconciliation: {
    passed: boolean;
    cf_ending_cash: number;
    bs_cash: number;
  } | null;
}

interface AccountingError {
  code: string;
  message: string;
  field?: string;
  expected?: string | number;
  actual?: string | number;
}

interface ValidationReportProps {
  report: ValidationReportData | null;
  errors: AccountingError[];
  isValid: boolean | null;
  status: string;
  fileName?: string;
  onProcessAsAuditedAccounts?: () => void;
  onUploadNew?: () => void;
}

const formatTZS = (value: number) =>
  `TZS ${Math.round(Math.abs(value)).toLocaleString("en-US")}`;

const CheckIcon = ({ passed }: { passed: boolean }) =>
  passed
    ? <CheckCircle2 className="w-5 h-5 text-accent" />
    : <XCircle className="w-5 h-5 text-destructive" />;

// -- Document-type detector -------------------------------------------------
// When the ONLY failure is a massive TB imbalance, the file is almost certainly
// pre-formatted financial statements (SCI/SFP/SCF), not a raw trial balance.
// Threshold: difference > TZS 500,000,000 (half a billion) with no other errors.
function isLikelyAuditedAccounts(
  errors: AccountingError[],
  report: ValidationReportData | null
): boolean {
  if (!report) return false;
  const onlyTBError =
    errors.length === 1 && errors[0].code === "TRIAL_BALANCE_IMBALANCE";
  const massiveDifference = report.tb_balance_check.difference > 500_000_000;
  const mappingPassed = report.mapping_completeness.passed;
  return onlyTBError && massiveDifference && mappingPassed;
}

export function ValidationReport({
  report,
  errors,
  isValid,
  status,
  fileName,
  onProcessAsAuditedAccounts,
  onUploadNew,
}: ValidationReportProps) {
  if (!report && errors.length === 0) return null;

  // Valid uploads with no errors, cash reconciliation, or profit->equity
  // linkage issues render nothing -- the Certification Console shows the rest.
  if (
    isValid === true &&
    errors.length === 0 &&
    !report?.cash_reconciliation &&
    !report?.profit_equity_linkage
  ) return null;

  // -- SMART ROUTING: audited accounts detected ------------------------------
  if (isLikelyAuditedAccounts(errors, report)) {
    return (
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-primary" />
              SAFF ERP -- Document Detection
            </CardTitle>
            <Badge className="bg-muted text-muted-foreground border-border text-xs">
              REVIEW REQUIRED
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Detection finding */}
          <div className="p-4 rounded-lg border border-border bg-secondary/20">
            <p className="text-sm font-medium text-foreground mb-1">
              This file appears to be formatted financial statements, not a raw trial balance.
            </p>
            <p className="text-sm text-foreground/60">
              The parser read two numeric columns (e.g. 2025 and 2024 figures) as Debit/Credit --
              producing a difference of{" "}
              <span className="font-medium text-foreground">
                {formatTZS(report!.tb_balance_check.difference)}
              </span>
              . A raw trial balance always nets to zero.
            </p>
            {fileName && (
              <p className="text-xs text-foreground/50 mt-2 font-mono">{fileName}</p>
            )}
          </div>

          {/* What the engine detected */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="p-3 rounded-lg border border-border bg-card">
              <p className="text-foreground/60 text-xs mb-1">Column A total</p>
              <p className="font-semibold text-foreground">
                {formatTZS(report!.tb_balance_check.total_debits)}
              </p>
            </div>
            <div className="p-3 rounded-lg border border-border bg-card">
              <p className="text-foreground/60 text-xs mb-1">Column B total</p>
              <p className="font-semibold text-foreground">
                {formatTZS(report!.tb_balance_check.total_credits)}
              </p>
            </div>
          </div>

          {/* Two paths */}
          <div className="space-y-3 pt-1">
            <p className="text-xs font-medium text-foreground/60 uppercase tracking-wide">
              How do you want to proceed?
            </p>

            {/* Path A -- process as audited accounts */}
            <button
              onClick={onProcessAsAuditedAccounts}
              className="w-full flex items-center justify-between p-4 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors text-left group"
            >
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Process as Audited Financial Statements
                </p>
                <p className="text-xs text-foreground/60 mt-0.5">
                  Reads SCI, SFP, SCE, SCF sheets directly -- no trial balance needed
                </p>
              </div>
              <ArrowRight className="w-4 h-4 text-primary shrink-0 group-hover:translate-x-0.5 transition-transform" />
            </button>

            {/* Path B -- upload correct file */}
            <button
              onClick={onUploadNew}
              className="w-full flex items-center justify-between p-4 rounded-lg border border-border hover:border-primary/20 hover:bg-secondary/30 transition-colors text-left group"
            >
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Upload correct Trial Balance
                </p>
                <p className="text-xs text-foreground/60 mt-0.5">
                  Export from Tally, QuickBooks, Sage or Excel -- accounts with debit/credit columns
                </p>
              </div>
              <RotateCcw className="w-4 h-4 text-foreground/40 shrink-0 group-hover:text-foreground/60 transition-colors" />
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // -- STANDARD VALIDATION REPORT -------------------------------------------
  const isBlocked = status === "blocked" || status === "error" || status === "needs_review";

  // TB integrity, mapping completeness, and BS equation are rendered by the
  // Certification Console. This component only surfaces what the console does
  // not: cash reconciliation, profit->equity linkage, and error/warning detail.
  const hasCashRecon    = !!report?.cash_reconciliation;
  const hasProfitLink   = !!report?.profit_equity_linkage;
  const hasErrors       = errors.length > 0;
  const hasUniqueContent = hasCashRecon || hasProfitLink || hasErrors;
  if (!hasUniqueContent) return null;

  // Errors take precedence: if any errors exist the status is INVALID
  // regardless of what the isValid prop says.
  const statusLabel =
    errors.length > 0
      ? "INVALID"
      : isValid === true
      ? "VALID"
      : isValid === false
      ? "INVALID"
      : "PENDING";
  const statusColor =
    statusLabel === "VALID"
      ? "bg-accent/20 text-accent border-accent/30"
      : statusLabel === "INVALID"
      ? "bg-destructive/20 text-destructive border-destructive/30"
      : "bg-muted text-muted-foreground";

  return (
    <Card className={`border-2 ${isBlocked ? "border-destructive/30" : "border-border"}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileCheck className="w-5 h-5 text-primary" />
            SAFF ERP -- Validation Report
          </CardTitle>
          <Badge className={statusColor}>{statusLabel}</Badge>
        </div>
        <p className="text-sm text-foreground/60">
          Deterministic accounting validation -- all checks must pass for VALID status
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {report && (
          <div className="space-y-3">
            {/* Cash Reconciliation */}
            {report.cash_reconciliation && (
              <div
                className={`p-4 rounded-lg border ${
                  report.cash_reconciliation.passed
                    ? "bg-accent/5 border-accent/20"
                    : "bg-destructive/5 border-destructive/20"
                }`}
              >
                <div className="flex items-center gap-3">
                  <CheckIcon passed={report.cash_reconciliation.passed} />
                  <div>
                    <p className="font-medium text-foreground">Cash Reconciliation</p>
                    <p className="text-sm text-foreground/60">
                      Cash flow ending balance = Balance sheet cash
                    </p>
                  </div>
                  <Banknote className="w-5 h-5 text-foreground/40 ml-auto" />
                </div>
              </div>
            )}

            {/* Profit -> Equity Linkage */}
            {report.profit_equity_linkage && (
              <div
                className={`p-4 rounded-lg border ${
                  report.profit_equity_linkage.passed
                    ? "bg-accent/5 border-accent/20"
                    : "bg-destructive/5 border-destructive/20"
                }`}
              >
                <div className="flex items-center gap-3">
                  <CheckIcon passed={report.profit_equity_linkage.passed} />
                  <div>
                    <p className="font-medium text-foreground">Profit -&gt; Equity Linkage</p>
                    <p className="text-sm text-foreground/60">
                      {report.profit_equity_linkage.details}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Accounting Errors (non-routing ones) */}
        {errors.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-4 h-4" />
              <p className="font-medium text-sm">
                Accounting Errors ({errors.length})
              </p>
            </div>
            <div className="space-y-2">
              {errors.map((error, index) => (
                <div
                  key={index}
                  className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg text-sm"
                >
                  <div className="flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">{error.code}</p>
                      <p className="text-foreground/60">{error.message}</p>
                      {error.expected !== undefined && (
                        <p className="text-xs text-foreground/50 mt-1">
                          Expected: {error.expected} | Actual: {error.actual}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action Required -- only for non-routing blocks */}
        {isBlocked && !isLikelyAuditedAccounts(errors, report) && (
          <div className="p-4 border border-border rounded-lg bg-secondary/20">
            <div className="flex items-center gap-2 font-medium text-foreground mb-2 text-sm">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              Action Required
            </div>
            <p className="text-sm text-foreground/60">
              Resolve the errors above, then reprocess. Check that every account has a
              valid debit or credit entry and that the trial balance nets to zero.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
