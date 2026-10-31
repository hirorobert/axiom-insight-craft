/**
 * Completion tasks and the incomplete report preview (charter §0 step 3–4; proposed spec §3, §6, §16).
 *
 * Every blocker becomes a task that says what is missing, why it matters, which evidence settles it, who can answer it,
 * where to act, what depends on it and where to return. Tasks derive from persisted facts only. The preview is a
 * labelled draft: it carries no compliance assertion and states, as data, why official issuance is unavailable.
 */
import type { BridgeResult } from "./openingBridge";
import type { PolicyNote } from "./policyNote";
import type { PpeIssue, PpeResult } from "./ppeWorkpaper";

export type TaskArea = "bring" | "prepare" | "review" | "approve" | "issue";
export type PrepTask = {
  id: string;
  title: string;
  missing: string;
  why: string;
  acceptedEvidence: string;
  responsible: "preparer" | "management" | "reviewer";
  area: TaskArea;
  /** The screen section to open, so a blocker is never a dead end. */
  target: string;
  status: "open";
  affects: string[];
};

const WHY: [RegExp, string, string[]][] = [
  [/^MEASUREMENT|^REVALUATION|^MEASUREMENT_BASIS/, "The measurement model decides how every figure in the class is measured and what must be disclosed.", ["PPE policy", "PPE note"]],
  [/^ESTIMATE_/, "Useful lives, methods and residual values are management's estimates; the depreciation charge, the carrying amount and the policy all follow from them.", ["Depreciation charge", "PPE policy", "PPE note"]],
  [/^ROLL_FORWARD|^ITEMS_|^DEPRECIATION_MOVEMENT/, "Opening plus movements must equal closing. A difference means a movement is missing or a balance is wrong; nothing is balanced for you.", ["PPE note", "Statement of financial position"]],
  [/^CHARGE_|^CONVENTION|^REGISTER_CHARGE/, "The charge in the schedule must come from the entity's estimates or its register, and any difference must be explained.", ["Depreciation charge", "PPE note"]],
  [/^DISPOSAL/, "A gain or loss on disposal needs the proceeds; unknown proceeds are not zero.", ["Surplus or deficit", "PPE note"]],
  [/^TB_/, "The schedule has to tie to the reviewed trial balance before any statement line can rely on it.", ["Statement of financial position", "Statement of financial performance"]],
  [/^ENTITY_QUESTION|^SPECIALISED_ROUTE/, "Each question decides whether a further requirement applies; an unanswered question is not an answer of 'no'.", ["Completeness of the PPE requirements"]],
  [/^OPENING_|^PUBLISHED_/, "The opening balances must agree to the prior report, or every difference must be explained by an evidenced item. No balancing entry is created.", ["Comparative figures", "Statement of financial position"]],
];
const why = (code: string): { why: string; affects: string[] } => {
  const hit = WHY.find(([re]) => re.test(code));
  return hit ? { why: hit[1], affects: hit[2] } : { why: "This is needed before the preparation can be reviewed.", affects: ["PPE note"] };
};
const title = (code: string): string => code.replace(/:.*/, "").toLowerCase().replace(/_/g, " ").replace(/^tb /, "trial balance ").replace(/ unknown$/, " not available").replace(/^./, (s) => s.toUpperCase());

export function tasksFromPreparation(ppe: PpeResult, bridge: BridgeResult): PrepTask[] {
  const out: PrepTask[] = [];
  for (const b of bridge.blockers) {
    const w = why(b.code);
    out.push({ id: `bridge:${b.code}:${b.lineId ?? "all"}`, title: title(b.code), missing: b.message, why: w.why, acceptedEvidence: "Prior report page, prior trial balance, journal or restatement record with its authority.", responsible: "preparer", area: "bring", target: "opening-bridge", status: "open", affects: w.affects });
  }
  for (const p of bridge.itemProblems) out.push({ id: `bridge:item:${p.slice(0, 40)}`, title: "Correct a bridge item", missing: p, why: why("OPENING_").why, acceptedEvidence: "Journal, restatement note or scope document, and who approved it.", responsible: "preparer", area: "bring", target: "opening-bridge", status: "open", affects: why("OPENING_").affects });
  for (const i of ppe.issues) {
    const w = why(i.code);
    out.push({ id: `ppe:${i.code}:${i.classId ?? "entity"}`, title: title(i.code), missing: i.message, why: w.why, acceptedEvidence: i.needs, responsible: i.owner, area: i.area, target: i.classId ? `equipment:${i.classId}` : i.code.startsWith("ENTITY_QUESTION") || i.code.startsWith("SPECIALISED") ? "equipment-questions" : "equipment", status: "open", affects: w.affects });
  }
  const rank = { bring: 0, prepare: 1, review: 2, approve: 3, issue: 4 } as const;
  return out.sort((a, b) => rank[a.area] - rank[b.area] || (a.id < b.id ? -1 : 1));
}

/** Why an official issuance is unavailable. Fixed, honest, and independent of how complete the PPE slice is. */
export const OFFICIAL_ISSUANCE_BLOCKERS = [
  "Only property, plant and equipment is prepared. The other statements and notes (cash flows, net assets, revenue and grants, receivables, payables, leases, employee benefits, related parties, going concern, events after the reporting date) are not yet prepared on this platform.",
  "The paragraph-level IPSAS requirement register has no accounting author or reviewer; applicability and completeness are unreviewed.",
  "Comparative transition choices (continuing application, first-time adoption, early adoption) are not yet recorded or reviewed.",
  "IPSAS statements, notes and the review, approval and frozen-issuance path are not integrated; the current compiler and issuance path serve other reporting frameworks only.",
  "Entity authorisation of the statements (the actual authorising body, person and date) is not recorded.",
] as const;

export type IncompletePreview = {
  label: "INCOMPLETE DRAFT — preparation only; not an IPSAS compliant report";
  ppeLine: { label: string; closingMinor: string | null; openingMinor: string | null; note: string };
  policyNote: PolicyNote;
  tasks: PrepTask[];
  nextAction: PrepTask | null;
  officialIssuance: { available: false; reasons: readonly string[] };
};
export function buildIncompletePreview(ppe: PpeResult, bridge: BridgeResult, policyNote: PolicyNote): IncompletePreview {
  const tasks = tasksFromPreparation(ppe, bridge);
  return {
    label: "INCOMPLETE DRAFT — preparation only; not an IPSAS compliant report",
    ppeLine: { label: "Property, plant and equipment", closingMinor: ppe.totals.closingCarryingMinor, openingMinor: ppe.totals.openingCarryingMinor, note: policyNote.semanticRefs.note },
    policyNote,
    tasks,
    nextAction: tasks[0] ?? null,
    officialIssuance: { available: false, reasons: OFFICIAL_ISSUANCE_BLOCKERS },
  };
}
export type { PpeIssue };
