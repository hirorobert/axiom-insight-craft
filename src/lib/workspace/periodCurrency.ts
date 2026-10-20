/**
 * periodCurrency — correcting a reporting period's currency (20261113100000).
 *
 * The ONE browser path: get_period_currency_correction (may it be corrected, and if not, which record prevents it) and
 * correct_period_currency (the authorised, recorded, idempotent, version-checked change). The server decides; this
 * module only reads its answers strictly and turns them into words. A refusal always names the record that prevents
 * the correction and the route that still works, so the page never offers a control the server would refuse.
 *
 * After a correction, each active trial balance of the period is re-checked through the normal path (requestReprocess:
 * tbu_request_reprocess, then process-trial-balance) with the deterministic operation id the server returned, so a
 * retry of a failed or interrupted re-check reuses the same request.
 */
import { requestReprocess, ReprocessRefusedError, type ReprocessClient } from "@/lib/workspace/requestReprocess";

export type CorrectionBlockCode = "ACCEPTED_CERTIFICATION" | "DOWNSTREAM_RECORD" | "PROCESSING_IN_PROGRESS" | "PERIOD_LOCKED" | "NOT_FOUND"
  | "DEPENDENCY_NOT_VISIBLE" | "DEPENDENCY_UNSUPPORTED" | "DEPENDENCY_NOT_LOCKABLE";
export interface CorrectionBlock {
  code: CorrectionBlockCode | string;
  relation: string | null;
  recordId: string | null;
  requiresReview: boolean | null;
  certifiedAt: string | null;
}
export interface Recheck { uploadId: string; operationId: string }
/** The latest recorded correction of the period (no reason or actor: those stay in the history). */
export interface LastCorrection { eventId: string; from: string; to: string; occurredAt: string; rechecks: Recheck[] }
export type Eligibility =
  | { kind: "eligible"; periodId: string; currency: string; lastCorrection: LastCorrection | null }
  | { kind: "not_eligible"; periodId: string; currency: string; block: CorrectionBlock; lastCorrection: LastCorrection | null }
  /** not_authorised: the server answered that this person may not see or correct it; error: no usable answer. */
  | { kind: "unavailable"; reason: "not_authorised" | "error" };

export type CorrectionResult =
  | { kind: "corrected"; eventId: string; from: string; to: string; rechecks: Recheck[]; replayed: boolean }
  | { kind: "stale"; currency: string }
  | { kind: "unchanged"; currency: string }
  | { kind: "not_eligible"; currency: string; block: CorrectionBlock }
  /** Other work in the workspace was being saved; nothing changed and the same request may be retried. */
  | { kind: "busy" }
  | { kind: "refused"; code: string };

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function parseBlock(v: unknown): CorrectionBlock {
  const b = obj(v);
  return { code: str(b.code) ?? "UNKNOWN", relation: str(b.relation), recordId: str(b.record_id),
    requiresReview: typeof b.requires_review === "boolean" ? b.requires_review : null, certifiedAt: str(b.certified_at) };
}
function parseRechecks(v: unknown): Recheck[] {
  return Array.isArray(v) ? v.map(obj).filter((r) => str(r.upload_id) && str(r.operation_id))
    .map((r) => ({ uploadId: r.upload_id as string, operationId: r.operation_id as string })) : [];
}

function parseLast(v: unknown): LastCorrection | null {
  const l = obj(v);
  const eventId = str(l.event_id), from = str(l.from), to = str(l.to), occurredAt = str(l.occurred_at);
  return eventId && from && to && occurredAt ? { eventId, from, to, occurredAt, rechecks: parseRechecks(l.rechecks) } : null;
}

export async function getCorrectionEligibility(rpc: Rpc, periodId: string): Promise<Eligibility> {
  const { data, error } = await rpc("get_period_currency_correction", { p_period_id: periodId });
  if (error) return { kind: "unavailable", reason: "error" };
  const d = obj(data);
  const currency = str(d.currency);
  const lastCorrection = parseLast(d.last_correction);
  if (d.outcome === "eligible" && currency) return { kind: "eligible", periodId, currency, lastCorrection };
  if (d.outcome === "not_eligible" && currency) return { kind: "not_eligible", periodId, currency, block: parseBlock(d.block), lastCorrection };
  return { kind: "unavailable", reason: d.outcome === "not_found" || d.outcome === "unauthenticated" ? "not_authorised" : "error" };
}

