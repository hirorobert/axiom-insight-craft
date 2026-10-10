/**
 * Outbound provider HTTP: one timeout per attempt and a bounded number of attempts.
 *
 * A retry is attempted ONLY where repeating the request cannot create a second charge — the caller says so by passing
 * attempts > 1 (Snippe: the same Idempotency-Key; Polar: a checkout session that is never handed to anyone cannot be
 * paid). Any other failure is reported, never retried silently. The outcome distinguishes "the provider answered"
 * (status + body) from "no answer" (network error or timeout): the latter is UNCERTAIN to the caller.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpOutcome =
  | { answered: true; status: number; body: unknown }
  | { answered: false; error: 'TIMEOUT' | 'NETWORK' };

export async function requestJson(fetchImpl: FetchLike, url: string, init: RequestInit, opts: { timeoutMs: number; attempts: number }): Promise<HttpOutcome> {
  let last: HttpOutcome = { answered: false, error: 'NETWORK' };
  for (let attempt = 1; attempt <= Math.max(1, Math.min(opts.attempts, 3)); attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      const text = await res.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      // A 5xx is the provider failing to answer the question; retry when allowed, else report it as answered.
      if (res.status >= 500 && attempt < opts.attempts) { last = { answered: true, status: res.status, body }; continue; }
      return { answered: true, status: res.status, body };
    } catch (e) {
      last = { answered: false, error: (e as Error)?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/** SHA-256 hex of a string (payload_hash evidence). */
export async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
