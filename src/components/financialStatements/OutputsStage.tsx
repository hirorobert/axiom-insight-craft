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
 *
 * Reporting Pack (REPORTING_PACK_EXPORT, 20260925100000): the web preview is
 * free. The browser-rendered JSON / CSV files are WORKING COPIES (issued by the
 * server, never sealed). The OFFICIAL Reporting Pack of a SAVED version is
 * generated, stored and sealed by the server itself (security correction N-1):
 * the browser only saves the server's document. This stage stays database-inert
 * and never writes a file itself: the HOST PAGE supplies `deliverDownload`,
 * `deliverOfficial` and `downloadsLocked`. Without a deliverer no download is
 * offered at all. The print is always a draft and carries DRAFT_PRINT_MARK on
 * every printed page.
 */
import { useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { FinancialStatementsWorkspaceModel } from "@/hooks/useFinancialStatementsWorkspace";
import { isApprovalReady } from "@/lib/financialStatementsWorkspace/findingsView";
import { StatementRenderer } from "./StatementRenderer";
import { StatusBadge } from "./SourcesStructureStatements";
import { BudgetActualTable, DisclosureChecklist, PublicationControls } from "./EvidenceUi";
import { auditExport, budgetCsv, canonicalJsonExport, checklistCsv, evidenceExport, findingsCsv, outputStatus, type ExportFile } from "@/lib/financialStatementsWorkspace/exports";
import { PaidActionNotice } from "@/components/commercial/PaidActionNotice";
import { lockedCopy } from "@/lib/commercial/paidActions";
import { DRAFT_PRINT_MARK, financialStatementsOutputRef, type DeliveryOutcome } from "@/lib/commercial/reportingPack";

const STAMP = {
  DRAFT: "Draft — not reviewed or approved",
  REVIEWED: "Reviewed — not yet final",
  FINAL: "Final — recorded by an authorised reviewer",
} as const;

export const PRINT_DOCUMENT_ID = "fs-print-document";

// Print isolates ONLY the report document, on A4 portrait, repeats table headers, avoids row splits, and marks EVERY
// printed page twice with DRAFT_PRINT_MARK: in the page's top margin box and as a diagonal watermark (a fixed-position
// element repeats on each printed page).
export const PRINT_CSS = `@media print {
  @page { size: A4 portrait; margin: 15mm; @top-center { content: "${DRAFT_PRINT_MARK}"; font-size: 8pt; font-weight: 700; } @bottom-center { content: "Page " counter(page) " of " counter(pages); font-size: 9pt; } }
  @page fs-landscape { size: A4 landscape; margin: 15mm; @top-center { content: "${DRAFT_PRINT_MARK}"; font-size: 8pt; font-weight: 700; } @bottom-center { content: "Page " counter(page) " of " counter(pages); font-size: 9pt; } }
  #${PRINT_DOCUMENT_ID} .fs-landscape { page: fs-landscape; break-before: page; }
  #${PRINT_DOCUMENT_ID} .fs-toc a { text-decoration: none; color: inherit; }
  #${PRINT_DOCUMENT_ID} table { max-width: 100%; }
  #${PRINT_DOCUMENT_ID} td, #${PRINT_DOCUMENT_ID} th { overflow-wrap: anywhere; }
  body * { visibility: hidden !important; }
  /* Remove everything that is neither the document, inside it, nor one of its ancestors from layout, so no blank pages are produced. */
  body *:not(:has(#${PRINT_DOCUMENT_ID})):not(#${PRINT_DOCUMENT_ID}):not(#${PRINT_DOCUMENT_ID} *) { display: none !important; }
  html, body { height: auto !important; overflow: visible !important; }
  #${PRINT_DOCUMENT_ID}, #${PRINT_DOCUMENT_ID} * { visibility: visible !important; }
  #${PRINT_DOCUMENT_ID} { position: absolute; left: 0; top: 0; width: 100%; max-width: none; border: 0; padding: 0; }
  #${PRINT_DOCUMENT_ID} thead { display: table-header-group; }
  #${PRINT_DOCUMENT_ID} tr { break-inside: avoid; }
  #${PRINT_DOCUMENT_ID} .fs-no-print { display: none !important; }
  #${PRINT_DOCUMENT_ID}::before { content: "${DRAFT_PRINT_MARK}"; position: fixed; top: 45%; left: 5%; width: 90%; text-align: center; font-size: 1.6rem; font-weight: 700; letter-spacing: 0.05em; color: rgba(0,0,0,0.12); transform: rotate(-30deg); z-index: 0; pointer-events: none; }
}`;

export interface OutputsStageProps {
  readonly model: FinancialStatementsWorkspaceModel;
  /** Delivers ONE browser-rendered file as a working copy for the given output reference (supplied by the host page). Absent → no downloads. */
  readonly deliverDownload?: (file: ExportFile, outputRef: string) => Promise<DeliveryOutcome>;
  /** Asks the server to generate and seal the official Reporting Pack of a saved version. Absent → not offered. */
  readonly deliverOfficial?: (outputRef: string) => Promise<DeliveryOutcome>;
  /** The host page knows the workspace cannot issue a Reporting Pack: show the plan explanation instead. */
  readonly downloadsLocked?: boolean;
  /** Explicit signature/approval blocks to print. Omit (default) to print none. */
  readonly signatureBlocks?: readonly string[];
}

export function OutputsStage({ model, signatureBlocks, deliverDownload, deliverOfficial, downloadsLocked = false }: OutputsStageProps) {
  const [refused, setRefused] = useState(false);
  const [failed, setFailed] = useState(false);
  const packLocked = refused || downloadsLocked;
  // A downloadable file is an official Reporting Pack: the host issues it, seals the exact bytes, then saves it.
  const issueAndDownload = async (file: ExportFile) => {
    const outputRef = financialStatementsOutputRef(model.output?.lineage ?? null);
    if (!deliverDownload || !outputRef) return;
    const outcome = await deliverDownload(file, outputRef);
    setFailed(outcome === "failed");
    if (outcome === "locked") setRefused(true);
  };
  // The official pack exists only for a SAVED version with a FINAL publication: the server binds that exact FINAL record,
  // generates the document from the version and seals it (the server refuses anything else; this only hides the button).
  const officialRef = model.output?.lineage?.persisted && model.publication?.state === "FINAL" ? financialStatementsOutputRef(model.output.lineage) : null;
  const issueOfficial = async () => {
    if (!deliverOfficial || !officialRef) return;
    const outcome = await deliverOfficial(officialRef);
    setFailed(outcome === "failed");
    if (outcome === "locked") setRefused(true);
  };
  const { snapshot, profile, composition, numbering, structure } = model;
  const blockers: string[] = [];
  for (const d of structure.diagnostics) if (d.severity === "BLOCKING") blockers.push(d.message);
  for (const b of composition?.blockers ?? []) blockers.push(b);
  if (model.views.length > 0 && !isApprovalReady(model.views)) blockers.push("Blocking or insufficient-evidence findings remain.");
  // Everything on this stage — print, every export — is rendered from ONE output: the persisted version (or the honest "Unsaved draft").
  const report = model.output?.report ?? null;
  const lineage = model.output?.lineage ?? null;
  const status = outputStatus(model.publication?.state ?? null, blockers.length);
  const evidenceRows = model.evidence.map((e) => ({ batch: e.batch, version: e.version }));
  const budget = model.budgetComparison?.status === "GENERATED" ? model.budgetComparison : null;
  const outputEvaluation = model.output?.evaluation ?? null;
  const bundle =
    report && lineage
      ? [
          canonicalJsonExport(report, lineage),
          evidenceExport(report, evidenceRows, lineage),
          auditExport({ report, lineage, evaluation: outputEvaluation, decisions: model.snapshot?.decisions ?? [], evidence: evidenceRows, publication: model.publication ? { state: model.publication.state, reason: model.publication.reason } : null, exportedAt: null }),
          ...(outputEvaluation ? [findingsCsv(report, outputEvaluation.findings, lineage)] : []),
          ...(budget ? [budgetCsv(report, budget, lineage)] : []),
          ...(model.checklist.length > 0 ? [checklistCsv(report, model.checklist, lineage)] : []),
        ]
      : [];

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

      {packLocked ? (
        <div className="fs-no-print">
          <PaidActionNotice copy={lockedCopy("REPORTING_PACK_EXPORT")} testId="outputs-downloads-locked" />
        </div>
      ) : !deliverDownload ? null : (
        <div className="flex flex-wrap gap-2 fs-no-print" data-testid="export-buttons">
          {deliverOfficial && officialRef && (
            <Button type="button" size="sm" onClick={() => void issueOfficial()} data-testid="official-pack-button">
              Official Reporting Pack (sealed by the server)
            </Button>
          )}
          {bundle.map((f) => (
            <Button key={f.fileName} type="button" variant="outline" size="sm" onClick={() => void issueAndDownload(f)} data-export-file={f.fileName}>
              {f.fileName.replace(/^.*?-(v\d+|unsaved-draft)\./, "").replace(/\./g, " ")} ({f.mimeType === "text/csv" ? "CSV" : "JSON"})
            </Button>
          ))}
        </div>
      )}
      {failed && !packLocked && (
        <p className="text-xs text-destructive fs-no-print" role="alert">The file could not be issued. Try again.</p>
      )}

      <PublicationControls model={model} blockers={blockers} />

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
                {STAMP[status]}
                {blockers.length > 0 ? " — unresolved items remain" : ""}
              </p>
              <h2 className="text-xl font-semibold text-foreground">{report.entity.legalName}</h2>
              <p className="text-sm text-foreground">
                Financial statements for the period {report.period.startDate} to {report.period.endDate}
              </p>
              <p className="text-xs text-muted-foreground">
                {profile.displayName} · presented in {report.presentationCurrency.currency}, full units · report {report.reportIdentity.reportId.slice(0, 8)} · <span data-testid="print-version">{lineage?.label ?? "Unsaved draft"}</span>{lineage?.evaluation ? ` · evaluation ${lineage.evaluation.evaluationRunId.slice(0, 8)}` : ""}
              </p>
            </header>

            <nav aria-label="Contents" className="fs-toc space-y-1" data-testid="print-toc">
              <p className="text-sm font-semibold text-foreground">Contents</p>
              <ol className="list-decimal pl-5 text-sm">
                {composition.entries.map((entry) => (
                  <li key={entry.kind}>
                    <a href={`#statement-${entry.statementId ?? entry.kind}`}>{entry.title}</a>
                  </li>
                ))}
                {budget && <li>Budget versus actual</li>}
                {report.notes.length > 0 && <li>Notes</li>}
                {report.accountingPolicies.length > 0 && <li>Accounting policies</li>}
              </ol>
            </nav>

            {composition.entries.map((entry, i) => {
              const statement = entry.statementId ? report.statements.find((s) => s.statementId === entry.statementId) : undefined;
              return statement ? (
                <StatementRenderer key={entry.kind} report={report} statement={statement} profile={profile} numbering={numbering} startOnNewPage={i > 0} />
              ) : (
                <section key={entry.kind} className="break-inside-avoid-page" data-incomplete-statement={entry.kind}>
                  <h3 className="text-base font-semibold text-foreground">{entry.title}</h3>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Not prepared — evidence required. <StatusBadge status={entry.status} />
                  </div>
                </section>
              );
            })}

            {budget && (
              <div className="fs-landscape">
                <BudgetActualTable comparison={budget} />
              </div>
            )}

            {report.notes.length > 0 && (
              <section className="print:break-before-page" data-testid="print-notes">
                <h3 className="text-base font-semibold text-foreground">Notes</h3>
                {[...report.notes].sort((a, b) => Number(numbering?.numberByNoteId.get(a.noteId) ?? 0) - Number(numbering?.numberByNoteId.get(b.noteId) ?? 0)).map((n) => (
                  <div key={n.noteId} className="mt-2 break-inside-avoid-page">
                    <p className="text-sm font-medium">
                      Note {numbering?.numberByNoteId.get(n.noteId)} — {n.title}
                    </p>
                    {report.textualDisclosures.filter((d) => d.relatedNoteId === n.noteId).map((d) => (
                      <p key={d.disclosureId} className="whitespace-pre-wrap text-sm text-muted-foreground">
                        {d.text}
                      </p>
                    ))}
                  </div>
                ))}
              </section>
            )}

            {model.checklist.some((c) => c.state !== "PROVIDED") && (
              <section className="fs-no-print" data-testid="print-checklist-gaps">
                <h3 className="text-base font-semibold text-foreground">Disclosure checklist</h3>
                <DisclosureChecklist checklist={model.checklist} />
              </section>
            )}

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
