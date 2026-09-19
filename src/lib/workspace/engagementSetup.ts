/**
 * engagementSetup — idempotent, convergent creation of a workspace's engagement scope.
 *
 * The database has no uniqueness constraint on "one open engagement per period", and this task adds no migration, so
 * convergence is enforced here, deterministically:
 *
 *   1. authorise (only owner / partner / manager may open or amend scope — the server enforces this too);
 *   2. find the reporting period (earliest wins if a race created two) or create it;
 *   3. reuse the open engagement if one exists, otherwise create one;
 *   4. re-read every open engagement for the period. The EARLIEST (opened_at, then id) is the engagement of record.
 *      If ours lost a concurrent race it is closed, and everything continues on the winner;
 *   5. grant only the capabilities not already granted; an "already part of this engagement" refusal is success.
 *
 * A repeated click, a retry and two concurrent requests therefore converge on ONE engagement with ONE grant per
 * capability. All I/O goes through `EngagementPort`, so the invariants are unit-tested against an in-memory fake.
 */

import type { EngagementCapability } from "./mandate";

export const SENIOR_ROLES = ["owner", "partner", "manager"] as const;

export interface OpenEngagementRow {
  readonly id: string;
  readonly opened_at: string;
}

export interface EngagementPort {
  memberOf(companyId: string): Promise<{ id: string; role: string } | null>;
  /** Periods for the company and year, any order. */
  periodsFor(companyId: string, year: number): Promise<readonly { id: string; created_at: string }[]>;
  createPeriod(companyId: string, year: number): Promise<{ id: string }>;
  openEngagements(periodId: string): Promise<readonly OpenEngagementRow[]>;
  createEngagement(periodId: string, companyId: string, memberId: string, engagementType: string): Promise<{ id: string }>;
  closeEngagement(engagementId: string): Promise<void>;
  granted(engagementId: string): Promise<readonly EngagementCapability[]>;
  grant(engagementId: string, capability: EngagementCapability, reason: string): Promise<void>;
}

export class EngagementSetupError extends Error {
  constructor(readonly kind: "NOT_A_MEMBER" | "NOT_AUTHORISED" | "NO_SERVICE_SELECTED", message: string) {
    super(message);
    this.name = "EngagementSetupError";
  }
}

/** Deterministic order: earliest opened first; the id breaks an exact tie. */
export const byEarliest = (a: OpenEngagementRow, b: OpenEngagementRow) => (a.opened_at < b.opened_at ? -1 : a.opened_at > b.opened_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const isAlreadyGranted = (e: unknown) => /already part of this engagement|restrict_violation|23001/i.test(`${(e as { message?: string })?.message ?? ""} ${(e as { code?: string })?.code ?? ""}`);

export async function openEngagementWithScope(
  port: EngagementPort,
  input: { companyId: string; year: number; capabilities: readonly EngagementCapability[]; engagementType?: string; reason?: string },
): Promise<{ engagementId: string; granted: readonly EngagementCapability[] }> {
  const wanted = [...new Set(input.capabilities)];
  if (wanted.length === 0) throw new EngagementSetupError("NO_SERVICE_SELECTED", "Choose at least one service.");

  const member = await port.memberOf(input.companyId);
  if (!member) throw new EngagementSetupError("NOT_A_MEMBER", "You are not an accepted member of this workspace.");
  if (!(SENIOR_ROLES as readonly string[]).includes(member.role)) throw new EngagementSetupError("NOT_AUTHORISED", "Only an owner, partner or manager can choose the services for a workspace.");

  let periods = await port.periodsFor(input.companyId, input.year);
  if (periods.length === 0) {
    await port.createPeriod(input.companyId, input.year);
    periods = await port.periodsFor(input.companyId, input.year); // re-read: a concurrent creator may have won
  }
  const period = [...periods].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))[0];

  let open = [...(await port.openEngagements(period.id))].sort(byEarliest);
  let mine: string | null = null;
  if (open.length === 0) {
    mine = (await port.createEngagement(period.id, input.companyId, member.id, input.engagementType ?? "composite")).id;
    open = [...(await port.openEngagements(period.id))].sort(byEarliest);
  }
  const winner = open[0];
  if (mine && winner && mine !== winner.id) await port.closeEngagement(mine); // lost the race: converge on the earliest

  const engagementId = winner.id;
  const already = new Set(await port.granted(engagementId));
  for (const cap of wanted) {
    if (already.has(cap)) continue;
    try {
      await port.grant(engagementId, cap, input.reason ?? "Selected when the workspace was set up");
    } catch (e) {
      if (!isAlreadyGranted(e)) throw e; // a concurrent request granted it first — that is the state we wanted
    }
  }
  return { engagementId, granted: [...new Set(await port.granted(engagementId))] };
}
