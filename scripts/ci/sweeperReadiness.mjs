// Fail-closed release control for the trial balance source sweeper (PR #32, 20260923120000 / 20260923130000).
//
// Pure evaluation (unit-tested in src/lib/workspace/sweeperReadiness.test.ts). The sweeper is READY only when ALL of:
//   1. the configured function URL is exactly <project URL>/functions/v1/trial-balance-source-sweeper;
//   2. pg_net is installed (the scheduler can call out);
//   3. the pg_cron job 'trial-balance-source-sweeper' exists and is active;
//   4. the deployed function answered a database-minted ticket with 200 'swept' (deployed, reachable, and able
//      to redeem a ticket and read its candidates);
//   5. the same ticket, sent again, was refused with 403 (single-use enforcement is live).
// Anything missing, unexpected or unreadable is NOT READY with a named reason. Nothing here is ever inferred.

export const SWEEPER_FUNCTION = "trial-balance-source-sweeper";

export function expectedSweeperUrl(projectUrl) {
  if (typeof projectUrl !== "string" || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(projectUrl)) return null;
  return `${projectUrl.replace(/\/$/, "")}/functions/v1/${SWEEPER_FUNCTION}`;
}

/**
 * @param {{ projectUrl: string, status: { function_url?: string|null, pg_net_installed?: boolean, cron_job_active?: boolean, cron_schedule?: string|null } | null,
 *           health: { first?: { status?: number, outcome?: string }, replay?: { status?: number } } | null }} input
 */
export function evaluateSweeperReadiness({ projectUrl, status, health }) {
  const reasons = [];
  const expected = expectedSweeperUrl(projectUrl);
  if (!expected) reasons.push("PROJECT_URL_INVALID");
  if (!status) reasons.push("STATUS_UNREADABLE");
  else {
    if (!status.function_url) reasons.push("FUNCTION_URL_NOT_CONFIGURED");
    else if (expected && status.function_url !== expected) reasons.push("FUNCTION_URL_WRONG_PROJECT");
    if (status.pg_net_installed !== true) reasons.push("PG_NET_MISSING");
    if (status.cron_job_active !== true) reasons.push("CRON_JOB_INACTIVE_OR_MISSING");
    if (status.cron_job_active === true && !status.cron_schedule) reasons.push("CRON_SCHEDULE_MISSING");
  }
  if (!health?.first) reasons.push("HEALTH_NOT_RUN");
  else if (health.first.status === 404) reasons.push("FUNCTION_NOT_DEPLOYED");
  else if (health.first.status !== 200 || health.first.outcome !== "swept") reasons.push("HEALTH_SWEEP_FAILED");
  if (health?.first?.status === 200 && health.replay?.status !== 403) reasons.push("TICKET_REPLAY_NOT_REFUSED");
  return { ready: reasons.length === 0, reasons };
}
