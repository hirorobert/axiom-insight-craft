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
export function classifyAgainstPrior(store, company_id, account, { meaningChanged = false } = {}) {
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
  return { status: "REUSABLE", key, prior };
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
  const reuse = read.accounts.map((a) => classifyAgainstPrior(store, upload.company_id, a, { meaningChanged: changedSet.has(accountKey(a)) }));
  const byStatus = (s) => reuse.filter((r) => r.status === s).map((r) => r.key);

  // Accounts still needing a reviewer this time = NEW + reopened (STALE_*) + individual (no meaning / high uncertainty).
  const reopened = reuse.filter((r) => r.status === "STALE_IDENTITY" || r.status === "STALE_MEANING");
  const needsReviewKeys = new Set([...byStatus("NEW"), ...reopened.map((r) => r.key), ...individual.map((i) => i.account_key)]);

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
    reuse: { reusable: byStatus("REUSABLE"), new: byStatus("NEW"), stale_identity: byStatus("STALE_IDENTITY"), stale_meaning: byStatus("STALE_MEANING") },
    mappingCoverage: { total, unmapped, ambiguous },
    accountsRead: read.accounts,
  };
}

/**
 * Accept ONE treatment group (explicit, with a reason) — expands to per-account decisions appended to the store.
 * NO "Accept all": one group per call. Refuses cross-tenant, stale source, and idempotency-reuse-with-different-payload.
 * Returns { batch_id, decisions_logged, reused: false } or the prior replay result.
 */
export function acceptGroup(store, { upload, summary, group, actor, reason, client_request_id }) {
  if (actor.company_id !== upload.company_id) throw new Refusal("UPLOAD_COMPANY_MISMATCH", { actor: actor.company_id, upload: upload.company_id });
  if (summary.source_digest !== upload.source_digest) throw new Refusal("SOURCE_CHANGED", { was: summary.source_digest, now: upload.source_digest });
  if (!reason || String(reason).trim().length < 3) throw new Refusal("REASON_REQUIRED");
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
      reason,
    });
    logged++;
  }
  const result = { batch_id, decisions_logged: logged, group_id: group.groupId, reused: false };
  store.batches.set(idemKey, { request_hash, result });
  return result;
}
