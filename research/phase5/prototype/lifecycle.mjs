// Phase 5 prototype — LIFECYCLE: review summary, grouped acceptance, repeat-upload reuse, meaning/identity invalidation,
// and cross-tenant / stale refusals. Isolated adapter; reuses production primitives (read-only facts), never imports them.
//
// Primitives reused:
//   - account_key identity + latest-by-sequence_no effective decision (account_review_decisions; get_effective_non_reporting_status).
//   - append-only decision ledger with a monotonic sequence (immutability triggers in production).
//   - content/source digests as the "accepted mapping version" surrogate (request_hash / provenance-link content equality /
//     tb_certifications input hashes). Reuse is compatible only when the account's BASIS digest matches the accepted one.
//   - identity-drift reopen (PRIOR_NON_REPORTING_DECISION_STALE_IDENTITY_CHANGED) generalised to classification decisions.
//   - refusals: UPLOAD_COMPANY_MISMATCH (cross-tenant), SOURCE_CHANGED (stale input),
//     IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD (replay-with-different-payload).
import { accountKey, normalizeAccountName } from "./layer2_identity.mjs";
import { readAccounts } from "./layer1_structure.mjs";
import { interpretMeaning } from "./layer3_meaning.mjs";
import { proposeTreatments } from "./layer4_treatment.mjs";
import { reuseContextOf, contextCompatible } from "./reuseContext.mjs";
import { sha256Hex } from "./util.mjs";

export class Refusal extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }

/** The account's identity BASIS (what a prior decision was accepted against). Drift here reopens the decision. */
function basisOf(account) { return { account_key: accountKey(account), identity_norm: normalizeAccountName(account.account_name) }; }
function basisDigest(account) { return sha256Hex(basisOf(account)); }

/** Append-only review store (in-memory research surrogate for account_review_decisions + account_review_batches). */
export class ReviewStore {
  constructor() { this.seq = 0; this.decisions = []; this.batches = new Map(); }
  /** Latest approving decision for (company, account_key), by sequence_no. Mirrors latest-wins effective state. */
  effective(company_id, account_key) {
    let best = null;
    for (const d of this.decisions) if (d.company_id === company_id && d.review_account_key === account_key && d.decision_action !== "MARK_NON_REPORTING_ACCOUNT") { if (!best || d.sequence_no > best.sequence_no) best = d; }
    return best;
  }
  append(d) { const row = { ...d, sequence_no: ++this.seq }; this.decisions.push(row); return row; }
}

/**
 * Classify a new-upload account against the store: NEW | REUSABLE | STALE_IDENTITY | STALE_MEANING.
 * meaningChanged = an upstream signal (a comparative/GL reconciliation revealed the account means something else).
 */
export function classifyAgainstPrior(store, company_id, account, { meaningChanged = false, nowCtx = null } = {}) {
  const key = accountKey(account);
  const prior = store.effective(company_id, key);
  if (!prior) return { status: "NEW", key };
  if (meaningChanged) return { status: "STALE_MEANING", key, prior, reason: "RELEVANT_MEANING_OR_CONTEXT_CHANGED" };
  if (prior.basis_digest !== basisDigest(account)) {
    // Same account_key but the identity basis drifted (e.g. a coded account's name materially changed).
    return normalizeAccountName(account.account_name) !== prior.identity_norm
      ? { status: "STALE_IDENTITY", key, prior, reason: "PRIOR_DECISION_STALE_IDENTITY_CHANGED" }
      : { status: "STALE_MEANING", key, prior, reason: "RELEVANT_MEANING_OR_CONTEXT_CHANGED" };
  }
  // Reuse is MORE than a file-hash / account_key match: the accounting CONTEXT must be compatible (Phase 6 first-slice
  // REUSE RULE). Verified-compatible ⇒ reuse may be proposed (REUSABLE). A KNOWN change ⇒ reopen (CONTEXT_INCOMPATIBLE).
  // Missing / unverifiable context ⇒ reopen for explicit confirmation (CONTEXT_UNVERIFIED) — NEVER a silent inherit.
  if (nowCtx && prior.context) {
    const ctx = contextCompatible(prior.context, nowCtx);
    if (ctx.state === "INCOMPATIBLE") return { status: "CONTEXT_INCOMPATIBLE", key, prior, reason: ctx.blocking.join(","), blocking: ctx.blocking };
    if (ctx.state === "UNVERIFIED") return { status: "CONTEXT_UNVERIFIED", key, prior, reason: `UNVERIFIABLE_CONTEXT:${ctx.reopen.join(",")}`, reopen: ctx.reopen };
    return { status: "REUSABLE", key, prior, notApplicable: ctx.notApplicable };
  }
  // No recorded prior context at all ⇒ cannot verify ⇒ reopen for explicit confirmation (never inherit on key alone).
  return { status: "CONTEXT_UNVERIFIED", key, prior, reason: "UNVERIFIABLE_CONTEXT:no_recorded_context", reopen: ["context"] };
}

