/**
 * Correcting an account's classification from a Close Review finding (the "account 95000" journey).
 *
 *   Close Review finding  →  that account on the trial balance page (same company, year and trial balance)
 *   →  an explicit, reasoned classification correction (resolve_account_review_batch, the ordinary review decision)
 *   →  a confirmed new check (tbu_request_reprocess, the one reprocess path)  →  the findings checked again
 *   (close_review_refresh_findings)  →  back to the finding with its status as the server now reports it.
 *
 * Every write is an existing server function; nothing here decides authority, writes a mapping, or infers a result. The
 * server's answers are only worded. Pure, apart from the injected readers in readCorrectionContext / saveCorrection.
 *
 * What is preserved, by the server functions this reuses: the uploaded file and its checks (a correction changes the
 * company's reviewed mapping, never the source), every earlier review decision (append-only), every earlier findings run
 * and its history (append-only), and every flag the correction does not decide (cash / retained earnings / payroll are
 * omitted from the payload, so the server keeps the mapping's values).
 */
import { buildReviewDecision, type ReviewDecisionPayload } from "@/lib/accounting/buildReviewDecisions";
import { classificationMeta, isClassification, type ClassificationValue } from "@/lib/accounting/classificationMeta";
import type { FindingRow, FindingsSummary, FindingStatus, RefreshOutcome } from "@/lib/closeReview/findings";
import type { DecisionMember } from "@/lib/workspace/reviewConfirmation";
import { withContext } from "@/lib/workbench/context";

/** The findings that concern ONE account's classification (A01 sign, A03 cash in credit, A10 machine suggestion). */
export const CORRECTABLE_RULES = ["A01", "A03", "A10"] as const;
export type CorrectableRule = (typeof CORRECTABLE_RULES)[number];

export const ACCOUNT_PARAM = "account";
export const FINDING_PARAM = "finding";
const MAX_KEY = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface CorrectionLink { accountKey: string; findingKey: string; rule: CorrectableRule }

const validKey = (k: string | null): k is string => !!k && k.length <= MAX_KEY && k.trim() === k && k.length > 0 && !CONTROL.test(k);

/** A finding key this journey accepts: `<A01|A03|A10>:<account key>` (the server's own format), bounded. */
export function parseFindingKey(raw: string | null): { rule: CorrectableRule; accountKey: string } | null {
  if (!raw || raw.length > MAX_KEY + 4) return null;
  const rule = raw.slice(0, 3);
  if (raw[3] !== ":" || !(CORRECTABLE_RULES as readonly string[]).includes(rule)) return null;
  const accountKey = raw.slice(4);
  return validKey(accountKey) ? { rule: rule as CorrectableRule, accountKey } : null;
}

/** The deep link's two parameters, validated together: the finding must name exactly the account. Anything else: null. */
export function parseCorrectionLink(search: string): CorrectionLink | null {
  const q = new URLSearchParams(search);
  const accountKey = q.get(ACCOUNT_PARAM);
  const finding = parseFindingKey(q.get(FINDING_PARAM));
  if (!validKey(accountKey) || !finding || finding.accountKey !== accountKey) return null;
  return { accountKey, findingKey: `${finding.rule}:${accountKey}`, rule: finding.rule };
}

const route = (companyId: string, periodYear: number) =>
  UUID.test(companyId) && Number.isInteger(periodYear) && periodYear >= 1900 && periodYear <= 2999 ? `/workspace/${companyId}/${periodYear}` : null;

/**
 * Where a finding's correction opens: the trial balance page of the SAME workspace and year (an internal path built only
 * from the route's own identity and the validated finding — never from anything a link supplies), or null when the
 * finding is not about one account's classification.
 */
export function correctionHref(companyId: string, periodYear: number, f: Pick<FindingRow, "rule_id" | "finding_key" | "account_key">, reportVersion: number | null): string | null {
  const base = route(companyId, periodYear);
  const parsed = parseFindingKey(f.finding_key);
  if (!base || !parsed || parsed.rule !== f.rule_id || parsed.accountKey !== f.account_key) return null;
  const q = new URLSearchParams({ [ACCOUNT_PARAM]: parsed.accountKey, [FINDING_PARAM]: f.finding_key });
  return withContext(`${base}/trial-balance/review?${q.toString()}`, { reportVersion });
}

