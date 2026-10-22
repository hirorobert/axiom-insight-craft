/**
 * FindingDecisionControl — what a person can record about ONE finding, under the finding itself (the card's one list).
 *
 * Offered only for a finding that takes a decision and carries the engine's identity, on the upload's current evaluation
 * (the page passes the certification id; no id, no control). Nothing is pre-selected; a decision needs its explicit
 * confirmation (or, for a clearing balance, an explanation and evidence) and a reason — the server requires the same and
 * refuses anything else. Recording invalidates the result at once; the page then checks the file again.
 */
import { useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { TrialBalanceIssue } from "@/lib/workspace/trialBalanceVerdict";
import {
  DECISION_CHOICES, clearingPayload, entityPayload, recordFindingDecision, rowsPayload,
  type ClearingNature, type CurrentDecisionView, type DecisionCode, type EvidenceKind,
} from "@/lib/workspace/findingDecisions";

type Rpc = Parameters<typeof recordFindingDecision>[0];
const NATURE: Record<ClearingNature, string> = { in_transit: "Cash or a payment in transit", timing: "A timing difference that clears after the period end", other: "Something else (explain)" };
const EVIDENCE: Record<EvidenceKind, string> = { reconciliation: "A reconciliation", document: "A document (for example a bank statement or deposit slip)" };

export function FindingDecisionControl({ issue, uploadId, certificationId, current, expectedRevision, workspaceEntity, reconcileHref, rpc, onRecorded }: {
  issue: TrialBalanceIssue & { code: DecisionCode; subject: string };
  uploadId: string;
  certificationId: string;
  current: CurrentDecisionView | undefined;
  /** The newest revision recorded for this finding (current or not); 0 when none. */
  expectedRevision: number;
  workspaceEntity: string;
  reconcileHref: string | null;
  rpc: Rpc;
  /** Called once a decision is recorded (the page re-checks the file through the reprocess path). */
  onRecorded: () => void;
}) {
  const ids = { group: useId(), reason: useId(), confirm: useId(), expl: useId(), ref: useId(), nature: useId(), evidence: useId() };
  const choices = DECISION_CHOICES[issue.code];
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<string | null>(choices.length === 1 ? choices[0].action : null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [nature, setNature] = useState<ClearingNature | null>(null);
  const [explanation, setExplanation] = useState("");
  const [evidence, setEvidence] = useState<EvidenceKind | null>(null);
  const [reference, setReference] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "recorded" } | { kind: "error"; message: string }>({ kind: "idle" });
  // One request id per decision attempt: a retry after a lost answer replays it; a changed decision gets a new one.
  const requestId = useRef<string>(crypto.randomUUID());
  const choice = choices.find((c) => c.action === action) ?? null;

  const payload = (): Record<string, unknown> | null => {
    if (!choice) return null;
    if (issue.code === "ENTITY_NAME_DIFFERS") return confirmed && issue.fileEntity ? entityPayload(issue.fileEntity, workspaceEntity, true) : null;
    if (issue.code === "UNRECOGNISED_TRAILING_TEXT") return confirmed ? rowsPayload(issue.rows, true) : null;
    return clearingPayload(nature, explanation, evidence, reference);
  };
  const ready = !!payload() && reason.trim().length >= 3 && state.kind !== "saving";

  const record = async () => {
    const p = payload();
    if (!choice || !p || reason.trim().length < 3) return;
    setState({ kind: "saving" });
    try {
      const r = await recordFindingDecision(rpc, {
        uploadId, certificationId, code: issue.code, subject: issue.subject, action: choice.action, payload: p, reason: reason.trim(),
        expectedRevision, requestId: requestId.current,
      });
      if (r.kind === "refused") { setState({ kind: "error", message: r.message }); requestId.current = crypto.randomUUID(); return; }
      setState({ kind: "recorded" });
      onRecorded();
    } catch {
      // The answer was lost: the same request id is kept, so trying again cannot record twice.
      setState({ kind: "error", message: "The decision may not have been recorded (connection problem). Try again — it will not be recorded twice." });
    }
  };
  const change = (patch: () => void) => { patch(); requestId.current = crypto.randomUUID(); if (state.kind === "error") setState({ kind: "idle" }); };

  if (state.kind === "recorded") {
    return <p role="status" className="mt-2 text-[13px] text-foreground" data-testid={`decision-recorded-${issue.code}`}>Recorded. The file is being checked again with your decision.</p>;
  }
  const decidedChoice = current ? choices.find((c) => c.action === current.action) : undefined;
  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]" data-testid={`decision-${issue.code}`}>
        {current && decidedChoice && (
          <span className="text-muted-foreground" data-testid={`decision-current-${issue.code}`}>
            Decided: {decidedChoice.label}.
            {current.action === "explained" && " The evidence is a reference you recorded, not a matched bank transaction."}
          </span>
        )}
        <button type="button" className="underline underline-offset-4" onClick={() => setOpen(true)} aria-expanded={false}
          data-testid={`decision-open-${issue.code}`}>
          {current ? "Change decision" : issue.code === "CLEARING_ACCOUNT_BALANCE" ? "Explain this balance" : issue.code === "UNRECOGNISED_TRAILING_TEXT" ? "Acknowledge" : "Decide"}
        </button>
        {!current && (
          <span className="text-[12px] text-muted-foreground" data-testid={`decision-requirement-${issue.code}`}>
            {issue.decisionRequired ? "Needed before this trial balance can be accepted." : "Optional — a note for review; it does not hold the trial balance back."}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 border border-border p-3 text-[13px]" data-testid={`decision-form-${issue.code}`} aria-busy={state.kind === "saving"}>
      {choices.length > 1 && (
        <fieldset>
          <legend className="font-medium text-foreground" id={ids.group}>
            {issue.code === "ENTITY_NAME_DIFFERS" ? `Is “${issue.fileEntity ?? "the entity in the file"}” the same entity as ${workspaceEntity}?` : `Are rows ${issue.rows.join(", ")} part of the trial balance?`}
          </legend>
          <div className="mt-2 space-y-1.5">
            {choices.map((c) => (
              <label key={c.action} className="flex items-start gap-2">
                <input type="radio" name={ids.group} value={c.action} checked={action === c.action} className="mt-1"
                  onChange={() => change(() => { setAction(c.action); setConfirmed(false); })} data-testid={`decision-choice-${c.action}`} />
                <span><span className="font-medium">{c.label}.</span> <span className="text-muted-foreground">{c.consequence}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {choice && issue.code !== "CLEARING_ACCOUNT_BALANCE" && (
        <label className="flex items-start gap-2" htmlFor={ids.confirm}>
          <input id={ids.confirm} type="checkbox" checked={confirmed} className="mt-1" onChange={(e) => change(() => setConfirmed(e.target.checked))} data-testid="decision-confirm" />
          <span>{issue.code === "ENTITY_NAME_DIFFERS"
            ? (choice.action === "same_entity" ? `I confirm “${issue.fileEntity}” is ${workspaceEntity}.` : `I confirm “${issue.fileEntity}” is not ${workspaceEntity}.`)
            : (choice.action === "not_part_of_trial_balance" ? `I confirm rows ${issue.rows.join(", ")} are not part of the trial balance.` : `I confirm rows ${issue.rows.join(", ")} are part of the trial balance.`)}</span>
        </label>
      )}

      {issue.code === "CLEARING_ACCOUNT_BALANCE" && (
        <>
          <fieldset>
            <legend className="font-medium text-foreground">Why is there a balance at the period end?</legend>
            <div className="mt-2 space-y-1.5">
              {(Object.keys(NATURE) as ClearingNature[]).map((n) => (
                <label key={n} className="flex items-center gap-2">
                  <input type="radio" name={ids.nature} checked={nature === n} onChange={() => change(() => setNature(n))} data-testid={`decision-nature-${n}`} />{NATURE[n]}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor={ids.expl} className="font-medium text-foreground">Explanation</label>
            <textarea id={ids.expl} value={explanation} maxLength={1000} rows={2} onChange={(e) => change(() => setExplanation(e.target.value))}
              className="mt-1 w-full border border-input bg-background p-2" data-testid="decision-explanation" aria-describedby={`${ids.expl}-hint`} />
            <p id={`${ids.expl}-hint`} className="text-[12px] text-muted-foreground">At least 10 characters — for example when it cleared and what it was.</p>
          </div>
          <fieldset>
            <legend className="font-medium text-foreground">Evidence</legend>
            <div className="mt-2 space-y-1.5">
              {(Object.keys(EVIDENCE) as EvidenceKind[]).map((k) => (
                <label key={k} className="flex items-center gap-2">
                  <input type="radio" name={ids.evidence} checked={evidence === k} onChange={() => change(() => setEvidence(k))} data-testid={`decision-evidence-${k}`} />{EVIDENCE[k]}
                </label>
              ))}
            </div>
            {evidence === "reconciliation" && reconcileHref && (
              <p className="mt-1 text-[12px] text-muted-foreground">Reconcile the account in <Link to={reconcileHref} className="underline underline-offset-4">Reconcile</Link>, then name the reconciliation here.</p>
            )}
            <label htmlFor={ids.ref} className="mt-2 block">Reference</label>
            <input id={ids.ref} value={reference} maxLength={200} onChange={(e) => change(() => setReference(e.target.value))}
              className="mt-1 h-10 w-full border border-input bg-background px-2" data-testid="decision-reference" aria-describedby={`${ids.ref}-hint`}
              placeholder="Where the evidence is (for example: January bank statement, line 2)" />
            <p id={`${ids.ref}-hint`} className="text-[12px] text-muted-foreground" data-testid="decision-reference-hint">
              A reference you record for the reviewer. It is not matched to a bank transaction, and the system does not check the document.
            </p>
          </fieldset>
        </>
      )}

      {choice && (
        <div>
          <label htmlFor={ids.reason} className="font-medium text-foreground">Reason</label>
          <textarea id={ids.reason} value={reason} maxLength={1000} rows={2} onChange={(e) => change(() => setReason(e.target.value))}
            className="mt-1 w-full border border-input bg-background p-2" data-testid="decision-reason" />
          <p className="text-[12px] text-muted-foreground">Recorded with your name and the time. At least 3 characters.</p>
        </div>
      )}

      {state.kind === "error" && <p role="alert" className="text-destructive" data-testid="decision-error">{state.message}</p>}
      <div className="flex flex-wrap gap-2" aria-live="polite">
        <Button type="button" className="h-10 rounded-none" disabled={!ready} onClick={() => void record()} data-testid="decision-record">
          {state.kind === "saving" ? "Recording…" : "Record decision"}
        </Button>
        <Button type="button" variant="outline" className="h-10 rounded-none" onClick={() => setOpen(false)} data-testid="decision-cancel">Cancel</Button>
      </div>
    </div>
  );
}

