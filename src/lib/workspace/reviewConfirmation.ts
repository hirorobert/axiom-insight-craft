/**
 * reviewConfirmation — what the account review makes explicit about confirmation (DEFECT-UX-TB-REVIEW-CONFIRMATION-
 * VISIBILITY-001). Pure; presentation only. The review contract itself is unchanged: only the company's own reviewed
 * mapping matched exactly stands without a reviewer; every other classification is a pre-selected SUGGESTION that a
 * reviewer confirms with "Save & reprocess" (resolve_account_review_batch records each decision with the
 * server-resolved firm member).
 *
 *   · Before saving: each row says whether it is a suggestion not yet confirmed, a changed classification, an exclusion
 *     or a kept treatment — none is saved yet — and the action states how many it will confirm.
 *   · After saving: the record lists the accounts confirmed for THIS trial balance, how and by whom (from the stored
 *     decisions), and the accounts that stood on a previously reviewed mapping (they were not confirmed in this run).
 */

export const CLASSIFICATION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  current_assets: "Current Assets", non_current_assets: "Non-Current Assets", current_liabilities: "Current Liabilities",
  non_current_liabilities: "Non-Current Liabilities", equity: "Equity", revenue: "Revenue", cost_of_goods_sold: "Cost of Goods Sold",
  operating_expenses: "Operating Expenses", other_income: "Other Income", taxes: "Taxes",
});
export const classificationWords = (c: string | null | undefined) => (c ? CLASSIFICATION_WORDS[c] ?? c : "Not recorded");

// ── Before saving ─────────────────────────────────────────────────────────────────────────────────────────────────

export type RowConfirmation = "suggested_unconfirmed" | "changed_unsaved" | "excluded_unsaved" | "kept_unsaved" | null;

export const ROW_CONFIRMATION_LABEL: Readonly<Record<Exclude<RowConfirmation, null>, string>> = Object.freeze({
  suggested_unconfirmed: "Suggested — not yet confirmed",
  changed_unsaved: "Your classification — not yet saved",
  excluded_unsaved: "Excluded — not yet saved",
  kept_unsaved: "Kept as mapped — not yet saved",
});

/** A row's confirmation state from what is on screen: the suggestion it started with, the current choice, exclusion. */
export function rowConfirmation(i: { suggested?: string | null; choice?: string | null; excluded: boolean; keepChoice?: string }): RowConfirmation {
  if (i.excluded) return "excluded_unsaved";
  if (!i.choice) return null;
  if (i.keepChoice && i.choice === i.keepChoice) return "kept_unsaved";
  return i.suggested && i.choice === i.suggested ? "suggested_unconfirmed" : "changed_unsaved";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The save action, with the count it confirms: "Confirm 3 classifications and reprocess". */
export function confirmActionLabel(i: { classifications: number; excluded: number }): string {
  const parts: string[] = [];
  if (i.classifications > 0) parts.push(`Confirm ${plural(i.classifications, "classification", "classifications")}`);
  if (i.excluded > 0) parts.push(`${parts.length ? "exclude" : "Exclude"} ${plural(i.excluded, "account", "accounts")}`);
  return parts.length ? `${parts.join(", ")} and reprocess` : "Save & reprocess";
}

// ── After saving: the record ──────────────────────────────────────────────────────────────────────────────────────

export interface RecordAccount { account_code: string | null; account_name: string; classification: string }
export interface StoredDecision {
  account_code: string | null; normalized_account_name: string; review_account_key: string; decision_action: string;
  new_value: { classification?: string | null } | null; firm_member_id: string; created_at: string; sequence_no: number;
}
export interface DecisionMember { id: string; user_id: string; role: string; invited_email: string | null }
export interface CompanyMapping { account_code: string | null; normalized_account_name: string | null; review_decision_id: string | null }

export const DECISION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  USER_ACCEPTED_SUGGESTION: "Suggestion confirmed",
  USER_MANUAL_CLASSIFICATION: "Classification chosen",
  MARK_NON_REPORTING_ACCOUNT: "Excluded as non-reporting",
  CONFIRM_ACCOUNT_TREATMENT: "Kept as mapped (treatment confirmed)",
});

/** The server's account-name normalisation (lower case, punctuation removed, spaces collapsed), for matching only. */
export const normaliseAccountName = (s: string) => s.toLowerCase().replace(/[\p{P}\p{S}]/gu, "").replace(/\s+/g, " ").trim();
const keyOf = (code: string | null | undefined, name: string) => (code && code.trim() ? `c:${code.trim()}` : `n:${normaliseAccountName(name)}`);

export function memberWords(m: DecisionMember | undefined, currentUserId: string | null): string {
  if (!m) return "a member of this workspace";
  const role = m.role ? ` (${m.role})` : "";
  if (currentUserId && m.user_id === currentUserId) return `you${role}`;
  return `${m.invited_email ?? "a member of this workspace"}${role}`;
}