export async function correctPeriodCurrency(rpc: Rpc, input: { periodId: string; to: string; from: string; reason: string; requestId: string }): Promise<CorrectionResult> {
  const { data, error } = await rpc("correct_period_currency", {
    p_period_id: input.periodId, p_new_currency: input.to, p_expected_currency: input.from, p_reason: input.reason, p_request_id: input.requestId,
  });
  if (error) throw error;
  const d = obj(data);
  switch (d.outcome) {
    case "corrected":
    case "already_corrected":
      return { kind: "corrected", eventId: str(d.event_id) ?? "", from: str(d.from) ?? input.from, to: str(d.to) ?? input.to,
        rechecks: parseRechecks(d.rechecks), replayed: d.outcome === "already_corrected" };
    case "stale": return { kind: "stale", currency: str(d.currency) ?? "" };
    case "unchanged": return { kind: "unchanged", currency: str(d.currency) ?? input.to };
    case "not_eligible": return { kind: "not_eligible", currency: str(d.currency) ?? input.from, block: parseBlock(d.block) };
    case "busy": return { kind: "busy" };
    default: return { kind: "refused", code: typeof d.outcome === "string" ? d.outcome : "unknown" };
  }
}

export type RecheckOutcome = { uploadId: string; ok: true } | { uploadId: string; ok: false; message: string };

/** Re-checks each trial balance through the normal path with its deterministic id (a retry reuses it). */
export async function runRechecks(client: ReprocessClient, rechecks: readonly Recheck[], ensureFreshSession: () => Promise<unknown>): Promise<RecheckOutcome[]> {
  const out: RecheckOutcome[] = [];
  for (const r of rechecks) {
    try {
      await requestReprocess(client, r.uploadId, { ensureFreshSession, newOperationId: () => r.operationId });
      out.push({ uploadId: r.uploadId, ok: true });
    } catch (e) {
      out.push({ uploadId: r.uploadId, ok: false,
        message: e instanceof ReprocessRefusedError ? e.message : "The re-check could not be started. Check your connection and try again." });
    }
  }
  return out;
}

const RELATION_LABELS: Record<string, string> = {
  "public.account_review_decisions": "account review decisions",
  "public.account_review_batches": "account review decisions",
  "public.adjusting_journal_entries": "adjusting journal entries",
  "public.close_review_adjustments": "close review adjustments",
  "public.close_review_finding_runs": "close review findings",
  "public.statement_sign_offs": "statement sign-offs",
  "public.reporting_pack_issuances": "issued Reporting Packs",
  "public.tax_computations": "tax computations",
  "public.period_closing_balances": "closing balances",
  "public.management_inputs": "management inputs",
  "public.findings": "compliance findings",
  "public.safisha_reconciliations": "bank reconciliations",
  "public.hesabu_validations": "statement validations",
  "public.capital_allowances": "capital allowances",
  "public.tax_losses": "tax losses",
  "public.tax_payments": "tax payments",
  "public.xbrl_instance_documents": "filing packs",
};

/**
 * The relation in words. Financial-statement tables are named by family, never by table name: their names must not
 * enter the entry chunk (harnessIsolation.test.ts keeps the reporting workspace's markers in its own chunks).
 */
function relationLabel(relation: string | null): string {
  if (!relation) return "records in another part of the workspace";
  if (RELATION_LABELS[relation]) return RELATION_LABELS[relation];
  const table = relation.replace(/^public\./, "");
  if (/^(fs|financial)_/.test(table)) return "financial statements work";
  return `records in ${relation}`;
}

