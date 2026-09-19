/**
 * Evidence-driven UI pieces: intake panel (Sources), budget-versus-actual table,
 * evidence drill-down, disclosure checklist and the save bar. Presentation only —
 * every figure and status comes from the workspace model. User-supplied text is
 * always rendered as plain text nodes (React escapes it); nothing here uses
 * dangerouslySetInnerHTML.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/canonicalStatement/money";
import type { Statement } from "@/lib/canonicalStatement/types";
import { EVIDENCE_TYPES, EVIDENCE_TYPE_LABELS, type EvidenceDiagnostic, type EvidenceType, type PeriodRole } from "@/lib/financialEvidence/types";
import { inspectWorkbook, XLSX_EVIDENCE_TYPES, XLSX_LIMITS, type WorkbookSheetInfo } from "@/lib/financialEvidence/xlsx";
import { CorrectEvidenceForm } from "./SavedWorkUi";
import type { EvidenceAddResult, FinancialStatementsWorkspaceModel, SaveStatus } from "@/hooks/useFinancialStatementsWorkspace";
import type { BudgetActualComparison } from "@/lib/financialGeneration/budgetActual";
import type { ChecklistItem } from "@/lib/financialGeneration/notesAndSchedules";

const FIELD = "h-9 w-full border border-input bg-background px-2 text-sm text-foreground focus-visible:outline focus-visible:outline-2";
const SEVERITY_BADGE: Record<EvidenceDiagnostic["severity"], "destructive" | "secondary" | "outline"> = { ERROR: "destructive", WARNING: "secondary", INFO: "outline" };

export function DiagnosticsTable({ diagnostics }: { diagnostics: readonly EvidenceDiagnostic[] }) {
  if (diagnostics.length === 0) return <p className="text-xs text-muted-foreground">No diagnostics.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-xs" data-testid="evidence-diagnostics">
        <caption className="sr-only">Evidence diagnostics</caption>
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-1 pr-2">Severity</th>
            <th className="py-1 pr-2">Code</th>
            <th className="py-1 pr-2">Row</th>
            <th className="py-1 pr-2">Column</th>
            <th className="py-1">Detail</th>
          </tr>
        </thead>
        <tbody>
          {diagnostics.map((d, i) => (
            <tr key={i} className="border-b border-border align-top" data-diagnostic-code={d.code}>
              <td className="py-1 pr-2">
                <Badge variant={SEVERITY_BADGE[d.severity]}>{d.severity}</Badge>
              </td>
              <td className="py-1 pr-2 font-mono">{d.code}</td>
              <td className="py-1 pr-2 tabular-nums">{d.row ?? "—"}</td>
              <td className="py-1 pr-2 font-mono">{d.column ?? "—"}</td>
              <td className="py-1">{d.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EvidencePanel({ model }: { model: FinancialStatementsWorkspaceModel }) {
  const report = model.snapshot?.report;
  const cashBasis = model.profile?.basis === "CASH";
  const types = EVIDENCE_TYPES.filter((t) => t !== "TRIAL_BALANCE" && (cashBasis ? t !== "TRANSACTION_LEDGER" && t !== "EQUITY_MOVEMENTS" : t !== "IPSAS_CASH_RECEIPTS_PAYMENTS"));
  const [type, setType] = useState<EvidenceType>(types[0]);
  const [role, setRole] = useState<PeriodRole>("CURRENT");
  const [currency, setCurrency] = useState(report?.presentationCurrency.currency ?? "");
  const [scale, setScale] = useState(report ? String(report.presentationCurrency.scale) : "");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<EvidenceAddResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [workbook, setWorkbook] = useState<{ bytes: Uint8Array; sheets: readonly WorkbookSheetInfo[]; diagnostics: readonly EvidenceDiagnostic[] } | null>(null);
  const [sheet, setSheet] = useState("");
  const isWorkbook = !!file && /\.xlsx$/i.test(file.name);
  const xlsxAllowed = (XLSX_EVIDENCE_TYPES as readonly string[]).includes(type);

  async function pick(f: File | null) {
    setFile(f);
    setResult(null);
    setWorkbook(null);
    setSheet("");
    if (f && /\.xlsx$/i.test(f.name)) {
      if (f.size > XLSX_LIMITS.maxBytes) {
        setResult({ kind: "REJECTED", diagnostics: [{ code: "FILE_TOO_LARGE", severity: "ERROR", message: `The workbook exceeds ${XLSX_LIMITS.maxBytes.toLocaleString("en-US")} bytes.` }] });
        return;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const inspected = inspectWorkbook(bytes);
      if (!inspected.ok) setResult({ kind: "REJECTED", diagnostics: inspected.diagnostics });
      else setWorkbook({ bytes, sheets: inspected.sheets, diagnostics: inspected.diagnostics });
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    const common = { evidenceType: type, periodRole: role, fileName: file.name, mimeType: file.type, currency: currency || undefined, scale: scale === "" ? undefined : Number(scale) } as const;
    if (isWorkbook) {
      if (!workbook || !sheet) {
        setBusy(false);
        return;
      }
      setResult(model.addEvidence({ ...common, bytes: workbook.bytes, sheetName: sheet }));
    } else {
      setResult(model.addEvidence({ ...common, text: await file.text() }));
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3" data-testid="evidence-panel">
      <div>
        <h4 className="text-sm font-semibold text-foreground">Evidence</h4>
        <p className="text-xs text-muted-foreground">
          Add CSV evidence (UTF-8, comma-delimited), or an Excel workbook (.xlsx) for ledgers, equity movements, budgets, IPSAS cash statements and schedules. Every amount must be a plain decimal; nothing is rounded, defaulted or inferred. Currency and decimal places must be stated. You choose the sheet: formulas, macros, encrypted or externally linked workbooks are refused, and hidden sheets, rows and columns are disclosed. PDF and image files are refused. A file that does not validate is kept for its diagnostics but is never used.
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-2 border border-border p-3 sm:grid-cols-2 lg:grid-cols-6" aria-label="Add evidence">
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block font-medium">Evidence type</span>
          <select className={FIELD} value={type} onChange={(e) => setType(e.target.value as EvidenceType)} data-testid="evidence-type">
            {types.map((t) => (
              <option key={t} value={t}>
                {EVIDENCE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Period</span>
          <select className={FIELD} value={role} onChange={(e) => setRole(e.target.value as PeriodRole)} data-testid="evidence-role">
            <option value="CURRENT">Current period</option>
            <option value="COMPARATIVE">Comparative period</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Currency</span>
          <input className={FIELD} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="e.g. TZS" data-testid="evidence-currency" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Decimal places</span>
          <input className={FIELD} value={scale} inputMode="numeric" onChange={(e) => setScale(e.target.value.replace(/\D/g, "").slice(0, 1))} placeholder="0–6" data-testid="evidence-scale" />
        </label>
        <label className="text-xs sm:col-span-2 lg:col-span-4">
          <span className="mb-1 block font-medium">File</span>
          <input type="file" accept={xlsxAllowed ? ".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : ".csv,text/csv"} className="block w-full text-xs" onChange={(e) => void pick(e.target.files?.[0] ?? null)} data-testid="evidence-file" />
        </label>
        {isWorkbook && workbook && (
          <label className="text-xs sm:col-span-2 lg:col-span-4" data-testid="sheet-picker">
            <span className="mb-1 block font-medium">Sheet to read (required — none is chosen for you)</span>
            <select className={FIELD} value={sheet} onChange={(e) => setSheet(e.target.value)} data-testid="evidence-sheet">
              <option value="">Choose a sheet…</option>
              {workbook.sheets.map((s) => (
                <option key={s.name} value={s.name} disabled={s.state === "veryHidden"}>
                  {s.name}
                  {s.state !== "visible" ? ` (${s.state === "hidden" ? "hidden" : "very hidden — cannot be read"})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex items-end sm:col-span-2">
          <Button type="submit" size="sm" disabled={!file || busy || (isWorkbook && (!workbook || !sheet))} data-testid="evidence-add">
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            Add evidence
          </Button>
        </div>
      </form>

      {result && (
        <div className="space-y-2 border border-border p-3" data-testid="evidence-result" data-result-kind={result.kind} role="status">
          <p className="text-sm font-medium text-foreground">
            {result.kind === "REJECTED" ? "The file was refused" : result.kind === "SHEET_SELECTION_REQUIRED" ? "Choose a sheet to read" : result.kind === "EXACT_REPLAY" ? "This exact content was already added — nothing changed" : `Added (${result.batch.validationStatus.replace(/_/g, " ").toLowerCase()})`}
          </p>
          {(result.kind === "ADDED" || result.kind === "EXACT_REPLAY") && result.replay.kind === "NEW_VERSION" && <p className="text-xs text-muted-foreground">New version {result.replay.version} of an existing series; the earlier version is kept and no longer feeds the statements.</p>}
          <DiagnosticsTable diagnostics={result.diagnostics} />
        </div>
      )}

      {model.evidence.length > 0 && (
        <ul className="divide-y divide-border border border-border" data-testid="evidence-list">
          {model.evidence.map((e) => (
            <li key={e.batch.evidenceBatchId} className="p-3" data-evidence-id={e.batch.evidenceBatchId} data-evidence-status={e.batch.validationStatus} data-evidence-used={e.used ? "yes" : "no"}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{EVIDENCE_TYPE_LABELS[e.batch.evidenceType]}</span>
                <Badge variant="outline">{e.batch.periodRole === "CURRENT" ? "Current" : "Comparative"}</Badge>
                <Badge variant="outline">v{e.version}</Badge>
                <Badge variant={e.batch.validationStatus === "INVALID" ? "destructive" : e.used ? "default" : "secondary"}>{e.batch.validationStatus.replace(/_/g, " ").toLowerCase()}</Badge>
                <Badge variant="outline">{e.saved ? "Saved" : "Not saved"}</Badge>
                {!e.saved && (
                  <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => model.removeUnsavedEvidence(e.batch.evidenceBatchId)}>
                    Remove
                  </Button>
                )}
              </div>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {e.batch.sourceFileName ?? "(no file name)"} · {e.batch.document.rows.length} rows · sha256 {e.batch.contentHash.slice(0, 16)}…
                {e.batch.document.sourceSheet ? ` · sheet "${e.batch.document.sourceSheet}"` : ""}
                {e.batch.document.sourceFormat === "XLSX" ? " · workbook" : ""}
              </p>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="evidence-use-reason">
                {e.used ? "Used: " : "Not used: "}
                {e.useReason}
              </p>
              {e.batch.diagnostics.some((d) => d.severity !== "INFO") && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-foreground">Diagnostics ({e.batch.diagnostics.length})</summary>
                  <DiagnosticsTable diagnostics={e.batch.diagnostics} />
                </details>
              )}
              <CorrectEvidenceForm model={model} evidenceBatchId={e.batch.evidenceBatchId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DIRECTION_LABEL = { FAVOURABLE: "Favourable", ADVERSE: "Adverse", NONE: "No variance", NOT_JUDGED: "Not judged" } as const;

export function BudgetActualTable({ comparison }: { comparison: Extract<BudgetActualComparison, { status: "GENERATED" }> }) {
  return (
    <section className="break-inside-avoid-page" aria-labelledby="fs-budget-h" data-testid="budget-actual">
      <h3 id="fs-budget-h" className="mb-1 text-base font-semibold text-foreground">
        Budget versus actual
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">Variance = actual − budget. Favourable/adverse is judged only for revenue and expense lines. Explanations are the preparer's own words; none is generated.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead className="table-header-group">
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 pr-3">Line</th>
              <th className="py-1.5 px-2 text-right">Budget</th>
              <th className="py-1.5 px-2 text-right">Actual</th>
              <th className="py-1.5 px-2 text-right">Variance</th>
              <th className="py-1.5 px-2 text-right">%</th>
              <th className="py-1.5 px-2">Direction</th>
              <th className="py-1.5 pl-2">Explanation</th>
            </tr>
          </thead>
          <tbody>
            {comparison.lines.map((l) => (
              <tr key={l.lineKey} className="border-b border-border align-top" data-budget-line={l.lineKey}>
                <td className="py-1.5 pr-3">
                  {l.label}
                  <span className="block text-[11px] text-muted-foreground">{l.comparisonBasis === "FINAL_BUDGET" ? "final budget" : "original budget"}</span>
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">{formatMoney(l.budget)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{l.actual ? formatMoney(l.actual) : "—"}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{l.variance ? formatMoney(l.variance) : "—"}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{l.variancePercent ?? "—"}</td>
                <td className="py-1.5 px-2">{DIRECTION_LABEL[l.direction]}</td>
                <td className="py-1.5 pl-2 text-xs">
                  {l.preparerExplanation ?? (l.explanationRequired ? <span className="text-destructive">Explanation required — none supplied</span> : "—")}
                  {l.notes.map((n) => (
                    <span key={n} className="block text-muted-foreground">
                      {n}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Drill-down: which evidence rows stand behind each line of a generated statement. */