/** Back to the finding on Close Review › Findings (the page selects it when the current check still raises it). */
export function findingReturnHref(companyId: string, periodYear: number, findingKey: string, reportVersion: number | null): string | null {
  const base = route(companyId, periodYear);
  if (!base || !parseFindingKey(findingKey)) return null;
  return withContext(`${base}/close/findings?${new URLSearchParams({ [FINDING_PARAM]: findingKey }).toString()}`, { reportVersion });
}

/** The finding the findings page should open (validated), or null. */
export function parseFocusFinding(search: string): string | null {
  const raw = new URLSearchParams(search).get(FINDING_PARAM);
  return parseFindingKey(raw) ? raw : null;
}

// ── The decision ────────────────────────────────────────────────────────────────────────────────────────────────────

export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const reasonValid = (r: string) => { const n = r.trim().length; return n >= REASON_MIN && n <= REASON_MAX; };

/**
 * The ONE decision a correction records: the ordinary manual classification of Account review (USER_MANUAL_
 * CLASSIFICATION, statement and normal side from the class), with the reviewer's reason and where it was made. No
 * flag is sent, so the server keeps the mapping's cash / retained-earnings / payroll values.
 */
export function correctionDecision(account: { account_code: string | null; account_name: string }, classification: ClassificationValue, reason: string, findingKey: string): ReviewDecisionPayload & { source: string } {
  if (!isClassification(classification)) throw new Error("unknown classification");
  if (!reasonValid(reason)) throw new Error(`a correction needs a reason of ${REASON_MIN}–${REASON_MAX} characters`);
  const d = buildReviewDecision({ account_code: account.account_code, account_name: account.account_name }, false, classification, classificationMeta);
  return { ...d, reason: reason.trim(), source: `close_review_finding:${findingKey}` };
}

// ── Saving: three honest outcomes ───────────────────────────────────────────────────────────────────────────────────

export type SaveOutcome =
  | { kind: "saved" }
  /** The server refused it: the function is one transaction, so nothing was saved. */
  | { kind: "refused"; words: string }
  /** No answer came back: it may or may not be saved. The same request id is kept; sending it again cannot record it twice. */
  | { kind: "unknown" };

type RpcError = { code?: string | null; message?: string | null } | null | undefined;

/** Words for a refusal. The function raises named exceptions; the message names them (the code is the SQLSTATE). */
function refusalWords(e: { code?: string | null; message?: string | null }): string {
  const m = e.message ?? "";
  if (e.code === "28000" || /UNAUTHENTICATED|JWT/i.test(m) || e.code === "PGRST301" || e.code === "PGRST303") return "Your session has ended. Sign in again. Nothing was saved.";
  if (/CAPABILITY_REQUIRED|NOT_A_MEMBER/.test(m)) return "Correcting a classification needs Prepare in this workspace. Nothing was saved.";
  if (/UPLOAD_COMPANY_MISMATCH/.test(m)) return "This trial balance does not belong to this workspace. Nothing was saved.";
  if (/IDEMPOTENCY_KEY_REUSED/.test(m)) return "This correction was already sent with different content. Start again. Nothing was saved.";
  if (e.code === "PT402") return "This workspace has no current plan, so changes cannot be recorded. Nothing was saved.";
  if (e.code === "PT503") return "Trial balance processing is paused for maintenance. Nothing was saved. Try again later.";
  return `The correction was refused${e.code ? ` (${e.code})` : ""}. Nothing was saved.`;
}

/** A PostgreSQL or PostgREST code means the server answered (and the transaction did not commit); none means no answer. */
export function classifySave(error: RpcError, thrown = false): SaveOutcome {
  if (thrown) return { kind: "unknown" };
  if (!error) return { kind: "saved" };
  const code = (error.code ?? "").trim();
  if (/^([0-9A-Z]{5}|PGRST\d{3})$/.test(code)) return { kind: "refused", words: refusalWords(error) };
  return { kind: "unknown" };
}

export async function saveCorrection(
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError }>,
  p: { companyId: string; uploadId: string; requestId: string; decision: ReviewDecisionPayload },
): Promise<SaveOutcome> {
  try {
    const { error } = await rpc("resolve_account_review_batch", { p_company_id: p.companyId, p_upload_id: p.uploadId, p_client_request_id: p.requestId, p_decisions: [p.decision] });
    return classifySave(error);
  } catch {
    return classifySave(null, true);
  }
}

// ── An unconfirmed save survives a reload (same request id, same content) ────────────────────────────────────────────

