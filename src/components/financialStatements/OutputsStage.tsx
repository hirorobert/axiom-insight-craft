/**
 * Final Outputs stage: the web-native financial report preview and the
 * controlled draft print output.
 *
 * Every output is stamped as a DRAFT. There is no "final" or "approved" output
 * because no approval workflow is persisted yet, and the print document says
 * whether blocking findings or composition gaps remain. PDF is the browser's
 * own print-to-PDF of this document (A4, repeating table headers, deliberate
 * page breaks). DOCX is not offered: no DOCX generator exists in this
 * repository and a low-fidelity file would misrepresent the statements.
 *
 * Signature / approval placeholders appear only when the caller explicitly
 * configures them.
 */
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { FinancialStatementsWorkspaceModel } from "@/hooks/useFinancialStatementsWorkspace";
import { isApprovalReady } from "@/lib/financialStatementsWorkspace/findingsView";
import { StatementRenderer } from "./StatementRenderer";
import { StatusBadge } from "./SourcesStructureStatements";

export const PRINT_DOCUMENT_ID = "fs-print-document";

// Print isolates ONLY the report document, on A4 portrait, repeats table headers, avoids row splits, and draws a diagonal DRAFT watermark.
export const PRINT_CSS = `@media print {
  @page { size: A4 portrait; margin: 15mm; }
  body * { visibility: hidden !important; }
  /* Remove everything that is neither the document, inside it, nor one of its ancestors from layout, so no blank pages are produced. */
  body *:not(:has(#${PRINT_DOCUMENT_ID})):not(#${PRINT_DOCUMENT_ID}):not(#${PRINT_DOCUMENT_ID} *) { display: none !important; }
  html, body { height: auto !important; overflow: visible !important; }
  #${PRINT_DOCUMENT_ID}, #${PRINT_DOCUMENT_ID} * { visibility: visible !important; }
  #${PRINT_DOCUMENT_ID} { position: absolute; left: 0; top: 0; width: 100%; max-width: none; border: 0; padding: 0; }
  #${PRINT_DOCUMENT_ID} thead { display: table-header-group; }
  #${PRINT_DOCUMENT_ID} tr { break-inside: avoid; }
  #${PRINT_DOCUMENT_ID} .fs-no-print { display: none !important; }
  #${PRINT_DOCUMENT_ID}::before { content: "DRAFT"; position: fixed; top: 40%; left: 10%; width: 80%; text-align: center; font-size: 8rem; font-weight: 700; letter-spacing: 0.2em; color: rgba(0,0,0,0.07); transform: rotate(-30deg); z-index: 0; pointer-events: none; }
}`;

export interface OutputsStageProps {
  readonly model: FinancialStatementsWorkspaceModel;
  /** Explicit signature/approval blocks to print. Omit (default) to print none. */
  readonly signatureBlocks?: readonly string[];
}

