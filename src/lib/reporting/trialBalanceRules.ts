/**
 * trialBalanceRules — the sign-off precondition that the period's trial balance in force was evaluated under the current
 * rules (20261118100000: tb_signoff_rules_blocker previews it; the one sign-off write enforces it). Merged into the
 * server's readiness answer so the sign-off page names it before anyone tries. Fails closed: an answer that cannot be
 * read is itself a blocker on the preview (the server decides at the write either way).
 */
export const RULES_UNAVAILABLE = "TRIAL_BALANCE_RULES_UNAVAILABLE";

export function rulesBlockerOf(answer: unknown): string | null {
  const a = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : null;
  if (!a || a.outcome !== "ok") return RULES_UNAVAILABLE;
  return typeof a.blocker === "string" && a.blocker.length > 0 ? a.blocker : null;
}

export function withTrialBalanceRules<T extends { ready?: boolean; blockers?: string[] }>(readiness: T, answer: unknown): T {
  const blocker = rulesBlockerOf(answer);
  return blocker ? { ...readiness, ready: false, blockers: [...(readiness.blockers ?? []), blocker] } : readiness;
}
