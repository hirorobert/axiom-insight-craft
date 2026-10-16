/**
 * admission — controlled admission for a memory-heavy Edge Function (repair A follow-up, 16 October 2026).
 *
 * Concurrent requests served by one worker share its memory. Measured on the local Edge Runtime (CI, PR #141): two
 * simultaneous 2,000-account trial balances are processed in full; four exceed the worker's resource limit (HTTP 546
 * WORKER_LIMIT), and a request killed that way leaves its processing attempt leased (600 s) — a retry is answered
 * "in progress" until the lease frees it.
 *
 * So at most `limit` requests run at once per worker; the others wait in arrival order for at most `maxWaitMs`. A request
 * still waiting then is refused BEFORE it begins anything (no attempt, no lease, nothing recorded or consumed) and the
 * caller retries the same request later. Each worker counts only its own requests; separate workers have separate memory.
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

/**
 * Admission across workers: one of the database's leased processing slots (tb_processing_slots, 20261107100000), polled
 * until `maxWaitMs`. An error from the database counts as busy (the caller retries; nothing has begun).
 */
export function createSlotAdmission(
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
  opts: { maxWaitMs: number; pollMs: number; leaseSeconds: number },
): Admission {
  let active = 0;
  return {
    async acquire() {
      const holder = crypto.randomUUID();
      const deadline = Date.now() + opts.maxWaitMs;
      for (;;) {
        const { data, error } = await rpc("tb_acquire_processing_slot", { p_holder: holder, p_lease_seconds: opts.leaseSeconds });
        if (!error && typeof data === "number") {
          active++;
          let done = false;
          return () => {
            if (done) return;
            done = true; active--;
            rpc("tb_release_processing_slot", { p_holder: holder }).catch(() => { /* the lease frees it */ });
          };
        }
        if (Date.now() + opts.pollMs > deadline) return null;
        await new Promise((r) => setTimeout(r, opts.pollMs));
      }
    },
    state: () => ({ active, waiting: 0 }),
  };
}

/** Both: a slot in this worker, then one shared by every worker. */
export function combineAdmissions(first: Admission, second: Admission): Admission {
  return {
    async acquire() {
      const a = await first.acquire();
      if (!a) return null;
      const b = await second.acquire();
      if (!b) { a(); return null; }
      return () => { b(); a(); };
    },
    state: () => first.state(),
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
