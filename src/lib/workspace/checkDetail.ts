import type { TrialBalanceIssue } from "@/lib/workspace/trialBalanceVerdict";

/**
 * A check whose detail only restates findings the card already lists (by exact message) points to that list instead of
 * repeating it, so each finding is stated once. Any other text in the detail is kept as written.
 */
export function checkDetail(detail: string, listed: readonly TrialBalanceIssue[]): { text: string; pointsToFindings: number } {
  const repeated = listed.filter((i) => i.message && detail.includes(i.message));
  if (repeated.length === 0) return { text: detail, pointsToFindings: 0 };
  const rest = repeated.reduce((d, i) => d.split(i.message).join(" "), detail).replace(/\s+/g, " ").trim();
  return { text: rest, pointsToFindings: repeated.length };
}
