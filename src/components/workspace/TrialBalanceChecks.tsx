/**
 * TrialBalanceChecks — the one list of checks that decides whether the trial balance is accepted. Derived from the same
 * verdict as the Current Trial Balance card (trialBalanceVerdict.ts → the certification ledger), so the card and this
 * list can never disagree. Informational assessments are listed apart and never decide acceptance.
 */

import { AlertTriangle, Check, Minus, X } from "lucide-react";
import type { MilestoneState, TrialBalanceCheck, TrialBalanceVerdict } from "@/lib/workspace/trialBalanceVerdict";
import { TRIAL_BALANCE_CHECKS_ANCHOR } from "./CurrentTrialBalanceCard";

const ICON: Record<TrialBalanceCheck["state"], JSX.Element> = {
  passed: <Check className="h-4 w-4 text-success" aria-hidden="true" />,
  failed: <X className="h-4 w-4 text-destructive" aria-hidden="true" />,
  review: <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />,
  pending: <Minus className="h-4 w-4 text-muted-foreground/60" aria-hidden="true" />,
};
const STATE_WORD: Record<TrialBalanceCheck["state"], string> = { passed: "Passed", failed: "Failed", review: "Needs review", pending: "Not checked yet" };
const MILESTONE_AS_CHECK: Record<MilestoneState, TrialBalanceCheck["state"]> = { passed: "passed", failed: "failed", needs_review: "review", not_reached: "pending" };
const MILESTONE_WORD: Record<MilestoneState, string> = { passed: "Done", failed: "Stopped here", needs_review: "Needs review", not_reached: "Not reached" };

function Row({ check, muted = false }: { check: TrialBalanceCheck; muted?: boolean }) {
  return (
    <li className="flex gap-3 border-t border-border px-5 py-3.5 first:border-t-0 sm:px-7" data-testid={`check-${check.id}`} data-state={check.state}>
      <span className="mt-0.5 shrink-0">{ICON[check.state]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className={`text-[14px] font-medium ${muted ? "text-muted-foreground" : "text-foreground"}`}>{check.label}</p>
          <span className={`text-[12px] ${check.state === "failed" ? "text-destructive" : check.state === "review" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
            {STATE_WORD[check.state]}
          </span>
        </div>
        <p className="mt-0.5 break-words text-[13px] text-muted-foreground">{check.detail}</p>
      </div>
    </li>
  );
}

export function TrialBalanceChecks({ verdict }: { verdict: TrialBalanceVerdict }) {
  const passed = verdict.checks.filter((c) => c.state === "passed").length;
  return (
    <section id={TRIAL_BALANCE_CHECKS_ANCHOR} aria-labelledby={`${TRIAL_BALANCE_CHECKS_ANCHOR}-title`} className="border border-border bg-card" data-testid="trial-balance-checks">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-4 sm:px-7">
        <h2 id={`${TRIAL_BALANCE_CHECKS_ANCHOR}-title`} tabIndex={-1} className="text-[15px] font-semibold text-foreground outline-none">Trial balance checks</h2>
        {verdict.checks.length > 0 && <p className="text-[12px] text-muted-foreground">{passed} of {verdict.checks.length} passed</p>}
      </div>
      {verdict.checks.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-muted-foreground sm:px-7">The checks appear here once processing finishes.</p>
      ) : (
        <ul>{verdict.checks.map((c) => <Row key={c.id} check={c} />)}</ul>
      )}
      {verdict.milestones.length > 0 && (
        <>
          <p className="border-t border-border bg-muted/30 px-5 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground sm:px-7">
            What the last check did
          </p>
          <ol data-testid="trial-balance-milestones">
            {verdict.milestones.map((m) => (
              <li key={m.id} className="flex gap-3 border-t border-border px-5 py-2.5 first:border-t-0 sm:px-7" data-milestone={m.id} data-state={m.status}>
                <span className="mt-0.5 shrink-0">{ICON[MILESTONE_AS_CHECK[m.status]]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className={`text-[13px] font-medium ${m.status === "not_reached" ? "text-muted-foreground" : "text-foreground"}`}>{m.label}</p>
                    <span className="text-[12px] text-muted-foreground">{MILESTONE_WORD[m.status]}</span>
                  </div>
                  {m.detail && <p className="mt-0.5 break-words text-[12px] text-muted-foreground">{m.detail}</p>}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      {verdict.informational.length > 0 && (
        <>
          <p className="border-t border-border bg-muted/30 px-5 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground sm:px-7">
            For information — does not decide acceptance
          </p>
          <ul>{verdict.informational.map((c) => <Row key={c.id} check={c} muted />)}</ul>
        </>
      )}
    </section>
  );
}
