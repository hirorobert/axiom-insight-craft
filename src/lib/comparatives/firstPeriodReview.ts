// comparatives/firstPeriodReview.ts - the browser's view of the governed first-period review (20261223100000) and the ONLY
// calls that change it: fs_record_first_period_evidence, fs_submit_first_period_claim, fs_decide_first_period and
// fs_withdraw_first_period, read through fs_first_period_status. The database decides every state; nothing is computed,
// defaulted or written here (CLAUDE.md 4.2: RPCs only). Anything the page cannot recognise is "cannot confirm", never approved.

import { z } from "zod";
import { FIRST_PERIOD_NEXT_ACTIONS } from "@/lib/comparatives/firstPeriodNextActions";

export type Subject = "first_period" | "opening_balances";

/** The evidence kinds the server records (fs_first_period_evidence.kind), with what the document's own date establishes. */
export const EVIDENCE_KINDS = {
  certificate_of_incorporation: { label: "Certificate of incorporation", dateLabel: "Registration date on the certificate" },
  certificate_of_registration: { label: "Certificate of registration", dateLabel: "Registration date on the certificate" },
  commencement_resolution: { label: "Commencement resolution", dateLabel: "Date trading or operations began" },
  regulatory_commencement_notice: { label: "Regulator's commencement notice", dateLabel: "Date trading or operations began" },
  dormancy_confirmation: { label: "Dormancy confirmation", dateLabel: "Last day it confirms the entity was dormant" },
  prior_activity_record: { label: "Record of activity", dateLabel: "Date of the activity it records" },
  pre_setup_activity_support: { label: "Support for activity before bookkeeping began", dateLabel: "Date of the activity it supports" },
  opening_position_support: { label: "Support for the opening position", dateLabel: "Date of the position it supports" },
} as const;
export type EvidenceKind = keyof typeof EVIDENCE_KINDS;
const KINDS = Object.keys(EVIDENCE_KINDS) as [EvidenceKind, ...EvidenceKind[]];

const HEX = z.string().regex(/^[0-9a-f]{64}$/);
const DATE = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const evidenceSchema = z.object({
  id: z.string(), kind: z.enum(KINDS), reference: z.string(), revision: z.number().int(), issuedOn: DATE, assertedDate: DATE.nullable(),
  documentSha256: HEX, note: z.string().nullable().optional(), recordedAt: z.string(), recordedByYou: z.boolean(),
});
const citedSchema = z.object({
  id: z.string(), kind: z.enum(KINDS), reference: z.string(), revision: z.number().int(), issuedOn: DATE, assertedDate: DATE.nullable(), documentSha256: HEX, current: z.boolean(),
});
const claimSchema = z.object({
  id: z.string(), facts: z.record(z.unknown()), basisText: z.string(), evidenceIds: z.array(z.string()), recordedAt: z.string(), recordedByYou: z.boolean(),
});
const decisionSchema = z.object({
  id: z.string(), outcome: z.enum(["verified", "not_verified", "withdrawn"]), reason: z.string(), ruleVersion: z.string(), decidedAt: z.string(), decidedByYou: z.boolean(),
});
const itemSchema = z.object({ code: z.string(), detail: z.string().nullable(), nextAction: z.string().nullable() });
const subjectSchema = z.object({
  subject: z.enum(["first_period", "opening_balances"]), rules: z.string(), state: z.string(),
  factIssues: z.array(z.string()), pending: z.array(z.string()), items: z.array(itemSchema),
  claimId: z.string().nullable(), decisionId: z.string().nullable(), binding: HEX.nullable(),
  claim: claimSchema.nullable(), decision: decisionSchema.nullable(), cited: z.array(citedSchema),
});
const statusSchema = z.object({
  state: z.literal("evaluated"), periodYear: z.number().int(),
  entity: z.object({ legalName: z.string().nullable(), tin: z.string().nullable() }),
  period: z.object({ reportingStart: DATE.nullable(), reportingEnd: DATE.nullable() }),
  evidence: z.array(evidenceSchema),
  firstPeriod: subjectSchema, openingBalances: subjectSchema,
  legacyDeclaration: z.object({ action: z.string(), evidenceKind: z.string().nullable(), evidenceRef: z.string().nullable(), evidenceDate: z.string().nullable(),
    recordedAt: z.string(), satisfiesRequirement: z.literal(false) }).nullable(),
});
export type FirstPeriodStatus = z.infer<typeof statusSchema>;
export type SubjectStatus = z.infer<typeof subjectSchema>;
export type EvidenceRevision = z.infer<typeof evidenceSchema>;
export type CitedRevision = z.infer<typeof citedSchema>;

