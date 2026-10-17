/**
 * processingInvoke — the ONE way the browser starts process-trial-balance, with a bounded retry of PROCESSING_BUSY.
 *
 * The function runs one check per Edge Runtime isolate and refuses another at once (503 PROCESSING_BUSY, Retry-After)
 * before anything begins — no attempt, no lease, nothing recorded. That refusal is retried here as the SAME request
 * (same uploadId and clientRequestId, so it can never be counted twice), a bounded number of times, with exponential
 * backoff and jitter so that simultaneous browsers spread out instead of retrying together. Every other answer — success,
 * a refusal, an error — is returned at once, unchanged. When the attempts are used up the busy answer is returned and the
 * caller shows its existing "check again; it will not be counted twice" message.
 */

export interface ProcessingAnswer {
  httpStatus: number | null;
  body: Record<string, unknown> | null;
  /** The invoke error as returned by supabase-js (its response body has already been read into `body`). */
  error: unknown;
  /** How many busy refusals were retried. */
  busyRetries: number;
}

export interface FunctionsClient {
  functions: { invoke: (name: string, opts: { body: unknown }) => Promise<{ data: unknown; error: unknown }> };
}

export const BUSY_RETRY = Object.freeze({ attempts: 4, capMs: 15_000, defaultRetryAfterMs: 3_000 });

async function readAnswer(error: unknown): Promise<{ httpStatus: number | null; body: Record<string, unknown> | null; retryAfterMs: number | null }> {
  const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown>; headers?: { get?: (k: string) => string | null } } } | null)?.context;
  const httpStatus = typeof ctx?.status === "number" ? ctx.status : null;
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await ctx?.json?.();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch { body = null; }
  const header = Number(ctx?.headers?.get?.("retry-after"));
  return { httpStatus, body, retryAfterMs: Number.isFinite(header) && header > 0 ? Math.min(header * 1000, BUSY_RETRY.capMs) : null };
}

/** Exponential backoff with equal jitter: half the step fixed, half random — never zero, never synchronised. */
export function busyDelayMs(retry: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  const base = Math.min(BUSY_RETRY.capMs, (retryAfterMs ?? BUSY_RETRY.defaultRetryAfterMs) * 2 ** retry);
  return Math.round(base / 2 + random() * (base / 2));
}

export async function invokeProcessing(
  client: FunctionsClient,
  body: { uploadId: string; clientRequestId: string },
  deps: { sleep?: (ms: number) => Promise<void>; random?: () => number; onBusy?: (retry: number, delayMs: number) => void } = {},
): Promise<ProcessingAnswer> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const { error } = await client.functions.invoke("process-trial-balance", { body });
    if (!error) return { httpStatus: 200, body: null, error: null, busyRetries: attempt };
    const a = await readAnswer(error);
    const busy = a.httpStatus === 503 && a.body?.code === "PROCESSING_BUSY";
    if (!busy || attempt + 1 >= BUSY_RETRY.attempts) return { httpStatus: a.httpStatus, body: a.body, error, busyRetries: attempt };
    const delay = busyDelayMs(attempt, a.retryAfterMs, deps.random);
    deps.onBusy?.(attempt + 1, delay);
    await sleep(delay);
  }
}
