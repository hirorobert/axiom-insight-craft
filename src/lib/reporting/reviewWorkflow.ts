// reporting/reviewWorkflow.ts — the reviewed reporting journey's server calls (20261112100000): version-bound reviewer
// comments, the next-period roll-forward worklist and carry, the authorised acceptance of prior-FINAL differences, and
// the OFFICIAL Reporting Pack of a FINAL version (the existing server-sealed issuance: issue → the Edge Function stores and
// seals the server's own document → verify / retrieve re-read the stored bytes). Reads and RPCs only; nothing is decided
// here — every state shown is the server's.
import { z } from "zod";
import type { ReportingDb } from "./signoff";
import { ServerRefusal } from "./signoff";

/** The reporting workbench's own outcome words for the official issuance (the server's contract, not the legacy helper's). */
export type DeliveryOutcome = "delivered" | "locked" | "not_permitted" | "not_final" | "superseded" | "failed";

const eventSchema = z.object({
  eventId: z.string(), action: z.enum(["opened", "responded", "resolved", "reopened"]), body: z.string().nullable(), reportVersion: z.number().int(),
  contentAt: z.string(), at: z.string(), actorRole: z.string().nullable(),
});
const commentSchema = z.object({
  commentId: z.string(), openedOnVersion: z.number().int(), itemKind: z.enum(["fact", "note", "section"]), itemId: z.string(),
  severity: z.enum(["blocking", "advisory"]), body: z.string(), state: z.enum(["open", "responded", "resolved", "reopened_by_change"]),
  changedSinceOpened: z.boolean(), openedContent: z.string(), contentNow: z.string(), lastAction: z.string(), lastEventAt: z.string(),
  lastReportVersion: z.number().int(), authorRole: z.string().nullable(), openedAt: z.string(), events: z.array(eventSchema),
});
export type ReviewComment = z.infer<typeof commentSchema>;
const commentsSchema = z.object({ state: z.string(), comments: z.array(commentSchema).optional() }).passthrough();
export type ReviewCommentsResult = z.infer<typeof commentsSchema>;
export type CommentOutcome = { outcome: string; commentId?: string; eventId?: string; state?: string; replay?: boolean; reportVersion?: number };

const carrySchema = z.object({
  carryId: z.string(), kind: z.enum(["wording", "decision"]), requirementId: z.string(), payload: z.record(z.unknown()), status: z.enum(["carried", "confirmed", "withdrawn"]),
  statusReason: z.string().nullable(), sourcePeriodYear: z.number().int(), sourceRecordId: z.string(), carriedAt: z.string(), decidedAt: z.string().nullable(),
  confirmationRecordId: z.string().nullable(), kindOfRequirement: z.string().nullable(),
});
export type CarriedItem = z.infer<typeof carrySchema>;
const differenceSchema = z.object({ factId: z.string(), issuedMinor: z.string().nullable(), comparativeAsReportedMinor: z.string().nullable(), comparativePresentedMinor: z.string().nullable().optional(), differenceMinor: z.string().nullable() });
export type PriorFinalDifference = z.infer<typeof differenceSchema>;
const priorFinalSchema = z.object({
  state: z.string(), priorFinal: z.object({ reportId: z.string(), reportVersion: z.number().int(), documentSha256: z.string(), issuedAt: z.string() }).optional(),
  differences: z.array(differenceSchema).optional(), blockers: z.array(z.string()).optional(),
  acceptance: z.object({ acceptanceId: z.string(), differencesSha256: z.string(), reason: z.string(), at: z.string(), inForce: z.boolean() }).nullable().optional(),
}).passthrough();
export type PriorFinalReconciliation = z.infer<typeof priorFinalSchema>;
const worklistSchema = z.object({
  state: z.string(), periodYear: z.number().int().optional(), sourcePeriodYear: z.number().int().optional(), priorFinal: priorFinalSchema.optional(),
  carries: z.array(carrySchema).optional(),
  evidence: z.array(z.object({ evidenceType: z.string(), periodRole: z.string(), supplied: z.boolean() })).nullable().optional(),
  presentation: z.object({ carriesInherently: z.boolean(), compositionState: z.string().nullable(), accountsNotPresented: z.number().nullable() }).optional(),
  editions: z.object({ target: z.string().nullable() }).optional(),
}).passthrough();
export type RollforwardWorklist = z.infer<typeof worklistSchema>;
export type CarryOutcome = { outcome: string; carried?: number; withdrawn?: number; skipped?: number; editionChanged?: boolean; sourcePackId?: string | null; targetPackId?: string | null };
export type DecideOutcome = { outcome: string; status?: string; recordId?: string | null; replay?: boolean; authority?: unknown };