/** Never throws: a payload the page does not recognise is "unknown" (shown as cannot confirm), never a default. */
export type ParsedStatus = FirstPeriodStatus | { state: "unavailable" } | { state: "unknown"; reason: string };
export function parseFirstPeriodStatus(payload: unknown): ParsedStatus {
  const ok = statusSchema.safeParse(payload);
  if (ok.success) return ok.data;
  if ((payload as { state?: unknown } | null)?.state === "unavailable") return { state: "unavailable" };
  return { state: "unknown", reason: ok.error.issues[0] ? `${ok.error.issues[0].path.join(".")}: ${ok.error.issues[0].message}` : "unrecognised answer" };
}

// ── The page's states ──────────────────────────────────────────────────────────────────────────────────────────────────
export type ReviewKind = "cannot_confirm" | "not_applicable" | "prerequisite" | "not_started" | "legacy_claim" | "needs_correction" | "awaiting_approval" | "returned" | "stale" | "approved";
/** The ONE primary action a state offers this person (null: none - the state says who acts next). */
export type PrimaryAction = "record_facts" | "review" | null;
export interface ReviewView {
  readonly kind: ReviewKind;
  readonly title: string;
  /** The server's ONE next action (its own sentence), or the page's statement for approved / cannot confirm. */
  readonly nextAction: string;
  readonly primary: PrimaryAction;
  /** Why this person has no primary action (who acts next), when that is the case. */
  readonly note: string | null;
  /** The server's reason codes, for the technical details. */
  readonly codes: readonly string[];
}
export interface Abilities { readonly canPrepare: boolean; readonly canApprove: boolean }

const PREFIX: Record<Subject, string> = { first_period: "FIRST_PERIOD_", opening_balances: "OPENING_SUPPORT_" };
const TITLES: Record<ReviewKind, string> = {
  cannot_confirm: "Cannot confirm", not_applicable: "Not a first reporting period", prerequisite: "Not ready yet", not_started: "Not started",
  legacy_claim: "Earlier declaration: an unverified claim", needs_correction: "The facts do not meet the rules yet", awaiting_approval: "Awaiting approval",
  returned: "Returned to the preparer", stale: "Approval out of date", approved: "Approved",
};
const CANNOT_CONFIRM = "The server's answer could not be read, so nothing here is treated as approved. Reload the page; until it reads, the comparatives are still required.";

function cannotConfirm(codes: readonly string[] = []): ReviewView {
  return { kind: "cannot_confirm", title: TITLES.cannot_confirm, nextAction: CANNOT_CONFIRM, primary: null, note: null, codes };
}

/**
 * Maps ONE subject of the server's status to what the page shows. Fails closed: an unknown state, an unknown reason code, a
 * reason without its next action, a "verified" without a verified decision, or a pending state without a reason is
 * "cannot confirm" - never approved, never a green state.
 */