/** The exact reason and the route that still works, for a period whose currency cannot be corrected. */
export function explainBlock(block: CorrectionBlock, currency: string): { reason: string; route: string } {
  switch (block.code) {
    case "ACCEPTED_CERTIFICATION": {
      const when = block.certifiedAt ? ` on ${new Date(block.certifiedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : "";
      return {
        reason: `A trial balance in this period was already accepted in ${currency}${when}${block.requiresReview ? " (it is awaiting account review)" : ""}. Its amounts were recorded in ${currency}, so the period's currency is fixed.`,
        route: `Replace the file with one whose amounts are in ${currency}.`,
      };
    }
    case "DOWNSTREAM_RECORD": {
      const what = relationLabel(block.relation);
      return { reason: `This period already has ${what} built on its ${currency} amounts, so its currency is fixed.`,
        route: `Replace the file with one whose amounts are in ${currency}.` };
    }
    case "PROCESSING_IN_PROGRESS":
      return { reason: "A check of this trial balance is still running.", route: "Wait for it to finish, then change the currency." };
    case "DEPENDENCY_NOT_VISIBLE":
    case "DEPENDENCY_UNSUPPORTED":
    case "DEPENDENCY_NOT_LOCKABLE":
      // Fail closed: the server could not prove that nothing in this workspace depends on the period's amounts.
      return { reason: `The server cannot confirm that nothing in this workspace depends on the period's ${currency} amounts, so its currency stays fixed.`,
        route: `Replace the file with one whose amounts are in ${currency}, or contact support quoting “${block.code}”.` };
    case "PERIOD_LOCKED":
      return { reason: "This period is locked, so its currency cannot change.", route: `Replace the file with one whose amounts are in ${currency}.` };
    default:
      return { reason: "The currency of this period cannot be changed now.", route: `Replace the file with one whose amounts are in ${currency}.` };
  }
}

/** The refused-currency facts the server recorded on a check: the currency it checked against and the file's labels. */
export interface CurrencyMismatch { checkedAgainst: string; fileCodes: string[] }

/** Reads processing_result.ingestion: present only when that check recorded a CURRENCY_MISMATCH issue. */
export function readCurrencyMismatch(processingResult: unknown): CurrencyMismatch | null {
  const ing = obj(obj(processingResult).ingestion);
  const issues = Array.isArray(ing.issues) ? ing.issues.map(obj) : [];
  if (!issues.some((i) => i.code === "CURRENCY_MISMATCH")) return null;
  const checkedAgainst = str(ing.currency);
  if (!checkedAgainst) return null;
  const labels = Array.isArray(obj(ing.evidence).currencyLabels) ? (obj(ing.evidence).currencyLabels as unknown[]).map(obj) : [];
  const fileCodes = [...new Set(labels.map((l) => str(l.code)?.toUpperCase()).filter((c): c is string => !!c))].sort();
  return { checkedAgainst: checkedAgainst.toUpperCase(), fileCodes };
}

/**
 * What the blocked card offers, decided only from the server's answers (never a control the server would refuse):
 *   offer     the period may be corrected to the ONE currency the file names: confirm with a reason;
 *   recheck   the period already reports in the file's currency (corrected after this check): re-check the file;
 *   mixed     the file names several currencies: it must be corrected, no currency change can fix it;
 *   blocked   the server refuses a correction: the record that prevents it and the route that works;
 *   none      no recovery to offer here (no authority, no labels, or the read failed): the card's Replace stays.
 */
export type CorrectionView =
  | { kind: "offer"; from: string; to: string }
  | { kind: "recheck"; currency: string; checkedAgainst: string; recheck: Recheck | null }
  | { kind: "mixed"; codes: string[]; currency: string }
  | { kind: "blocked"; currency: string; to: string | null; reason: string; route: string }
  | { kind: "none" };

export function decideCorrectionView(mismatch: CurrencyMismatch | null, eligibility: Eligibility | null, uploadId: string): CorrectionView {
  if (!mismatch || !eligibility || eligibility.kind === "unavailable") return { kind: "none" };
  const current = eligibility.currency.toUpperCase();
  const codes = mismatch.fileCodes;
  if (codes.length === 1 && codes[0] === current && mismatch.checkedAgainst !== current) {
    const recheck = eligibility.lastCorrection?.to.toUpperCase() === current
      ? eligibility.lastCorrection.rechecks.find((r) => r.uploadId === uploadId) ?? null : null;
    return { kind: "recheck", currency: current, checkedAgainst: mismatch.checkedAgainst, recheck };
  }
  if (codes.length > 1) return { kind: "mixed", codes, currency: current };
  if (codes.length !== 1) return { kind: "none" };
  if (eligibility.kind === "not_eligible") {
    const { reason, route } = explainBlock(eligibility.block, current);
    return { kind: "blocked", currency: current, to: codes[0], reason, route };
  }
  return { kind: "offer", from: current, to: codes[0] };
}