/**
 * Build a review summary for an upload. Runs layers 1,3,4; classifies every account for reuse against the store; computes
 * mapping coverage. Returns a summary the UI would render (grouped treatments + individual accounts + relationships +
 * reuse breakdown + coverage + a source_digest the acceptance step binds to).
 */
export function buildReviewSummary({ upload, headers, dataRows, store = new ReviewStore(), meaningChangedKeys = [] }) {
  const read = readAccounts(headers, dataRows);
  if (read.kind !== "flat_tb") return { ok: false, structure: read, source_digest: upload.source_digest };
  const { meanings, relationships } = interpretMeaning(read.accounts);
  const { groups, individual } = proposeTreatments(read.accounts, meanings);

  const changedSet = new Set(meaningChangedKeys);
  const nowCtx = reuseContextOf(upload);
  const reuse = read.accounts.map((a) => classifyAgainstPrior(store, upload.company_id, a, { meaningChanged: changedSet.has(accountKey(a)), nowCtx }));
  const byStatus = (s) => reuse.filter((r) => r.status === s).map((r) => r.key);

  // Accounts still needing a reviewer this time = NEW + reopened (STALE_* / CONTEXT_INCOMPATIBLE / CONTEXT_UNVERIFIED) +
  // individual. CONTEXT_UNVERIFIED reopens for EXPLICIT confirmation — the first-slice rule forbids a silent inherit.
  const reopened = reuse.filter((r) => ["STALE_IDENTITY", "STALE_MEANING", "CONTEXT_INCOMPATIBLE", "CONTEXT_UNVERIFIED"].includes(r.status));
  const needsReviewKeys = new Set([...byStatus("NEW"), ...reopened.map((r) => r.key), ...individual.map((i) => i.account_key)]);
  // Which context fields forced a reopen-for-confirmation (missing/unverifiable), disclosed per the rule — never hidden.
  const reopenContextFields = [...new Set(reuse.filter((r) => r.status === "CONTEXT_UNVERIFIED").flatMap((r) => r.reopen || []))].sort();

  // Coverage over accounts that need a mapping (every account): unmapped = needs review & not groupable-approved yet.
  const total = read.accounts.length;
  const ambiguous = individual.filter((i) => i.reason === "HIGH_UNCERTAINTY").length;
  const unmapped = needsReviewKeys.size;
  const groupsNeedingReview = groups.map((g) => ({ ...g, members: g.members.filter((m) => needsReviewKeys.has(m.account_key)) }))
    .filter((g) => g.members.length > 0).map((g) => ({ ...g, member_count: g.members.length }));

  return {
    ok: true,
    upload,
    source_digest: upload.source_digest,
    groups: groupsNeedingReview,
    individual: individual.filter((i) => needsReviewKeys.has(i.account_key)),
    relationships,
    reuse: { reusable: byStatus("REUSABLE"), new: byStatus("NEW"), stale_identity: byStatus("STALE_IDENTITY"), stale_meaning: byStatus("STALE_MEANING"), context_incompatible: byStatus("CONTEXT_INCOMPATIBLE"), context_unverified: byStatus("CONTEXT_UNVERIFIED") },
    reuseDisclosure: { reopen_context_fields: reopenContextFields, note: "First-slice reuse rule: a decision is REUSABLE only when the applicable accounting context (entity + currency + dimensions, from fiscal_periods etc.) is verified compatible. Missing/unverifiable context reopens for explicit confirmation (CONTEXT_UNVERIFIED); a known change reopens (CONTEXT_INCOMPATIBLE). A treatment is never inherited silently from company_id + account_key alone." },
    context: nowCtx,
    mappingCoverage: { total, unmapped, ambiguous },
    accountsRead: read.accounts,
  };
}

/**
 * Accept ONE treatment group (explicit, with a reason) — expands to per-account decisions appended to the store.
 * NO "Accept all": one group per call. Refuses cross-tenant, stale source, and idempotency-reuse-with-different-payload.
 * Returns { batch_id, decisions_logged, reused: false } or the prior replay result.
 */