export function reviewView(s: SubjectStatus | null | undefined, subject: Subject, a: Abilities): ReviewView {
  if (!s || s.subject !== subject) return cannotConfirm();
  const codes = s.items.map((i) => i.code);
  if (s.items.some((i) => !i.code.startsWith(PREFIX[subject]) || !(i.code in FIRST_PERIOD_NEXT_ACTIONS) || !i.nextAction)) return cannotConfirm(codes);
  const first = s.items[0];
  const v = (kind: ReviewKind, nextAction: string, primary: PrimaryAction, note: string | null): ReviewView => ({ kind, title: TITLES[kind], nextAction, primary, note, codes });
  const recorder = s.claim?.recordedByYou === true;
  const prepare = (kind: ReviewKind, at = first) => v(kind, at!.nextAction!, a.canPrepare ? "record_facts" : null, a.canPrepare ? null : "A preparer records the facts and the evidence.");
  const review = (kind: ReviewKind, at = first) => {
    if (a.canApprove && !recorder) return v(kind, at!.nextAction!, "review", null);
    return v(kind, at!.nextAction!, null, recorder && a.canApprove
      ? "You recorded these facts, so you cannot approve them. A different partner or manager must review them."
      : "Waiting for a partner or manager other than the person who recorded the facts.");
  };

  if (s.state === "verified") {
    if (s.items.length !== 0 || s.pending.length !== 0 || s.claim === null || s.decision?.outcome !== "verified") return cannotConfirm(codes);
    return v("approved", subject === "first_period"
      ? "A different partner or manager verified the first-period facts. Comparatives are not required while this approval stays in force."
      : "A different partner or manager verified the opening-balance support.", null, null);
  }
  if (s.items.length === 0 || s.items.length !== s.pending.length) return cannotConfirm(codes);
  if (s.state === "not_eligible") {
    if (subject !== "first_period") return cannotConfirm(codes);
    const why = s.items.find((i) => ["FIRST_PERIOD_EARLIER_BOOKS_EXIST", "FIRST_PERIOD_NOT_FIRST_ON_EVIDENCE", "FIRST_PERIOD_PRIOR_STATEMENTS_EXIST"].includes(i.code));
    return why ? v("not_applicable", why.nextAction!, null, null) : cannotConfirm(codes);
  }
  if (s.state !== "pending") return cannotConfirm(codes);

  const staleItem = s.items.find((i) => /_(DECISION_STALE|RULES_CHANGED)$/.test(i.code));
  const factItems = s.items.filter((i) => !/_(DECISION_STALE|RULES_CHANGED|REVIEW_PENDING|REVIEW_REFUSED)$/.test(i.code));
  const only = (suffix: string) => codes.length === 1 && codes[0] === `${PREFIX[subject]}${suffix}`;
  const prereq = s.items.find((i) => i.code === "FIRST_PERIOD_PERIOD_UNKNOWN" || i.code === "OPENING_SUPPORT_FIRST_PERIOD_FACTS_MISSING");
  if (prereq) return v("prerequisite", prereq.nextAction!, null, null);
  if (staleItem) {
    if (s.decision?.outcome !== "verified" || s.claim === null) return cannotConfirm(codes);
    return factItems.length > 0 ? prepare("stale", factItems[0]) : review("stale", staleItem);
  }
  if (only("LEGACY_DECLARATION_UNVERIFIED")) return s.claim === null ? prepare("legacy_claim") : cannotConfirm(codes);
  if (only("FACTS_MISSING") || only("MISSING")) return s.claim === null ? prepare("not_started") : cannotConfirm(codes);
  if (s.claim === null) return cannotConfirm(codes);
  if (only("REVIEW_PENDING")) return review("awaiting_approval");
  if (only("REVIEW_REFUSED")) return s.decision?.outcome === "not_verified" ? prepare("returned") : cannotConfirm(codes);
  if (factItems.length === s.items.length) return prepare("needs_correction");
  return cannotConfirm(codes);
}

// ── Words for the server's write outcomes ─────────────────────────────────────────────────────────────────────────────
const COMMON: Readonly<Record<string, string>> = {
  forbidden: "Your role cannot do this; nothing was recorded.",
  feature_disabled: "Financial statements are not enabled for this company; nothing was recorded.",
  request_reused: "This request was already used for something else; nothing was recorded.",
  no_claim: "There are no first-period facts to decide; nothing was recorded.",
  unchanged: "Nothing changed: the server already holds this.",
  replay: "Already recorded (this was a retry of the same request).",
};
export const EVIDENCE_OUTCOMES: Readonly<Record<string, string>> = {
  ...COMMON,
  forbidden: "Only a member who prepares the close can record evidence; nothing was recorded.",
  unchanged: "This document is already recorded with these dates; nothing changed.",
  issued_on_in_future: "The issue date cannot be in the future; nothing was recorded.",
  nothing_to_retract: "There is no current revision to retract; nothing was recorded.",
  invalid_request: "The evidence was refused: the kind, a reference of 3 to 300 characters, the issue date, the date the document establishes and the document itself are required.",
};
export const CLAIM_OUTCOMES: Readonly<Record<string, string>> = {
  ...COMMON,
  forbidden: "Only a member who prepares the close can record the facts; nothing was recorded.",
  evidence_not_current: "A cited evidence revision has been replaced or retracted since the page was loaded; nothing was recorded. Choose the current revisions.",
  invalid_request: "The facts were refused; nothing was recorded.",
};
export const DECISION_OUTCOMES: Readonly<Record<string, string>> = {
  ...COMMON,
  forbidden: "Only a partner or manager who approves certifications can decide; nothing was recorded.",
  separate_approver_required: "You recorded these facts, so you cannot approve them; nothing was recorded. A different partner or manager must review them.",
  not_ready: "The facts do not meet the rules yet, so they cannot be verified; nothing was recorded.",
  changed_since_viewed: "Something changed after this page was loaded (new evidence, new facts, or a change to the company or period); nothing was recorded. Review what is shown now and decide again.",
  invalid_request: "A reason of 3 to 1,500 characters is required; nothing was recorded.",
};

export interface Outcome { outcome: string; detail?: string; pending?: string[]; [k: string]: unknown }
/** A server outcome in words: the outcome's own sentence, the server's detail kept, each unmet rule with its next action. */
export function outcomeWords(table: Readonly<Record<string, string>>, r: Outcome): string {
  if (r.outcome === "invalid_request" && typeof r.detail === "string" && table[r.detail]) return table[r.detail];
  const base = table[r.outcome] ?? `The server answered: ${r.outcome}; nothing is assumed.`;
  const detail = r.outcome === "invalid_request" && typeof r.detail === "string" ? ` (${r.detail})` : "";
  const pending = Array.isArray(r.pending) ? r.pending.map((x) => FIRST_PERIOD_NEXT_ACTIONS[String(x).split(":")[0]] ?? String(x)) : [];
  return `${base}${detail}${pending.length ? ` ${pending.join(" ")}` : ""}`;
}

