/** Types and small helpers shared by the reporting workbench pages (no server calls of its own). */
import { useRef } from "react";
import type { WorkbenchPageId } from "@/lib/workbench/routes";
import type { compositionClient, CompositionResult } from "@/lib/statements/composition";
import type { notesClient, NotesStatusResult } from "@/lib/notes/notesStatus";
import type { comparativesClient, ComparativeStatus } from "@/lib/comparatives/comparatives";
import type { ReportingDb, SavedVersion, signoffClient } from "@/lib/reporting/signoff";

export type ReportingPage = Extract<WorkbenchPageId, "fs-statements" | "fs-notes" | "fs-schedules" | "fs-comparatives" | "signoff" | "exports">;

export interface ReportingProps {
  readonly page: ReportingPage;
  readonly companyId: string;
  readonly periodYear: number;
  readonly legalName: string;
  readonly db: ReportingDb;
  /** The caller's server-reported capabilities (display hints; the server still refuses every unauthorised write). */
  readonly allowed: readonly string[];
  /** The selected report version from the `v` query parameter (context preservation). */
  readonly reportVersion: number | null;
  readonly hrefFor: (page: ReportingPage, reportVersion: number | null) => string;
  readonly newRequestId?: () => string;
}

export interface ReportingState {
  readonly composition: CompositionResult | null;
  readonly notes: NotesStatusResult | null;
  readonly comparatives: ComparativeStatus | { state: string } | null;
  readonly versions: readonly SavedVersion[];
  readonly latest: { readonly version: SavedVersion; readonly blockers: readonly string[]; readonly ready: boolean } | null;
}

export type Clients = { composition: ReturnType<typeof compositionClient>; notes: ReturnType<typeof notesClient>; comparatives: ReturnType<typeof comparativesClient>; signoff: ReturnType<typeof signoffClient> };
export type PageProps = ReportingProps & { state: ReportingState; clients: Clients; refresh: () => Promise<void> };

/** A stable request id per attempt: a retry of the same attempt replays, a changed attempt gets a new id. */
export function useAttempt(newId?: () => string) {
  const pending = useRef<{ key: string; id: string } | null>(null);
  const make = newId ?? (() => crypto.randomUUID());
  return {
    idFor: (key: string) => { if (!pending.current || pending.current.key !== key) pending.current = { key, id: make() }; return pending.current.id; },
    done: () => { pending.current = null; },
  };
}

/** Plain words for the server's write outcomes; anything unknown is shown as returned. */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  recorded: "Recorded.", unchanged: "Nothing changed — the server already holds this.", forbidden: "Your role cannot do this; nothing was recorded.",
  feature_disabled: "Financial statements are not enabled for this company.", invalid_request: "The request was not valid; nothing was recorded.",
  request_reused: "This request was already used for something else; nothing was recorded.", stale: "Something changed; reload and try again.",
  framework_not_ifrs_for_smes: "This company does not report under the IFRS for SMEs.", unknown_line: "That presentation line does not exist.",
  not_decidable: "This requirement always applies; there is nothing to decide.", not_a_disclosure: "This requirement takes no wording.",
  unknown_schedule: "That schedule does not exist.", invalid_schedule: "The schedule was refused; nothing was recorded.",
  unbalanced: "The restatement does not balance; nothing was recorded.", invalid_lines: "A restatement line is not on the comparative statements.",
  comparative_not_available: "There is no comparative to restate or bridge.", not_found: "That record does not exist.",
  not_pending: "That restatement has already been decided.", self_decision_not_allowed: "The person who proposed a restatement cannot decide it.",
  not_approvable: "The comparatives cannot be approved in their current state.", not_approved: "There is no approval to withdraw.",
};
/** The server's own detail is kept: the problems of a refused schedule, the difference of an unbalanced restatement. */
export const outcomeText = (r: { outcome: string; [k: string]: unknown }) => {
  const base = OUTCOME_WORDS[r.outcome] ?? `The server answered: ${r.outcome}.`;
  if (Array.isArray(r.problems)) return `${base} ${(r.problems as unknown[]).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ")}`;
  if (typeof r.differenceMinor === "string") return `${base} Difference ${r.differenceMinor} (minor units).`;
  if (typeof r.state === "string" && r.outcome === "not_approvable") return `${base} (${r.state})`;
  return base;
};

export function Notice({ text }: { text: string | null }) {
  return text ? <p role="status" aria-live="polite" className="text-sm" data-testid="notice">{text}</p> : null;
}
