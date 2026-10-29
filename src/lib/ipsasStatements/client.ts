/** Validated server figures only. No ledger arithmetic or browser authority. */
import { z } from "zod";
import type { ReportingDb } from "@/lib/reporting/signoff";
const uuid = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const minor = z.string().regex(/^(0|-?[1-9][0-9]{0,63})$/);
export const assignmentSchema = z.object({ period: z.enum(["current", "comparative"]), accountKey: z.string().min(1).max(160),
  captionId: z.string().nullable(), zeroDisposition: z.enum(["movement-source-reviewed", "non-reporting-reviewed"]).nullable(), reason: z.string().max(2000).nullable() }).strict();
export type Assignment = z.infer<typeof assignmentSchema>;
const account = z.object({ period: z.enum(["current", "comparative"]), accountKey: z.string(), accountName: z.string(), classification: z.string().nullable(), section: z.string(),
  debitMinor: minor, creditMinor: minor, certifiedDebitMinor: minor, certifiedCreditMinor: minor, adjustmentIds: z.array(uuid),
  captionId: z.string().nullable(), zeroDisposition: assignmentSchema.shape.zeroDisposition, reason: z.string().nullable(), status: z.enum(["presented", "reviewed_zero", "needs_confirmation", "unassigned"]) });
const totals = z.object({ state: z.enum(["composed", "incomplete"]), assetsMinor: minor.nullable(), liabilitiesMinor: minor.nullable(),
  revenueMinor: minor.nullable(), expensesMinor: minor.nullable(), surplusMinor: minor.nullable(), netAssetsMinor: minor.nullable(), balanceDifferenceMinor: minor });
export const reviewSchema = z.object({ outcome: z.literal("available"), contract: z.literal("ipsas-statement-review/1"), companyId: uuid, periodYear: z.number().int(), catalogueVersion: z.literal("1"),
  current: z.object({ certificationId: uuid, uploadId: uuid, reportingStart: z.string(), reportingEnd: z.string(), currency: z.string().regex(/^[A-Z]{3}$/), exponent: z.number().int().min(0).max(6) }).passthrough(),
  comparative: z.object({ state: z.string(), usable: z.boolean(), label: z.string() }).passthrough(),
  revisionId: uuid.nullable(), assignmentsCurrent: z.boolean(), sourceSha256: hash, inputSha256: hash, compositionSha256: hash,
  accounts: z.array(account).max(1000), lines: z.array(z.object({ id: z.string(), label: z.string(), statement: z.enum(["SFP", "SFPERF"]), section: z.string(), currentMinor: minor.nullable(), comparativeMinor: minor.nullable() })).max(100),
  totals: z.object({ current: totals, comparative: totals.optional() }), adjustmentsRequiringRevalidation: z.number().int().nonnegative(),
  officialIssuance: z.object({ available: z.literal(false), reasons: z.array(z.string()).min(1) }),
});
export type StatementReview = z.infer<typeof reviewSchema>;
export type SaveIntent = { companyId: string; periodYear: number; assignments: Assignment[]; expectedRevision: string | null; expectedInput: string; requestId: string };
export class StatementServiceError extends Error { constructor(readonly kind: "installation" | "unknown", message: string) { super(message); } }