/**
 * Expand a treatment group into the EXACT per-account decision payloads that resolve_account_review_batch consumes
 * (ReviewDecisionPayload). Pure — no store write. This is the array passed as p_decisions to the real RPC.
 * Fields match the real function's parsing: account_code, account_name, proposal_type, decision_action, statement,
 * classification, line_item, normal_balance, (is_cash_account|is_retained_earnings|is_payroll_account), reason.
 * Flags stay TRI-STATE: only the group's confirmed flag_candidate is emitted; others are OMITTED (never sent as false).
 */
export function expandGroupToDecisions(group, reason) {
  return group.members.map((m) => {
    const d = {
      account_code: m.account_code ?? null,
      account_name: m.account_name,
      proposal_type: "MACHINE_SUGGESTION",
      decision_action: "USER_ACCEPTED_SUGGESTION",
      statement: group.treatment.statement,
      classification: group.treatment.classification,
      line_item: m.account_name, // server defaults line_item to the account name; we send it explicitly
      normal_balance: group.treatment.normal_balance,
      reason,
    };
    if (group.treatment.flag_candidate === "cash") d.is_cash_account = true;
    else if (group.treatment.flag_candidate === "retained") d.is_retained_earnings = true;
    else if (group.treatment.flag_candidate === "payroll") d.is_payroll_account = true;
    return d;
  });
}

export function acceptGroup(store, { upload, summary, group, actor, reason, client_request_id }) {
  if (actor.company_id !== upload.company_id) throw new Refusal("UPLOAD_COMPANY_MISMATCH", { actor: actor.company_id, upload: upload.company_id });
  if (summary.source_digest !== upload.source_digest) throw new Refusal("SOURCE_CHANGED", { was: summary.source_digest, now: upload.source_digest });
  // Reason is OPTIONAL for routine classification — the real resolve_account_review_batch requires a reason ONLY for
  // CONFIRM_ACCOUNT_TREATMENT (3..500); account_review_decisions.reason is TEXT NULL. We do not invent a mandatory essay;
  // a reason is recorded when supplied. (Corrected from an earlier prototype that over-required a 3-char reason.)
  if (group.uncertainty.level === "high") throw new Refusal("GROUP_UNCERTAIN_REVIEW_INDIVIDUALLY");

  const payload = { upload_id: upload.id, group_id: group.groupId, treatment: group.treatment, members: group.members.map((m) => m.account_key).sort(), reason };
  const request_hash = sha256Hex(payload);
  const idemKey = `${upload.id}|${actor.firm_member_id}|${client_request_id}`;
  const seen = store.batches.get(idemKey);
  if (seen) {
    if (seen.request_hash !== request_hash) throw new Refusal("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
    return { ...seen.result, reused: true };
  }

  const batch_id = sha256Hex({ idemKey, request_hash }).slice(0, 32);
  let logged = 0;
  for (const m of group.members) {
    const account = summary.accountsRead.find((a) => accountKey(a) === m.account_key);
    const identity_norm = normalizeAccountName(m.account_name);
    const flags = group.treatment.flag_candidate === "cash" ? { is_cash_account: true }
      : group.treatment.flag_candidate === "retained" ? { is_retained_earnings: true }
        : group.treatment.flag_candidate === "payroll" ? { is_payroll_account: true } : {};
    // Per-account decision mirrors ReviewDecisionPayload; line_item defaults to the account name server-side.
    const treatment = { statement: group.treatment.statement, classification: group.treatment.classification, line_item: m.account_name, normal_balance: group.treatment.normal_balance, ...flags };
    store.append({
      batch_id, company_id: upload.company_id, upload_id: upload.id, firm_member_id: actor.firm_member_id,
      account_code: m.account_code, normalized_account_name: identity_norm, review_account_key: m.account_key,
      proposal_type: "MACHINE_SUGGESTION", decision_action: "USER_ACCEPTED_SUGGESTION",
      treatment, identity_norm, basis_digest: account ? basisDigest(account) : sha256Hex(basisOf({ account_code: m.account_code, account_name: m.account_name })),
      context: reuseContextOf(upload), reason,
    });
    logged++;
  }
  const result = { batch_id, decisions_logged: logged, group_id: group.groupId, reused: false };
  store.batches.set(idemKey, { request_hash, result });
  return result;
}
