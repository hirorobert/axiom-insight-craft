// financialStatementsWorkspace/serverBlockers.ts — plain words for the server's publication blockers
// (fs_publication_blockers). The code is always shown too; a code without words is shown as is, never hidden.

const WORDS: Record<string, (detail: string) => string> = {
  REPORTING_INPUT_STALE: () => "The reviewed trial balance, its approved adjustments or its findings changed after this version was prepared. Prepare and save a new version.",
  REPORTING_INPUT_NOT_AUTHORITATIVE: (d) => `There is no reviewed trial balance to prepare these statements from${d ? ` (${d.replace(/_/g, " ")})` : ""}.`,
  CLOSE_REVIEW_FINDINGS_NOT_CHECKED: () => "Close Review has not checked the current reviewed trial balance for findings yet.",
  CLOSE_REVIEW_BLOCKING_FINDINGS: (d) => `${d} blocking Close Review finding${d === "1" ? " is" : "s are"} unresolved.`,
  CLOSE_REVIEW_ADJUSTMENTS_UNDECIDED: (d) => `${d} adjustment${d === "1" ? " is" : "s are"} awaiting approval or rejection.`,
  COMPARATIVE_PERIOD_MISSING: () => "The framework requires comparative figures. Add the prior year, or record a first-period declaration with its evidence.",
};

/** "CODE" or "CODE:detail" → a sentence (or null when there are no words for the code). */
export function blockerSentence(blocker: string): string | null {
  const i = blocker.indexOf(":");
  const code = i < 0 ? blocker : blocker.slice(0, i);
  const detail = i < 0 ? "" : blocker.slice(i + 1);
  return WORDS[code] ? WORDS[code](detail) : null;
}
