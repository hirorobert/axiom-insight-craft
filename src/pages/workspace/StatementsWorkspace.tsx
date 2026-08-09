/**
 * StatementsWorkspace — Financial Statement Validation.
 *
 * Re-homes from Dashboard:
 *   HesabuAssurancePanel, PeriodClosingBalancesPanel
 *
 * Gate: upload must be complete + valid.
 * Prepare gate does NOT block Statements draft validation.
 */

import { useWorkspace } from "@/contexts/WorkspaceContext";
import { HesabuAssurancePanel } from "@/components/HesabuAssurancePanel";
import { PeriodClosingBalancesPanel } from "@/components/PeriodClosingBalancesPanel";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";
import { MappingSourcePreview } from "@/components/workspace/MappingSourcePreview";
import { TrialBalancePreflight } from "@/components/workspace/TrialBalancePreflight";
import { computePreflight } from "@/lib/workspace/computePreflight";

export default function StatementsWorkspace() {
  const { upload, workspaceState, companyId, periodYear } = useWorkspace();

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

  // Statements are only trustworthy once the trial balance is certified.
  // Show the exact reason and the one route that clears it.
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
