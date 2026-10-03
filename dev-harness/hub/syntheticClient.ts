// NON-PRODUCTION HARNESS. An in-memory stand-in for the Supabase client: answers the hub's RPCs as the CURRENT synthetic
// identity (as a JWT would), with configurable delays, and records every call so the browser test can count them.
import { currentSyntheticUser } from "./syntheticAuth";

type Answer = { data: unknown; error: { code?: string; message: string } | null };
export const harness = {
  calls: [] as { fn: string; user: string | null; at: number }[],
  grantAnswers: [] as Answer[],
  granted: false,
  capabilityDelayMs: 800,
  grantDelayMs: 1500,
  /** user id → may review_close on c1 */
  reviewers: new Set<string>(["owner-a"]),
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const supabase = {
  async rpc(fn: string, args: Record<string, unknown>): Promise<Answer> {
    const user = currentSyntheticUser()?.id ?? null;
    harness.calls.push({ fn, user, at: Date.now() });
    if (fn === "get_my_workspace_capabilities") {
      await wait(harness.capabilityDelayMs);
      if (!user) return { data: null, error: { code: "42501", message: "not signed in" } };
      const reviewer = harness.reviewers.has(user);
      const caps = reviewer ? ["review_close", "prepare_close"] : ["prepare_close"];
      return { data: { access: true, capabilities: caps, allowed: caps, has_current_plan: true, manage_billing: reviewer }, error: null };
    }
    if (fn === "grant_engagement_capability") {
      await wait(harness.grantDelayMs);
      const answer: Answer = !user || !harness.reviewers.has(user)
        ? { data: null, error: { code: "42501", message: "not authorised" } }
        : harness.granted ? { data: null, error: { code: "23001", message: "already granted" } } : { data: { ok: true }, error: null };
      if (!answer.error) harness.granted = true;
      harness.grantAnswers.push(answer);
      return answer;
    }
    if (fn === "fold_engagement_mandate") {
      return { data: [{ capability: "TAX_COMPUTATION", granted: true }, { capability: "FINANCIAL_STATEMENTS", granted: harness.granted }], error: null };
    }
    return { data: null, error: { code: "42883", message: `synthetic backend has no ${fn} (args: ${Object.keys(args).join(",")})` } };
  },
};
