/**
 * admission — controlled admission for a CPU-heavy Edge Function (repair A follow-up, 16 October 2026).
 *
 * The Edge Runtime limits CPU time per isolate, summed over the requests that isolate serves. Measured on the local runtime
 * (CI run 38892294850, runtime log): an isolate running two 2,000-account checks at once reached its soft CPU limit, and
 * requests queued in that isolate then ran there and hit the hard limit (HTTP 546 WORKER_LIMIT) — leaving their attempts
 * leased. So process-trial-balance admits ONE check per isolate and queues nothing (`createAdmission(1, 0)`): a request
 * arriving meanwhile is refused at once, before anything begins, and the caller retries the same request.
 */

export interface Admission {
  /** Resolves to a release function, or null when no slot freed within the wait bound. */
  acquire(): Promise<(() => void) | null>;
  /** For tests and logs. */
  readonly state: () => { active: number; waiting: number };
}

export function createAdmission(limit: number, maxWaitMs: number): Admission {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("admission limit must be a positive integer");
  let active = 0;
  const waiting: { grant: () => void }[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next.grant(); // the slot passes straight to the next waiter (active unchanged)
    else active--;
  };
  const once = () => { let done = false; return () => { if (!done) { done = true; release(); } }; };
  return {
    acquire() {
      if (active < limit) { active++; return Promise.resolve(once()); }
      if (maxWaitMs <= 0) return Promise.resolve(null); // never queue: refuse at once
      return new Promise((resolve) => {
        const entry = { grant: () => { clearTimeout(timer); resolve(once()); } };
        const timer = setTimeout(() => {
          const i = waiting.indexOf(entry);
          if (i >= 0) { waiting.splice(i, 1); resolve(null); }
        }, maxWaitMs);
        waiting.push(entry);
      });
    },
    state: () => ({ active, waiting: waiting.length }),
  };
}

/** Wraps a handler: OPTIONS passes straight through; everything else holds a slot for its whole duration. */
export function withAdmission(
  admission: Admission,
  busy: () => Response,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return handler(req);
    const release = await admission.acquire();
    if (!release) return busy();
    try { return await handler(req); } finally { release(); }
  };
}
