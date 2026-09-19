/**
 * Sources, Structure and Statements stages. Presentation only: every value and
 * status comes from the workspace model (financialStatementsWorkspace/*).
 */
import { AlertTriangle, CheckCircle2, CircleSlash, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatementRenderer } from "./StatementRenderer";
import { BudgetActualTable, EvidencePanel, EvidenceSources } from "./EvidenceUi";
import { CashPerimeterPanel } from "./SavedWorkUi";
import type { FinancialStatementsWorkspaceModel } from "@/hooks/useFinancialStatementsWorkspace";
import type { SourceStatus } from "@/lib/financialStatementsWorkspace/sourcesModel";
import { labelForStatus, type CompositionEntry, type CompositionStatus } from "@/lib/financialStatementsWorkspace/statementComposition";

const SOURCE_BADGE: Record<SourceStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  AVAILABLE: { label: "Available", variant: "default" },
  MISSING: { label: "Missing", variant: "destructive" },
  INELIGIBLE: { label: "Not usable yet", variant: "secondary" },
  UNAVAILABLE: { label: "Not available yet", variant: "outline" },
};

export function SourcesStage({ model }: { model: FinancialStatementsWorkspaceModel }) {
  return (
    <section aria-labelledby="fs-sources-h" className="space-y-3">
      <h3 id="fs-sources-h" className="text-base font-semibold text-foreground">
        Sources
      </h3>
      <p className="text-xs text-muted-foreground">Where each input to these statements comes from. Inputs the product cannot read yet are labelled, never simulated.</p>
      <ul className="divide-y divide-border border border-border">
        {model.sources.map((s) => (
          <li key={s.id} className="p-3" data-source-id={s.id} data-source-status={s.status}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{s.label}</span>
              <Badge variant={SOURCE_BADGE[s.status].variant}>{SOURCE_BADGE[s.status].label}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{s.detail}</p>
            {s.provenance && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{s.provenance}</p>}
          </li>
        ))}
      </ul>
      <EvidencePanel model={model} />
    </section>
  );
}

