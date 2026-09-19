/**
 * Notes & Policies, Validate and Professional Review stages. Presentation
 * only. Notes and policies render ONLY canonical/source data — nothing is
 * generated, and a disclosure area with no source text is shown as requiring
 * evidence, never filled in.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { resolveLatestFact } from "@/lib/canonicalStatement/provenance";
import { formatMoney } from "@/lib/canonicalStatement/money";
import type { CanonicalFinancialStatementReport, MovementSchedule } from "@/lib/canonicalStatement/types";
import { FindingsPanel } from "./FindingsPanel";
import { DisclosureChecklist } from "./EvidenceUi";
import { EvidenceCorrectionHistory } from "./SavedWorkUi";
import type { DecisionRequest, DecisionResult, FinancialStatementsWorkspaceModel } from "@/hooks/useFinancialStatementsWorkspace";
import { correctableFacts } from "@/lib/financialStatementsWorkspace/correctableFacts";
import { isApprovalReady, type FindingView } from "@/lib/financialStatementsWorkspace/findingsView";
import { REVIEW_OUTCOME_LABELS, type ReviewOutcome } from "@/lib/financialStatementsWorkspace/reviewerDecisionCommands";
import type { PersistenceState } from "@/lib/financialStatementsWorkspace/persistenceContract";
import { FINANCIAL_STATEMENT_PERSISTENCE_ENABLED } from "@/lib/financialStatementsWorkspace/persistenceGate";

function moneyText(report: CanonicalFinancialStatementReport, factId: string): string {
  const fact = resolveLatestFact(report.facts, factId);
  return fact?.value ? formatMoney(fact.value) : "—";
}

function MovementTable({ report, schedule }: { report: CanonicalFinancialStatementReport; schedule: MovementSchedule }) {
  const rows: [string, string][] = [
    ["Opening balance", moneyText(report, schedule.openingBalanceFactId)],
    ...schedule.additionFactIds.map((id): [string, string] => ["Additions", moneyText(report, id)]),
    ...schedule.disposalFactIds.map((id): [string, string] => ["Disposals", moneyText(report, id)]),
    ...schedule.otherMovements.map((m): [string, string] => [m.sign === "ADD" ? "Other movement (+)" : "Other movement (−)", moneyText(report, m.factId)]),
    ["Closing balance", moneyText(report, schedule.closingBalanceFactId)],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="mt-2 w-full min-w-[16rem] text-sm">
        <caption className="sr-only">Movement schedule</caption>
        <tbody>
          {rows.map(([label, value], i) => (
            <tr key={i} className={i === rows.length - 1 ? "border-t border-border font-semibold" : ""}>
              <td className="py-1 pr-4">{label}</td>
              <td className="py-1 text-right tabular-nums">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NotesStage({ model }: { model: FinancialStatementsWorkspaceModel }) {
  const { snapshot, profile, numbering } = model;
  const report = snapshot?.report ?? null;
  const notes = report ? [...report.notes].sort((a, b) => Number(numbering?.numberByNoteId.get(a.noteId) ?? 0) - Number(numbering?.numberByNoteId.get(b.noteId) ?? 0)) : [];
  return (
    <section aria-labelledby="fs-notes-h" className="space-y-4">
      <h3 id="fs-notes-h" className="text-base font-semibold text-foreground">
        Notes &amp; Policies
      </h3>

      {profile && (
        <div>
          <h4 className="text-sm font-semibold text-foreground">Required disclosure areas — {profile.displayName}</h4>
          {model.checklist.length > 0 && <DisclosureChecklist checklist={model.checklist} />}
          <ul className={model.checklist.length > 0 ? "hidden" : "mt-1 divide-y divide-border border border-border text-sm"} data-testid="disclosure-areas">
            {profile.disclosureAreas.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                <span>
                  {a.label} <span className="text-xs text-muted-foreground">({a.reference})</span>
                </span>
                <Badge variant="outline">{report && (a.id === "accounting-policies" ? report.accountingPolicies.length > 0 : report.notes.length > 0 || report.textualDisclosures.length > 0) ? "Source text present" : "No source text — evidence required"}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold text-foreground">Accounting policies</h4>
        {report && report.accountingPolicies.length > 0 ? (
          <ol className="mt-1 space-y-2 text-sm">
            {report.accountingPolicies.map((p) => (
              <li key={p.policyId}>
                <p className="font-medium">{p.topic}</p>
                <p className="text-muted-foreground">{p.text}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="no-policies">
            No accounting policy text has been provided. This workspace does not write policy wording; it can only present text supplied from a source.
          </p>
        )}
      </div>

      <div>
        <h4 className="text-sm font-semibold text-foreground">Notes</h4>
        {notes.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="no-notes">
            No notes exist for this report, so no face-to-note references are shown.
          </p>
        ) : (
          <ol className="mt-1 space-y-4">
            {notes.map((n) => (
              <li key={n.noteId} id={`note-${n.noteId}`}>
                <p className="text-sm font-medium">
                  Note {numbering?.numberByNoteId.get(n.noteId)} — {n.title}
                </p>
                {report?.textualDisclosures.filter((d) => d.relatedNoteId === n.noteId).map((d) => (
                  <p key={d.disclosureId} className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground" data-testid="note-text">
                    {d.text}
                  </p>
                ))}
                {n.movementSchedule && report && <MovementTable report={report} schedule={n.movementSchedule} />}
              </li>
            ))}
          </ol>
        )}
        {numbering && numbering.diagnostics.length > 0 && (
          <ul className="mt-2 space-y-1" data-testid="note-diagnostics">
            {numbering.diagnostics.map((d, i) => (
              <li key={i} className="text-xs text-destructive">
                {d.message}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Supporting schedules cannot be imported yet, so movement schedules appear only where a note already carries one.</p>
      </div>
    </section>
  );
}

export function ValidateStage({ model, onFocusLine }: { model: FinancialStatementsWorkspaceModel; onFocusLine: (lineId: string) => void }) {
  if (model.views.length === 0) {
    return (
      <section aria-labelledby="fs-validate-h">
        <h3 id="fs-validate-h" className="text-base font-semibold text-foreground">
          Validate
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {model.profile && model.profile.trialBalance.status === "UNSUPPORTED" ? "No validation runs for this framework: the primary statement cannot be prepared from a trial balance." : "Validation runs once statements have been prepared."}
        </p>
      </section>
    );
  }
  const ready = isApprovalReady(model.views);
  return (
    <section aria-labelledby="fs-validate-h" className="space-y-3">
      <h3 id="fs-validate-h" className="sr-only">
        Validate
      </h3>
      <p className="text-sm text-foreground" role="status" data-testid="approval-readiness" data-ready={ready ? "yes" : "no"}>
        {ready ? "No blocking or insufficient-evidence findings remain in the prepared statements." : "Approval is not ready: blocking or insufficient-evidence findings remain."} Readiness also depends on the statement set being complete — see Structure.
      </p>
      <FindingsPanel views={model.views} onFocusLine={onFocusLine} />
    </section>
  );
}

// ─── Professional Review ────────────────────────────────────────────────────

const PERSISTENCE_COPY: Record<PersistenceState, { title: string; body: string }> = {
  UNSAVED_DRAFT: { title: "Session only — unsaved draft", body: "Decisions and corrections exist only in this browser session until saving is enabled. Reloading or leaving this page discards them." },
  UNAVAILABLE: { title: "Session only — saving is not available", body: "Corrections and decisions exist only in this browser session. Nothing is written to any database, and reloading or leaving this page discards them." },
  PERSISTED: { title: "Saved", body: "This evaluation and its decisions are stored." },
  STALE_VERSION: { title: "Report version is stale", body: "The report changed after this decision was prepared. Re-run validation and decide again." },
  PERMISSION_DENIED: { title: "Permission needed", body: "Your account is not permitted to record review decisions for this company." },
};

export function PersistenceBanner({ state }: { state: PersistenceState }) {
  // "Saved" can never be shown while persistence is disabled in source, whatever state a caller passes.
  const effective: PersistenceState = state === "PERSISTED" && !FINANCIAL_STATEMENT_PERSISTENCE_ENABLED ? "UNAVAILABLE" : state;
  const copy = PERSISTENCE_COPY[effective];
  return (
    <Alert variant={state === "PERMISSION_DENIED" || state === "STALE_VERSION" ? "destructive" : "default"} data-persistence-state={effective} role="status">
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.body}</AlertDescription>
    </Alert>
  );
}

function DecisionForm({ view, report, onDecide, savingAvailable, readOnly }: { view: FindingView; report: CanonicalFinancialStatementReport | null; onDecide: (r: DecisionRequest) => Promise<DecisionResult>; savingAvailable: boolean; readOnly: boolean }) {
  const factOptions = report ? correctableFacts(report, view.record) : [];
  const [outcome, setOutcome] = useState<ReviewOutcome>("ACCEPT_WITH_JUDGEMENT");
  const [rationale, setRationale] = useState("");
  const [factId, setFactId] = useState(factOptions[0]?.factId ?? "");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idBase = `decision-${view.record.findingKey.slice(0, 12)}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await onDecide({ outcome, finding: view.record, rationale, correction: outcome === "CORRECTED" ? { factId, correctedAmount: amount } : undefined });
    setBusy(false);
    if ("message" in result) {
      setError(result.message);
    } else {
      setRationale("");
      setAmount("");
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 border-t border-border pt-3" aria-label={`Decide finding ${view.record.ruleId}`} data-read-only={readOnly ? "yes" : undefined}>
      <fieldset disabled={readOnly}>
        <legend className="text-xs font-medium text-foreground">Your decision</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {(Object.keys(REVIEW_OUTCOME_LABELS) as ReviewOutcome[]).map((o) => (
            <label key={o} className="flex items-center gap-1.5 text-xs">
              <input type="radio" name={`${idBase}-outcome`} value={o} checked={outcome === o} onChange={() => setOutcome(o)} />
              {REVIEW_OUTCOME_LABELS[o]}
            </label>
          ))}
        </div>
      </fieldset>
      {outcome === "CORRECTED" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Figure to correct
            <select className="mt-1 block w-full border border-border bg-background p-1.5 text-xs" value={factId} disabled={readOnly} onChange={(e) => setFactId(e.target.value)}>
              {factOptions.length === 0 && <option value="">No correctable figure in this finding</option>}
              {factOptions.map((f) => (
                <option key={f.factId} value={f.factId}>
                  {f.label}
                  {f.currentAmount ? ` — currently ${f.currentAmount}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            Corrected amount
            <input className="mt-1 block w-full border border-border bg-background p-1.5 text-xs" inputMode="decimal" value={amount} disabled={readOnly} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1250000.00" />
          </label>
        </div>
      )}
      <label className="block text-xs">
        Documented reason (required)
        <textarea className="mt-1 block w-full border border-border bg-background p-1.5 text-xs" rows={2} value={rationale} disabled={readOnly} onChange={(e) => setRationale(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs font-medium text-foreground" data-testid="session-only-notice">
        {savingAvailable
          ? "This decision is recorded in the draft and stored, with your identity taken from your sign-in, when you save."
          : "Session only: this decision is held in this browser session and is lost if you reload or leave the page. It is not saved anywhere."}
      </p>
      <Button type="submit" size="sm" disabled={busy || readOnly}>
        {busy ? "Recording…" : savingAvailable ? "Record decision" : "Record decision (session only)"}
      </Button>
    </form>
  );
}

export function ReviewStage({ model, onFocusLine }: { model: FinancialStatementsWorkspaceModel; onFocusLine: (lineId: string) => void }) {
  const actionable = model.views.filter((v) => v.record.actionable);
  const readOnly = model.readOnly;
  const savingAvailable = model.saveStatus !== "DISABLED" && model.saveStatus !== "DENIED" && model.saveStatus !== "CHECKING";
  const corrections = (model.snapshot?.decisions ?? []).filter((d) => d.decisionType === "CORRECT_FACT");
  return (
    <section aria-labelledby="fs-review-h" className="space-y-4">
      <h3 id="fs-review-h" className="text-base font-semibold text-foreground">
        Professional Review
      </h3>
      <PersistenceBanner state={model.persistence} />
      {model.notice && (
        <Alert>
          <AlertDescription>{model.notice}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">
        {savingAvailable
          ? "Accepting a finding or marking it not applicable records your judgement and does not change the accounting result — the finding stays visible with its original outcome. Only a correction changes the evaluated statements: a correction to a source figure re-derives every dependent total, and a correction to source evidence (Sources → Correct a value) creates a new evidence version. When saved, each correction becomes its own report version, together with the re-validation and your decision, in one all-or-nothing step."
          : "Accepting a finding or marking it not applicable records your judgement and does not change the accounting result — the finding stays visible with its original outcome. Only a correction to a source figure changes the evaluated statements. A correction is an all-or-nothing change to this session's in-memory draft that re-derives every dependent total; it is not a database transaction and it is not saved."}
      </p>
      {actionable.length === 0 ? (
        <p className="text-sm text-muted-foreground">There is nothing to decide: no finding needs review.</p>
      ) : (
        <ul className="space-y-3" data-testid="review-list">
          {actionable.map((v) => (
            <li key={v.record.evaluationId} className="border border-border p-3 text-sm" data-finding-key={v.record.findingKey}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={v.bucket === "BLOCKING" ? "destructive" : "secondary"}>{v.record.outcome.replace("_", " ")}</Badge>
                <Badge variant="outline" data-testid="review-label">
                  {v.reviewLabel}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">{v.record.ruleId}</span>
              </div>
              <p className="mt-2">{v.record.deterministicCalculation}</p>
              {(v.record.affected.lineId ?? v.record.evidenceReferences.find((e) => e.lineId)?.lineId) && (
                <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onFocusLine((v.record.affected.lineId ?? v.record.evidenceReferences.find((e) => e.lineId)!.lineId)!)}>
                  Show affected line
                </Button>
              )}
              <DecisionForm view={v} report={model.snapshot?.report ?? null} onDecide={model.decide} savingAvailable={savingAvailable} readOnly={readOnly} />
            </li>
          ))}
        </ul>
      )}
      <div>
        <h4 className="text-sm font-semibold text-foreground">{savingAvailable ? "Correction history" : "Correction history (session only)"}</h4>
        {corrections.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{savingAvailable ? "No source figures have been corrected." : "No figures have been corrected in this session."}</p>
        ) : (
          <ol className="mt-1 space-y-1 text-xs" data-testid="correction-history">
            {corrections.map((d) =>
              d.decisionType === "CORRECT_FACT" ? (
                <li key={d.decisionId}>
                  <span className="font-mono">{d.factId}</span> v{d.supersedesVersion} → v{d.newVersion}: {d.correctedValue ? formatMoney(d.correctedValue) : "—"} — {d.rationale}
                </li>
              ) : null,
            )}
          </ol>
        )}
        <EvidenceCorrectionHistory decisions={(model.snapshot?.decisions ?? []).filter((d): d is Extract<typeof d, { decisionType: "CORRECT_EVIDENCE" }> => d.decisionType === "CORRECT_EVIDENCE")} />
      </div>
    </section>
  );
}
