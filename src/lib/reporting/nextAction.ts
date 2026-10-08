// reporting/nextAction.ts — the ONE next action of the reporting workbench, derived from the server's own states. Pure.
//
// Order follows the dependency chain the server enforces: statements compose → notes and schedules → comparatives →
// a saved report version on the current dependencies → its blockers → REVIEWED → FINAL → export. Every input is a server
// payload; nothing is inferred beyond reading it, and an unknown state is named, never treated as done.

import type { WorkbenchPageId } from "@/lib/workbench/routes";
import type { CompositionResult } from "@/lib/statements/composition";
import { needsWork, type NotesStatus, type NotesStatusResult } from "@/lib/notes/notesStatus";
import { COMPARATIVE_WORDS, type ComparativeStatus } from "@/lib/comparatives/comparatives";

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
  const c = i.composition;
  if (!c) return { page: "fs-statements", title: "Reading the statements", detail: "The composed statements have not been read yet.", tone: "blocked" };
  if (c.state !== "composed") return { page: "fs-statements", title: "Statements cannot be composed yet", detail: NOT_COMPOSED[c.state] ?? `The server reports ${c.state}.`, tone: "blocked" };

  const unassigned = count(c.blockers, "PRESENTATION_UNASSIGNED") + count(c.blockers, "PRESENTATION_INCOMPATIBLE") + count(c.blockers, "ACCOUNTS_NOT_PRESENTABLE");
  if (unassigned > 0) return { page: "fs-statements", title: `Assign ${unassigned} account${unassigned === 1 ? "" : "s"} to statement lines`, detail: "Every account must be on a compatible line before totals are shown.", tone: "todo" };
  if (c.blockers.includes("EXPENSE_ANALYSIS_MIXED")) return { page: "fs-statements", title: "Choose one expense analysis", detail: "Expenses are presented both by nature and by function; use one.", tone: "todo" };
  if (c.blockers.length > 0) return { page: "fs-statements", title: "The statements do not yet compose cleanly", detail: c.blockers.join("; "), tone: "blocked" };

  if (!i.notes || i.notes.state !== "evaluated") return { page: "fs-notes", title: "Notes are not available", detail: i.notes ? `The server reports ${i.notes.state}.` : "The notes status has not been read yet.", tone: "blocked" };
  const open = (i.notes as NotesStatus).requirements.filter((r) => r.blocking && needsWork(r));
  const schedules = open.filter((r) => r.kind === "SCHEDULE");
  const evidence = open.filter((r) => r.status === "evidence_missing");
  const unsupported = open.filter((r) => r.status === "unsupported");
  if (unsupported.length > 0) return { page: "fs-notes", title: "This report cannot be finalised: a reporting case is not supported", detail: unsupported.map((r) => r.requirementId).join(", "), tone: "blocked" };
  const notes = open.filter((r) => r.kind !== "SCHEDULE" && r.status !== "evidence_missing");
  if (notes.length > 0) return { page: "fs-notes", title: `Complete ${notes.length} note requirement${notes.length === 1 ? "" : "s"}`, detail: notes.map((r) => r.requirementId).join(", "), tone: "todo" };
  if (schedules.length > 0) return { page: "fs-schedules", title: `Complete ${schedules.length} schedule${schedules.length === 1 ? "" : "s"}`, detail: schedules.map((r) => r.requirementId).join(", "), tone: "todo" };

  const cmp = i.comparatives;
  if (!cmp || cmp.state !== "evaluated") return { page: "fs-comparatives", title: "Comparatives are not available", detail: cmp ? `The server reports ${cmp.state}.` : "The comparative status has not been read yet.", tone: "blocked" };
  const cs = (cmp as ComparativeStatus).comparative;
  if (!COMPARATIVE_WORDS[cs.state].satisfiesRequirement) {
    const canApprove = i.allowed.includes("review_close");
    return { page: "fs-comparatives", title: `Comparatives: ${COMPARATIVE_WORDS[cs.state].title}`, detail: COMPARATIVE_WORDS[cs.state].detail + (cs.state === "unapproved" && !canApprove ? " A reviewer approves them." : ""), tone: cs.state === "unapproved" && canApprove ? "todo" : cs.state === "unapproved" ? "blocked" : "todo" };
  }

  if (evidence.length > 0) return { page: "signoff", title: "Add the evidence for the cash-flow and equity statements", detail: evidence.map((r) => r.requirementId).join(", "), tone: "todo" };
  const l = i.latest;
  if (!l || l.blockers.some((b) => b === "REPORTING_DEPENDENCIES_STALE" || b === "REPORTING_DEPENDENCIES_UNBOUND"))
    return { page: "signoff", title: l ? "Save a new report version" : "Save the first report version", detail: l ? "Something changed since the latest version was saved." : "The statements, notes and comparatives are ready to be saved as a version.", tone: "todo" };
  if (l.state === "FINAL") return { page: "exports", title: `Version ${l.reportVersion} is signed off`, detail: "Export the sealed report.", tone: "done" };
  if (l.blockers.length > 0) return { page: "signoff", title: `Resolve ${l.blockers.length} sign-off blocker${l.blockers.length === 1 ? "" : "s"}`, detail: l.blockers.slice(0, 3).join("; ") + (l.blockers.length > 3 ? "; …" : ""), tone: "todo" };
  if (l.state === "DRAFT") return i.allowed.includes("review_close")
    ? { page: "signoff", title: `Review version ${l.reportVersion}`, detail: "Mark the version reviewed.", tone: "todo" }
    : { page: "signoff", title: `Version ${l.reportVersion} awaits review`, detail: "A reviewer marks it reviewed.", tone: "blocked" };
  return i.allowed.includes("approve_certification")
    ? { page: "signoff", title: `Approve version ${l.reportVersion} as final`, detail: "Final sign-off seals the version.", tone: "todo" }
    : { page: "signoff", title: `Version ${l.reportVersion} awaits final approval`, detail: "A partner approves it as final.", tone: "blocked" };
}
