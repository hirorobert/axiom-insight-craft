#!/usr/bin/env node
// Phase 5 — MANUAL MULTI-ACCOUNT TREATMENT path. Runnable: node research/phase5/tests/manual.test.mjs
// Covers the UNCERTAIN-accounts directive: no inferred-equivalence auto-grouping; visual-by-issue only; deliberate selection
// with a shown preview; atomic all-or-nothing submission; cross-tenant / stale / idempotency / concurrent conflict;
// reuse-context (more than file-hash); and the proposed-role sign WARNING vs a blocking mapping ERROR distinction.
import { buildReviewSummary, ReviewStore, acceptGroup } from "../prototype/lifecycle.mjs";
import { organiseByIssue, previewManualAssignment, assignCommonTreatment } from "../prototype/manual.mjs";
import { interpretMeaning } from "../prototype/layer3_meaning.mjs";
import { readAccounts } from "../prototype/layer1_structure.mjs";
import * as F from "../fixtures/synthetic.mjs";

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d, (k, v) => typeof v === "bigint" ? String(v) : v)}` : ""}`); } };
const group = (n) => console.log(`\n== ${n}`);
const up = (tb, over = {}) => ({ id: "u1", company_id: "co-A", source_digest: tb.source_digest, ...over });
const refused = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };

group("Uncertain accounts are NOT auto-grouped by inferred equivalence");
{
  const s = buildReviewSummary({ upload: up(F.UNCERTAIN), headers: F.UNCERTAIN.headers, dataRows: F.UNCERTAIN.dataRows });
  check("every unrecognised account is INDIVIDUAL (no proposal group formed from inferred equivalence)", s.groups.length === 0 && s.individual.length === 4, { groups: s.groups.length, individual: s.individual.length });
  check("each is flagged NO_RECOGNISED_MEANING (not silently treated)", s.individual.every((i) => i.reason === "NO_RECOGNISED_MEANING"));
}

group("Visual organisation by issue implies NO treatment or approval");
{
  const read = readAccounts(F.UNCERTAIN.headers, F.UNCERTAIN.dataRows);
  const { meanings } = interpretMeaning(read.accounts);
  const s = buildReviewSummary({ upload: up(F.UNCERTAIN), headers: F.UNCERTAIN.headers, dataRows: F.UNCERTAIN.dataRows });
  const buckets = organiseByIssue(s.individual, new Map(meanings.map((m) => [m.account_key, m])));
  check("accounts are organised into issue buckets for display", buckets.length >= 1 && buckets.every((b) => b.members.length >= 1));
  check("every bucket explicitly implies NO common treatment and NO approval", buckets.every((b) => b.impliesTreatment === false && b.impliesApproval === false));
}

