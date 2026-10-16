// Phase 5 prototype — MANUAL MULTI-ACCOUNT TREATMENT (deliberate reviewer selection; never inferred equivalence).
//
// Directive (UNCERTAIN ACCOUNTS):
//   - HIGH_UNCERTAINTY / NO_RECOGNISED_MEANING accounts are NOT auto-grouped for treatment acceptance by inferred
//     equivalence (that discipline lives in layer 4: such accounts are always `individual`, never in a proposal group).
//   - They MAY be organised VISUALLY by issue — with NO common treatment or approval implied (organiseByIssue).
//   - A reviewer MAY deliberately SELECT several accounts and assign ONE common treatment in a single action. Before
//     submission the UI must show the selected accounts, the proposed treatment, and the relevant warnings
//     (previewManualAssignment). The submission validates every selected account through the SAME server authority and is
//     ATOMIC: one invalid account rejects the whole batch (mirrors resolve_account_review_batch — see §ATOMICITY below).
//
// ATOMICITY (verified against supabase/migrations/20261007100000_treatment_authority_and_processing_control.sql):
//   resolve_account_review_batch validates EVERY decision in a first pass and RAISEs on the first invalid one BEFORE any
//   write; there is no per-decision try/catch and it returns a single aggregate result_summary. => batch acceptance is
//   ALL-OR-NOTHING. Partial outcomes do NOT exist server-side. So the honest UX is: show each account's PRE-FLIGHT outcome
//   before submission; submit only the confirmed set; a failing submit rejects the WHOLE batch naming the offending account
//   — never a silent skip, never a misleading blanket success.
//
// REASON: the real RPC requires a reason ONLY for CONFIRM_ACCOUNT_TREATMENT. A routine USER_MANUAL_CLASSIFICATION needs
// none (account_review_decisions.reason is TEXT NULL). No mandatory essay is invented; a reason is recorded when supplied.
import { accountKey, normalizeAccountName } from "./layer2_identity.mjs";
import { interpretMeaning } from "./layer3_meaning.mjs";
import { reuseContextOf } from "./reuseContext.mjs";
import { Refusal } from "./lifecycle.mjs";
import { sha256Hex } from "./util.mjs";

// The supported statement/classification pairs — a mirror of the real function's S1 validation (20261007100000 lines 541-544).
const SUPPORTED = {
  balance_sheet: new Set(["current_assets", "non_current_assets", "current_liabilities", "non_current_liabilities", "equity"]),
  income_statement: new Set(["revenue", "cost_of_goods_sold", "operating_expenses", "other_income", "taxes"]),
};
const ACTIVITY = new Set(["operating_activities", "investing_activities", "financing_activities"]);

/**
 * Organise individual (uncertain / unrecognised) accounts VISUALLY by issue. This is a presentation grouping ONLY:
 * every bucket carries impliesTreatment:false and impliesApproval:false. It never proposes a common treatment.
 */
export function organiseByIssue(individual, meaningsByKey = new Map()) {
  const buckets = new Map();
  for (const acc of individual) {
    const m = meaningsByKey.get(acc.account_key);
    const issue = acc.reason === "NO_RECOGNISED_MEANING" ? "NO_RECOGNISED_MEANING"
      : (m && m.signals && m.signals.includes("UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE")) ? "UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE"
        : "HIGH_UNCERTAINTY";
    if (!buckets.has(issue)) buckets.set(issue, { issue, impliesTreatment: false, impliesApproval: false, members: [] });
    buckets.get(issue).members.push({ account_key: acc.account_key, account_name: acc.account_name });
  }
  return [...buckets.values()];
}

// The server computes the review key as COALESCE(account_code, normalized account_name) — mirror it exactly so the local
// preflight derives the SAME identity the RPC will, rather than trusting a caller-supplied key.
function serverKey(d) {
  const code = d.account_code == null ? "" : String(d.account_code).trim();
  return code !== "" ? code : normalizeAccountName(d.account_name ?? "");
}

