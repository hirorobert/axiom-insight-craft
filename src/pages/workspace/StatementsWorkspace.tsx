/**
 * StatementsWorkspace — Financial Statement Validation.
 *
 * Re-homes from Dashboard:
 *   HesabuAssurancePanel, PeriodClosingBalancesPanel
 *
 * Gate: upload must be complete + valid.
 * Prepare gate does NOT block Statements draft validation.
 */

import { lazy, Suspense } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { HesabuAssurancePanel } from "@/components/HesabuAssurancePanel";
import { PeriodClosingBalancesPanel } from "@/components/PeriodClosingBalancesPanel";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";
import { MappingSourcePreview } from "@/components/workspace/MappingSourcePreview";
import { TrialBalancePreflight } from "@/components/workspace/TrialBalancePreflight";
import { computePreflight } from "@/lib/workspace/computePreflight";
import { ExportStatements, type ProcessingResult } from "@/components/ExportStatements";
import { FINANCIAL_STATEMENTS_WORKSPACE_ENABLED } from "@/lib/financialStatementsWorkspace/workspaceGate";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspaceCommercialState } from "@/hooks/useWorkspaceCommercialState";
import { paidActionState } from "@/lib/commercial/paidActions";
import { issueReportingPack } from "@/lib/commercial/reportingPack";

// Internal-preview workspace: loaded (and therefore evaluated) only when the source-controlled gate is on.
const FinancialStatementsWorkspace = FINANCIAL_STATEMENTS_WORKSPACE_ENABLED
  ? lazy(() => import("@/components/financialStatements/FinancialStatementsWorkspace").then((m) => ({ default: m.FinancialStatementsWorkspace })))
  : null;

export default function StatementsWorkspace() {
  const { upload, uploads, workspaceState, companyId, periodYear, company } = useWorkspace();
  // Reporting Pack (20260925100000): downloadable statement outputs are issued by the server first. The statements
  // workspace itself stays database-inert; this page supplies the issuer and the explanatory plan state.
  const commercial = useWorkspaceCommercialState(companyId);
  const downloadsLocked = paidActionState(commercial.state, "REPORTING_PACK_EXPORT", commercial.loading).status === "locked";
  const issueStatementsDownload = () =>
    issueReportingPack((fn, args) => supabase.rpc(fn as never, args as never), companyId, periodYear, "financial_statements_data");

  const mission = workspaceState.missions.statements;
  const preflight = computePreflight(
    upload
      ? {
          status: upload.status,
          isValid: upload.is_valid,
          processedAt: upload.processed_at,
          processingResult: upload.processing_result,
          validationReport: upload.validation_report,
          accountingErrors: upload.accounting_errors,
        }
      : null,
  );
  const prepareHref = `/workspace/${companyId}/${periodYear}/prepare`;
  const hasBlockingPreflightIssue = preflight.checks.some(
    (check) => check.state === "failed" || (check.state === "review" && check.id !== "bs_equation"),
  );

  if (mission.status === "locked") {
    return (
      <WorkspaceGate
        mission="Prepare Statements"
        blocker={mission.blocker ?? "Complete prerequisites first"}
        prerequisiteHref={workspaceState.missions.prepare.href}
        prerequisiteLabel="Go to Prepare Data"
      />
    );
  }

  // Import integrity and unresolved mapping decisions are blocking. A computed
  // statement-equation difference is advisory and belongs inside Statements.
  if (upload && (preflight.verdict === "pending" || hasBlockingPreflightIssue)) {
    return (
      <div className="max-w-2xl space-y-6 pt-2">
        <TrialBalancePreflight upload={upload} resolveHref={prepareHref} />
        <WorkspaceGate
          mission="Prepare Statements"
          blocker={preflight.blocker ?? "The trial balance is not certified yet."}
          prerequisiteHref={prepareHref}
          prerequisiteLabel="Certify the trial balance"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {upload?.company_id && (
        <>
          <MappingSourcePreview
            processingResult={upload.processing_result}
            fileName={upload.file_name}
          />
          {FinancialStatementsWorkspace && (
            <Suspense fallback={null}>
              <FinancialStatementsWorkspace
                companyId={companyId}
                periodYear={periodYear}
                companyName={upload.company_name ?? company?.name ?? ""}
                companyTin={company?.tin ?? null}
                reportingFramework={company?.reporting_framework ?? null}
                currency={company?.currency ?? null}
                fiscalYearEnd={company?.fiscal_year_end ?? null}
                currentUpload={upload}
                uploads={uploads}
                issueDownload={issueStatementsDownload}
                downloadsLocked={downloadsLocked}
              />
            </Suspense>
          )}
          <div className="border border-border p-4 sm:flex sm:items-center sm:justify-between sm:gap-6">
            <div>
              <p className="text-sm font-semibold text-foreground">Financial statement output</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Produce the current statement set from this workspace's reviewed mapping and framework context.
              </p>
            </div>
            <div className="mt-4 shrink-0 sm:mt-0">
              <ExportStatements
                fileName={upload.file_name}
                processingResult={upload.processing_result as ProcessingResult | null}
                uploadId={upload.id}
                reportingFramework={company?.reporting_framework ?? null}
                companyName={upload.company_name ?? ""}
                companyTin={company?.tin ?? ""}
                periodYearEnd={company?.fiscal_year_end ?? ""}
                companyCurrency={company?.currency ?? "TZS"}
                taxResult={null}
                companyId={companyId}
                periodYear={periodYear}
              />
            </div>
          </div>
          <HesabuAssurancePanel uploadId={upload.id} companyId={upload.company_id} />
          <PeriodClosingBalancesPanel
            companyId={upload.company_id}
            companyName={upload.company_name ?? undefined}
          />
        </>
      )}

      {!upload && (
        <WorkspaceGate
          mission="Prepare Statements"
          blocker="No trial balance found for this period"
          prerequisiteHref={workspaceState.missions.prepare.href}
          prerequisiteLabel="Import Trial Balance"
        />
      )}
    </div>
  );
}