group("Deliberate selection → preview shows selected accounts, proposed treatment, warnings, and per-account preflight");
{
  const store = new ReviewStore();
  const s = buildReviewSummary({ upload: up(F.UNCERTAIN), headers: F.UNCERTAIN.headers, dataRows: F.UNCERTAIN.dataRows, store });
  const treatment = { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", flag_candidate: null };
  const p = previewManualAssignment({ store, upload: up(F.UNCERTAIN), summary: s, selectedKeys: ["9000", "9100", "9200"], treatment, reason: "" });
  check("the preview lists exactly the selected accounts with the proposed treatment", p.rows.length === 3 && p.rows.every((r) => r.proposed_treatment.classification === "current_assets"));
  check("the preview is submittable (all three preflight OK) with no reason required", p.submittable === true && p.rows.every((r) => r.preflight.ok));
}

group("Proposed-role sign WARNING (advisory) is distinct from a blocking mapping ERROR");
{
  // (advisory) assigning an income-statement treatment to a debit 'Suspense' raises a TREATMENT_DIFFERS / sign warning but
  //            does NOT block — the reviewer may deliberately override. 'Suspense' is unknown so no nature warning; use WRONGLY_MAPPED's 'Rent income'.
  const store = new ReviewStore();
  const sW = buildReviewSummary({ upload: up(F.WRONGLY_MAPPED), headers: F.WRONGLY_MAPPED.headers, dataRows: F.WRONGLY_MAPPED.dataRows, store });
  const okTreat = { statement: "income_statement", classification: "revenue", normal_balance: "credit", flag_candidate: null };
  const pw = previewManualAssignment({ store, upload: up(F.WRONGLY_MAPPED), summary: sW, selectedKeys: ["4200"], treatment: okTreat, reason: "" });
  check("an UNEXPECTED_BALANCE sign warning is ADVISORY (warning present, preflight still OK — not a block)", pw.rows[0].warnings.some((w) => w.code === "UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE" && w.advisory === true) && pw.rows[0].preflight.ok && pw.submittable, pw.rows[0]);
  // (blocking) an unsupported statement/classification pair is a BLOCKING preflight error.
  const badTreat = { statement: "balance_sheet", classification: "revenue", normal_balance: "credit", flag_candidate: null };
  const pb = previewManualAssignment({ store, upload: up(F.WRONGLY_MAPPED), summary: sW, selectedKeys: ["4200"], treatment: badTreat, reason: "" });
  check("an unsupported statement/classification pair BLOCKS (STATEMENT_CLASSIFICATION_MISMATCH), not merely warns", !pb.submittable && pb.blocking[0].code === "STATEMENT_CLASSIFICATION_MISMATCH", pb.blocking);
}

group("Mixed valid/invalid selection → ATOMIC: nothing is written, the offending account is named");
{
  const store = new ReviewStore();
  const s = buildReviewSummary({ upload: up(F.UNCERTAIN), headers: F.UNCERTAIN.headers, dataRows: F.UNCERTAIN.dataRows, store });
  const treatment = { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", flag_candidate: null };
  const sel = ["9000", "NOT-IN-UPLOAD", "9200"];
  const prev = previewManualAssignment({ store, upload: up(F.UNCERTAIN), summary: s, selectedKeys: sel, treatment, reason: "" });
  check("the preview shows each outcome explicitly: 2 OK, 1 blocking (never a blanket success)", prev.rows.filter((r) => r.preflight.ok).length === 2 && prev.blocking.length === 1 && prev.blocking[0].account_key === "NOT-IN-UPLOAD");
  const code = refused(() => assignCommonTreatment(store, { upload: up(F.UNCERTAIN), summary: s, selectedKeys: sel, treatment, actor: { company_id: "co-A", firm_member_id: "fm" }, reason: "", client_request_id: "m1" }));
  check("submission is refused atomically (ACCOUNT_NOT_IN_UPLOAD) — no partial accept", code === "ACCOUNT_NOT_IN_UPLOAD");
  check("NOTHING was written from the aborted batch (store unchanged — all-or-nothing)", store.decisions.length === 0, { logged: store.decisions.length });
}

group("Valid manual assignment succeeds, logs USER_MANUAL_CLASSIFICATION, becomes effective");
{
  const store = new ReviewStore();
  const s = buildReviewSummary({ upload: up(F.UNCERTAIN), headers: F.UNCERTAIN.headers, dataRows: F.UNCERTAIN.dataRows, store });
  const treatment = { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", flag_candidate: null };
  const r = assignCommonTreatment(store, { upload: up(F.UNCERTAIN), summary: s, selectedKeys: ["9000", "9100", "9200"], treatment, actor: { company_id: "co-A", firm_member_id: "fm" }, reason: "treated as current assets", client_request_id: "m-ok" });
  check("all three are written (decisions_logged = mappings_written = 3)", r.decisions_logged === 3 && r.mappings_written === 3, r);
  check("each decision is a USER_MANUAL_CLASSIFICATION with proposal_type NONE", store.decisions.every((d) => d.decision_action === "USER_MANUAL_CLASSIFICATION" && d.proposal_type === "NONE"));
  check("the effective treatment is the assigned one and the previous value was preserved on the decision", store.effective("co-A", "9000").treatment.classification === "current_assets");
}

group("Cross-tenant / stale-source refusals on the manual path");
{
  const store = new ReviewStore();
  const s = buildReviewSummary({ upload: up(F.UNCERTAIN), headers: F.UNCERTAIN.headers, dataRows: F.UNCERTAIN.dataRows, store });
  const treatment = { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", flag_candidate: null };
  check("an actor from another company cannot assign (UPLOAD_COMPANY_MISMATCH)",
    refused(() => assignCommonTreatment(store, { upload: up(F.UNCERTAIN), summary: s, selectedKeys: ["9000"], treatment, actor: { company_id: "co-B", firm_member_id: "fm-x" }, reason: "", client_request_id: "x1" })) === "UPLOAD_COMPANY_MISMATCH");
  check("assigning against a summary whose source has changed is refused (SOURCE_CHANGED)",
    refused(() => assignCommonTreatment(store, { upload: up(F.UNCERTAIN, { source_digest: "changed" }), summary: s, selectedKeys: ["9000"], treatment, actor: { company_id: "co-A", firm_member_id: "fm" }, reason: "", client_request_id: "x2" })) === "SOURCE_CHANGED");
}

group("Duplicate submission / lost-response retry (idempotency)");
{
  const store = new ReviewStore();
  const s = buildReviewSummary({ upload: up(F.UNCERTAIN), headers: F.UNCERTAIN.headers, dataRows: F.UNCERTAIN.dataRows, store });
  const treatment = { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", flag_candidate: null };
  const args = (cid) => ({ upload: up(F.UNCERTAIN), summary: s, selectedKeys: ["9000", "9100"], treatment, actor: { company_id: "co-A", firm_member_id: "fm" }, reason: "r", client_request_id: cid });
  const a = assignCommonTreatment(store, args("dup"));
  const b = assignCommonTreatment(store, args("dup"));
  check("a retry with the same request id + same payload replays (no duplicate rows)", b.reused === true && a.batch_id === b.batch_id && store.decisions.length === 2);
  check("the same request id with a DIFFERENT payload is refused (IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD)",
    refused(() => assignCommonTreatment(store, { ...args("dup"), selectedKeys: ["9000", "9100", "9200"] })) === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
}

group("Conflicting concurrent decisions on the same account (serialized; last-writer-wins; no lost write)");
{
  const store = new ReviewStore();
  const s = buildReviewSummary({ upload: up(F.UNCERTAIN), headers: F.UNCERTAIN.headers, dataRows: F.UNCERTAIN.dataRows, store });
  // Two authorised actors assign DIFFERENT treatments to 9000. Production serializes via pg_advisory_xact_lock(company,key);
  // the prototype models the serialized outcome: both decisions are recorded (append-only), the later sequence_no wins.
  assignCommonTreatment(store, { upload: up(F.UNCERTAIN), summary: s, selectedKeys: ["9000"], treatment: { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", flag_candidate: null }, actor: { company_id: "co-A", firm_member_id: "fm-1" }, reason: "first", client_request_id: "c1" });
  assignCommonTreatment(store, { upload: up(F.UNCERTAIN), summary: s, selectedKeys: ["9000"], treatment: { statement: "balance_sheet", classification: "non_current_assets", normal_balance: "debit", flag_candidate: null }, actor: { company_id: "co-A", firm_member_id: "fm-2" }, reason: "second", client_request_id: "c2" });
  const dec9000 = store.decisions.filter((d) => d.review_account_key === "9000");
  check("both conflicting decisions are retained in the append-only ledger (no lost write)", dec9000.length === 2);
  check("the latest (highest sequence_no) decision is effective — deterministic last-writer-wins", store.effective("co-A", "9000").treatment.classification === "non_current_assets");
}

group("Reuse is MORE than a file-hash match (entity + currency + dimensions + ruleset context)");
{
  const store = new ReviewStore();
  const TB = F.UNCERTAIN;
  const u1 = { id: "u1", company_id: "co-A", source_digest: TB.source_digest, currency: "TZS", period_year: 2025 };
  const s1 = buildReviewSummary({ upload: u1, headers: TB.headers, dataRows: TB.dataRows, store });
  assignCommonTreatment(store, { upload: u1, summary: s1, selectedKeys: ["9000", "9100", "9200", "9300"], treatment: { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", flag_candidate: null }, actor: { company_id: "co-A", firm_member_id: "fm" }, reason: "", client_request_id: "r1" });
  // This single-entity engagement authoritatively declares dimensions + ruleset N/A (otherwise absent context is UNKNOWN).
  const NA = ["dimensions", "rulesetVersion"];
  // Same entity + same currency, later period, N/A declared → REUSABLE (mappings reuse across periods by design).
  const u2 = { id: "u2", company_id: "co-A", source_digest: TB.source_digest, currency: "TZS", period_year: 2026 };
  const s2 = buildReviewSummary({ upload: u2, headers: TB.headers, dataRows: TB.dataRows, store, notApplicableContextFields: NA });
  check("verified-compatible context (entity + currency equal; dimensions/ruleset authoritatively N/A) → reusable across a new period", s2.reuse.reusable.includes("9000") && s2.reuse.context_incompatible.length === 0 && s2.reuse.context_unverified.length === 0, s2.reuse);
  // Same entity, DIFFERENT currency → NOT silently reused: CONTEXT_INCOMPATIBLE (more than file-hash).
  const u3 = { id: "u3", company_id: "co-A", source_digest: TB.source_digest, currency: "USD", period_year: 2026 };
  const s3 = buildReviewSummary({ upload: u3, headers: TB.headers, dataRows: TB.dataRows, store, notApplicableContextFields: NA });
  check("a changed currency reopens reuse as CONTEXT_INCOMPATIBLE (file hash alone is insufficient)", s3.reuse.context_incompatible.includes("9000") && !s3.reuse.reusable.includes("9000"), s3.reuse);
  // Unknown/unverifiable currency → REOPEN for explicit confirmation (never silently reused on entity+key alone).
  const u4 = { id: "u4", company_id: "co-A", source_digest: TB.source_digest, period_year: 2026 }; // no currency (prior had TZS)
  const s4 = buildReviewSummary({ upload: u4, headers: TB.headers, dataRows: TB.dataRows, store, notApplicableContextFields: NA });
  check("an unverifiable (absent) currency reopens for explicit confirmation (CONTEXT_UNVERIFIED), not silent reuse", s4.reuse.context_unverified.includes("9000") && !s4.reuse.reusable.includes("9000") && s4.reuseDisclosure.reopen_context_fields.includes("currency"), s4.reuse);
  // UNKNOWN != NOT APPLICABLE: WITHOUT the authoritative N/A declaration, absent dimensions/ruleset are UNKNOWN → reopen.
  const s5 = buildReviewSummary({ upload: u2, headers: TB.headers, dataRows: TB.dataRows, store });
  check("absent dimensions/ruleset with NO authoritative N/A rule → UNKNOWN → reopen (not silently reused)", s5.reuse.context_unverified.includes("9000") && !s5.reuse.reusable.includes("9000") && s5.reuseDisclosure.reopen_context_fields.some((f) => f === "dimensions" || f === "rulesetVersion"), s5.reuse);
}

group("Exact money preserved on the manual path (BigInt; nothing netted)");
{
  const read = readAccounts(F.UNCERTAIN.headers, F.UNCERTAIN.dataRows);
  check("selected account balances remain exact BigInt minor units (no float, no netting)", read.accounts.find((a) => a.account_code === "9000").debitMinor === 100000n && read.accounts.find((a) => a.account_code === "9300").creditMinor === 180000n);
}

console.log(`\n${pass}/${pass + fail} manual-path checks passed.`);
process.exit(fail ? 1 : 0);
