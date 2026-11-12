// financialStatementsWorkspace/serverBlockers.ts — plain words for the server's publication blockers
// (fs_publication_blockers). The code is always shown too; a code without words is shown as is, never hidden.
import { FIRST_PERIOD_NEXT_ACTIONS } from "@/lib/comparatives/firstPeriodNextActions";

const WORDS: Record<string, (detail: string) => string> = {
  REPORTING_INPUT_STALE: () => "The reviewed trial balance, its approved adjustments or its findings changed after this version was prepared. Prepare and save a new version.",
  REPORTING_INPUT_NOT_AUTHORITATIVE: (d) => `There is no reviewed trial balance to prepare these statements from${d ? ` (${d.replace(/_/g, " ")})` : ""}.`,
  CLOSE_REVIEW_FINDINGS_NOT_CHECKED: () => "Close Review has not checked the current reviewed trial balance for findings yet.",
  CLOSE_REVIEW_BLOCKING_FINDINGS: (d) => `${d} blocking Close Review finding${d === "1" ? " is" : "s are"} unresolved.`,
  CLOSE_REVIEW_ADJUSTMENTS_UNDECIDED: (d) => `${d} adjustment${d === "1" ? " is" : "s are"} awaiting approval or rejection.`,
  CLOSE_REVIEW_ADJUSTMENTS_REQUIRE_REVALIDATION: (d) => `${d} approved adjustment${d === "1" ? " was" : "s were"} approved on an earlier trial balance and must be revalidated or declined first.`,
  COMPARATIVE_PERIOD_MISSING: () => "The framework requires comparative figures. Add the prior year. Only a first reporting period that has been reviewed can replace them: record the first-period facts, cite the evidence, and have a different partner or manager verify it. A declaration alone does not.",
  // First-period and opening-balance items: each carries its one next action (the server's own sentence).
  ...Object.fromEntries(Object.entries(FIRST_PERIOD_NEXT_ACTIONS).map(([code, words]) => [code, () => words])),
  // [20261222100000] role:account:account:net minor units
  CASHFLOW_TRANSFER_UNMATCHED: (d) => {
    const [role, a, b] = d.split(":");
    return `In the ${role === "COMPARATIVE" ? "comparative" : "current"} cash ledger, the transfers recorded between cash accounts ${a ?? "?"} and ${b ?? "?"} do not net to zero. Record both legs of each transfer, one on each account, naming the other account; money leaving the two accounts is a cash flow, not a transfer.`;
  },
};

/** "CODE" or "CODE:detail" → a sentence (or null when there are no words for the code). */
export function blockerSentence(blocker: string): string | null {
  const i = blocker.indexOf(":");
  const code = i < 0 ? blocker : blocker.slice(0, i);
  const detail = i < 0 ? "" : blocker.slice(i + 1);
  return WORDS[code] ? WORDS[code](detail) : null;
}
