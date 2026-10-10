// reporting/nextAction.ts — the ONE next action of the reporting workbench, derived from the server's own states. Pure.
//
// Order follows the preparation journey and the dependency chain the server enforces: Close Review findings checked and
// resolved on the reviewed trial balance → statements compose → comparatives established → notes and schedules →
// cash-flow and equity evidence → a saved report version on the current dependencies → its blockers → REVIEWED → FINAL →
// export. Every input is a server payload; nothing is inferred beyond reading it, and an unknown state is named, never
// treated as done. Requirements are named by the framework pack's words; their identifiers stay in technical details.

import type { WorkbenchPageId } from "@/lib/workbench/routes";
import type { CompositionResult } from "@/lib/statements/composition";
import { needsWork, type NotesStatus, type NotesStatusResult } from "@/lib/notes/notesStatus";
import { COMPARATIVE_WORDS, type ComparativeStatus } from "@/lib/comparatives/comparatives";
import { blockerText } from "./blockers";
import type { FindingsSummary } from "@/lib/closeReview/findings";
import { namedList, requirementLabel } from "@/lib/notes/requirementLabels";

export interface NextAction {
  readonly page: WorkbenchPageId;
  readonly title: string;
  readonly detail: string;
  /** "done" only after FINAL; "blocked" when the action is someone else's (or the server's) to unblock. */
  readonly tone: "todo" | "blocked" | "done";
}

export interface NextActionInput {
  readonly composition: CompositionResult | null;
  readonly notes: NotesStatusResult | null;
  readonly comparatives: ComparativeStatus | { state: string } | null;
  /** The latest saved version of the report for this period, with the server's readiness for it. */
  readonly latest: { readonly reportVersion: number; readonly state: "DRAFT" | "REVIEWED" | "FINAL"; readonly blockers: readonly string[] } | null;
  readonly allowed: readonly string[];
  /**
   * The Close Review findings summary for this period (close_review_findings_summary). Findings are resolved before the
   * statements are prepared. Omitted (undefined) = not read: the version's own Close Review blockers still apply.
   */
  readonly closeReview?: FindingsSummary | null;
}

const NOT_COMPOSED: Record<string, string> = {
  unavailable: "Financial statements are not enabled for this company.",
  no_authority: "There is no reviewed trial balance for this year yet.",
  legacy_certification: "This year's trial balance was reviewed before exact amounts were recorded; review it again.",
  currency_unknown: "The trial balance has no currency recorded.",
  edition_unresolved: "The IFRS for SMEs edition cannot be decided: the period start is unknown, or early application is not confirmed.",
  invalid_request: "The request was not valid.",
};

const count = (blockers: readonly string[], prefix: string) => blockers.filter((b) => b.startsWith(prefix)).reduce((n, b) => n + (Number(b.split(":")[1]) || 1), 0);

