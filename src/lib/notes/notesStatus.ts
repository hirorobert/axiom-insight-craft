// notes/notesStatus.ts — the browser's view of the database's notes and schedules state (fs_notes_status,
// 20261019100000). The database decides every status and every reconciliation; this module validates the payload,
// names each status in words (one word per server state, nothing merged), and calls the server RPCs. It writes no table,
// generates no wording, and never reaches a withheld service.

import { z } from "zod";
import { presentAmount, type AmountText } from "@/lib/presentation/amounts";

const MINOR = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
export const REQUIREMENT_STATUSES = [
  "provided", "missing", "undecided", "not_applicable", "satisfied", "dates_unknown",
  "composed", "incomplete", "evidence_present", "evidence_missing", "derived",
  "reconciled", "reconciled_opening_unverified", "closing_mismatch", "opening_mismatch",
  // 20261022100000: a case the product cannot compose correctly (a discontinued operation, other comprehensive income).
  "unsupported",
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

const requirementSchema = z.object({
  requirementId: z.string(), kind: z.enum(["STATEMENT", "DISCLOSURE", "PERIOD", "SCHEDULE", "LINE_ITEM"]), blocking: z.boolean(), status: z.enum(REQUIREMENT_STATUSES),
  basis: z.string().optional(), decisionId: z.string().optional(), textId: z.string().optional(), sourceRef: z.string().nullable().optional(),
  scheduleId: z.string().optional(), submissionId: z.string().optional(), contentSha256: z.string().optional(),
  composedClosingMinor: MINOR.nullable().optional(), composedOpeningMinor: MINOR.nullable().optional(),
  scheduleOpeningMinor: MINOR.optional(), scheduleClosingMinor: MINOR.optional(), differenceMinor: MINOR.optional(),
  // Total comprehensive income per complete period, when composed (5.5(i)).
  totalsMinor: z.object({ current: MINOR.optional(), comparative: MINOR.optional() }).optional(),
});
const evaluatedSchema = z.object({
  state: z.literal("evaluated"), contract: z.literal("fs-notes-status/2"), packId: z.enum(["ifrs-for-smes/2015", "ifrs-for-smes/2025"]),
  compositionSha256: z.string().regex(/^[0-9a-f]{64}$/), periodYear: z.number().int(),
  requirements: z.array(requirementSchema), blockers: z.array(z.string()), statusSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const otherSchema = z.object({ state: z.string().refine((s) => s !== "evaluated"), reason: z.string().optional(), periodYear: z.number().int().optional() });

export type NotesStatus = z.infer<typeof evaluatedSchema>;
export type RequirementState = z.infer<typeof requirementSchema>;
export type NotesStatusResult = NotesStatus | z.infer<typeof otherSchema>;

export function parseNotesStatus(payload: unknown): NotesStatusResult {
  const ok = evaluatedSchema.safeParse(payload);
  if (ok.success) return ok.data;
  const other = otherSchema.safeParse(payload);
  if (other.success && (payload as { state?: string }).state !== "evaluated") return other.data;
  throw new Error(`fs_notes_status returned an unrecognised payload: ${ok.error.issues[0]?.message ?? "invalid"}`);
}

/** One plain word or phrase per server state — never merged, never softened. */
export const STATUS_WORDS: Readonly<Record<RequirementStatus, string>> = {
  provided: "Provided", missing: "Missing", undecided: "Needs a decision", not_applicable: "Not applicable", satisfied: "Satisfied",
  dates_unknown: "Period dates unknown", composed: "Composed", incomplete: "Incomplete", evidence_present: "Evidence held",
  evidence_missing: "Evidence missing", derived: "Follows its parts", reconciled: "Reconciled",
  reconciled_opening_unverified: "Reconciled — opening not verified", closing_mismatch: "Closing does not agree", opening_mismatch: "Opening does not agree",
  unsupported: "Not supported — blocks finalisation",
};

/** Whether a status means the requirement still needs work (blocking ones block REVIEWED/FINAL). */
export const needsWork = (r: RequirementState): boolean =>
  ["missing", "undecided", "dates_unknown", "incomplete", "evidence_missing", "closing_mismatch", "opening_mismatch", "unsupported"].includes(r.status);

export interface ScheduleReconciliation {
  readonly scheduleId: string;
  readonly closing: { readonly schedule: AmountText; readonly statement: AmountText };
  readonly opening: { readonly schedule: AmountText; readonly statement: AmountText };
  readonly difference: AmountText | null;
}
/** The reconciliation figures the server returned, as text (missing with its reason where the server gave none). */
export function scheduleReconciliation(r: RequirementState, exponent: number): ScheduleReconciliation | null {
  if (r.kind !== "SCHEDULE" || !r.scheduleId) return null;
  const amt = (m: string | null | undefined, reason: string) => (m === null || m === undefined ? presentAmount({ kind: "missing", reason }) : presentAmount({ kind: "amount", minor: BigInt(m), exponent }));
  return {
    scheduleId: r.scheduleId,
    closing: { schedule: amt(r.scheduleClosingMinor, "no schedule recorded"), statement: amt(r.composedClosingMinor, "not composed") },
    opening: { schedule: amt(r.scheduleOpeningMinor, "no schedule recorded"), statement: amt(r.composedOpeningMinor, "no authoritative prior-year statement") },
    difference: r.differenceMinor === undefined ? null : presentAmount({ kind: "amount", minor: BigInt(r.differenceMinor), exponent }),
  };
}

// ── Server calls ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface NotesDb { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }
export interface ScheduleClassInput { classLabel: string; openingMinor: string; closingMinor: string; movements: { kind: string; amountMinor: string }[] }

export function notesClient(db: NotesDb) {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as { outcome: string; [k: string]: unknown };
  };
  return {
    status: async (companyId: string, periodYear: number) =>
      parseNotesStatus((await db.rpc("fs_notes_status", { p_company_id: companyId, p_period_year: periodYear })).data),
    decide: (companyId: string, periodYear: number, requirementId: string, decision: "applicable" | "not_applicable", reason: string, requestId: string) =>
      call("fs_decide_requirement", { p_company_id: companyId, p_period_year: periodYear, p_requirement_id: requirementId, p_decision: decision, p_reason: reason, p_request_id: requestId }),
    disclose: (companyId: string, periodYear: number, requirementId: string, body: string | null, sourceRef: string | null, requestId: string) =>
      call("fs_record_disclosure", { p_company_id: companyId, p_period_year: periodYear, p_requirement_id: requirementId, p_body: body, p_source_ref: sourceRef, p_request_id: requestId }),
    recordSchedule: (companyId: string, periodYear: number, scheduleId: string, rows: readonly ScheduleClassInput[], sourceRef: string, requestId: string) =>
      call("fs_record_schedule", { p_company_id: companyId, p_period_year: periodYear, p_schedule_id: scheduleId, p_rows: rows, p_source_ref: sourceRef, p_request_id: requestId }),
  };
}