/** The server-authority validation of ONE proposed per-account decision. Returns null if OK, or a {code,detail} refusal. */
function validateDecision(d, seenKeys) {
  const key = serverKey(d);
  if ((d.proposal_type ?? "NONE") === "AUTO_MAPPED_RULE") return { code: "AUTO_MAPPED_RULE_NOT_AUTHORIZED", detail: key };
  const VALID_ACTIONS = new Set(["USER_ACCEPTED_SUGGESTION", "USER_MANUAL_CLASSIFICATION", "MARK_NON_REPORTING_ACCOUNT", "CONFIRM_ACCOUNT_TREATMENT"]);
  if (!VALID_ACTIONS.has(d.decision_action)) return { code: "INVALID_DECISION_ACTION", detail: d.decision_action };
  if (d.decision_action === "USER_ACCEPTED_SUGGESTION" || d.decision_action === "USER_MANUAL_CLASSIFICATION") {
    if (d.statement === "cash_flow" || ACTIVITY.has(d.classification)) return { code: "UNSUPPORTED_CASH_FLOW_CLASSIFICATION", detail: `${d.statement}/${d.classification}` };
    if (!SUPPORTED[d.statement] || !SUPPORTED[d.statement].has(d.classification)) return { code: "STATEMENT_CLASSIFICATION_MISMATCH", detail: `${d.statement ?? "NULL"}/${d.classification ?? "NULL"}` };
    if (d.normal_balance !== "debit" && d.normal_balance !== "credit") return { code: "NORMAL_BALANCE_REQUIRED", detail: key };
  }
  if (!key || key === "") return { code: "ACCOUNT_IDENTITY_UNRESOLVABLE", detail: d.account_name };
  if (seenKeys.has(key)) return { code: "DUPLICATE_ACCOUNT_IN_BATCH", detail: key };
  return null;
}

/**
 * Build the per-account decision payloads a manual common-treatment assignment produces — the EXACT wire shape the real
 * resolve_account_review_batch consumes (same field set as the group path; no local-only key is sent).
 */
export function buildManualDecisions(selected, treatment, reason) {
  return selected.map((s) => {
    const d = {
      account_code: s.account_code ?? null,
      account_name: s.account_name,
      proposal_type: "NONE",                       // a deliberate manual classification, not a machine suggestion
      decision_action: "USER_MANUAL_CLASSIFICATION",
      statement: treatment.statement,
      classification: treatment.classification,
      line_item: s.account_name,
      normal_balance: treatment.normal_balance,
    };
    if (reason != null && String(reason).trim() !== "") d.reason = String(reason);
    if (treatment.flag_candidate === "cash") d.is_cash_account = true;
    else if (treatment.flag_candidate === "retained") d.is_retained_earnings = true;
    else if (treatment.flag_candidate === "payroll") d.is_payroll_account = true;
    return d;
  });
}

/**
 * PREVIEW a manual common-treatment assignment WITHOUT writing. Returns, for each selected account: its identity, its
 * previous (reused) treatment if any, the proposed common treatment, advisory WARNINGS (role/sign signals — NOT errors),
 * and a blocking PRE-FLIGHT outcome (null = OK, else the exact refusal the server would raise). Also a batch-level `blocking`
 * list. This is what the UI shows before submission so each outcome is explicit.
 */
export function previewManualAssignment({ store, upload, summary, selectedKeys, treatment, reason }) {
  const accByKey = new Map(summary.accountsRead.map((a) => [accountKey(a), a]));
  const { meanings } = interpretMeaning(summary.accountsRead);
  const meaningByKey = new Map(meanings.map((m) => [m.account_key, m]));
  const seen = new Set();
  const selected = selectedKeys.map((k) => {
    const a = accByKey.get(k);
    return a ? { account_key: k, account_code: a.account_code ?? null, account_name: a.account_name } : { account_key: k, account_code: null, account_name: null, missing: true };
  });
  const decisions = buildManualDecisions(selected, treatment, reason);
  const rows = selected.map((s, i) => {
    const prior = store ? store.effective(upload.company_id, s.account_key) : null;
    const m = meaningByKey.get(s.account_key);
    const warnings = [];
    if (s.missing) warnings.push({ code: "ACCOUNT_NOT_IN_UPLOAD", advisory: false });
    if (m && m.signals && m.signals.includes("UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE")) warnings.push({ code: "UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE", advisory: true, note: "Role/sign review signal — NOT proof of a wrong mapping." });
    // A proposed-role sign WARNING (advisory) is distinct from a blocking preflight ERROR (an unsupported pair, below).
    if (m && m.nature && m.nature !== "unknown") {
      const impliedStatement = m.nature === "revenue" || m.nature === "expense" ? "income_statement" : "balance_sheet";
      if (treatment.statement !== impliedStatement) warnings.push({ code: "TREATMENT_DIFFERS_FROM_RECOGNISED_NATURE", advisory: true, recognised: m.nature, note: "The reviewer is deliberately overriding the recognised nature — advisory only." });
    }
    const preflight = s.missing ? { code: "ACCOUNT_NOT_IN_UPLOAD", detail: s.account_key } : validateDecision(decisions[i], seen);
    if (!preflight && !s.missing) seen.add(s.account_key);
    return {
      account_key: s.account_key, account_name: s.account_name, account_code: s.account_code,
      previous_treatment: prior ? prior.treatment : null,
      proposed_treatment: { statement: treatment.statement, classification: treatment.classification, normal_balance: treatment.normal_balance, flag_candidate: treatment.flag_candidate ?? null },
      warnings,
      preflight: preflight ? { ok: false, ...preflight } : { ok: true },
    };
  });
  const blocking = rows.filter((r) => !r.preflight.ok).map((r) => ({ account_key: r.account_key, code: r.preflight.code }));
  return { upload_id: upload.id, treatment, rows, blocking, submittable: blocking.length === 0, decisions };
}

