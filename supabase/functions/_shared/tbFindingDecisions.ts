/**
 * Trial-balance finding decisions and the evaluation manifest (engine generation 7; 20261118100000).
 *
 * Pure. The engine reads the upload's current decisions (tb_current_finding_decisions: its own newest decision per
 * finding, made against the same source bytes, under the same layout revision and — for an entity finding — the same
 * entity revision) and the workspace's requirement for each decision-taking code (tb_finding_requirements: entity always;
 * clearing balances only under a recorded policy; amount-free trailing text never), then — at the one place a
 * certification is built — applies them to the complete findings and reports every rule it evaluated:
 *
 *   · each decision-taking finding states decision_required (the database recomputes it) and cites its current decision;
 *   · a decision that does not resolve (different entity; the trailing text IS part of the trial balance) adds a blocking
 *     finding with its recovery — the file is never accepted as it stands, and nothing is dropped or adjusted silently;
 *   · an undecided REQUIRED finding makes an otherwise accepted result "needs review"; an undecided review indicator does
 *     not (it stays a note on the result);
 *   · the manifest names every rule of tb_evaluation_rules(7) once, with outcomes consistent with the findings.
 *
 * Nothing here changes an amount, adds or removes a row, or claims anything about the originating ledger.
 */

/** What a finding needs to carry for decisions: the engine's own finding record plus the identity fields. */
export interface DecisionFinding {
  code: string;
  layer: number;
  severity: "error" | "warning" | "info";
  accountCode: string | null;
  message: string;
  rows?: number[];
  subject?: string;
  file_entity?: string;
  decision_required?: boolean;
  decision?: { id: string; action: string };
}

export interface CurrentDecision {
  decisionId: string;
  code: string;
  subject: string;
  action: string;
  resolves: boolean;
}

/** The workspace's requirement per decision-taking code (tb_finding_requirements). */
export type Requirements = Readonly<Record<string, boolean>>;

/** The codes that take a recorded decision (tb_decision_actions). */
export const DECISION_CODES: ReadonlySet<string> = new Set(["ENTITY_NAME_DIFFERS", "UNRECOGNISED_TRAILING_TEXT", "CLEARING_ACCOUNT_BALANCE"]);

export const EVALUATION_RULES = [
  "source_read", "columns", "period_and_currency", "duplicate_identities", "balance", "entity_name", "trailing_text",
  "clearing_accounts", "classification",
] as const;
export type EvaluationRule = (typeof EVALUATION_RULES)[number];
export type RuleOutcome = "passed" | "finding" | "not_applicable" | "not_reached";

/** The manifest rule a finding code is reported under (mirrors public.tb_finding_rule). */
export const FINDING_RULE: Readonly<Record<string, EvaluationRule>> = {
  ENTITY_NAME_DIFFERS: "entity_name", ENTITY_WRONG_DESTINATION: "entity_name",
  UNRECOGNISED_TRAILING_TEXT: "trailing_text", LAYOUT_CORRECTION_REQUIRED: "trailing_text",
  CLEARING_ACCOUNT_BALANCE: "clearing_accounts",
  TRIAL_BALANCE_IMBALANCE: "balance",
  DUPLICATE_ACCOUNT_CODE: "duplicate_identities", DUPLICATE_ACCOUNT_NAME: "duplicate_identities",
  PERIOD_MISMATCH: "period_and_currency", CURRENCY_MISMATCH: "period_and_currency", PERIOD_MISSING: "period_and_currency",
  CURRENCY_MISSING: "period_and_currency", CURRENCY_UNSUPPORTED: "period_and_currency",
  NEEDS_REVIEW: "classification",
};
/** The rules whose outcome the database cross-checks against the findings (both directions). */
const STRICT_RULES: ReadonlySet<EvaluationRule> = new Set(["entity_name", "trailing_text", "clearing_accounts", "balance"]);

const key = (code: string, subject: string) => `${code}\u0000${subject}`;

export interface AppliedDecisions {
  findings: DecisionFinding[];
  /** REQUIRED findings without a current, resolving decision (they hold acceptance). */
  undecided: DecisionFinding[];
  /** Review indicators without a decision (they never hold acceptance). */
  notes: DecisionFinding[];
  /** Blocking findings added for decisions that do not resolve (each with its recovery). */
  blocking: DecisionFinding[];
}

export function applyDecisions(findings: readonly DecisionFinding[], decisions: readonly CurrentDecision[], requirements: Requirements): AppliedDecisions {
  const byKey = new Map(decisions.map((d) => [key(d.code, d.subject), d]));
  const out: DecisionFinding[] = [];
  const undecided: DecisionFinding[] = [];
  const notes: DecisionFinding[] = [];
  const blocking: DecisionFinding[] = [];
  for (const raw of findings) {
    if (!DECISION_CODES.has(raw.code) || !raw.subject) { out.push(raw); continue; }
    const required = requirements[raw.code];
    if (typeof required !== "boolean") throw new Error(`no requirement known for ${raw.code}`);
    const f: DecisionFinding = { ...raw, decision_required: required };
    const d = byKey.get(key(f.code, f.subject!));
    if (!d) { out.push(f); (required ? undecided : notes).push(f); continue; }
    const cited: DecisionFinding = { ...f, decision: { id: d.decisionId, action: d.action } };
    out.push(cited);
    if (d.resolves) continue;
    if (f.code === "ENTITY_NAME_DIFFERS") {
      blocking.push({
        code: "ENTITY_WRONG_DESTINATION", layer: 2, severity: "error", accountCode: null, rows: f.rows,
        message: `You recorded that this file is for ${f.file_entity ?? "another entity"}, not this workspace's entity. Remove it from this engagement and upload it to the right one.`,
      });
    } else if (f.code === "UNRECOGNISED_TRAILING_TEXT") {
      blocking.push({
        code: "LAYOUT_CORRECTION_REQUIRED", layer: 2, severity: "error", accountCode: null, rows: f.rows,
        message: `You recorded that rows ${(f.rows ?? []).join(", ")} are part of the trial balance, but they have no amounts this check can read. Correct the layout or the file and check it again.`,
      });
    }
  }
  return { findings: [...out, ...blocking], undecided, notes, blocking };
}