export function nextReportingAction(i: NextActionInput): NextAction {
  // 1. Close Review: findings checked on the reviewed trial balance, blocking ones resolved — before statements.
  const cr = i.closeReview;
  const canPrepare = i.allowed.includes("prepare_close");
  if (cr && (cr.state === "not_generated" || cr.state === "stale"))
    return { page: "close-findings", title: cr.state === "stale" ? "Run the Close Review checks again" : "Run the Close Review checks",
      detail: cr.state === "stale" ? "The reviewed trial balance changed after the last check." : "Findings are checked on the reviewed trial balance before the statements are prepared.",
      tone: canPrepare ? "todo" : "blocked" };
  if (cr && cr.state === "current" && cr.unresolvedBlocking > 0)
    return { page: "close-findings", title: `Resolve ${cr.unresolvedBlocking} blocking finding${cr.unresolvedBlocking === 1 ? "" : "s"}`,
      detail: "Explain, accept or adjust each one in Close Review › Findings; adjustments are approved in Close Review › Adjustments.", tone: canPrepare ? "todo" : "blocked" };

  const c = i.composition;
  if (!c) return { page: "fs-statements", title: "Reading the statements", detail: "The composed statements have not been read yet.", tone: "blocked" };
  if (c.state !== "composed") return { page: "fs-statements", title: "Statements cannot be composed yet", detail: NOT_COMPOSED[c.state] ?? `The server reports ${c.state}.`, tone: "blocked" };

  const unassigned = count(c.blockers, "PRESENTATION_UNASSIGNED") + count(c.blockers, "PRESENTATION_INCOMPATIBLE") + count(c.blockers, "ACCOUNTS_NOT_PRESENTABLE");
  if (unassigned > 0) return { page: "fs-statements", title: `Assign ${unassigned} account${unassigned === 1 ? "" : "s"} to statement lines`, detail: "Every account must be on a compatible line before totals are shown.", tone: "todo" };
  if (c.blockers.includes("EXPENSE_ANALYSIS_MIXED")) return { page: "fs-statements", title: "Choose one expense analysis", detail: "Expenses are presented both by nature and by function; use one.", tone: "todo" };
  if (c.blockers.length > 0) return { page: "fs-statements", title: "The statements do not yet compose cleanly", detail: c.blockers.join("; "), tone: "blocked" };

  // 3. Comparatives are established early: a missing prior period is recovered (intake or an approved exception) first.
  const cmp = i.comparatives;
  if (!cmp || cmp.state !== "evaluated") return { page: "fs-comparatives", title: "Comparatives are not available", detail: cmp ? `The server reports ${cmp.state}.` : "The comparative status has not been read yet.", tone: "blocked" };
  const cs = (cmp as ComparativeStatus).comparative;
  if (!COMPARATIVE_WORDS[cs.state].satisfiesRequirement) {
    const canApprove = i.allowed.includes("review_close");
    return { page: "fs-comparatives", title: `Comparatives: ${COMPARATIVE_WORDS[cs.state].title}`, detail: COMPARATIVE_WORDS[cs.state].detail + (cs.state === "unapproved" && !canApprove ? " A reviewer approves them." : ""), tone: cs.state === "unapproved" && canApprove ? "todo" : cs.state === "unapproved" ? "blocked" : "todo" };
  }

  if (!i.notes || i.notes.state !== "evaluated") return { page: "fs-notes", title: "Notes are not available", detail: i.notes ? `The server reports ${i.notes.state}.` : "The notes status has not been read yet.", tone: "blocked" };
  const ns = i.notes as NotesStatus;
  const label = (id: string) => requirementLabel(ns.packId, id);
  const open = ns.requirements.filter((r) => r.blocking && needsWork(r));
  const schedules = open.filter((r) => r.kind === "SCHEDULE");
  const evidence = open.filter((r) => r.status === "evidence_missing");
  const unsupported = open.filter((r) => r.status === "unsupported");
  if (unsupported.length > 0) return { page: "fs-notes", title: "This report cannot be finalised: a reporting case is not supported", detail: namedList(unsupported.map((r) => label(r.requirementId))), tone: "blocked" };
  const notes = open.filter((r) => r.kind !== "SCHEDULE" && r.status !== "evidence_missing");
  // The Notes page counts every open blocking row it lists (evidence-held statements included); say how the two differ.
  const evidenceNote = evidence.length > 0 ? ` ${evidence.length} more need${evidence.length === 1 ? "s" : ""} cash-flow or equity evidence (Statements › Evidence).` : "";
  if (notes.length > 0) return { page: "fs-notes", title: `Complete ${notes.length} note requirement${notes.length === 1 ? "" : "s"}`, detail: `${namedList(notes.map((r) => label(r.requirementId)))}.${evidenceNote}`, tone: "todo" };
  if (schedules.length > 0) return { page: "fs-schedules", title: `Complete ${schedules.length} schedule${schedules.length === 1 ? "" : "s"}`, detail: `${namedList(schedules.map((r) => label(r.requirementId)))}.`, tone: "todo" };

  // Evidence is collected while preparing the statements (Statements › Evidence); Sign-off only summarises it.
  if (evidence.length > 0) return { page: "fs-statements", title: "Add the evidence for the cash-flow and equity statements", detail: `${namedList(evidence.map((r) => label(r.requirementId)))}.`, tone: "todo" };
  const l = i.latest;
  if (!l || l.blockers.some((b) => b === "REPORTING_DEPENDENCIES_STALE" || b === "REPORTING_DEPENDENCIES_UNBOUND"))
    return { page: "signoff", title: l ? "Save a new report version" : "Save the first report version", detail: l ? "Something changed since the latest version was saved." : "The statements, notes and comparatives are ready to be saved as a version.", tone: "todo" };
  if (l.state === "FINAL") return { page: "exports", title: `Version ${l.reportVersion} is signed off`, detail: "Export the sealed report.", tone: "done" };
  // Sign-off needs a checked Close Review with no unresolved blocking finding (20261017100000): its page clears it.
  const closeReview = l.blockers.filter((b) => b === "CLOSE_REVIEW_FINDINGS_NOT_CHECKED" || b.startsWith("CLOSE_REVIEW_BLOCKING_FINDINGS"));
  if (closeReview.length > 0) return { page: "close-findings", title: "Check the Close Review findings", detail: closeReview.map(blockerText).join(" "), tone: canPrepare ? "todo" : "blocked" };
  if (l.blockers.length > 0) return { page: "signoff", title: `Resolve ${l.blockers.length} sign-off blocker${l.blockers.length === 1 ? "" : "s"}`, detail: l.blockers.slice(0, 3).join("; ") + (l.blockers.length > 3 ? "; …" : ""), tone: "todo" };
  if (l.state === "DRAFT") return i.allowed.includes("review_close")
    ? { page: "signoff", title: `Review version ${l.reportVersion}`, detail: "Mark the version reviewed.", tone: "todo" }
    : { page: "signoff", title: `Version ${l.reportVersion} awaits review`, detail: "A reviewer marks it reviewed.", tone: "blocked" };
  return i.allowed.includes("approve_certification")
    ? { page: "signoff", title: `Approve version ${l.reportVersion} as final`, detail: "Final sign-off seals the version.", tone: "todo" }
    : { page: "signoff", title: `Version ${l.reportVersion} awaits final approval`, detail: "A partner approves it as final.", tone: "blocked" };
}
