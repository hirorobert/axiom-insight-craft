// Scheduled, server-only sweep of trial balance source objects (PR #32, 20260923120000).
//
// Pure orchestration with injected dependencies. It is unit-tested in Node (src/lib/workspace/sourceSweeper.test.ts)
// and runs unchanged in the trial-balance-source-sweeper Edge Function. The rules:
//   * The request carries ONE thing: a single-use ticket minted by the database (tbu_run_source_sweeper, called
//     by pg_cron). It is redeemed before anything else happens; anything else in the body is refused. No user,
//     path, workspace or bucket is ever read from the request.
//   * What may be deleted comes only from tbu_sweeper_candidates(): terminal discards (undo window over), cancelled
//     replacements whose cleanup never finished, and objects left by reservations that expired unconsumed.
//     delete_object is true only for an existing object that no upload row references.
//   * Each object is deleted, then verified absent, and only then is completion recorded
//     (tbu_sweeper_complete), which re-checks every rule and re-reads storage.objects itself. A failure leaves the
//     item pending for the next sweep; every step is idempotent.

const TICKET = /^[0-9a-f]{64}$/;
export const SWEEP_BATCH = 100;

export type SweepKind = "discard" | "cancel_replacement" | "reservation";

export interface SweepCandidate {
  kind: SweepKind;
  target_id: string;
  object_path: string | null;
  delete_object: boolean;
}

export interface SweeperDeps {
  redeemTicket(ticket: string): Promise<boolean>;
  listCandidates(limit: number): Promise<SweepCandidate[]>;
  /** Service-role Storage removal of exactly this object. */
  removeObject(path: string): Promise<boolean>;
  /** Server-read presence in storage.objects; null when it could not be read. */
  objectExists(path: string): Promise<boolean | null>;
  complete(kind: SweepKind, targetId: string): Promise<string | null>;
}

export interface SweepTally {
  purged: number;
  completed: number;
  reclaimed: number;
  pending: number;
  skipped: number;
  failed: number;
}

export interface SweepResult {
  status: number;
  outcome: "swept" | "forbidden" | "invalid_request" | "sweep_failed";
  tally?: SweepTally;
}

export function parseSweeperRequest(body: unknown): { ticket: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "ticket") return null;
  const t = (body as Record<string, unknown>).ticket;
  return typeof t === "string" && TICKET.test(t) ? { ticket: t } : null;
}

const safePath = (p: string) => p.length > 0 && !p.startsWith("/") && !p.includes("..");

export async function runSourceSweep(deps: SweeperDeps, ticket: string): Promise<SweepResult> {
  if (!(await deps.redeemTicket(ticket))) return { status: 403, outcome: "forbidden" };

  let candidates: SweepCandidate[];
  try {
    candidates = await deps.listCandidates(SWEEP_BATCH);
  } catch {
    return { status: 500, outcome: "sweep_failed" };
  }

  const tally: SweepTally = { purged: 0, completed: 0, reclaimed: 0, pending: 0, skipped: 0, failed: 0 };
  for (const c of candidates) {
    try {
      if (c.delete_object) {
        if (!c.object_path || !safePath(c.object_path)) { tally.skipped++; continue; }
        if (!(await deps.removeObject(c.object_path))) { tally.pending++; continue; }
        if ((await deps.objectExists(c.object_path)) !== false) { tally.pending++; continue; }
      }
      const outcome = await deps.complete(c.kind, c.target_id);
      if (outcome === "purged") tally.purged++;
      else if (outcome === "completed") tally.completed++;
      else if (outcome === "reclaimed") tally.reclaimed++;
      else if (outcome === "storage_cleanup_pending") tally.pending++;
      else if (outcome === "already_done" || outcome === "not_eligible" || outcome === "stale") tally.skipped++;
      else tally.failed++;
    } catch {
      tally.failed++;
    }
  }
  return { status: 200, outcome: "swept", tally };
}