export function EvidenceSources({ model, statement }: { model: FinancialStatementsWorkspaceModel; statement: Statement }) {
  const index = model.applied?.evidenceIndex ?? {};
  const lines = statement.sections.flatMap((s) => s.lines).filter((l) => index[l.lineId]?.length);
  if (lines.length === 0) return null;
  return (
    <details className="mt-2 fs-no-print" data-testid="evidence-sources">
      <summary className="cursor-pointer text-xs font-medium text-foreground">Evidence behind these figures ({lines.length} lines)</summary>
      <ul className="mt-2 space-y-2 text-xs">
        {lines.map((l) => (
          <li key={l.lineId} data-evidence-line={l.lineId}>
            <span className="font-medium">{l.label}</span>
            {index[l.lineId].map((ref) => {
              const batch = model.evidence.find((e) => e.batch.evidenceBatchId === ref.batchId)?.batch;
              return (
                <div key={ref.batchId} className="mt-1 overflow-x-auto border border-border">
                  <p className="p-1 font-mono text-[11px] text-muted-foreground">
                    {batch?.sourceFileName ?? ref.batchId} · rows {ref.rowNumbers.join(", ")}
                    {batch?.document.rowLocators ? ` · cells ${ref.rowNumbers.slice(0, 6).map((n) => batch.document.rowLocators?.[n - 1] ?? `row ${n}`).join(", ")}${ref.rowNumbers.length > 6 ? ", …" : ""}` : ""}
                  </p>
                  {batch && (
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-y border-border text-left text-muted-foreground">
                          <th className="px-1">#</th>
                          {batch.document.columns.map((c) => (
                            <th key={c} className="px-1 font-mono">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ref.rowNumbers.slice(0, 50).map((n) => (
                          <tr key={n} className="border-b border-border">
                            <td className="px-1 tabular-nums">{n}</td>
                            {batch.document.rows[n - 1].map((cell, i) => (
                              <td key={i} className="px-1">
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </li>
        ))}
      </ul>
    </details>
  );
}

const CHECKLIST_LABEL: Record<ChecklistItem["state"], string> = { PROVIDED: "Provided", NOT_APPLICABLE_WITH_RATIONALE: "Not applicable — rationale given", MISSING: "Missing — evidence required" };

export function DisclosureChecklist({ checklist }: { checklist: readonly ChecklistItem[] }) {
  return (
    <ul className="mt-1 divide-y divide-border border border-border text-sm" data-testid="disclosure-checklist">
      {checklist.map((c) => (
        <li key={c.areaId} className="p-2" data-checklist-state={c.state}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {c.label} <span className="text-xs text-muted-foreground">({c.reference})</span>
            </span>
            <Badge variant={c.state === "MISSING" ? "destructive" : "outline"}>{CHECKLIST_LABEL[c.state]}</Badge>
          </div>
          {c.rationale && <p className="mt-1 text-xs text-muted-foreground">Rationale (preparer): {c.rationale}</p>}
        </li>
      ))}
    </ul>
  );
}

const SAVE_COPY: Record<SaveStatus, { label: string; tone: "default" | "destructive" | "outline" | "secondary" }> = {
  DISABLED: { label: "Saving is not enabled for this company", tone: "outline" },
  DENIED: { label: "Read-only: you cannot save for this company", tone: "destructive" },
  CHECKING: { label: "Checking whether saving is enabled…", tone: "outline" },
  CLEAN: { label: "Nothing to save yet", tone: "outline" },
  UNSAVED: { label: "Unsaved changes", tone: "secondary" },
  SAVING: { label: "Saving…", tone: "secondary" },
  SAVED: { label: "Saved", tone: "default" },
  CONFLICT: { label: "Conflict — someone else saved first", tone: "destructive" },
  ERROR: { label: "Save failed", tone: "destructive" },
};

export function SaveBar({ model }: { model: FinancialStatementsWorkspaceModel }) {
  const copy = SAVE_COPY[model.saveStatus];
  const canSave = (model.saveStatus === "UNSAVED" || model.saveStatus === "ERROR") && !model.readOnly;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="save-bar" data-save-status={model.saveStatus} role="status">
      <Badge variant={copy.tone} data-testid="save-status">
        {model.saveStatus === "SAVED" && model.storedVersion !== null ? `Saved · version ${model.storedVersion}` : copy.label}
      </Badge>
      {model.saveStatus === "SAVING" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
      {model.saveStatus === "SAVED" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
      {(model.saveStatus === "CONFLICT" || model.saveStatus === "ERROR") && <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />}
      {canSave && (
        <Button type="button" size="sm" onClick={() => void model.save()} data-testid="save-button">
          <Save className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {model.saveStatus === "ERROR" ? "Retry save" : "Save"}
        </Button>
      )}
      {model.saveStatus === "CONFLICT" && (
        <Button type="button" size="sm" variant="outline" onClick={model.reloadFromServer} data-testid="save-reload">
          Discard my draft and reload the saved version
        </Button>
      )}
      {model.saveMessage && (
        <span className="text-xs text-muted-foreground" data-testid="save-message">
          {model.saveMessage}
        </span>
      )}
    </div>
  );
}

export function PublicationControls({ model, blockers = [] }: { model: FinancialStatementsWorkspaceModel; blockers?: readonly string[] }) {
  const serverBlockers = model.readiness?.blockers ?? [];
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (model.saveStatus === "DISABLED" || model.saveStatus === "DENIED" || model.saveStatus === "CHECKING") return null;
  async function set(state: "DRAFT" | "REVIEWED" | "FINAL") {
    setBusy(true);
    const r = await model.setPublication(state, reason);
    setMsg({ ok: r.ok, text: r.message });
    setBusy(false);
  }
  return (
    <div className="space-y-2 border border-border p-3 fs-no-print" data-testid="publication-controls">
      <p className="text-sm font-medium text-foreground">Report state {model.publication ? `— currently ${model.publication.state}` : "— no state recorded"}</p>
      <p className="text-xs text-muted-foreground">Only the server can mark a saved version Reviewed or Final, and only an owner or partner may. It refuses while the statement set is incomplete, evidence is invalid or superseded, blocking findings or unmet reconciliations remain, or the version was never evaluated, and it never changes a Final version.</p>
      {model.readiness && (
        <div className={`text-xs ${model.readiness.ready ? "text-muted-foreground" : "text-destructive"}`} data-testid="server-readiness" data-server-ready={model.readiness.ready ? "yes" : "no"}>
          <p className="font-medium">{model.readiness.ready ? "The server reports this saved version as ready to mark Reviewed or Final." : `The server would refuse Reviewed or Final for this saved version (${serverBlockers.length} requirement${serverBlockers.length === 1 ? "" : "s"} unmet):`}</p>
          {serverBlockers.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {serverBlockers.map((b) => (
                <li key={b} className="break-words font-mono">
                  {b}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {blockers.length > 0 && (
        <p className="text-xs text-destructive" data-testid="publication-blocked">
          Reviewed and Final are unavailable while {blockers.length} statement-set item{blockers.length === 1 ? "" : "s"} remain unresolved (listed under "Why this is not ready to issue"). This is a preview: the database enforces the same completeness rules and refuses Reviewed or Final itself.
        </p>
      )}
      <label className="block text-xs">
        <span className="mb-1 block font-medium">Reason (at least 8 characters)</span>
        <input className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="publication-reason" />
      </label>
      <div className="flex flex-wrap gap-2">
        {(["DRAFT", "REVIEWED", "FINAL"] as const).map((s) => (
          <Button key={s} type="button" size="sm" variant="outline" disabled={busy || model.readOnly || reason.trim().length < 8 || (s !== "DRAFT" && (blockers.length > 0 || (model.readiness !== null && !model.readiness.ready)))} onClick={() => void set(s)} data-testid={`publication-${s.toLowerCase()}`}>
            Mark {s.toLowerCase()}
          </Button>
        ))}
      </div>
      {msg && (
        <Alert variant={msg.ok ? "default" : "destructive"} data-testid="publication-message">
          <AlertDescription>{msg.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
