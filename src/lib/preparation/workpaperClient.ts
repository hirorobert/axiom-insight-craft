import { z } from "zod";
import type { ReportingDb } from "@/lib/reporting/signoff";
const uuid = z.string().uuid();
const jsonObject = z.record(z.unknown());
const noteSchema = z
  .object({
    id: uuid,
    body: z.string().nullable(),
    sourceRef: z.string().nullable(),
  })
  .nullable();
const contextSchema = z.object({
  equipmentNote: noteSchema.optional(),
  scheduleId: uuid.nullable().optional(),
  outcome: z.literal("available"),
  workpaper: z
    .object({
      id: uuid,
      payload: jsonObject,
      sourceDocumentId: uuid.nullable(),
      createdAt: z.string(),
    })
    .nullable(),
  policy: z
    .object({
      id: uuid,
      body: z.string().nullable(),
      sourceRef: z.string().nullable(),
    })
    .nullable(),
});
export type EquipmentContext = z.infer<typeof contextSchema>;
export function workpaperClient(db: Pick<ReportingDb, "rpc">) {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args);
    if (error)
      throw new Error("The preparation service could not confirm the request.");
    return data;
  };
  return {
    async createSchedule(companyId: string, periodYear: number, rows: unknown[], sourceRef: string, requestId: string) {
      return z.object({outcome: z.string(), submissionId: uuid.optional()}).passthrough().parse(await call("fs_create_equipment_schedule", {
        p_company_id: companyId, p_period_year: periodYear, p_rows: rows, p_source_ref: sourceRef, p_request_id: requestId,
      }));
    },
    async context(
      companyId: string,
      periodYear: number,
    ): Promise<EquipmentContext> {
      return contextSchema.parse(
        await call("fs_equipment_context", {
          p_company_id: companyId,
          p_period_year: periodYear,
        }),
      );
    },
    async save(
      companyId: string,
      periodYear: number,
      payload: Record<string, unknown>,
      expectedId: string | null,
      sourceDocumentId: string | null,
      requestId: string,
    ) {
      return z
        .object({
          outcome: z.string(),
          workpaperId: uuid.optional(),
          sourceRetained: z.boolean().optional(),
          createdAt: z.string().optional(),
          replay: z.boolean().optional(),
        })
        .parse(
          await call("fs_save_equipment_workpaper", {
            p_company_id: companyId,
            p_period_year: periodYear,
            p_payload: payload,
            p_expected_id: expectedId,
            p_source_document_id: sourceDocumentId,
            p_request_id: requestId,
          }),
        );
    },
    async commit(
      companyId: string,
      periodYear: number,
      payload: Record<string, unknown>,
      expectedId: string | null,
      sourceDocumentId: string | null,
      expectedNoteId: string | null,
      body: string,
      requirementId: "smes.note.policies" | "smes.note.subclassifications",
      requestId: string,
      expectedScheduleId: string | null = null,
    ) {
      return z
        .object({
          outcome: z.string(),
          workpaperId: uuid.optional(),
          sourceRetained: z.boolean().optional(),
          createdAt: z.string().optional(),
          replay: z.boolean().optional(),
          schedule: z
            .object({ outcome: z.string(), submissionId: uuid.optional() })
            .optional(),
          note: z
            .object({ outcome: z.string(), textId: uuid.optional() })
            .optional(),
        })
        .parse(
          await call("fs_commit_equipment_preparation", {
            p_expected_schedule_id: expectedScheduleId,
            p_company_id: companyId,
            p_period_year: periodYear,
            p_payload: payload,
            p_expected_id: expectedId,
            p_source_document_id: sourceDocumentId,
            p_expected_note_id: expectedNoteId,
            p_body: body,
            p_requirement_id: requirementId,
            p_request_id: requestId,
          }),
        );
    },
    async recordPolicy(
      companyId: string,
      periodYear: number,
      workpaperId: string,
      expectedPolicyId: string | null,
      body: string,
      requestId: string,
      requirementId:
        | "smes.note.policies"
        | "smes.note.subclassifications" = "smes.note.policies",
    ) {
      return z
        .object({
          outcome: z.string(),
          textId: uuid.optional(),
          replay: z.boolean().optional(),
        })
        .parse(
          await call("fs_record_reviewed_equipment_note", {
            p_company_id: companyId,
            p_period_year: periodYear,
            p_workpaper_id: workpaperId,
            p_expected_policy_id: expectedPolicyId,
            p_requirement_id: requirementId,
            p_body: body,
            p_request_id: requestId,
          }),
        );
    },
  };
}
export function policyProposal(
  existing: string | null,
  equipment: string,
): string {
  if (!equipment.trim())
    throw new Error("Equipment policy answers are incomplete.");
  if ((existing ?? "").includes(equipment.trim())) return existing!;
  return [
    existing?.trim(),
    "Equipment — proposed section for review",
    equipment.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}