export function StructureStage({ model }: { model: FinancialStatementsWorkspaceModel }) {
  const s = model.structure;
  const rows: readonly [string, string, string | null][] = [
    ["Reporting framework", s.framework.label, s.framework.resolved ? null : "Not set"],
    ["Reporting period", s.period.label, s.period.basisNote],
    ["Comparative period", s.comparative.label, s.comparative.available ? null : "Missing"],
    ["Presentation currency", s.currency.label, s.currency.resolved ? null : "Not set"],
    ["Scale", s.scale.label, null],
  ];
  return (
    <section aria-labelledby="fs-structure-h" className="space-y-4">
      <h3 id="fs-structure-h" className="text-base font-semibold text-foreground">
        Structure
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[14rem,1fr] text-sm">
        {rows.map(([k, v, flag]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-foreground">
              {v}
              {flag && <span className="ml-2 text-xs font-medium text-destructive">{flag}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <div>
        <h4 className="text-sm font-semibold text-foreground">Account mapping</h4>
        {s.mapping ? (
          <>
            <p className="mt-1 text-sm text-foreground" data-testid="mapping-summary">
              {s.mapping.mapped} of {s.mapping.total} accounts mapped{s.mapping.complete ? " — complete" : ""}
            </p>
            {s.mapping.unmapped.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-destructive">No reviewed mapping ({s.mapping.unmapped.length}) — excluded from the statements</p>
                <ul className="mt-1 text-xs text-muted-foreground">
                  {s.mapping.unmapped.map((a) => (
                    <li key={a.accountCode}>
                      {a.accountCode} {a.accountName}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {s.mapping.ambiguous.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-destructive">Conflicting mappings ({s.mapping.ambiguous.length}) — excluded until reviewed</p>
                <ul className="mt-1 text-xs text-muted-foreground">
                  {s.mapping.ambiguous.map((a) => (
                    <li key={a.accountCode}>
                      {a.accountCode} {a.accountName}: {a.placements.join(" vs ")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">Mapping is assessed once a trial balance is available.</p>
        )}
      </div>

      {s.composition && (
        <div>
          <h4 className="text-sm font-semibold text-foreground">Statement composition</h4>
          <ul className="mt-1 divide-y divide-border border border-border text-sm" data-testid="composition-list">
            {s.composition.entries.map((e) => (
              <li key={e.kind} className="flex flex-wrap items-center justify-between gap-2 p-2">
                <span>
                  {e.title} <span className="text-xs text-muted-foreground">({e.requirement === "REQUIRED" ? "required" : "conditional"} · {e.reference})</span>
                </span>
                <StatusBadge status={e.status} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold text-foreground">Diagnostics</h4>
        {s.diagnostics.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No structure diagnostics.</p>
        ) : (
          <ul className="mt-1 space-y-1" data-testid="structure-diagnostics">
            {s.diagnostics.map((d) => (
              <li key={d.code} className="flex gap-2 text-sm">
                <AlertTriangle className={d.severity === "BLOCKING" ? "h-4 w-4 shrink-0 text-destructive" : "h-4 w-4 shrink-0 text-muted-foreground"} aria-hidden="true" />
                <span>
                  <span className="sr-only">{d.severity === "BLOCKING" ? "Blocking: " : "Attention: "}</span>
                  {d.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function StatusBadge({ status }: { status: CompositionStatus }) {
  const Icon = status === "PRESENT" ? CheckCircle2 : status === "UNSUPPORTED" ? CircleSlash : status === "UNDETERMINED" ? Info : AlertTriangle;
  return (
    <Badge variant={status === "PRESENT" ? "default" : "outline"} className="gap-1" data-status={status}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {labelForStatus(status)}
    </Badge>
  );
}

function IncompleteStatementCard({ entry }: { entry: CompositionEntry }) {
  return (
    <section className="border border-dashed border-border p-4 break-inside-avoid-page" aria-labelledby={`incomplete-${entry.kind}`} data-incomplete-statement={entry.kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`incomplete-${entry.kind}`} className="text-base font-semibold text-foreground">
          {entry.title}
        </h3>
        <StatusBadge status={entry.status} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {entry.requirement === "REQUIRED" ? "Required" : "Conditional"} · {entry.reference}
        {entry.condition ? ` · ${entry.condition}` : ""}
      </p>
      <p className="mt-2 text-sm text-foreground">No figures are shown: this statement cannot be prepared from the evidence held. Nothing has been estimated.</p>
      {entry.availableEvidence.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-foreground">Evidence held</p>
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {entry.availableEvidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-2">
        <p className="text-xs font-medium text-foreground">Evidence required</p>
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {entry.evidenceRequirements.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function StatementsStage({ model }: { model: FinancialStatementsWorkspaceModel }) {
  const { composition, snapshot, profile, numbering } = model;
  if (!profile || !composition) {
    return (
      <section aria-labelledby="fs-statements-h">
        <h3 id="fs-statements-h" className="text-base font-semibold text-foreground">
          Statements
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">{model.reason ?? "Choose a reporting framework to see the statement set."}</p>
      </section>
    );
  }
  let rendered = 0;
  return (
    <section aria-labelledby="fs-statements-h" className="space-y-6">
      <h3 id="fs-statements-h" className="text-base font-semibold text-foreground">
        Statements — {profile.displayName}
      </h3>
      {composition.entries.map((entry) => {
        const statement = entry.statementId ? snapshot?.report.statements.find((s) => s.statementId === entry.statementId) : undefined;
        if (snapshot && statement) {
          const node = (
            <div key={entry.kind}>
              <StatementRenderer report={snapshot.report} statement={statement} profile={profile} numbering={numbering} startOnNewPage={rendered > 0} />
              <EvidenceSources model={model} statement={statement} />
            </div>
          );
          rendered += 1;
          return node;
        }
        if (entry.kind === "BUDGET_VS_ACTUAL" && entry.status === "PRESENT" && model.budgetComparison?.status === "GENERATED") {
          return <BudgetActualTable key={entry.kind} comparison={model.budgetComparison} />;
        }
        return <IncompleteStatementCard key={entry.kind} entry={entry} />;
      })}
      <CashPerimeterPanel model={model} />
    </section>
  );
}
