/**
 * FinancialStatementsWorkspace — the integrated seven-stage experience inside
 * the existing Prepare Statements stage (no second shell):
 *
 *   Sources → Structure → Statements → Notes & Policies → Validate →
 *   Professional Review → Final Outputs
 *
 * The active stage lives in the URL (?fs=<stage>) so a deep link preserves the
 * workspace, company and period identity, and refresh keeps the place. Exactly
 * one dominant next action is shown, derived from the first unmet precondition.
 */
import { Loader2, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFinancialStatementsWorkspace, type AccountMappingLoader, type WorkspaceUploadInput } from "@/hooks/useFinancialStatementsWorkspace";
import { deriveNextAction, isWorkspaceStage, STAGE_LABELS, WORKSPACE_STAGES, type WorkspaceStage } from "@/lib/financialStatementsWorkspace/nextAction";
import { statementLineDomId } from "@/lib/financialStatementsWorkspace/findingsView";
import { SourcesStage, StatementsStage, StructureStage } from "./SourcesStructureStatements";
import { NotesStage, PersistenceBanner, ReviewStage, ValidateStage } from "./NotesValidateReview";
import { OutputsStage } from "./OutputsStage";

export interface FinancialStatementsWorkspaceProps {
  readonly companyId: string;
  readonly periodYear: number;
  readonly companyName: string;
  readonly companyTin: string | null;
  readonly reportingFramework: string | null;
  readonly currency: string | null;
  readonly fiscalYearEnd: string | null;
  readonly currentUpload: WorkspaceUploadInput | null;
  readonly uploads: readonly WorkspaceUploadInput[];
  readonly loadAccountMappings?: AccountMappingLoader;
  readonly signatureBlocks?: readonly string[];
}

function focusLine(lineId: string) {
  const el = document.getElementById(statementLineDomId(lineId));
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("bg-accent/20");
  window.setTimeout(() => el.classList.remove("bg-accent/20"), 2000);
  return true;
}

export function FinancialStatementsWorkspace(props: FinancialStatementsWorkspaceProps) {
  const model = useFinancialStatementsWorkspace(props);
  const [params, setParams] = useSearchParams();
  const requested = params.get("fs");
  const stage: WorkspaceStage = isWorkspaceStage(requested) ? requested : "statements";
  const next = deriveNextAction({ structure: model.structure, views: model.views, hasReport: !!model.snapshot });

  function go(target: WorkspaceStage) {
    const p = new URLSearchParams(params);
    p.set("fs", target);
    setParams(p, { replace: false });
  }

  // A finding's affected line lives on the Statements stage: move there first, then focus once it has rendered.
  function focusFromAnywhere(lineId: string) {
    if (focusLine(lineId)) return;
    go("statements");
    window.setTimeout(() => focusLine(lineId), 150);
  }

  return (
    <section aria-labelledby="fs-workspace-h" className="space-y-4 border border-border p-3 sm:p-4" data-fs-workspace data-fs-stage={stage}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="fs-workspace-h" className="text-sm font-semibold text-foreground">
            Financial statements
          </h2>
          <p className="mt-1 break-words text-xs text-muted-foreground" data-testid="workspace-context">
            {props.companyName} · FY{props.periodYear} · {model.structure.framework.label} · {model.structure.currency.label} · {model.structure.period.label}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" data-testid="draft-badge">
            Draft — not saved
          </Badge>
          <Button type="button" variant="outline" size="sm" onClick={model.rerun} disabled={model.status === "loading"}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Re-run
          </Button>
        </div>
      </header>

      <nav aria-label="Financial statements stages" className="overflow-x-auto">
        <ol className="flex min-w-max gap-1" role="tablist" aria-orientation="horizontal">
          {WORKSPACE_STAGES.map((s, i) => (
            <li key={s} role="presentation">
              <button
                type="button"
                role="tab"
                id={`fs-tab-${s}`}
                aria-selected={stage === s}
                aria-controls="fs-stage-panel"
                data-stage={s}
                onClick={() => go(s)}
                className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 ${stage === s ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                <span className="mr-1 text-[10px] text-muted-foreground">{i + 1}</span>
                {STAGE_LABELS[s]}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {model.status !== "loading" && (
        <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-muted/30 p-3" data-testid="next-action">
          <p className="text-xs text-foreground">
            <span className="font-medium">Next:</span> {next.reason}
          </p>
          {next.stage !== stage && (
            <Button type="button" size="sm" onClick={() => go(next.stage)}>
              {next.label}
            </Button>
          )}
        </div>
      )}

      <div id="fs-stage-panel" role="tabpanel" aria-labelledby={`fs-tab-${stage}`} className="min-w-0">
        {model.status === "loading" && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Preparing statements from the reviewed trial balance…
          </p>
        )}
        {model.status === "error" && (
          <Alert variant="destructive" className="mb-3">
            <AlertTitle>Statement preparation failed</AlertTitle>
            <AlertDescription>
              <p>{model.reason}</p>
              {model.diagnostics.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-xs">
                  {model.diagnostics.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}
        {model.status === "blocked" && (
          <Alert className="mb-3">
            <AlertTitle>Statements cannot be prepared yet</AlertTitle>
            <AlertDescription>{model.reason}</AlertDescription>
          </Alert>
        )}
        {model.status !== "loading" && stage === "sources" && <SourcesStage model={model} />}
        {model.status !== "loading" && stage === "structure" && <StructureStage model={model} />}
        {model.status !== "loading" && stage === "statements" && <StatementsStage model={model} />}
        {model.status !== "loading" && stage === "notes" && <NotesStage model={model} />}
        {model.status !== "loading" && stage === "validate" && <ValidateStage model={model} onFocusLine={focusFromAnywhere} />}
        {model.status !== "loading" && stage === "review" && <ReviewStage model={model} onFocusLine={focusFromAnywhere} />}
        {model.status !== "loading" && stage === "outputs" && <OutputsStage model={model} signatureBlocks={props.signatureBlocks} />}
      </div>

      {stage !== "review" && model.persistence !== "UNSAVED_DRAFT" && <PersistenceBanner state={model.persistence} />}
    </section>
  );
}
