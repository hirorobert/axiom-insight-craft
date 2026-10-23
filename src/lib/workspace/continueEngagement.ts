/**
 * continueEngagement — which accessible, unfinished engagement the account home offers as "Continue where you left off".
 *
 * Pure. Only engagements that actually exist (server-listed) and whose persisted workspace state is known are eligible;
 * a trial balance already passed or signed is not "unfinished". The most recently opened wins (server opened_at), ties
 * keep the server's order. Nothing is inferred from route visits or browser storage.
 */
import type { WorkspaceState } from "./types";

export interface ContinueCandidate {
  engagementId: string;
  companyId: string;
  companyName: string;
  periodYear: number;
  workspaceState?: WorkspaceState;
}

export function pickContinueEngagement<T extends ContinueCandidate>(entries: readonly T[], openedAt: Readonly<Record<string, string>> = {}): T | null {
  const open = entries.filter((e) => {
    const s = e.workspaceState?.missions.prepare.status;
    return !!s && s !== "passed" && s !== "signed" && s !== "not_applicable";
  });
  if (open.length === 0) return null;
  return open.reduce((best, e) => ((openedAt[e.engagementId] ?? "") > (openedAt[best.engagementId] ?? "") ? e : best), open[0]);
}
