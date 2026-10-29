/**
 * The browser's client of the IPSAS preparation functions (20261207100000). Every call carries the expected revision of
 * what it changes and a request identity; the server derives the actor, recomputes the assessment and decides. Nothing
 * here writes a table, and nothing the server returns is replaced by a browser calculation.
 */
import { z } from "zod";
import type { ReportingDb } from "@/lib/reporting/signoff";

const uuid = z.string().uuid();
const minor = z.string().nullable();
const assessment = z.object({
  tb: z.object({ certificationId: uuid.nullable(), isBlocking: z.boolean().nullable(), requiresReview: z.boolean().nullable(), ppeCarryingClosingMinor: minor, ppeCarryingOpeningMinor: minor, depreciationExpenseMinor: minor }).passthrough(),
  confirmedClasses: z.record(z.boolean()),
  priorConfirmed: z.boolean(),
  ppe: z.object({
    state: z.enum(["incomplete", "ready-for-review"]),
    codes: z.array(z.string()),
    classes: z.array(z.object({ classId: z.string(), rollForward: z.string(), chargeCalculatedMinor: minor, depreciationMovementMinor: minor, disposalGainMinor: minor }).passthrough()),
    totals: z.object({ openingCarryingMinor: minor, closingCarryingMinor: minor, depreciationMinor: minor, disposalGainMinor: minor }),
  }).nullable(),
  bridge: z.object({
    state: z.enum(["agrees", "bridged", "blocked"]),
    codes: z.array(z.string()),
    lines: z.array(z.object({ lineId: z.string(), publishedMinor: minor, openingMinor: minor, differenceMinor: minor, bridgedMinor: z.string(), residualMinor: minor, status: z.string() })),
  }).nullable(),
  workpaperId: uuid.nullable(),
  priorFiguresId: uuid.nullable(),
});
export type Assessment = z.infer<typeof assessment>;

const revision = z.object({ id: uuid, payload: z.record(z.unknown()), sha256: z.string(), createdAt: z.string() }).passthrough();
const availableContext = z.object({
  outcome: z.literal("available"),
  workpaper: revision.nullable(),
  priorFigures: revision.nullable(),
  confirmations: z.array(z.object({ subjectKind: z.string(), subjectKey: z.string(), subjectSha256: z.string(), firmMemberId: uuid.nullable(), createdAt: z.string() })),
  assessment,
});
export type IpsasContext = z.infer<typeof availableContext>;
export type ContextResult = IpsasContext | { outcome: Exclude<string, "available"> };

const receipt = z.object({
  outcome: z.string(),
  revisionId: uuid.optional(),
  confirmationId: uuid.optional(),
  createdAt: z.string().optional(),
  replay: z.boolean().optional(),
  currentId: uuid.nullable().optional(),
  assessment: assessment.optional(),
});
export type Receipt = z.infer<typeof receipt>;

export type PreparationKind = "prior_figures" | "ppe_workpaper";
export type SubjectKind = "ppe_class_estimate" | "prior_figure_set";

/** A transport failure or an unreadable answer is an UNKNOWN outcome, never a refusal and never a success. */
export class UnknownOutcome extends Error {
  constructor() { super("We could not confirm the result."); this.name = "UnknownOutcome"; }
}

export function ipsasClient(db: Pick<ReportingDb, "rpc">) {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new UnknownOutcome();
    return data;
  };
  const parseReceipt = (data: unknown): Receipt => {
    const r = receipt.safeParse(data);
    if (!r.success) throw new UnknownOutcome();
    return r.data;
  };
  return {
    async context(companyId: string, periodYear: number): Promise<ContextResult> {
      const data = await call("ipsas_prep_context", { p_company_id: companyId, p_period_year: periodYear });
      const ok = availableContext.safeParse(data);
      if (ok.success) return ok.data;
      const refusal = z.object({ outcome: z.string() }).safeParse(data);
      if (refusal.success && refusal.data.outcome !== "available") return { outcome: refusal.data.outcome };
      throw new UnknownOutcome();
    },
    async save(companyId: string, periodYear: number, kind: PreparationKind, payload: Record<string, unknown>, expectedId: string | null, requestId: string): Promise<Receipt> {
      return parseReceipt(await call("ipsas_save_preparation", { p_company_id: companyId, p_period_year: periodYear, p_kind: kind, p_payload: payload, p_expected_id: expectedId, p_request_id: requestId }));
    },
    async confirm(companyId: string, periodYear: number, kind: SubjectKind, key: string, expectedRevisionId: string, requestId: string): Promise<Receipt> {
      return parseReceipt(await call("ipsas_confirm", { p_company_id: companyId, p_period_year: periodYear, p_subject_kind: kind, p_subject_key: key, p_expected_revision_id: expectedRevisionId, p_request_id: requestId }));
    },
  };
}