export interface PendingSave { requestId: string; classification: ClassificationValue; reason: string }
export const pendingKey = (uploadId: string, accountKey: string) => `cfoclose.accountCorrection.${uploadId}.${accountKey}`;
export function parsePending(raw: string | null): PendingSave | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingSave>;
    return typeof v.requestId === "string" && UUID.test(v.requestId) && isClassification(v.classification) && typeof v.reason === "string" && reasonValid(v.reason)
      ? { requestId: v.requestId, classification: v.classification, reason: v.reason } : null;
  } catch { return null; }
}

// ── What the page shows: from the server's answers only ─────────────────────────────────────────────────────────────

export interface MappingRead {
  classification: string | null;
  review_decision_id: string | null;
}
export interface DecisionRead { decision_action: string; created_at: string; firm_member_id: string; upload_id: string | null; reason: string | null }

export interface CorrectionContext {
  summary: FindingsSummary;
  finding: FindingRow | null;
  /** The trial balance the current findings run was checked on (null when there is no current run). */
  runUploadId: string | null;
  findingStatus: FindingStatus | null;
  mapping: MappingRead | null;
  decision: DecisionRead | null;
  /** Who recorded that decision, when the reader may see the member (otherwise "a member of this workspace"). */
  decidedBy: DecisionMember | null;
}

export type ActiveUpload = { id: string; status: string } | null;
const CHECKING = new Set(["pending", "queued", "processing", "validating"]);

export type CorrectionView =
  | { kind: "unavailable"; words: string }
  | { kind: "checking" }
  | { kind: "needs_review" }
  | { kind: "no_authority"; words: string }
  /** Certified, but the findings have not been checked on it (after a new check, or after anything else changed it). */
  | { kind: "findings_out_of_date" }
  | { kind: "other_trial_balance" }
  | { kind: "not_raised" }
  | { kind: "ready"; finding: FindingRow; mapping: MappingRead | null; decision: DecisionRead | null; decidedBy: DecisionMember | null;
      /** The saved classification differs from the one the current check used: saved, not yet checked. */
      savedNotChecked: boolean; findingStatus: FindingStatus | null };

export function correctionView(ctx: CorrectionContext, upload: ActiveUpload): CorrectionView {
  if (upload && CHECKING.has(upload.status)) return { kind: "checking" };
  const s = ctx.summary;
  if (s.state === "unavailable") return { kind: "unavailable", words: "Close Review is not enabled for this workspace." };
  if (s.state === "no_authority") {
    if (upload?.status === "needs_review") return { kind: "needs_review" };
    return { kind: "no_authority", words: upload ? "There is no reviewed trial balance for this period at the moment." : "There is no trial balance for this period." };
  }
  if (s.state === "stale" || s.state === "not_generated") return { kind: "findings_out_of_date" };
  if (!upload || ctx.runUploadId !== upload.id) return { kind: "other_trial_balance" };
  if (!ctx.finding) return { kind: "not_raised" };
  const saved = ctx.mapping?.classification ?? null;
  // Saved after these findings were generated (a confirmation may keep the class), or saved as another class.
  const generatedAt = s.state === "current" ? Date.parse(s.generatedAt) : NaN;
  const decidedAfter = !!ctx.decision && Date.parse(ctx.decision.created_at) > generatedAt;
  return { kind: "ready", finding: ctx.finding, mapping: ctx.mapping, decision: ctx.decision, decidedBy: ctx.decidedBy,
    savedNotChecked: (!!saved && saved !== ctx.finding.classification) || decidedAfter, findingStatus: ctx.findingStatus };
}

/** Reads everything the view needs with the person's own session (RLS decides what they may see). */
export interface CorrectionReaders {
  summary(companyId: string, periodYear: number): Promise<FindingsSummary>;
  list(runId: string): Promise<FindingRow[]>;
  states(companyId: string, periodYear: number): Promise<{ finding_id: string; status: FindingStatus }[]>;
  runUpload(runId: string): Promise<string | null>;
  mapping(companyId: string, accountKey: string): Promise<MappingRead | null>;
  decision(decisionId: string): Promise<DecisionRead | null>;
  member(firmMemberId: string): Promise<DecisionMember | null>;
}

