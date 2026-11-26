/**
 * Display rules for the account-mapping review (R1, 2026-11-26).
 *
 * NULL means NOT COMPUTED (CLAUDE.md §4.1): a confidence the engine never computed is shown as "Not scored", never replaced by
 * a default figure. Previously the modal showed an invented 85% with a coloured bar and a "High" label for every unscored
 * account. The modal does not know the workspace currency, so a balance is a plain number with no currency symbol (it
 * previously printed "$" for every workspace, whatever its currency).
 */

/** The engine's mapping confidence, or null when it never scored this account. */
export function computedConfidence(account: { confidence?: number | null }): number | null {
  return typeof account.confidence === "number" && Number.isFinite(account.confidence) ? account.confidence : null;
}

/** The confidence as shown to the reviewer. */
export function confidenceLabel(confidence: number | null): string {
  return confidence === null ? "Not scored" : `${confidence}%`;
}

/** A balance as a plain number with two decimals and no currency symbol. */
export function formatBalance(balance: number): string {
  return balance.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Routed to the "Review" filter: an account the engine scored below 70, or one it never scored (unscored is not "confident"). */
export function needsReview(account: { confidence?: number | null }): boolean {
  const confidence = computedConfidence(account);
  return confidence === null || confidence < 70;
}
