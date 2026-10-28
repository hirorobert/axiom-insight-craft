import { z } from "zod";
import type { ReportingDb } from "@/lib/reporting/signoff";
/**
 * The browser's client of the multi-class equipment preparation functions (20261206100000). Every call carries the
 * expected revision of what it changes and a request identity; the server decides. Nothing here writes a table.
 */
const uuid = z.string().uuid();
const jsonObject = z.record(z.unknown());
const noteSchema = z.object({ id: uuid, body: z.string().nullable(), sourceRef: z.string().nullable() }).nullable();
export const NOTE_REQUIREMENTS = ["smes.note.policies", "smes.note.subclassifications", "smes.note.estimates"] as const;
export type NoteRequirement = (typeof NOTE_REQUIREMENTS)[number];
const answerRecord = z.object({
  classKey: z.string().nullable(), classLabel: z.string().nullable(), questionId: z.string(), status: z.string(), answer: jsonObject, workpaperId: uuid, createdAt: z.string(),
});
const contextSchema = z.object({
  outcome: z.literal("available"),
  contract: z.literal("fs-equipment-context/2"),
  workpaper: z.object({ id: uuid, payload: jsonObject, sourceDocumentId: uuid.nullable(), createdAt: z.string(), contract: z.string().nullable() }).nullable(),
  notes: z.object({ "smes.note.policies": noteSchema, "smes.note.subclassifications": noteSchema, "smes.note.estimates": noteSchema }),
  schedule: z.object({
    id: uuid, sourceRef: z.string(), createdAt: z.string(), contentSha256: z.string(),
    rows: z.array(z.object({ classLabel: z.string(), openingMinor: z.string(), closingMinor: z.string(), movements: z.array(z.object({ kind: z.string(), amountMinor: z.string() })) })),
  }).nullable(),
  answers: z.array(answerRecord),
  priorAnswers: z.array(answerRecord),
});
type DeepRequired<T> = T extends (infer U)[] ? DeepRequired<U>[] : T extends object ? { [K in keyof T]-?: DeepRequired<T[K]> } : T;
export type EquipmentContextV2 = DeepRequired<z.infer<typeof contextSchema>>;
export type AnswerRecord = DeepRequired<z.infer<typeof answerRecord>>;
const problem = z.object({ code: z.string() }).passthrough();
const receiptSchema = z.object({
  outcome: z.string(),
  workpaperId: uuid.optional(),
  createdAt: z.string().optional(),
  sourceRetained: z.boolean().optional(),
  replay: z.boolean().optional(),
  currentId: uuid.nullable().optional(),
  requirementId: z.string().optional(),
  problems: z.array(problem).optional(),
  schedule: z.object({ outcome: z.string(), submissionId: uuid.optional(), problems: z.array(z.unknown()).optional() }).optional(),
  notes: z.array(z.object({ outcome: z.string(), textId: uuid.optional(), requirementId: z.string() })).optional(),
  answersRecorded: z.number().int().optional(),
});
export type CommitReceipt = z.infer<typeof receiptSchema>;
export type NoteInsertion = { requirementId: NoteRequirement; expectedTextId: string | null; body: string };

export function workpaperClient(db: Pick<ReportingDb, "rpc">) {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error("The preparation service could not confirm the request.");
    return data;
  };
  return {
    async context(companyId: string, periodYear: number): Promise<EquipmentContextV2> {
      return contextSchema.parse(await call("fs_equipment_context_v2", { p_company_id: companyId, p_period_year: periodYear })) as EquipmentContextV2;
    },
    async saveDraft(companyId: string, periodYear: number, payload: Record<string, unknown>, expectedId: string | null, sourceDocumentId: string | null, requestId: string) {
      return z.object({ outcome: z.string(), workpaperId: uuid.optional(), sourceRetained: z.boolean().optional(), createdAt: z.string().optional(), replay: z.boolean().optional(), currentId: uuid.nullable().optional() })
        .parse(await call("fs_save_equipment_workpaper_v2", { p_company_id: companyId, p_period_year: periodYear, p_payload: payload, p_expected_id: expectedId, p_source_document_id: sourceDocumentId, p_request_id: requestId }));
    },
    /** The reviewed save: workpaper + every class + answers + the given reviewed notes, in one server transaction. */
    async commit(companyId: string, periodYear: number, payload: Record<string, unknown>, expectedWorkpaperId: string | null, sourceDocumentId: string | null, expectedScheduleId: string | null, notes: readonly NoteInsertion[], requestId: string): Promise<CommitReceipt> {
      return receiptSchema.parse(await call("fs_commit_equipment_preparation_v2", {
        p_company_id: companyId, p_period_year: periodYear, p_payload: payload, p_expected_workpaper_id: expectedWorkpaperId, p_source_document_id: sourceDocumentId,
        p_expected_schedule_id: expectedScheduleId, p_notes: notes, p_request_id: requestId,
      }));
    },
  };
}

/** A proposal that keeps the whole existing note and appends the equipment section for review; never a silent replacement. */
export function noteProposal(existing: string | null, heading: string, section: string): string {
  if (!section.trim()) throw new Error("The equipment section is empty.");
  if ((existing ?? "").includes(section.trim())) return existing!;
  return [existing?.trim(), heading, section.trim()].filter(Boolean).join("\n\n");
}

/** Plain words for a commit receipt the page cannot treat as a save. */
export function commitProblemWords(r: CommitReceipt): string {
  const names: Record<string, string> = {
    stale: "A newer workpaper exists. Read the current preparation before deciding how to reconcile your draft; your edits are kept.",
    stale_schedule: "The equipment schedule changed while you were preparing. Read the current classes and reconcile them; nothing was replaced and your edits are kept.",
    stale_note: `Another person changed the ${r.requirementId?.replace("smes.note.", "") ?? ""} note. Read the latest wording and reconcile your proposal; nothing was saved.`,
    stale_inputs: "The statements changed since you reviewed them. Review the refreshed figures, then save again; your edits are kept.",
    request_reused: "This request was already used for a different preparation; nothing was saved. Make the change again as a new save.",
    source_mismatch: "The retained original does not match the figure's document fingerprint; nothing was saved.",
    invalid_schedule: "The schedule authority refused the classes; nothing was saved.",
    invalid_preparation: "The preparation is not complete or does not reconcile; nothing was saved.",
    forbidden: "Your role cannot prepare equipment for this company; nothing was saved.",
    feature_disabled: "Financial statements are not enabled for this company.",
    invalid_request: "The request was not valid; nothing was saved.",
    framework_not_ifrs_for_smes: "This company does not report under the IFRS for SMEs.",
  };
  const base = names[r.outcome] ?? `The server answered: ${r.outcome}.`;
  const detail = (r.problems ?? []).map((p) => {
    const x = p as Record<string, unknown>;
    return [x.code, x.class ? `class ${x.class}` : null, x.questionId ? `question ${x.questionId}` : null, x.kind ? `movement ${x.kind}` : null, x.target ? `destination ${x.target}` : null, x.differenceMinor !== undefined ? `difference ${x.differenceMinor} (minor units)` : null].filter(Boolean).join(" ");
  });
  const scheduleDetail = (r.schedule?.problems ?? []).map((p) => (typeof p === "string" ? p : JSON.stringify(p)));
  return [base, ...detail, ...scheduleDetail].join(" ");
}