// ── The calls (each one RPC; the transport is the workbench's) ─────────────────────────────────────────────────────────
export interface FirstPeriodDb { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> }
export interface EvidenceInput { kind: EvidenceKind; reference: string; issuedOn: string; assertedDate: string | null; documentSha256: string; note: string | null; retract: boolean }

export function firstPeriodClient(db: FirstPeriodDb) {
  const call = async (fn: string, args: Record<string, unknown>): Promise<Outcome> => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    const o = data as Outcome | null;
    if (!o || typeof o.outcome !== "string") throw new Error(`${fn} returned no outcome`);
    return o;
  };
  return {
    /** Reads never throw: a failed read is "unknown" (cannot confirm). */
    status: async (companyId: string, periodYear: number): Promise<ParsedStatus> => {
      try {
        const { data, error } = await db.rpc("fs_first_period_status", { p_company_id: companyId, p_period_year: periodYear });
        return error ? { state: "unknown", reason: error.message } : parseFirstPeriodStatus(data);
      } catch (e) { return { state: "unknown", reason: e instanceof Error ? e.message : "read failed" }; }
    },
    recordEvidence: (companyId: string, periodYear: number, e: EvidenceInput, requestId: string) =>
      call("fs_record_first_period_evidence", { p_company_id: companyId, p_period_year: periodYear, p_kind: e.kind, p_reference: e.reference, p_issued_on: e.issuedOn,
        p_asserted_date: e.assertedDate, p_document_sha256: e.documentSha256, p_note: e.note, p_retract: e.retract, p_request_id: requestId }),
    submitClaim: (companyId: string, periodYear: number, subject: Subject, facts: Record<string, unknown>, basis: string, evidenceIds: readonly string[], requestId: string) =>
      call("fs_submit_first_period_claim", { p_company_id: companyId, p_period_year: periodYear, p_subject: subject, p_facts: facts, p_basis: basis, p_evidence_ids: [...evidenceIds], p_request_id: requestId }),
    /** `binding` is what the page showed the approver (status.<subject>.binding); the server refuses a decision on anything else. */
    decide: (companyId: string, periodYear: number, subject: Subject, verify: boolean, reason: string, requestId: string, binding: string | null) =>
      call("fs_decide_first_period", { p_company_id: companyId, p_period_year: periodYear, p_subject: subject, p_verify: verify, p_reason: reason, p_request_id: requestId, p_expected_binding: binding }),
    withdraw: (companyId: string, periodYear: number, subject: Subject, reason: string, requestId: string) =>
      call("fs_withdraw_first_period", { p_company_id: companyId, p_period_year: periodYear, p_subject: subject, p_reason: reason, p_request_id: requestId }),
  };
}
export type FirstPeriodClient = ReturnType<typeof firstPeriodClient>;

// ── The facts the page builds (the server validates them again; the reporting dates are always the server's) ─────────
export interface FirstPeriodFactsInput {
  legalName: string; registrationNumber: string; tin: string; basis: "incorporated_in_period" | "commenced_after_dormancy";
  registrationDate: string; effectiveStart: string; priorStatementsPrepared: boolean; dormantFrom: string; dormantThrough: string;
}
export function firstPeriodFacts(f: FirstPeriodFactsInput, period: { reportingStart: string; reportingEnd: string }): Record<string, unknown> {
  return {
    legalName: f.legalName.trim(), registrationNumber: f.registrationNumber.trim(), ...(f.tin.trim() ? { tin: f.tin.trim() } : {}), basis: f.basis,
    registrationDate: f.registrationDate, effectiveStart: f.effectiveStart, reportingStart: period.reportingStart, reportingEnd: period.reportingEnd,
    priorStatementsPrepared: f.priorStatementsPrepared,
    ...(f.basis === "commenced_after_dormancy" ? { dormantFrom: f.dormantFrom, dormantThrough: f.dormantThrough } : {}),
  };
}
export const BASIS_MIN = 20;
export const BASIS_MAX = 1500;
export const basisOk = (t: string) => t.trim().length >= BASIS_MIN && t.trim().length <= BASIS_MAX;

/** SHA-256 of a document's bytes, lower-case hex (the document itself is not sent anywhere). */
export async function documentSha256(bytes: ArrayBuffer): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