const issuanceSchema = z.object({
  id: z.string(), pack_kind: z.string(), output_ref: z.string().nullable(), issued_at: z.string(), consumed_at: z.string().nullable(), content_sha256: z.string().nullable(),
  expires_at: z.string().nullable().optional(),
});
export interface Issuance { readonly issuanceId: string; readonly outputRef: string | null; readonly issuedAt: string; readonly sealedAt: string | null; readonly contentSha256: string | null }
/** `superseded` (20261123100000): a later version of the lineage is FINAL; the server discloses it, official status is unchanged. */
export type VerifyOutcome = { outcome: string; official?: boolean; superseded?: boolean };
export type RetrieveOutcome = { outcome: string; document?: string; file_name?: string; content_sha256?: string; superseded?: boolean };

export function reviewClient(db: ReportingDb) {
  const rpc = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new ServerRefusal(fn, error.message, error.code ?? null);
    return data;
  };
  const invoke = async (name: string, body: Record<string, unknown>) => {
    if (!db.invoke) return { data: null, error: { message: "Server functions are not reachable from this page." } };
    return db.invoke(name, body);
  };
  // Resume an existing server issuance; never create a replacement after an uncertain seal response.
  const deliverOfficial = async (issuanceId: string, save: (blob: Blob, fileName: string) => void, retrieve = false): Promise<DeliveryOutcome> => {
    let sealed = await invoke("seal-reporting-pack", { action: retrieve ? "retrieve" : "issue", issuance_id: issuanceId });
    if (sealed.error && !retrieve) {
      sealed = await invoke("seal-reporting-pack", { action: "retrieve", issuance_id: issuanceId });
      retrieve = true;
    }
    if (sealed.error) return "failed";
    const s = (sealed.data && typeof sealed.data === "object" ? sealed.data : {}) as Record<string, unknown>;
    if (s.outcome === "entitlement_required") return "locked";
    if (s.outcome === "capability_required" || s.outcome === "workspace_access_denied") return "not_permitted";
    if (s.outcome === "superseded_final_version") return "superseded";
    if (s.outcome !== (retrieve ? "retrieved" : "sealed") || typeof s.document !== "string" || typeof s.file_name !== "string" || !/^[0-9a-f]{64}$/.test(String(s.content_sha256))) return "failed";
    save(new Blob([s.document], { type: "application/json" }), s.file_name);
    return "delivered";
  };
  return {
    // ── Reviewer comments ─────────────────────────────────────────────────────────────────────────────────────────────
    comments: async (companyId: string, reportId: string, reportVersion: number) =>
      commentsSchema.parse(await rpc("fs_review_comments", { p_company_id: companyId, p_report_id: reportId, p_report_version: reportVersion })),
    openComment: async (p: { companyId: string; reportId: string; reportVersion: number; itemKind: "fact" | "note" | "section"; itemId: string; severity: "blocking" | "advisory"; body: string; requestId: string }) =>
      (await rpc("fs_review_comment_open", { p_company_id: p.companyId, p_report_id: p.reportId, p_report_version: p.reportVersion, p_item_kind: p.itemKind, p_item_id: p.itemId, p_severity: p.severity, p_body: p.body, p_request_id: p.requestId })) as CommentOutcome,
    respond: async (companyId: string, commentId: string, body: string, requestId: string) =>
      (await rpc("fs_review_comment_respond", { p_company_id: companyId, p_comment_id: commentId, p_body: body, p_request_id: requestId })) as CommentOutcome,
    resolve: async (companyId: string, commentId: string, body: string, requestId: string) =>
      (await rpc("fs_review_comment_resolve", { p_company_id: companyId, p_comment_id: commentId, p_body: body, p_request_id: requestId })) as CommentOutcome,
    reopen: async (companyId: string, commentId: string, body: string | null, requestId: string) =>
      (await rpc("fs_review_comment_reopen", { p_company_id: companyId, p_comment_id: commentId, p_body: body, p_request_id: requestId })) as CommentOutcome,
    // ── Roll-forward ─────────────────────────────────────────────────────────────────────────────────────────────────
    worklist: async (companyId: string, periodYear: number) => worklistSchema.parse(await rpc("fs_rollforward_worklist", { p_company_id: companyId, p_period_year: periodYear })),
    carry: async (companyId: string, periodYear: number, requestId: string) => (await rpc("fs_rollforward_carry", { p_company_id: companyId, p_period_year: periodYear, p_request_id: requestId })) as CarryOutcome,
    decideCarry: async (companyId: string, carryId: string, confirm: boolean, reason: string | null, requestId: string) =>
      (await rpc("fs_rollforward_decide", { p_company_id: companyId, p_carry_id: carryId, p_confirm: confirm, p_reason: reason, p_request_id: requestId })) as DecideOutcome,
    priorFinal: async (companyId: string, periodYear: number) => priorFinalSchema.parse(await rpc("fs_prior_final_reconciliation", { p_company_id: companyId, p_period_year: periodYear })),
    acceptDifferences: async (companyId: string, periodYear: number, accept: boolean, reason: string, requestId: string) =>
      (await rpc("fs_accept_prior_final_differences", { p_company_id: companyId, p_period_year: periodYear, p_accept: accept, p_reason: reason, p_request_id: requestId })) as { outcome: string; acceptanceId?: string; differencesSha256?: string; state?: string },
    // ── The official Reporting Pack of a FINAL version (existing server-sealed issuance) ────────────────────────────
    /** The server's closed output-reference scheme for a SAVED version (fs-report:<id>:v<n>); a draft is never official. */
    outputRef: (reportId: string, reportVersion: number) => `fs-report:${reportId}:v${reportVersion}`,
    issuances: async (companyId: string, outputRef: string): Promise<Issuance[]> => {
      const { data, error } = await db.select("reporting_pack_issuances", { company_id: companyId, output_ref: outputRef });
      if (error) throw new ServerRefusal("reporting_pack_issuances", error.message, error.code ?? null);
      return z.array(issuanceSchema.passthrough()).parse(data ?? []).filter((r) => r.pack_kind === "financial_statements_data")
        .map((r) => ({ issuanceId: r.id, outputRef: r.output_ref, issuedAt: r.issued_at, sealedAt: r.consumed_at, contentSha256: r.content_sha256 }))
        .sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
    },
    /**
     * issue → store → seal, exactly as the existing official path does it (issue_official_reporting_pack binds the FINAL
     * publication; the Edge Function stores the server's own document and the database seals its hash); the file saved is
     * the server's sealed document. Nothing is built, uploaded or hashed here; a transport error is a failure, never a pack.
     */
    issueOfficial: async (companyId: string, periodYear: number, outputRef: string, save: (blob: Blob, fileName: string) => void, requestId: string = crypto.randomUUID()): Promise<DeliveryOutcome> => {
      const issued = await db.rpc("issue_official_reporting_pack", { p_company_id: companyId, p_period_year: periodYear, p_output_ref: outputRef, p_request_id: requestId });
      if (issued.error) return "failed";
      const r = (issued.data && typeof issued.data === "object" ? issued.data : {}) as Record<string, unknown>;
      if (r.outcome === "final_publication_required") return "not_final";
      if (r.outcome === "superseded_final_version") return "superseded";
      if (r.outcome === "entitlement_required") return "locked";
      if (r.outcome === "capability_required") return "not_permitted";
      if (!((r.outcome === "issued" || r.outcome === "already_issued") && typeof r.issuance_id === "string" && r.issuance_id.length > 0)) return "failed";
      return deliverOfficial(r.issuance_id, save, r.sealed === true);
    },
    resumeOfficial: async (issuanceId: string, save: (blob: Blob, fileName: string) => void): Promise<DeliveryOutcome> => deliverOfficial(issuanceId, save),
    verify: async (issuanceId: string): Promise<VerifyOutcome> => {
      const { data, error } = await invoke("seal-reporting-pack", { action: "verify", issuance_id: issuanceId });
      if (error) return { outcome: "unavailable" };
      const r = data as Record<string, unknown> | null;
      return r && typeof r.outcome === "string" ? { outcome: r.outcome, official: r.official === true, superseded: r.superseded === true } : { outcome: "unavailable" };
    },
    retrieve: async (issuanceId: string): Promise<RetrieveOutcome> => {
      const { data, error } = await invoke("seal-reporting-pack", { action: "retrieve", issuance_id: issuanceId });
      if (error) return { outcome: "unavailable" };
      const r = data as Record<string, unknown> | null;
      if (!r || typeof r.outcome !== "string") return { outcome: "unavailable" };
      return r.outcome === "retrieved" && typeof r.document === "string" && typeof r.file_name === "string" && /^[0-9a-f]{64}$/.test(String(r.content_sha256))
        ? { outcome: "retrieved", document: r.document, file_name: r.file_name, content_sha256: String(r.content_sha256), superseded: r.superseded === true } : { outcome: r.outcome, superseded: r.superseded === true };
    },
  };
}
export type ReviewClient = ReturnType<typeof reviewClient>;

/** The SHA-256 of a text, as the browser can recompute it over a retrieved document (never trusted over the server's). */
export async function sha256HexOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const COMMENT_STATE_WORDS: Readonly<Record<ReviewComment["state"], string>> = {
  open: "Open — awaiting the preparer", responded: "Responded — awaiting the reviewer", resolved: "Resolved", reopened_by_change: "Reopened — the item changed since it was resolved",
};
export const COMMENT_OUTCOME_WORDS: Readonly<Record<string, string>> = {
  recorded: "Recorded.", forbidden: "Your role cannot do this; nothing was recorded.", item_not_found: "That figure or note is not in this version.",
  not_found: "That comment does not exist.", already_resolved: "The comment is already resolved.", not_resolved: "Only a resolved comment can be reopened.",
  request_reused: "This request was already used for something else; nothing was recorded.", invalid_request: "The request was not valid; nothing was recorded.",
  feature_disabled: "Financial statements are not enabled for this company.",
};
export const CARRY_STATUS_WORDS: Readonly<Record<CarriedItem["status"], string>> = {
  carried: "Carried forward — review required", confirmed: "Confirmed for this period", withdrawn: "Withdrawn — decide afresh",
};
