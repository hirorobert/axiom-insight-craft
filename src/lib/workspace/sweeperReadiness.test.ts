/**
 * sweeperReadiness.test.ts: the fail-closed release control for the trial balance source sweeper
 * (scripts/ci/sweeperReadiness.mjs). READY only when every condition holds; every gap is a named reason.
 */
import { describe, expect, it } from "vitest";
import { evaluateSweeperReadiness, expectedSweeperUrl } from "../../../scripts/ci/sweeperReadiness.mjs";

const PROJECT = "https://hplriydtdelehepgttul.supabase.co";
const URL_OK = `${PROJECT}/functions/v1/trial-balance-source-sweeper`;
const good = () => ({
  projectUrl: PROJECT,
  status: { function_url: URL_OK, pg_net_installed: true, cron_job_active: true, cron_schedule: "*/5 * * * *" },
  health: { first: { status: 200, outcome: "swept" }, replay: { status: 403 } },
});

describe("sweeper readiness", () => {
  it("READY only when configured for THIS project, scheduled, deployed, healthy and single-use", () => {
    expect(evaluateSweeperReadiness(good())).toEqual({ ready: true, reasons: [] });
  });
  it("the expected URL is project-specific; anything but a supabase.co project URL is invalid", () => {
    expect(expectedSweeperUrl(`${PROJECT}/`)).toBe(URL_OK);
    expect(expectedSweeperUrl("http://evil.example")).toBeNull();
    expect(evaluateSweeperReadiness({ ...good(), projectUrl: "nope" }).reasons).toContain("PROJECT_URL_INVALID");
  });
  it.each([
    ["no configured URL", (g: ReturnType<typeof good>) => { g.status.function_url = null as never; }, "FUNCTION_URL_NOT_CONFIGURED"],
    ["another project's URL", (g: ReturnType<typeof good>) => { g.status.function_url = "https://bvyivmmfjejbmqoydezk.supabase.co/functions/v1/trial-balance-source-sweeper"; }, "FUNCTION_URL_WRONG_PROJECT"],
    ["pg_net missing", (g: ReturnType<typeof good>) => { g.status.pg_net_installed = false; }, "PG_NET_MISSING"],
    ["cron inactive", (g: ReturnType<typeof good>) => { g.status.cron_job_active = false; }, "CRON_JOB_INACTIVE_OR_MISSING"],
    ["function not deployed", (g: ReturnType<typeof good>) => { g.health.first = { status: 404, outcome: undefined as never }; }, "FUNCTION_NOT_DEPLOYED"],
    ["health sweep failed", (g: ReturnType<typeof good>) => { g.health.first = { status: 500, outcome: "sweep_failed" }; }, "HEALTH_SWEEP_FAILED"],
    ["ticket replay accepted", (g: ReturnType<typeof good>) => { g.health.replay = { status: 200 }; }, "TICKET_REPLAY_NOT_REFUSED"],
  ])("NOT READY: %s", (_n, mutate, reason) => {
    const g = good(); mutate(g);
    const r = evaluateSweeperReadiness(g);
    expect(r.ready).toBe(false);
    expect(r.reasons).toContain(reason);
  });
  it("an unreadable status or a health check that never ran is NOT READY, never assumed", () => {
    expect(evaluateSweeperReadiness({ ...good(), status: null }).reasons).toContain("STATUS_UNREADABLE");
    expect(evaluateSweeperReadiness({ ...good(), health: null }).reasons).toContain("HEALTH_NOT_RUN");
  });
});
