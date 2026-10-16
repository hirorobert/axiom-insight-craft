/**
 * processingInvoke.test.ts — the browser's one way to start process-trial-balance: a busy refusal is retried as the SAME
 * request, bounded, with backoff and jitter; nothing else is retried. Every browser caller uses it (asserted below).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUSY_RETRY, busyDelayMs, invokeProcessing, type FunctionsClient } from "./processingInvoke";
import { classifyCheckAnswer } from "@/lib/ingestion/uploadFlow";

const REPO = path.resolve(__dirname, "../../..");
const answer = (status: number, body: Record<string, unknown> | null, retryAfter?: string) => ({
  data: null,
  error: { context: { status, json: async () => body, headers: { get: (k: string) => (k === "retry-after" ? retryAfter ?? null : null) } } },
});
const BUSY = { status: "busy", code: "PROCESSING_BUSY", message: "Another trial balance is being checked right now." };

function client(script: ReturnType<typeof answer>[] | ((n: number) => ReturnType<typeof answer>)) {
  const calls: unknown[] = [];
  const c: FunctionsClient = { functions: { invoke: async (_name, opts) => {
    calls.push(opts.body);
    const n = calls.length - 1;
    return typeof script === "function" ? script(n) : (script[n] ?? { data: {}, error: null });
  } } };
  return { c, calls };
}
const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("invokeProcessing", () => {
  it("success at once: one call, no retry", async () => {
    const { c, calls } = client([{ data: {}, error: null } as never]);
    expect(await invokeProcessing(c, { uploadId: "u", clientRequestId: "r" }, noSleep)).toMatchObject({ httpStatus: 200, error: null, busyRetries: 0 });
    expect(calls).toHaveLength(1);
  });

  it("busy, busy, then processed: retried as the SAME request (same upload and request id)", async () => {
    const { c, calls } = client([answer(503, BUSY, "3"), answer(503, BUSY, "3"), { data: {}, error: null } as never]);
    const delays: number[] = [];
    const r = await invokeProcessing(c, { uploadId: "u1", clientRequestId: "req-1" }, { ...noSleep, sleep: async (ms) => { delays.push(ms); } });
    expect(r).toMatchObject({ httpStatus: 200, busyRetries: 2 });
    expect(calls).toEqual([{ uploadId: "u1", clientRequestId: "req-1" }, { uploadId: "u1", clientRequestId: "req-1" }, { uploadId: "u1", clientRequestId: "req-1" }]);
    expect(delays).toEqual([2250, 4500]); // 3 s then 6 s steps, equal jitter at random()=0.5
  });

  it("bounded: after the attempts are used up the busy answer is returned for the caller's existing message", async () => {
    const { c, calls } = client(() => answer(503, BUSY, "3"));
    const r = await invokeProcessing(c, { uploadId: "u", clientRequestId: "r" }, noSleep);
    expect(calls).toHaveLength(BUSY_RETRY.attempts);
    expect(r).toMatchObject({ httpStatus: 503, busyRetries: BUSY_RETRY.attempts - 1 });
    const outcome = classifyCheckAnswer({ httpStatus: r.httpStatus, body: r.body });
    expect(outcome).toMatchObject({ kind: "failed", failure: { retry: "same_request", fileSaved: true } });
  });

  it("nothing else is retried: a 500, a 409 in progress, a 402 and a 503 without the busy code are returned at once", async () => {
    for (const a of [answer(500, { status: "processing_unavailable" }), answer(409, { status: "in_progress" }), answer(402, { code: "ENTITLEMENT_REQUIRED" }), answer(503, { code: "PROCESSING_HELD" })]) {
      const { c, calls } = client([a]);
      await invokeProcessing(c, { uploadId: "u", clientRequestId: "r" }, noSleep);
      expect(calls).toHaveLength(1);
    }
  });

  it("no retry storm: delays grow, are capped, and are spread by jitter (never zero, never identical across browsers)", () => {
    const lows = [0, 1, 2, 3, 4].map((i) => busyDelayMs(i, 3000, () => 0));
    const highs = [0, 1, 2, 3, 4].map((i) => busyDelayMs(i, 3000, () => 0.999));
    expect(lows).toEqual([1500, 3000, 6000, 7500, 7500]);
    expect(highs.every((h, i) => h > lows[i] && h <= BUSY_RETRY.capMs)).toBe(true);
    // The worst case before the caller's message: the sum of the retried waits.
    const worst = [0, 1, 2].reduce((t, i) => t + busyDelayMs(i, 3000, () => 1), 0);
    expect(worst).toBeLessThanOrEqual(21_000);
  });

  it("every browser caller of process-trial-balance goes through it", () => {
    const callers = ["src/components/workspace/FirstUpload.tsx", "src/components/TrialBalanceUpload.tsx", "src/lib/workspace/requestReprocess.ts", "src/pages/workspace/PrepareWorkspace.tsx"];
    for (const f of callers) {
      const src = fs.readFileSync(path.join(REPO, f), "utf8");
      expect(src, f).toContain("invokeProcessing(");
      expect(src, f).not.toMatch(/functions\.invoke\("process-trial-balance"/);
    }
    const all = fs.readdirSync(path.join(REPO, "src"), { recursive: true }) as string[];
    const direct = all.filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && !f.endsWith("processingInvoke.ts"))
      .filter((f) => /invoke\("process-trial-balance"/.test(fs.readFileSync(path.join(REPO, "src", f), "utf8")));
    expect(direct).toEqual([]);
  });
});
