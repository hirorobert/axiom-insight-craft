/**
 * CanonicalStatementSection — Phase 4/5/6 workspace surface embedded in the
 * existing Prepare Statements stage (no second shell). Presents the canonical
 * statement preview, its deterministic validation findings, and the
 * framework / period / currency context. Everything shown is derived by
 * financialStatementsWorkspace/* — this component computes no accounting.
 *
 * Honest state: results are an in-memory DRAFT (the persistence migration is
 * authored but unapplied) and are labelled as such. Reviewer decisions are
 * not offered until a server-side write path exists; the panel says so
 * rather than showing dead buttons.
 */
import { useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCanonicalStatementPreview } from "@/hooks/useCanonicalStatementPreview";
import { buildFindingViews, isApprovalReady, statementLineDomId } from "@/lib/financialStatementsWorkspace/findingsView";
import type { CanonicalStatementsLike } from "@/lib/financialStatementsWorkspace/mapWorkspaceTrialBalance";
import { FindingsPanel } from "./FindingsPanel";
import { StatementRenderer } from "./StatementRenderer";

export interface CanonicalStatementSectionProps {
  readonly companyId: string;
  readonly periodYear: number;
  readonly companyName: string;
  readonly companyTin: string | null;
  readonly reportingFramework: string | null;
  readonly currency: string | null;
  readonly fiscalYearEnd: string | null;
  readonly uploadId: string | null;
  readonly processingResult: CanonicalStatementsLike | { statements?: CanonicalStatementsLike } | null;
}

const FRAMEWORK_LABELS: Record<string, string> = {
  ifrs_for_smes: "IFRS for SMEs",
  full_ifrs: "IFRS",
  ipsas_accrual: "IPSAS (accrual)",
  ipsas_cash: "IPSAS (cash)",
};

function focusLine(lineId: string) {
  const el = document.getElementById(statementLineDomId(lineId));
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("bg-accent/20");
  window.setTimeout(() => el.classList.remove("bg-accent/20"), 2000);
}

export function CanonicalStatementSection(props: CanonicalStatementSectionProps) {
  const preview = useCanonicalStatementPreview(props);
  const views = useMemo(() => (preview.evaluation && preview.snapshot ? buildFindingViews(preview.evaluation.findings, preview.snapshot.decisions) : []), [preview.evaluation, preview.snapshot]);

  return (
    <section aria-labelledby="fs-canonical-heading" className="space-y-4 border border-border p-4 print:border-0">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="fs-canonical-heading" className="text-sm font-semibold text-foreground">
            Statements and validation
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {props.companyName} · FY{props.periodYear} · {props.reportingFramework ? (FRAMEWORK_LABELS[props.reportingFramework] ?? props.reportingFramework) : "Framework not set"} · {props.currency ?? "Currency not set"}
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <Badge variant="outline">Draft — not saved</Badge>
          <Button type="button" variant="outline" size="sm" onClick={preview.rerun} disabled={preview.status === "loading"}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Re-run validation
          </Button>
        </div>
      </header>

      {preview.status === "loading" && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Preparing statements from the reviewed trial balance…
        </p>
      )}

      {preview.status === "unavailable" && (
        <Alert>
          <AlertTitle>Statements cannot be prepared yet</AlertTitle>
          <AlertDescription>{preview.reason}</AlertDescription>
        </Alert>
      )}

      {preview.status === "error" && (
        <Alert variant="destructive">
          <AlertTitle>Statement preparation failed</AlertTitle>
          <AlertDescription>
            <p>{preview.reason}</p>
            {preview.diagnostics.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs">
                {preview.diagnostics.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {preview.unmappedAccounts.length > 0 && preview.status !== "loading" && (
        <Alert>
          <AlertTitle>{preview.unmappedAccounts.length} account(s) are not mapped and are excluded</AlertTitle>
          <AlertDescription>
            <p className="text-xs">
              {preview.unmappedAccounts.slice(0, 10).map((a) => `${a.accountCode} ${a.accountName}`).join("; ")}
              {preview.unmappedAccounts.length > 10 ? "…" : ""}
            </p>
            <p className="mt-1 text-xs">Statements are incomplete until these accounts are reviewed and mapped.</p>
          </AlertDescription>
        </Alert>
      )}

      {preview.status === "ready" && preview.snapshot && (
        <>
          <p className="text-xs text-foreground" role="status">
            {isApprovalReady(views) ? "No blocking findings remain." : "Approval is not ready: blocking or insufficient-evidence findings remain."} Reviewer decisions are not yet
            available in this workspace — recording them requires the server-side persistence layer, which has not been enabled.
          </p>
          {preview.snapshot.report.statements.map((statement) => (
            <StatementRenderer key={statement.statementId} report={preview.snapshot!.report} statement={statement} />
          ))}
          <FindingsPanel views={views} onFocusLine={focusLine} />
        </>
      )}
    </section>
  );
}
