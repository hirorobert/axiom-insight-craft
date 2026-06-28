import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  Scale, 
  FileCheck, 
  Calculator,
  Banknote,
  Link2
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
}

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
};

const CheckIcon = ({ passed }: { passed: boolean }) => {
  if (passed) {
    return <CheckCircle2 className="w-5 h-5 text-accent" />;
  }
  return <XCircle className="w-5 h-5 text-destructive" />;
};

export function ValidationReport({ report, errors, isValid, status }: ValidationReportProps) {
  if (!report && errors.length === 0) {
    return null;
  }

  const isBlocked = status === "blocked" || status === "error";
  const statusLabel = isValid === true ? "VALID" : isValid === false ? "INVALID" : "PENDING";
  const statusColor = isValid === true 
    ? "bg-accent/20 text-accent border-accent/30" 
    : isValid === false 
      ? "bg-destructive/20 text-destructive border-destructive/30"
      : "bg-muted text-muted-foreground";

  return (
    <Card className={`border-2 ${isBlocked ? 'border-destructive/50 bg-destructive/5' : 'border-border'}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <FileCheck className="w-5 h-5 text-primary" />
            AXIOM Validation Report
          </CardTitle>
          <Badge className={statusColor}>
            {statusLabel}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Deterministic accounting validation — all checks must pass for VALID status
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Validation Checks */}
        {report && (
          <div className="space-y-3">
            {/* Trial Balance Check */}
            <div className={`p-4 rounded-lg border ${report.tb_balance_check.passed ? 'bg-accent/5 border-accent/20' : 'bg-destructive/5 border-destructive/20'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CheckIcon passed={report.tb_balance_check.passed} />
                  <div>
                    <p className="font-medium text-foreground">Trial Balance Integrity</p>
                    <p className="text-sm text-muted-foreground">SUM(Debit) - SUM(Credit) = 0</p>
                  </div>
                </div>
                <div className="text-right text-sm">
                  <p className="text-muted-foreground">
                    Debits: {formatCurrency(report.tb_balance_check.total_debits)}
                  </p>
                  <p className="text-muted-foreground">
                    Credits: {formatCurrency(report.tb_balance_check.total_credits)}
                  </p>
                  {report.tb_balance_check.difference > 0.01 && (
                    <p className="text-destructive font-medium">
                      Difference: {formatCurrency(report.tb_balance_check.difference)}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Mapping Completeness */}
            <div className={`p-4 rounded-lg border ${report.mapping_completeness.passed ? 'bg-accent/5 border-accent/20' : 'bg-destructive/5 border-destructive/20'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CheckIcon passed={report.mapping_completeness.passed} />
                  <div>
                    <p className="font-medium text-foreground">Mapping Completeness</p>
                    <p className="text-sm text-muted-foreground">All accounts must have explicit mappings</p>
                  </div>
                </div>
                <div className="text-right text-sm">
                  <p className="text-foreground font-medium">
                    {report.mapping_completeness.mapped_accounts} / {report.mapping_completeness.total_accounts}
                  </p>
                  <p className="text-muted-foreground">accounts mapped</p>
                </div>
              </div>
              {report.mapping_completeness.unmapped.length > 0 && (
                <div className="mt-3 p-2 bg-destructive/10 rounded text-sm">
                  <p className="text-destructive font-medium mb-1">Unmapped accounts:</p>
                  <p className="text-muted-foreground">
                    {report.mapping_completeness.unmapped.slice(0, 5).join(", ")}
                    {report.mapping_completeness.unmapped.length > 5 && ` and ${report.mapping_completeness.unmapped.length - 5} more...`}
                  </p>
                </div>
              )}
            </div>

            {/* Balance Sheet Equation */}
            {report.balance_sheet_equation && (
              <div className={`p-4 rounded-lg border ${report.balance_sheet_equation.passed ? 'bg-accent/5 border-accent/20' : 'bg-destructive/5 border-destructive/20'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CheckIcon passed={report.balance_sheet_equation.passed} />
                    <div>
                      <p className="font-medium text-foreground">Balance Sheet Equation</p>
                      <p className="text-sm text-muted-foreground">Assets = Liabilities + Equity</p>
                    </div>
                  </div>
                  <Scale className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-4 text-sm">
                  <div className="text-center p-2 bg-background rounded">
                    <p className="text-muted-foreground">Assets</p>
                    <p className="font-medium text-foreground">{formatCurrency(report.balance_sheet_equation.assets)}</p>
                  </div>
                  <div className="text-center p-2 bg-background rounded">
                    <p className="text-muted-foreground">Liabilities</p>
                    <p className="font-medium text-foreground">{formatCurrency(report.balance_sheet_equation.liabilities)}</p>
                  </div>
                  <div className="text-center p-2 bg-background rounded">
                    <p className="text-muted-foreground">Equity</p>
                    <p className="font-medium text-foreground">{formatCurrency(report.balance_sheet_equation.equity)}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Cash Reconciliation */}
            {report.cash_reconciliation && (
              <div className={`p-4 rounded-lg border ${report.cash_reconciliation.passed ? 'bg-accent/5 border-accent/20' : 'bg-destructive/5 border-destructive/20'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CheckIcon passed={report.cash_reconciliation.passed} />
                    <div>
                      <p className="font-medium text-foreground">Cash Reconciliation</p>
                      <p className="text-sm text-muted-foreground">Cash Flow ending = Balance Sheet cash</p>
                    </div>
                  </div>
                  <Banknote className="w-5 h-5 text-muted-foreground" />
                </div>
              </div>
            )}

            {/* Profit to Equity Linkage */}
            {report.profit_equity_linkage && (
              <div className={`p-4 rounded-lg border ${report.profit_equity_linkage.passed ? 'bg-accent/5 border-accent/20' : 'bg-destructive/5 border-destructive/20'}`}>
                <div className="flex items-center gap-3">
                  <CheckIcon passed={report.profit_equity_linkage.passed} />
                  <div>
                    <p className="font-medium text-foreground">Profit → Equity Linkage</p>
                    <p className="text-sm text-muted-foreground">{report.profit_equity_linkage.details}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Accounting Errors */}
        {errors.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-4 h-4" />
              <p className="font-medium">Accounting Errors ({errors.length})</p>
            </div>
            <div className="space-y-2">
              {errors.map((error, index) => (
                <div key={index} className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg text-sm">
                  <div className="flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">{error.code}</p>
                      <p className="text-muted-foreground">{error.message}</p>
                      {error.expected !== undefined && (
                        <p className="text-xs text-muted-foreground mt-1">
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

        {/* Action Required */}
        {isBlocked && (
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
            <div className="flex items-center gap-2 text-destructive font-medium mb-2">
              <AlertTriangle className="w-5 h-5" />
              Action Required
            </div>
            <p className="text-sm text-muted-foreground">
              Financial statements cannot be generated until all validation checks pass. 
              Please resolve the errors above by adding explicit account mappings or 
              correcting your trial balance data.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