export function statementClient(db: Pick<ReportingDb, "rpc">) {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args);
    if (error) {
      if (["42883", "PGRST202"].includes(error.code ?? "")) throw new StatementServiceError("installation", "Statement review is not installed for this release. Existing preparation remains available; ask your administrator to complete the release installation.");
      throw new StatementServiceError("unknown", "The server answer could not be confirmed.");
    }
    return data;
  };
  return {
    async read(companyId: string, periodYear: number): Promise<StatementReview | { outcome: string }> {
      const raw = await call("ipsas_statement_review", { p_company: companyId, p_year: periodYear });
      const available = reviewSchema.safeParse(raw);
      if (available.success) {
        if (available.data.companyId !== companyId || available.data.periodYear !== periodYear) throw new StatementServiceError("unknown", "The server answered for a different reporting scope.");
        return available.data;
      }
      const refusal = z.object({ outcome: z.string() }).safeParse(raw);
      if (refusal.success && refusal.data.outcome !== "available") return { outcome: refusal.data.outcome! };
      throw new StatementServiceError("unknown", "The statement response was incomplete. No figures are assumed.");
    },
    async save(intent: SaveIntent): Promise<{ outcome: string; revisionId?: string }> {
      const raw = await call("ipsas_save_presentation", { p_company: intent.companyId, p_year: intent.periodYear, p_assignments: intent.assignments,
        p_expected_revision: intent.expectedRevision, p_expected_input: intent.expectedInput, p_request: intent.requestId });
      const refusal = z.object({ outcome: z.string() }).safeParse(raw);
      if (refusal.success && refusal.data.outcome !== "recorded") return { outcome: refusal.data.outcome! };
      const receipt = z.object({ outcome: z.literal("recorded"), revisionId: uuid, requestId: z.literal(intent.requestId), sourceSha256: hash }).safeParse(raw);
      if (!receipt.success) throw new StatementServiceError("unknown", "We could not confirm whether your presentation choices were saved. Send the same request again.");
      return { outcome: "recorded", revisionId: receipt.data.revisionId! };
    },
  };
}
export const choicesFrom = (r: StatementReview): Assignment[] => r.accounts.map(a => ({ period: a.period, accountKey: a.accountKey, captionId: a.captionId, zeroDisposition: a.zeroDisposition, reason: a.reason }));
export const refusalMessage = (outcome: string): string => ({
  forbidden: "You do not currently have permission to review these statements.", feature_disabled: "Statement preparation is not enabled for this company.",
  framework_not_ipsas_accrual: "This company is not set up for IPSAS accrual reporting.", no_authority: "Check the trial balance before reviewing statements.",
  period_unknown: "Confirm the reporting dates in company settings, then check the trial balance again.", currency_unknown: "Confirm the reporting currency and units before reviewing statements.",
  over_capacity: "This release supports 1,000 accounts across both periods. Ask your administrator about this reporting scope.",
  stale: "The source figures or saved presentation changed. Refresh and review the latest version before saving again.",
  incompatible_caption: "A caption conflicts with the account's reviewed classification. Correct the classification or choose a compatible caption.",
  request_reused: "This request identity belongs to a different save. Refresh before starting another save.",
}[outcome] ?? "The server refused this request. Review the latest inputs before trying again.");

const recovery = z.object({ actorId: uuid, companyId: uuid, periodYear: z.number().int(), assignments: z.array(assignmentSchema).max(1000),
  expectedRevision: uuid.nullable(), expectedInput: hash, requestId: uuid, expiresAt: z.number().finite() }).strict();
export function recoveryKey(actor: string, company: string, year: number) { return `cfoclose:ipsas-presentation:${actor}:${company}:${year}`; }
export function recoverIntent(storage: Pick<Storage, "getItem">, actor: string, company: string, year: number, now = Date.now()): SaveIntent | null {
  try {
    const raw = storage.getItem(recoveryKey(actor, company, year)); if (!raw || raw.length > 250000) return null;
    const p = recovery.safeParse(JSON.parse(raw));
    if (!p.success || p.data.actorId !== actor || p.data.companyId !== company || p.data.periodYear !== year || p.data.expiresAt < now || p.data.expiresAt > now + 86400000) return null;
    const { actorId: _actor, expiresAt: _expires, ...intent } = p.data; return intent as SaveIntent;
  } catch { return null; }
}
export function storeIntent(storage: Pick<Storage, "setItem">, actor: string, intent: SaveIntent): boolean {
  try { storage.setItem(recoveryKey(actor, intent.companyId, intent.periodYear), JSON.stringify({ ...intent, actorId: actor, expiresAt: Date.now() + 86400000 })); return true; } catch { return false; }
}