/** Plain words for an outcome that is not a successful save. */
export function refusalWords(outcome: string): string {
  const words: Record<string, string> = {
    stale: "Someone saved a newer version. Reload to see it; your edits are kept on this page so you can reapply them.",
    request_reused: "This request was already used for a different change; nothing was saved. Make the change again.",
    forbidden: "Your role cannot do this for this company; nothing was saved.",
    feature_disabled: "Financial statements are not enabled for this company.",
    framework_not_ipsas_accrual: "This company does not report under IPSAS accrual.",
    invalid_request: "The request was not valid; nothing was saved.",
    source_mismatch: "The retained original document was not found for this company; nothing was saved.",
    not_confirmable: "This is not ready to confirm yet: it needs a stated source and basis first.",
    unknown_subject: "That item no longer exists in the saved version; reload and try again.",
  };
  return words[outcome] ?? `The server answered: ${outcome}.`;
}

/**
 * Save-state of one write. The four outcomes are never merged: `saved` only after the server's recorded receipt,
 * `refused` for a named refusal (nothing changed), `pending` while in flight, and `unknown` when the answer was lost —
 * which keeps the ORIGINAL request identity so a retry replays rather than duplicates.
 */
export type SaveState =
  | { kind: "idle" }
  | { kind: "pending"; requestId: string }
  | { kind: "saved"; requestId: string; revisionId: string; replay: boolean }
  | { kind: "refused"; outcome: string }
  | { kind: "unknown"; requestId: string };
export function afterReceipt(requestId: string, r: { outcome?: string; revisionId?: string; confirmationId?: string; replay?: boolean }): SaveState {
  if ((r.outcome === "recorded" || r.outcome === "confirmed") && (r.revisionId ?? r.confirmationId)) return { kind: "saved", requestId, revisionId: (r.revisionId ?? r.confirmationId)!, replay: r.replay === true };
  return { kind: "refused", outcome: r.outcome ?? "unknown" };
}
export const afterFailure = (requestId: string): SaveState => ({ kind: "unknown", requestId });

/* ── grants and revenue (20261208100000) ─────────────────────────────────────────────────────────────────────────────── */
const grantFigure = z.object({ grantId: z.string(), cumulativeRevenueMinor: minor, periodRevenueMinor: minor, liabilityMinor: minor, receivableMinor: minor, cashReceivedMinor: minor, considerationMinor: minor });
const grantsLive = z.object({
  period: z.object({ certificationId: uuid.nullable(), start: z.string().nullable(), end: z.string().nullable() }),
  revisionId: uuid.nullable(),
  tb: z.object({ revenueMinor: minor, liabilityMinor: minor, receivableMinor: minor }).nullable(),
  confirmedGrants: z.record(z.boolean()),
  assessment: z.object({
    model: z.enum(["ipsas23", "ipsas47"]).nullable(), state: z.enum(["incomplete", "ready-for-review"]), codes: z.array(z.string()), grants: z.array(grantFigure),
    totals: z.object({ periodRevenueMinor: minor, liabilityMinor: minor, receivableMinor: minor }),
  }).nullable(),
});
export type GrantsLive = z.infer<typeof grantsLive>;
const grantsContext = z.object({ outcome: z.literal("available"), register: revision.nullable(), confirmations: z.array(z.object({ grantId: z.string(), subjectSha256: z.string(), createdAt: z.string() }).passthrough()), live: grantsLive });
export type GrantsContext = z.infer<typeof grantsContext>;
const grantsReceipt = z.object({ outcome: z.string(), revisionId: uuid.optional(), confirmationId: uuid.optional(), replay: z.boolean().optional(), currentId: uuid.nullable().optional(), live: grantsLive.optional() });
export type GrantsReceipt = z.infer<typeof grantsReceipt>;

export function grantsClient(db: Pick<ReportingDb, "rpc">) {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new UnknownOutcome();
    return data;
  };
  const receiptOf = (data: unknown): GrantsReceipt => { const r = grantsReceipt.safeParse(data); if (!r.success) throw new UnknownOutcome(); return r.data; };
  return {
    async context(companyId: string, periodYear: number): Promise<GrantsContext | { outcome: string }> {
      const data = await call("ipsas_grants_context", { p_company_id: companyId, p_period_year: periodYear });
      const ok = grantsContext.safeParse(data);
      if (ok.success) return ok.data;
      const refusal = z.object({ outcome: z.string() }).safeParse(data);
      if (refusal.success && refusal.data.outcome !== "available") return { outcome: refusal.data.outcome };
      throw new UnknownOutcome();
    },
    async save(companyId: string, periodYear: number, payload: Record<string, unknown>, expectedId: string | null, requestId: string): Promise<GrantsReceipt> {
      return receiptOf(await call("ipsas_save_grants", { p_company_id: companyId, p_period_year: periodYear, p_payload: payload, p_expected_id: expectedId, p_request_id: requestId }));
    },
    async confirm(companyId: string, periodYear: number, grantId: string, expectedRevisionId: string, requestId: string): Promise<GrantsReceipt> {
      return receiptOf(await call("ipsas_confirm_grant", { p_company_id: companyId, p_period_year: periodYear, p_grant_id: grantId, p_expected_revision_id: expectedRevisionId, p_request_id: requestId }));
    },
  };
}