export type RecordBasis = "confirmed_here" | "previously_reviewed" | "no_review_record";
export interface RecordRow {
  key: string; account_code: string | null; account_name: string; classification: string; basis: RecordBasis;
  /** confirmed_here only */
  action?: string; by?: string; at?: string;
}

/** Every account on the trial balance, with the basis of its classification (latest decision for this upload wins). */
export function buildReviewRecord(i: {
  accounts: readonly RecordAccount[]; decisions: readonly StoredDecision[]; members: readonly DecisionMember[];
  mappings: readonly CompanyMapping[]; currentUserId: string | null;
}): { rows: RecordRow[]; confirmed: number; previouslyReviewed: number; noRecord: number } {
  const latest = new Map<string, StoredDecision>();
  for (const d of [...i.decisions].sort((a, b) => a.sequence_no - b.sequence_no)) latest.set(keyOf(d.account_code, d.normalized_account_name), d);
  const reviewed = new Set(i.mappings.filter((m) => !!m.review_decision_id).map((m) => keyOf(m.account_code, m.normalized_account_name ?? "")));
  const members = new Map(i.members.map((m) => [m.id, m]));
  const rows: RecordRow[] = i.accounts.map((a) => {
    const key = keyOf(a.account_code, a.account_name);
    const d = latest.get(key);
    if (d) {
      return { key, account_code: a.account_code, account_name: a.account_name, classification: a.classification, basis: "confirmed_here",
        action: DECISION_WORDS[d.decision_action] ?? "Decision recorded", by: memberWords(members.get(d.firm_member_id), i.currentUserId), at: d.created_at };
    }
    return { key, account_code: a.account_code, account_name: a.account_name, classification: a.classification, basis: reviewed.has(key) ? "previously_reviewed" : "no_review_record" };
  });
  // Decisions for accounts no longer on the statements (e.g. excluded as non-reporting) are part of the record too.
  const onStatements = new Set(rows.map((r) => r.key));
  for (const [key, d] of latest) {
    if (onStatements.has(key)) continue;
    rows.push({ key, account_code: d.account_code, account_name: d.normalized_account_name, classification: d.new_value?.classification ?? "",
      basis: "confirmed_here", action: DECISION_WORDS[d.decision_action] ?? "Decision recorded", by: memberWords(members.get(d.firm_member_id), i.currentUserId), at: d.created_at });
  }
  const order: Record<RecordBasis, number> = { confirmed_here: 0, previously_reviewed: 1, no_review_record: 2 };
  rows.sort((a, b) => order[a.basis] - order[b.basis] || (a.account_code ?? a.account_name).localeCompare(b.account_code ?? b.account_name));
  const count = (b: RecordBasis) => rows.filter((r) => r.basis === b).length;
  return { rows, confirmed: count("confirmed_here"), previouslyReviewed: count("previously_reviewed"), noRecord: count("no_review_record") };
}

/** One sentence for the live region: what this review confirmed, by whom, and what stood on earlier reviews. */
export function recordSummary(r: { rows: RecordRow[]; confirmed: number; previouslyReviewed: number }, when: (iso: string) => string): string {
  const confirmed = r.rows.filter((x) => x.basis === "confirmed_here");
  const who = [...new Set(confirmed.map((x) => x.by))];
  const last = confirmed.map((x) => x.at ?? "").sort().pop();
  const first = r.confirmed > 0
    ? `${plural(r.confirmed, "account", "accounts")} confirmed in this review by ${who.join(", ")}${last ? `, ${when(last)}` : ""}.`
    : "No account was confirmed in this review.";
  const second = r.previouslyReviewed > 0 ? ` ${plural(r.previouslyReviewed, "account stood", "accounts stood")} on a previously reviewed mapping.` : "";
  return first + second;
}

/** The trial balance's accounts as the stored result lists them (processing_result.statements), with their section. */
export function statementAccounts(processingResult: unknown): RecordAccount[] {
  const st = (processingResult as { statements?: Record<string, Record<string, { accounts?: { account_code?: string; account_name?: string }[] }> | null> | null } | null)?.statements;
  if (!st) return [];
  const out: RecordAccount[] = [];
  for (const statement of ["balance_sheet", "income_statement"]) {
    for (const [classification, section] of Object.entries(st[statement] ?? {})) {
      for (const a of section?.accounts ?? []) {
        if (!a?.account_name && !a?.account_code) continue;
        const code = a.account_code && a.account_code !== a.account_name ? a.account_code : null;
        out.push({ account_code: code, account_name: a.account_name ?? a.account_code ?? "", classification });
      }
    }
  }
  return out;
}