/**
 * The evaluation manifest. `reached` is how far this check got: "ingestion" (stopped by a blocking ingestion finding; the
 * balance is evaluated only when the accounts were complete), "classification" (accounts needing review) or "complete".
 */
export function evaluationManifest(findings: readonly DecisionFinding[], reached: "ingestion" | "classification" | "complete",
  balanceEvaluated: boolean): { format: "tb-evaluation/1"; rules: { rule: EvaluationRule; outcome: RuleOutcome }[] } {
  const found = new Set(findings.map((f) => FINDING_RULE[f.code]).filter(Boolean));
  const rules = EVALUATION_RULES.map((rule): { rule: EvaluationRule; outcome: RuleOutcome } => {
    if (found.has(rule)) return { rule, outcome: "finding" };
    if (rule === "balance" && !balanceEvaluated) return { rule, outcome: "not_reached" };
    if (rule === "classification" && reached === "ingestion") return { rule, outcome: "not_reached" };
    return { rule, outcome: "passed" };
  });
  return { format: "tb-evaluation/1", rules };
}

/** Whether a manifest is consistent with its findings, exactly as tb_finalize_attempt checks it (used by tests). */
export function manifestAgrees(findings: readonly DecisionFinding[], rules: readonly { rule: string; outcome: string }[]): boolean {
  const outcome = new Map(rules.map((r) => [r.rule, r.outcome]));
  if (rules.length !== EVALUATION_RULES.length || EVALUATION_RULES.some((r) => !outcome.has(r))) return false;
  for (const f of findings) { const r = FINDING_RULE[f.code]; if (r && STRICT_RULES.has(r) && outcome.get(r) !== "finding") return false; }
  for (const r of STRICT_RULES) {
    if (outcome.get(r) === "finding" && !findings.some((f) => FINDING_RULE[f.code] === r)) return false;
  }
  return true;
}

// ── Reading (service role) ───────────────────────────────────────────────────────────────────────────────────────────

export type DecisionsRead = { kind: "unavailable" } | { kind: "read"; decisions: CurrentDecision[] };
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

/**
 * The upload's current decisions. "unavailable" when the database has no decision authority yet (20261118100000 not
 * applied: the function does not exist) — the generation-7 engine then refuses before writing anything, never treating a
 * missing authority as "no decisions". Any other error is thrown (a processing failure).
 */
export async function readCurrentDecisions(rpc: Rpc, uploadId: string): Promise<DecisionsRead> {
  const { data, error } = await rpc("tb_current_finding_decisions", { p_upload_id: uploadId });
  if (error && (error.code === "PGRST202" || error.code === "42883")) return { kind: "unavailable" };
  if (error) throw new Error(`finding decisions lookup failed: ${error.code ?? "unknown"}`);
  const rows = Array.isArray(data) ? data : [];
  const decisions = rows.map((r): CurrentDecision => {
    const o = r as Record<string, unknown>;
    if (typeof o.decision_id !== "string" || typeof o.code !== "string" || typeof o.subject !== "string" || typeof o.action !== "string" || typeof o.resolves !== "boolean") {
      throw new Error("finding decisions lookup returned a malformed row");
    }
    return { decisionId: o.decision_id, code: o.code, subject: o.subject, action: o.action, resolves: o.resolves };
  });
  return { kind: "read", decisions };
}

/** The workspace's requirement per decision-taking code; "unavailable" when the authority is missing (as above). */
export async function readRequirements(rpc: Rpc, companyId: string): Promise<{ kind: "unavailable" } | { kind: "read"; requirements: Requirements }> {
  const { data, error } = await rpc("tb_finding_requirements", { p_company_id: companyId });
  if (error && (error.code === "PGRST202" || error.code === "42883")) return { kind: "unavailable" };
  if (error) throw new Error(`finding requirements lookup failed: ${error.code ?? "unknown"}`);
  const o = (data && typeof data === "object" && !Array.isArray(data) ? data : null) as Record<string, unknown> | null;
  if (!o || [...DECISION_CODES].some((c) => typeof o[c] !== "boolean")) throw new Error("finding requirements lookup returned a malformed answer");
  return { kind: "read", requirements: Object.fromEntries([...DECISION_CODES].map((c) => [c, o[c] as boolean])) };
}

export const sameRequirements = (a: Requirements, b: Requirements) => [...DECISION_CODES].every((c) => a[c] === b[c]);

/** The same set of decisions (ids and actions), whatever the order — the post-snapshot re-read compares with this. */
export function sameDecisions(a: readonly CurrentDecision[], b: readonly CurrentDecision[]): boolean {
  const s = (x: readonly CurrentDecision[]) => x.map((d) => `${d.decisionId}:${d.action}`).sort().join("|");
  return s(a) === s(b);
}

export const DECISIONS_AUTHORITY_UNAVAILABLE = {
  status: "unavailable",
  code: "DECISIONS_AUTHORITY_UNAVAILABLE",
  message: "Trial balance checks are briefly unavailable while an update is completed. Nothing was changed; try again shortly.",
} as const;
