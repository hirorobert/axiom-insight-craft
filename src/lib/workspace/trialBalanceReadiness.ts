/**
 * trialBalanceReadiness — the ONE definition of "Trial balance ready". Pure.
 *
 * Arithmetic balance alone is never enough. A trial balance is ready only when all three checks hold:
 *
 *   1. Checks passed — the authoritative certification for this upload is "certified": the file was read in full,
 *      every amount is exact in the period's currency, there is no duplicate or missing identity, and debits equal
 *      credits to the last minor unit (process-trial-balance / _shared/tbIngestion.ts).
 *   2. Classifications confirmed — "certified" is only ever committed once no account needs review, and every
 *      machine suggestion (shared chart, dictionary, naming rule, fuzzy match) needs a reviewer's confirmation first.
 *   3. Supporting evidence reconciled — the upload's reconciliation finished clean AND actually compared something:
 *      at least one trial-balance line was matched to evidence. A "clean" result over an empty comparison is not
 *      reconciliation, and evidence that cannot be read (null) counts as not reconciled.
 *
 * Unknown, missing or contradictory state is not ready.
 */

export interface ReconciliationEvidence {
  status: string | null;
  matched_count: number | null;
  exception_count: number | null;
  total_tb_lines: number | null;
}

export interface ReadinessInput {
  /** computeCertificationReadiness verdict for the CURRENT upload. */
  certificationVerdict: string | null | undefined;
  /** trial_balance_uploads.safisha_status. */
  safishaStatus: string | null | undefined;
  /** The upload's latest reconciliation record (safisha_reconciliations), or null when there is none / it cannot be read. */
  reconciliation: ReconciliationEvidence | null | undefined;
}

export type ReadinessCheckId = "checks" | "classifications" | "evidence";

export interface ReadinessCheck {
  id: ReadinessCheckId;
  label: string;
  met: boolean;
  detail: string;
}

export interface TrialBalanceReadiness {
  ready: boolean;
  checks: ReadinessCheck[];
  /** The first unmet check, in plain language — null when ready. */
  nextStep: string | null;
}

export function reconciliationEvaluated(r: ReconciliationEvidence | null | undefined): boolean {
  return !!r && r.status === "clean" && (r.total_tb_lines ?? 0) > 0 && (r.matched_count ?? 0) > 0;
}

export function trialBalanceReadiness(input: ReadinessInput): TrialBalanceReadiness {
  const certified = input.certificationVerdict === "certified";
  const review = input.certificationVerdict === "review";
  const evidence = input.safishaStatus === "clean" && reconciliationEvaluated(input.reconciliation);
  const r = input.reconciliation;

  const checks: ReadinessCheck[] = [
    {
      id: "checks",
      label: "File checks passed",
      met: certified || review,
      detail: certified || review ? "Read in full; amounts exact; debits equal credits." : "The file has not passed its checks yet.",
    },
    {
      id: "classifications",
      label: "Account classifications confirmed",
      met: certified,
      detail: certified ? "Every account is on a reviewed classification." : review ? "Some accounts need a reviewer's confirmation." : "Waiting for the file checks.",
    },
    {
      id: "evidence",
      label: "Supporting evidence reconciled",
      met: evidence,
      detail: evidence
        ? `${r!.matched_count} trial-balance line${r!.matched_count === 1 ? "" : "s"} matched to evidence; no open exceptions.`
        : input.safishaStatus === "clean"
          ? "No trial-balance line has been matched to evidence yet."
          : "Match the trial balance to bank statements, mobile-money exports or subledgers.",
    },
  ];
  const firstUnmet = checks.find((c) => !c.met) ?? null;
  return { ready: !firstUnmet, checks, nextStep: firstUnmet ? firstUnmet.detail : null };
}
