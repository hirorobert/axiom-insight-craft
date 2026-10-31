// Bounded checkpoints for the deterministic multi-session proofs (re-review of #229, finding 3 harness).
//
// A proof that parks code under test at a boundary and then waits for it must never be able to hang: a wait that is not satisfied, an operation that finishes
// before it reaches the boundary, a callback that is never called, and an error thrown on the way are all FAILURES OF THE PROOF'S CASE, reported with a code and a
// message, never a stuck process. Every wait here has a deadline. Cleanup is registered in a Scope and always runs, releasing barriers and closing resources.

export const DEFAULT_DEADLINE_MS = 10_000;

/** A structured failure of a case. `code` is one of: checkpoint_timeout | operation_completed_early | operation_threw | condition_timeout | operation_timeout | case_deadline. */
export class HarnessFailure extends Error {
  constructor(code, message, cause) { super(message); this.name = "HarnessFailure"; this.code = code; this.cause = cause; }
}

/** A named point that the code under test reaches by calling hit(); hit() then parks until release(). */
export function checkpoint(name) {
  let reach, release, hits = 0;
  const reached = new Promise((r) => { reach = r; });
  const released = new Promise((r) => { release = r; });
  return { name, reached, released, release: () => release(), get hits() { return hits; }, hit: async (info) => { hits++; reach(info); await released; } };
}

const settle = (op) => Promise.resolve(op).then((value) => ({ kind: "value", value }), (error) => ({ kind: "error", error }));
const brief = (v) => { try { return JSON.stringify(v)?.slice(0, 200); } catch { return String(v); } };

/**
 * Wait, bounded, until `cp` is reached. Fails (structurally) if `op` settles first - completed early, or threw - or if the deadline passes (the callback was
 * never called). Returns what the code passed to hit().
 */
export async function awaitCheckpoint(cp, op, { deadlineMs = DEFAULT_DEADLINE_MS, what = "operation" } = {}) {
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r({ kind: "timeout" }), deadlineMs); });
  try {
    const first = await Promise.race([cp.reached.then((info) => ({ kind: "reached", info })), settle(op), timeout]);
    if (first.kind === "reached") return first.info;
    if (first.kind === "timeout") throw new HarnessFailure("checkpoint_timeout", `${what}: checkpoint "${cp.name}" was not reached within ${deadlineMs} ms (callback never called, or the code hung)`);
    if (first.kind === "error") throw new HarnessFailure("operation_threw", `${what}: threw before reaching checkpoint "${cp.name}": ${first.error?.message ?? first.error}`, first.error);
    throw new HarnessFailure("operation_completed_early", `${what}: completed (${brief(first.value)}) before reaching checkpoint "${cp.name}"`);
  } finally { clearTimeout(timer); }
}

/**
 * Poll `condition` (async, truthy when satisfied) until it holds, bounded. `op` is the operation whose progress is awaited: if it settles first the wait fails
 * with operation_completed_early / operation_threw, unless allowSettle is true (then settling ends the wait with `false`).
 */
export async function awaitCondition(what, condition, op, { deadlineMs = DEFAULT_DEADLINE_MS, intervalMs = 15, allowSettle = false } = {}) {
  let settled = null;
  if (op) settle(op).then((s) => { settled = s; });
  const t0 = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (settled) {
      if (allowSettle) return false;
      if (settled.kind === "error") throw new HarnessFailure("operation_threw", `${what}: the operation threw while waiting: ${settled.error?.message ?? settled.error}`, settled.error);
      throw new HarnessFailure("operation_completed_early", `${what}: the operation completed (${brief(settled.value)}) instead of reaching the awaited state`);
    }
    if (Date.now() - t0 > deadlineMs) throw new HarnessFailure("condition_timeout", `${what}: not satisfied within ${deadlineMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** LIFO cleanup. Every registered step runs even when an earlier one throws; the errors are collected, never rethrown from close(). */
export class Scope {
  #steps = [];
  defer(fn) { this.#steps.push(fn); return fn; }
  async close() {
    const errors = [];
    while (this.#steps.length) { const fn = this.#steps.pop(); try { await fn(); } catch (e) { errors.push(e); } }
    return errors;
  }
}

/** Run a case body against a deadline; the scope is closed whatever happens, and a body still running after the deadline is cut off by its cleanup. */
export async function runCase(fn, { deadlineMs = 60_000 } = {}) {
  const scope = new Scope();
  let timer;
  const body = Promise.resolve().then(() => fn(scope));
  body.catch(() => {});                                   // a body abandoned at the deadline must not become an unhandled rejection
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new HarnessFailure("case_deadline", `the case did not finish within ${deadlineMs} ms`)), deadlineMs); });
  try { await Promise.race([body, deadline]); }
  finally { clearTimeout(timer); const errors = await scope.close(); if (errors.length) console.error("cleanup errors:", errors.map((e) => e?.message ?? e).join("; ")); }
}

/** Await `promise` for at most `ms`; a promise that does not settle in time is an operation_timeout failure rather than a hang. */
export async function withDeadline(promise, what, ms = DEFAULT_DEADLINE_MS) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new HarnessFailure("operation_timeout", `${what}: did not finish within ${ms} ms`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