/**
 * ASSIGN a common treatment to explicitly-selected accounts, ATOMICALLY. Validates every selected account first; a single
 * failure throws and NOTHING is written (all-or-nothing, as the server enforces). On success, appends one
 * USER_MANUAL_CLASSIFICATION decision per account and returns an aggregate result (mirrors the real result_summary shape).
 * Idempotent on (upload, actor, client_request_id): same payload replays; a different payload is refused.
 */
export function assignCommonTreatment(store, { upload, summary, selectedKeys, treatment, actor, reason, client_request_id }) {
  if (actor.company_id !== upload.company_id) throw new Refusal("UPLOAD_COMPANY_MISMATCH", { actor: actor.company_id, upload: upload.company_id });
  if (summary.source_digest !== upload.source_digest) throw new Refusal("SOURCE_CHANGED", { was: summary.source_digest, now: upload.source_digest });
  if (!Array.isArray(selectedKeys) || selectedKeys.length === 0) throw new Refusal("EMPTY_DECISION_BATCH");

  const preview = previewManualAssignment({ store, upload, summary, selectedKeys, treatment, reason });

  // Idempotency: a request_hash over the sorted selection + treatment + reason. Same key + same payload => replay.
  const request_hash = sha256Hex({ upload_id: upload.id, treatment, keys: [...selectedKeys].sort(), reason: reason ?? "" });
  const idemKey = `${upload.id}|${actor.firm_member_id}|${client_request_id}`;
  const seen = store.batches.get(idemKey);
  if (seen) {
    if (seen.request_hash !== request_hash) throw new Refusal("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
    return { ...seen.result, reused: true };
  }

  // ATOMIC pre-pass: the FIRST invalid account aborts the whole batch (nothing is written) — exactly like the server.
  for (const r of preview.rows) {
    if (!r.preflight.ok) throw new Refusal(r.preflight.code, { account_key: r.account_key, detail: r.preflight.detail });
  }

  const batch_id = sha256Hex({ idemKey, request_hash }).slice(0, 32);
  const ctx = reuseContextOf(upload);
  let logged = 0;
  for (const r of preview.rows) {
    const flags = treatment.flag_candidate === "cash" ? { is_cash_account: true }
      : treatment.flag_candidate === "retained" ? { is_retained_earnings: true }
        : treatment.flag_candidate === "payroll" ? { is_payroll_account: true } : {};
    const identity_norm = normalizeAccountName(r.account_name);
    store.append({
      batch_id, company_id: upload.company_id, upload_id: upload.id, firm_member_id: actor.firm_member_id,
      account_code: r.account_code, normalized_account_name: identity_norm, review_account_key: r.account_key,
      proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION",
      previous_value: r.previous_treatment,
      treatment: { statement: treatment.statement, classification: treatment.classification, line_item: r.account_name, normal_balance: treatment.normal_balance, ...flags },
      identity_norm, basis_digest: sha256Hex({ account_key: r.account_key, identity_norm }),
      context: ctx, reason: (reason != null && String(reason).trim() !== "") ? String(reason) : null,
    });
    logged++;
  }
  const result = { batch_id, decisions_logged: logged, mappings_written: logged, reused: false };
  store.batches.set(idemKey, { request_hash, result });
  return result;
}