export async function readCorrectionContext(r: CorrectionReaders, companyId: string, periodYear: number, link: CorrectionLink): Promise<CorrectionContext> {
  const summary = await r.summary(companyId, periodYear);
  let finding: FindingRow | null = null, runUploadId: string | null = null, findingStatus: FindingStatus | null = null;
  if (summary.state === "current") {
    const [rows, upload] = await Promise.all([r.list(summary.runId), r.runUpload(summary.runId)]);
    runUploadId = upload;
    finding = rows.find((x) => x.finding_key === link.findingKey && x.account_key === link.accountKey) ?? null;
    if (finding) findingStatus = (await r.states(companyId, periodYear)).find((x) => x.finding_id === finding!.id)?.status ?? null;
  }
  const mapping = await r.mapping(companyId, link.accountKey);
  const decision = mapping?.review_decision_id ? await r.decision(mapping.review_decision_id) : null;
  const decidedBy = decision ? await r.member(decision.firm_member_id) : null;
  return { summary, finding, runUploadId, findingStatus, mapping, decision, decidedBy };
}

// ── After the findings are checked again ────────────────────────────────────────────────────────────────────────────

export type ReturnStatus =
  | { kind: "no_longer_raised"; words: string }
  | { kind: "still_raised"; words: string }
  | { kind: "not_checked"; words: string };

export const REFRESH_REFUSALS: Partial<Record<RefreshOutcome, string>> = {
  forbidden: "Checking for findings needs Prepare in this workspace.",
  feature_disabled: "Close Review is not enabled for this workspace.",
  no_authority: "There is no reviewed trial balance for this period yet, so the findings were not checked.",
  legacy_certification: "This trial balance was checked before exact amounts were recorded; run its check again first.",
  currency_unknown: "This period has no reporting currency, so the findings were not checked.",
  invalid_request: "The request was not valid. Nothing was recorded.",
};

const STATUS: Record<FindingStatus, string> = { open: "open", explained: "explained", accepted: "accepted", not_applicable: "marked not applicable", adjusted: "adjusted" };

/**
 * The status to report on return, from the server's refresh answer and the current run as read afterwards. "No longer
 * raised" means the current check of the reviewed trial balance does not produce this finding — never that a person
 * resolved the earlier one (its history stays on the earlier run).
 */
export function returnStatus(outcome: RefreshOutcome, ctx: Pick<CorrectionContext, "summary" | "finding" | "findingStatus">): ReturnStatus {
  if (outcome !== "generated" && outcome !== "unchanged") return { kind: "not_checked", words: REFRESH_REFUSALS[outcome] ?? "The findings were not checked." };
  if (ctx.summary.state !== "current") return { kind: "not_checked", words: "The findings could not be read after the check. Open Close Review › Findings to see them." };
  if (!ctx.finding) return { kind: "no_longer_raised", words: "The check of the reviewed trial balance no longer raises this finding." };
  return { kind: "still_raised", words: `The check still raises this finding; its status is ${STATUS[ctx.findingStatus ?? "open"]}.` };
}

/** The readers the page needs beyond the findings client: the run's trial balance, the mapping, its decision and member, the upload's status. */
export type CorrectionDbReaders = Omit<CorrectionReaders, "summary" | "list" | "states"> & { uploadStatus(uploadId: string): Promise<string | null> };

// ── The readers, with the person's session (RLS decides what may be seen; a row they may not see reads as none) ───────
type One = { data: unknown; error: unknown };
type Q = { select(c: string): Q; eq(c: string, v: unknown): Q; maybeSingle(): PromiseLike<One> };
export function supabaseCorrectionReaders(db: { from(t: string): unknown }): CorrectionDbReaders {
  const from = (t: string) => db.from(t) as Q;
  const one = async <T,>(q: PromiseLike<One>): Promise<T | null> => { const { data, error } = await q; if (error) throw error; return (data ?? null) as T | null; };
  return {
    runUpload: async (runId) => (await one<{ upload_id: string }>(from("close_review_finding_runs").select("upload_id").eq("id", runId).maybeSingle()))?.upload_id ?? null,
    mapping: (companyId, accountKey) => one(from("account_mappings").select("classification, review_decision_id").eq("company_id", companyId).eq("account_key", accountKey).maybeSingle()),
    decision: (id) => one(from("account_review_decisions").select("decision_action, created_at, firm_member_id, upload_id, reason").eq("id", id).maybeSingle()),
    // A member row the reader may not see is "a member of this workspace" (memberWords), never someone else.
    member: async (id) => { try { return await one(from("firm_members").select("id, user_id, role, invited_email").eq("id", id).maybeSingle()); } catch { return null; } },
    uploadStatus: async (uploadId) => (await one<{ status: string }>(from("trial_balance_uploads").select("status").eq("id", uploadId).maybeSingle()))?.status ?? null,
  };
}