export function OutputsStage({ model, signatureBlocks }: OutputsStageProps) {
  const { snapshot, profile, composition, numbering, structure } = model;
  const blockers: string[] = [];
  for (const d of structure.diagnostics) if (d.severity === "BLOCKING") blockers.push(d.message);
  for (const b of composition?.blockers ?? []) blockers.push(b);
  if (model.views.length > 0 && !isApprovalReady(model.views)) blockers.push("Blocking or insufficient-evidence findings remain.");
  const report = snapshot?.report ?? null;

  return (
    <section aria-labelledby="fs-outputs-h" className="space-y-4">
      <style>{PRINT_CSS}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 fs-no-print">
        <div>
          <h3 id="fs-outputs-h" className="text-base font-semibold text-foreground">
            Final Outputs
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">Everything below is a draft. It has not been reviewed or approved, and nothing is filed.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => window.print()} disabled={!report}>
          <Printer className="mr-1 h-4 w-4" aria-hidden="true" />
          Print / save as PDF (draft)
        </Button>
      </div>

      <ul className="divide-y divide-border border border-border text-sm fs-no-print" data-testid="output-capabilities">
        <li className="flex flex-wrap items-center justify-between gap-2 p-2">
          <span>Web report preview</span>
          <Badge>{report ? "Available (draft)" : "Needs prepared statements"}</Badge>
        </li>
        <li className="flex flex-wrap items-center justify-between gap-2 p-2">
          <span>PDF — via the browser's print</span>
          <Badge variant="outline">Draft only</Badge>
        </li>
        <li className="flex flex-wrap items-center justify-between gap-2 p-2" data-output="docx">
          <span>Word (DOCX)</span>
          <Badge variant="outline">Not available — no reliable DOCX generator exists yet</Badge>
        </li>
        <li className="flex flex-wrap items-center justify-between gap-2 p-2" data-output="xbrl">
          <span>XBRL / iXBRL filing package</span>
          <Badge variant="outline">Not produced — facts keep provenance, but no filing capability is claimed</Badge>
        </li>
      </ul>

      {blockers.length > 0 && (
        <div className="border border-border p-3 fs-no-print" data-testid="output-blockers">
          <p className="text-sm font-medium text-foreground">Why this is not ready to issue</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      <article id={PRINT_DOCUMENT_ID} className="space-y-6 border border-border p-4 sm:p-6" aria-label="Financial statements — draft" data-print-document>
        {!report || !profile || !composition ? (
          <p className="text-sm text-muted-foreground">There are no prepared statements to preview yet.</p>
        ) : (
          <>
            <header className="space-y-1 break-after-avoid">
              <p className="text-xs font-semibold uppercase tracking-wide text-destructive" data-testid="draft-stamp">
                Draft — not reviewed or approved{blockers.length > 0 ? " — unresolved items remain" : ""}
              </p>
              <h2 className="text-xl font-semibold text-foreground">{report.entity.legalName}</h2>
              <p className="text-sm text-foreground">
                Financial statements for the period {report.period.startDate} to {report.period.endDate}
              </p>
              <p className="text-xs text-muted-foreground">
                {profile.displayName} · presented in {report.presentationCurrency.currency}, full units · report {report.reportIdentity.reportId.slice(0, 8)} v{report.reportIdentity.reportVersion}
              </p>
            </header>

            {composition.entries.map((entry, i) => {
              const statement = entry.statementId ? report.statements.find((s) => s.statementId === entry.statementId) : undefined;
              return statement ? (
                <StatementRenderer key={entry.kind} report={report} statement={statement} profile={profile} numbering={numbering} startOnNewPage={i > 0} />
              ) : (
                <section key={entry.kind} className="break-inside-avoid-page" data-incomplete-statement={entry.kind}>
                  <h3 className="text-base font-semibold text-foreground">{entry.title}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Not prepared — evidence required. <StatusBadge status={entry.status} />
                  </p>
                </section>
              );
            })}

            {report.accountingPolicies.length > 0 && (
              <section className="print:break-before-page">
                <h3 className="text-base font-semibold text-foreground">Accounting policies</h3>
                {report.accountingPolicies.map((p) => (
                  <div key={p.policyId} className="mt-2">
                    <p className="text-sm font-medium">{p.topic}</p>
                    <p className="text-sm text-muted-foreground">{p.text}</p>
                  </div>
                ))}
              </section>
            )}

            {signatureBlocks && signatureBlocks.length > 0 && (
              <section className="break-inside-avoid-page pt-8" aria-label="Approval" data-testid="signature-blocks">
                <div className="grid gap-8 sm:grid-cols-2">
                  {signatureBlocks.map((label) => (
                    <div key={label}>
                      <div className="h-10 border-b border-foreground" />
                      <p className="mt-1 text-xs">{label}</p>
                      <p className="text-xs text-muted-foreground">Date: ____________</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </article>
    </section>
  );
}
