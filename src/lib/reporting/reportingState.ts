// reporting/reportingState.ts — ONE reader of every server state the reporting next action depends on (composition, notes,
// comparatives, saved versions with the latest version's readiness, and the Close Review findings summary). Used by the
// reporting workbench, the workspace shell and the Overview, so all three name the same next action. Reads only.

import { compositionClient, type CompositionResult } from "@/lib/statements/composition";
import { notesClient, type NotesStatusResult } from "@/lib/notes/notesStatus";
import { comparativesClient, type ComparativeStatus } from "@/lib/comparatives/comparatives";
import { signoffClient, type ReportingDb, type SavedVersion } from "./signoff";
import type { FindingsSummary } from "@/lib/closeReview/findings";
import { nextReportingAction, type NextAction } from "./nextAction";

export interface ReportingSnapshot {
  readonly composition: CompositionResult | null;
  readonly notes: NotesStatusResult | null;
  readonly comparatives: ComparativeStatus | { state: string } | null;
  readonly versions: readonly SavedVersion[];
  readonly latest: { readonly version: SavedVersion; readonly blockers: readonly string[]; readonly ready: boolean } | null;
  /** close_review_findings_summary; null when it could not be read (the version's own blockers still apply). */
  readonly closeReview: FindingsSummary | null;
}

export function reportingClients(db: ReportingDb) {
  return { composition: compositionClient(db), notes: notesClient(db), comparatives: comparativesClient(db), signoff: signoffClient(db) };
}

export async function readReportingSnapshot(db: ReportingDb, clients: ReturnType<typeof reportingClients>, companyId: string, periodYear: number): Promise<ReportingSnapshot> {
  const [composition, notes, comparatives, versions, closeReview] = await Promise.all([
    clients.composition.compose(companyId, periodYear), clients.notes.status(companyId, periodYear),
    clients.comparatives.status(companyId, periodYear), clients.signoff.versions(companyId, periodYear).catch(() => [] as SavedVersion[]),
    Promise.resolve(db.rpc("close_review_findings_summary", { p_company_id: companyId, p_period_year: periodYear }))
      .then((r) => (r.error ? null : (r.data as FindingsSummary)), () => null),
  ]);
  const last = [...versions].filter((v) => v.isLatest).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
  const r = last ? await clients.signoff.readiness(companyId, last.reportId, last.reportVersion) : null;
  return { composition, notes, comparatives, versions, closeReview, latest: last && r ? { version: last, blockers: r.blockers, ready: r.ready } : null };
}

/** The one next action for a snapshot, for the caller's server-reported capabilities. */
export function nextActionFor(s: ReportingSnapshot, allowed: readonly string[]): NextAction {
  return nextReportingAction({
    composition: s.composition, notes: s.notes, comparatives: s.comparatives, allowed, closeReview: s.closeReview ?? undefined,
    latest: s.latest ? { reportVersion: s.latest.version.reportVersion, state: s.latest.version.state, blockers: s.latest.blockers } : null,
  });
}
