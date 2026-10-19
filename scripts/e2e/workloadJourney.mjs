#!/usr/bin/env bun
// MEASUREMENT of the financial-statements workload through the REAL local Supabase stack (`supabase start` in CI: real
// Auth, PostgREST with its API-session guards, RLS, Storage and the Edge Functions served from this repository). API
// level, as the production build would call it (supabase-js, the workbench's own client code for saves and the official
// pack), no browser. It MEASURES and RECORDS; it asserts only that the representative journey reaches FINAL and that the
// official pack verifies, so a measurement that degrades is recorded, never hidden.
//
// Two companies, invented data:
//   REPRESENTATIVE  18 accounts, 7-row ledger, two years, comparatives approved → save → REVIEWED → FINAL → official
//                   pack issued, verified, retrieved; then a growing history (30 further versions) and 8 simultaneous
//                   saves of one attempt / 8 simultaneous reads.
//   DEMANDING       2,000 accounts (the trial-balance processing limit), a 20,000-row ledger (the intake limit), 50
//                   equity rows → composition, notes, dependencies, the save (evidence step + bind), readiness, versions.
// Every timing is the API round trip as seen by the client (wall time of one PostgREST / Edge Function call on the CI
// runner) — NOT server CPU. CPU telemetry is not available from this path and is recorded as such.
//
//   bun scripts/e2e/workloadJourney.mjs <evidence-dir>       (after `supabase start`; reads `supabase status -o json`)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { assertLocalStack, tbCsv, TB, CURRENT, PRIOR, PERIODS, reviewDecisions, ASSIGN, EVIDENCE, NOTES, NOT_APPLICABLE, PPE_SCHEDULE, CODES } from "./localStackFixtures.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { supabaseReportingDb } from "../../src/lib/reporting/supabaseDb.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { reviewClient } from "../../src/lib/reporting/reviewWorkflow.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "e2e-evidence/workload"));
fs.mkdirSync(OUT, { recursive: true });
const BUCKET = "trial-balance-files";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const uuid = () => crypto.randomUUID();
const key = () => crypto.randomBytes(18).toString("base64url");
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "workload.log"), s + "\n"); };
const results = [];
async function check(name, fn) {
  try { const r = await fn(); const ok = r === true; results.push({ name, ok }); log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${JSON.stringify(r)?.slice(0, 1200)}`}`); return ok; }
  catch (e) { results.push({ name, ok: false }); log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`); return false; }
}
/** One measured call: ms, outcome, error class (never financial content). */
const M = { environment: {}, representative: {}, demanding: {}, history: [], concurrency: {}, failures: [], notes: [] };
process.on("exit", () => { try { writeSummary(); } catch { /* */ } });
async function measure(section, label, fn, meta = {}) {
  const t0 = performance.now();
  try {
    const value = await fn();
    const ms = Math.round(performance.now() - t0);
    const entry = { ms, ok: true, ...meta, ...(typeof value === "object" && value !== null && value.__meta ? value.__meta : {}) };
    (M[section][label] ??= []).push(entry);
    log(`        [${section}] ${label}: ${ms} ms${meta.size ? ` (${meta.size})` : ""}`);
    return value;
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const cls = /statement timeout|canceling statement/i.test(String(e?.message)) ? "statement_timeout" : /PT409|STALE/.test(String(e?.message)) ? "stale_or_conflict" : /42501|FORBIDDEN/.test(String(e?.message)) ? "permission" : /fetch|network|ECONN/i.test(String(e?.message)) ? "transport" : "error";
    const entry = { ms, ok: false, errorClass: cls, message: String(e?.message ?? e).slice(0, 160), ...meta };
    (M[section][label] ??= []).push(entry);
    M.failures.push({ section, label, ...entry });
    log(`        [${section}] ${label}: FAILED after ${ms} ms (${cls}): ${entry.message}`);
    return null;
  }
}

// ── The stack (never printed) ─────────────────────────────────────────────────────────────────────────────────────────
const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const apiUrl = status.API_URL;
const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
const serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
assertLocalStack({ apiUrl, anonKey, serviceRoleKey: serviceKey });
const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
M.environment = { when: new Date().toISOString(), platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null, memoryGb: Math.round(os.totalmem() / 1e9), runner: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
  measure: "client-observed API round trip in ms (PostgREST / Edge Function on loopback); server CPU is NOT measured from this path" };

// ── Accounts and companies (invented) ─────────────────────────────────────────────────────────────────────────────────
const run = Date.now().toString(36);
const mk = (who) => ({ email: `${who}.${run}@e2e-local.test`, password: `E2e!${crypto.randomBytes(12).toString("base64url")}` });
const U = { owner: mk("wl-owner"), preparer: mk("wl-preparer"), partner: mk("wl-partner") };
for (const u of Object.values(U)) {
  const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
  if (error) throw new Error(`creating a test user failed: ${error.message}`);
  u.id = data.user.id;
}
{
  const prod = (await admin.from("commercial_products").select("id").eq("code", "CFOCLOSE").single()).data;
  const plan = (await admin.from("commercial_plans").select("id").eq("product_id", prod.id).eq("code", "PRACTICE").single()).data;
  const bc = await admin.from("billing_customers").insert({ owner_user_id: U.owner.id, product_id: prod.id }).select("id").single();
  if (bc.error) throw new Error(`billing customer: ${bc.error.message}`);
  const lic = await admin.from("commercial_licences").insert({ billing_customer_id: bc.data.id, plan_id: plan.id, status: "ACTIVE", source: "ADMIN_GRANT", effective_start: new Date(Date.now() - 86400000).toISOString(), additional_seats: 4 });
  if (lic.error) throw new Error(`licence: ${lic.error.message}`);
}
const signIn = async (u) => {
  const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`api sign-in failed: ${error.message}`);
  return { c, token: data.session.access_token, db: supabaseReportingDb(c) };
};
const owner = await signIn(U.owner), preparer = await signIn(U.preparer), partner = await signIn(U.partner);
const OK_OUTCOMES = new Set(["recorded", "generated", "accepted", "replayed", "certified", "carried", "approved", "reviewed"]);
const rpc = async (who, fn, args) => {
  const { data, error } = await who.c.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.outcome === "string" && !OK_OUTCOMES.has(data.outcome) && !/^fs_(statement_composition|notes_status|reporting_dependencies|report_readiness|reporting_input|prior_final_reconciliation|review_comments)$/.test(fn)) {
    M.notes.push(`${fn} answered ${JSON.stringify(data).slice(0, 200)}`);
    log(`        NOTE ${fn} answered ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
};
const newCompany = async (name) => {
  // The reporting framework is chosen at first run in the product (the kit's makeWorld sets it the same way); without it
  // every fs_* authority answers framework_not_ifrs_for_smes and nothing composes.
  const { data, error } = await admin.from("companies").insert({ user_id: U.owner.id, name, reporting_framework: "ifrs_for_smes" }).select("id").single();
  if (error) throw new Error(`company: ${error.message}`);
  for (const [who, role] of [["preparer", "preparer"], ["partner", "partner"]]) {
    const r = await admin.from("firm_members").insert({ company_id: data.id, user_id: U[who].id, role, accepted_at: new Date().toISOString() });
    if (r.error) throw new Error(`member ${role}: ${r.error.message}`);
  }
  const ro = await admin.rpc("fs_set_company_rollout", { p_company_id: data.id, p_enabled: true, p_reason: "Workload measurement (invented company)", p_operator_label: "workload" });
  if (ro.error) throw new Error(`rollout: ${ro.error.message}`);
  return data.id;
};

// ── The trial balance through the REAL draft → commit → process path, then review and re-check ───────────────────────
const fnDraft = async (who, body) => {
  const res = await fetch(`${apiUrl}/functions/v1/trial-balance-draft`, { method: "POST", headers: { Authorization: `Bearer ${who.token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};
const openPeriod = async (company, year, start, end) => {
  const d = await rpc(owner, "open_engagement_with_period", { p_company_id: company, p_period_start: start, p_period_end: end, p_reporting_currency: "TZS", p_capabilities: ["FINANCIAL_STATEMENTS"] });
  if (!d?.periodId) throw new Error(`period FY${year}: ${JSON.stringify(d)}`);
  return d;
};
const settled = async (uploadId) => {
  for (let i = 0; i < 120; i++) {
    const { data } = await admin.from("trial_balance_uploads").select("id, status, processing_result").eq("id", uploadId).single();
    if (data && !["pending", "processing", "queued", "validating"].includes(data.status)) return data;
    await sleep(1500);
  }
  throw new Error("the check did not finish");
};
const processUpload = async (who, uploadId, op) => {
  const res = await fetch(`${apiUrl}/functions/v1/process-trial-balance`, { method: "POST", headers: { Authorization: `Bearer ${who.token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ uploadId, clientRequestId: op }) });
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
/** What the processing function answered and what the upload row says, for the log and the measurement (no financial content). */
const processingSummary = (http, up) => ({ http: http?.status ?? null, outcome: http?.body?.outcome ?? http?.body?.status ?? null, code: http?.body?.code ?? http?.body?.error ?? null,
  uploadStatus: up?.status ?? null, resultStatus: up?.processing_result?.status ?? null, errors: (up?.processing_result?.errors ?? []).slice(0, 5).map((e) => (typeof e === "string" ? e : e?.code ?? JSON.stringify(e).slice(0, 80))),
  needsReview: Array.isArray(up?.processing_result?.needs_review_accounts) ? up.processing_result.needs_review_accounts.length : null });
const certified = async (company, year) => { const { data } = await owner.c.rpc("get_authoritative_certification", { p_company_id: company, p_period_year: year }); return Array.isArray(data) ? data.length > 0 : !!data; };
/** Upload a CSV for a period (draft → sign → storage → commit → process), review every account once, re-check, return the upload id. */
const uploadReviewCertify = async (company, entity, year, periodLabel, p, bytes, decisions, section) => {
  const d = await rpc(owner, "reserve_trial_balance_draft", { p_file_name: `${entity.replace(/\W+/g, "-")}-FY${year}.csv`, p_file_size: bytes.length, p_content_sha256: sha(bytes), p_idempotency_key: key() });
  const draft = d[0];
  const s = await fnDraft(owner, { action: "sign", draft_id: draft.draft_id });
  if (s.body?.outcome !== "signed") throw new Error(`sign: ${JSON.stringify(s.body)}`);
  const up = await owner.c.storage.from(BUCKET).uploadToSignedUrl(s.body.path, s.body.token, new Blob([bytes], { type: "text/csv" }));
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const c = await fnDraft(owner, { action: "commit", draft_id: draft.draft_id, commit_key: key(), company_id: company, period_year: year, period_id: p.periodId, engagement_id: p.engagementId, confirmation: { entity, period: periodLabel, currency: "TZS" } });
  if (c.body?.outcome !== "committed") throw new Error(`commit: ${JSON.stringify(c.body)}`);
  const uploadId = c.body.upload_id;
  let http = null, row = null;
  row = await measure(section, `tb_process_first_check_${year}`, async () => { http = await processUpload(owner, uploadId, uuid()); return settled(uploadId); }, { size: `${decisions.length} accounts, ${bytes.length} bytes` });
  log(`        [${section}] first check FY${year}: ${JSON.stringify(processingSummary(http, row))}`);
  if (!(await certified(company, year))) {
    await measure(section, `tb_review_batch_${year}`, () => rpc(owner, "resolve_account_review_batch", { p_company_id: company, p_upload_id: uploadId, p_client_request_id: uuid(), p_decisions: decisions }), { size: `${decisions.length} decisions` });
    const op = uuid();
    const { data: src } = await owner.c.from("trial_balance_uploads").select("source_file_hash").eq("id", uploadId).single();
    await rpc(owner, "tbu_request_reprocess", { p_upload_id: uploadId, p_operation_id: op, p_expected_source_hash: src?.source_file_hash ?? null });
    row = await measure(section, `tb_process_recheck_${year}`, async () => { http = await processUpload(owner, uploadId, op); return settled(uploadId); }, { size: `${decisions.length} accounts` });
    log(`        [${section}] re-check FY${year}: ${JSON.stringify(processingSummary(http, row))}`);
  }
  if (!(await certified(company, year))) {
    const summary = processingSummary(http, row);
    M.failures.push({ section, label: `tb_certification_${year}`, ok: false, errorClass: "not_certified", message: JSON.stringify(summary).slice(0, 400), accounts: decisions.length });
    throw Object.assign(new Error(`FY${year} of ${entity} is not certified after review: ${JSON.stringify(summary).slice(0, 300)}`), { notCertified: true });
  }
  return uploadId;
};

// ── Reporting preparation (the same server functions the pages call) ─────────────────────────────────────────────────
const prepareNotes = async (company, year) => {
  await rpc(preparer, "fs_decide_requirement", { p_company_id: company, p_period_year: year, p_requirement_id: "smes.note.share_capital", p_decision: "applicable", p_reason: "The entity has share capital", p_request_id: uuid() });
  for (const id of NOT_APPLICABLE) await rpc(preparer, "fs_decide_requirement", { p_company_id: company, p_period_year: year, p_requirement_id: id, p_decision: "not_applicable", p_reason: "None in the periods presented", p_request_id: uuid() });
  for (const [id, text] of Object.entries(NOTES)) await rpc(preparer, "fs_record_disclosure", { p_company_id: company, p_period_year: year, p_requirement_id: id, p_body: text, p_source_ref: "Notes v1", p_request_id: uuid() });
};
const explainFindings = async (company, year) => {
  await rpc(preparer, "close_review_refresh_findings", { p_company_id: company, p_period_year: year });
  const st0 = await rpc(preparer, "close_review_finding_states", { p_company_id: company, p_period_year: year });
  const st = Array.isArray(st0) ? st0 : st0 ? [st0] : [];
  for (const f of st.filter((x) => !x.resolved)) await rpc(preparer, "close_review_finding_action", { p_finding_id: f.finding_id, p_action: "explain", p_text: "Reviewed against the fixed asset register", p_evidence_ref: "FAR", p_request_id: uuid() });
};
const parseEvidence = (company, year, type, role, text, period) => {
  const r = ingestEvidence({ companyId: company, evidenceType: type, periodRole: role, reportingPeriodId: `FY${year}`, currency: "TZS", scale: 2, text, fileName: `${type.toLowerCase()}.csv`, mimeType: "text/csv", periodStart: period.start, periodEnd: period.end });
  if (r.outcome !== "PARSED") throw new Error(`${type} ${role} rejected: ${JSON.stringify(r.diagnostics).slice(0, 300)}`);
  const errs = r.batch.diagnostics.filter((d) => d.severity === "ERROR");
  if (errs.length) throw new Error(`${type} ${role}: ${JSON.stringify(errs).slice(0, 300)}`);
  return r.batch;
};
const save = (who, company, year, legalName, reportId, newEvidence, idempotencyKey = `attempt-${uuid()}`) =>
  prepareReportVersion(who.db, signoffClient(who.db), { companyId: company, periodYear: year, legalName, reportId, newEvidence, idempotencyKey, evaluatedAt: new Date().toISOString() });

/** The fixture ledger (7 rows) padded with netting pairs on the bank account to exactly `rows` data rows. */
const paddedLedger = (rows) => {
  const base = EVIDENCE.current.TRANSACTION_LEDGER.trimEnd().split(String.fromCharCode(10));
  const lines = [...base];
  for (let i = lines.length - 1; i < rows; i++) {
    const m = 7 + (i % 12); const y = m > 12 ? 2026 : 2025; const mm = ((m - 1) % 12) + 1; const d = 1 + (i % 28);
    lines.push(`N${i},${y}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")},${CODES.bank},Invented ${i % 2 ? "payment" : "receipt"} ${i},${i % 2 ? "" : "1.00"},${i % 2 ? "1.00" : ""},OPERATING,${i % 2 ? "Payments to suppliers and employees" : "Receipts from customers"}`);
  }
  return lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
};
/**
 * The ledger-size sweep on one company whose other evidence is already stored: for each size, a new ledger version of
 * `rows` rows is saved through the browser's save code (evidence step + bind) and timed; after a successful save,
 * readiness and dependencies are timed on the new version. Every outcome is recorded (ok / statement_timeout / other);
 * nothing is asserted, so the bound can be set from the numbers.
 */
const ledgerSweep = async (section, company, legalName, reportId, sizes) => {
  M.sweep ??= [];
  for (const rows of sizes) {
    const text = paddedLedger(rows);
    let batch = null;
    try { batch = parseEvidence(company, 2026, "TRANSACTION_LEDGER", "CURRENT", text, PERIODS.current); }
    catch (e) { M.sweep.push({ section, rows, parsed: false, message: String(e.message).slice(0, 160) }); log(`        [sweep ${section}] ${rows} rows: intake refused (${String(e.message).slice(0, 100)})`); continue; }
    const bytes = Buffer.byteLength(JSON.stringify(batch.document));
    const t0 = performance.now();
    let outcome = "ok", message = null, version = null;
    try {
      const r = await save(preparer, company, 2026, legalName, reportId, [batch]);
      if (r.outcome !== "saved") { outcome = "refused"; message = String(r.reason).slice(0, 160); } else version = r.reportVersion;
    } catch (e) {
      const msg = String(e?.message ?? e);
      outcome = /statement timeout|canceling statement/i.test(msg) ? "statement_timeout" : /_LIMIT/.test(msg) ? "refused_by_bound" : "error";
      message = msg.slice(0, 160);
    }
    const saveMs = Math.round(performance.now() - t0);
    const entry = { section, rows, csvBytes: Buffer.byteLength(text), batchDocumentBytes: bytes, saveMs, outcome, message, version };
    if (version) {
      const t1 = performance.now();
      try { const rd = await rpc(partner, "fs_report_readiness", { p_company_id: company, p_report_id: reportId, p_report_version: version }); entry.readinessMs = Math.round(performance.now() - t1); entry.ready = rd?.ready ?? null; entry.blockerCount = rd?.blockers?.length ?? null; }
      catch (e) { entry.readinessMs = Math.round(performance.now() - t1); entry.readinessError = String(e.message).slice(0, 120); }
      const t2 = performance.now();
      try { await rpc(preparer, "fs_reporting_dependencies", { p_company_id: company, p_period_year: 2026 }); entry.dependenciesMs = Math.round(performance.now() - t2); }
      catch (e) { entry.dependenciesMs = Math.round(performance.now() - t2); entry.dependenciesError = String(e.message).slice(0, 120); }
    }
    M.sweep.push(entry);
    log(`        [sweep ${section}] ${rows} rows (${bytes} B): save ${saveMs} ms ${outcome}${message ? ` (${message})` : ""}${version ? `; readiness ${entry.readinessMs} ms ready=${entry.ready}; dependencies ${entry.dependenciesMs} ms` : ""}`);
    if (outcome === "statement_timeout") { log(`        [sweep ${section}] stopping at ${rows} rows: the API session cancelled the save`); break; }
  }
};


// ═══ REPRESENTATIVE ═══════════════════════════════════════════════════════════════════════════════════════════════════
log("\n== REPRESENTATIVE: 18 accounts, two years, the full journey to FINAL and the official pack");
const A = await newCompany("Workload Representative Ltd");
const pA25 = await openPeriod(A, 2025, PERIODS.prior.start, PERIODS.prior.end);
const pA26 = await openPeriod(A, 2026, PERIODS.current.start, PERIODS.current.end);
await uploadReviewCertify(A, "Workload Representative Ltd", 2025, "1 Jul 2024 – 30 Jun 2025", pA25, Buffer.from(tbCsv(PRIOR)), reviewDecisions(), "representative");
await uploadReviewCertify(A, "Workload Representative Ltd", 2026, "1 Jul 2025 – 30 Jun 2026", pA26, Buffer.from(tbCsv(CURRENT)), reviewDecisions(), "representative");
await measure("representative", "assign_presentation_18", () => rpc(preparer, "fs_assign_presentation", { p_company_id: A, p_assignments: Object.entries(ASSIGN).map(([accountKey, lineId]) => ({ accountKey, lineId })), p_reason: "Presentation per the chart of accounts", p_request_id: uuid() }), { size: "18 assignments" });
await explainFindings(A, 2026);
await prepareNotes(A, 2026);
await rpc(preparer, "fs_record_schedule", { p_company_id: A, p_period_year: 2026, p_schedule_id: "ppe", p_rows: PPE_SCHEDULE, p_source_ref: "Fixed asset register FY2026", p_request_id: uuid() });
await measure("representative", "approve_comparatives", () => rpc(partner, "fs_approve_comparatives", { p_company_id: A, p_period_year: 2026, p_approve: true, p_reason: "Agreed to the signed FY2025 statements", p_request_id: uuid() }));
for (let i = 0; i < 3; i++) {
  await measure("representative", "fs_statement_composition", () => rpc(preparer, "fs_statement_composition", { p_company_id: A, p_period_year: 2026 }), { size: "18 accounts" });
  await measure("representative", "fs_notes_status", () => rpc(preparer, "fs_notes_status", { p_company_id: A, p_period_year: 2026 }));
  await measure("representative", "fs_reporting_dependencies", () => rpc(preparer, "fs_reporting_dependencies", { p_company_id: A, p_period_year: 2026 }));
}
const evA = [
  parseEvidence(A, 2026, "TRANSACTION_LEDGER", "CURRENT", EVIDENCE.current.TRANSACTION_LEDGER, PERIODS.current), parseEvidence(A, 2026, "EQUITY_MOVEMENTS", "CURRENT", EVIDENCE.current.EQUITY_MOVEMENTS, PERIODS.current),
  parseEvidence(A, 2026, "CASH_ACCOUNT_MAP", "CURRENT", EVIDENCE.current.CASH_ACCOUNT_MAP, PERIODS.current), parseEvidence(A, 2026, "TRANSACTION_LEDGER", "COMPARATIVE", EVIDENCE.prior.TRANSACTION_LEDGER, PERIODS.prior),
  parseEvidence(A, 2026, "EQUITY_MOVEMENTS", "COMPARATIVE", EVIDENCE.prior.EQUITY_MOVEMENTS, PERIODS.prior), parseEvidence(A, 2026, "PRIOR_PERIOD_STATEMENTS", "COMPARATIVE", EVIDENCE.prior.PRIOR_PERIOD_STATEMENTS, PERIODS.prior),
];
const ridA = `rpt-wl-${uuid()}`;
const statesBefore = async (company, year, who) => {
  const comp = await rpc(who, "fs_statement_composition", { p_company_id: company, p_period_year: year });
  const notes = await rpc(who, "fs_notes_status", { p_company_id: company, p_period_year: year });
  const deps = await rpc(who, "fs_reporting_dependencies", { p_company_id: company, p_period_year: year });
  const out = { composition: comp?.state, compositionBlockers: (comp?.blockers ?? []).slice(0, 10), notes: notes?.state, dependencies: deps?.state, dependencyBlockers: (deps?.blockers ?? []).slice(0, 10) };
  log(`        states before the save: ${JSON.stringify(out)}`);
  return out;
};
const saveOutcome = (label, r) => { if (!r || r.outcome !== "saved") { const d = { outcome: r?.outcome ?? null, reason: r?.reason ?? null, diagnostics: (r?.diagnostics ?? []).slice(0, 8) }; log(`        ${label}: NOT SAVED ${JSON.stringify(d).slice(0, 1500)}`); M.failures.push({ section: label, label: "save", ok: false, errorClass: "refused", message: JSON.stringify(d).slice(0, 600) }); } };
M.representative.statesBeforeSave = await statesBefore(A, 2026, preparer);
const savedA = await measure("representative", "save_evidence_and_bind", () => save(preparer, A, 2026, "Workload Representative Ltd", ridA, evA), { size: "6 batches, 7+7 ledger rows" });
saveOutcome("representative", savedA);
if (savedA?.outcome !== "saved") throw new Error(`the representative save was not saved: ${savedA?.reason ?? JSON.stringify(savedA).slice(0, 300)}`);
let vA = savedA.reportVersion;
const rdA = await measure("representative", "fs_report_readiness", () => rpc(partner, "fs_report_readiness", { p_company_id: A, p_report_id: ridA, p_report_version: vA }));
await check("the representative version is ready for review through the real stack", async () => (rdA?.ready === true ? true : rdA?.blockers ?? rdA));
await measure("representative", "set_state_REVIEWED", () => rpc(partner, "fs_set_publication_state", { p_report_id: ridA, p_report_version: vA, p_company_id: A, p_state: "REVIEWED", p_reason: "Reviewed" }));
await measure("representative", "set_state_FINAL", () => rpc(owner, "fs_set_publication_state", { p_report_id: ridA, p_report_version: vA, p_company_id: A, p_state: "FINAL", p_reason: "Approved for issue" }));
const review = reviewClient(owner.db);
const outputRef = review.outputRef(ridA, vA);
let issuanceId = null, officialSha = null, officialBytes = 0;
const issued = await measure("representative", "issue_official_pack", () => review.issueOfficial(A, 2026, outputRef, (blob, name) => { officialBytes = blob.size; }), { size: "issue RPC + Edge Function store + seal" });
await check("the official pack of the FINAL version is issued and sealed by the server", async () => {
  const list = await review.issuances(A, outputRef);
  const sealed = list.find((i) => i.sealedAt);
  issuanceId = sealed?.issuanceId ?? null; officialSha = sealed?.contentSha256 ?? null;
  return issued === "delivered" && !!issuanceId && /^[0-9a-f]{64}$/.test(officialSha ?? "") ? true : { issued, list };
});
const verified = await measure("representative", "verify_official_pack", () => review.verify(issuanceId), { size: `${officialBytes} bytes stored` });
const retrieved = await measure("representative", "retrieve_official_pack", () => review.retrieve(issuanceId));
await check("verify is intact and retrieve returns the sealed bytes with the matching digest", async () =>
  (verified?.outcome === "intact" && verified.official === true && retrieved?.outcome === "retrieved" && retrieved.content_sha256 === officialSha && retrieved.document.length > 0 ? true : { verified, retrieved: retrieved?.outcome }));
await measure("representative", "issue_official_pack_second", () => review.issueOfficial(A, 2026, outputRef, () => {}));

// ── Concurrency: 8 simultaneous saves of ONE attempt; 8 simultaneous composition reads ───────────────────────────────
log("\n== CONCURRENCY (representative lineage)");
await rpc(preparer, "fs_record_disclosure", { p_company_id: A, p_period_year: 2026, p_requirement_id: "smes.note.judgements", p_body: "None beyond estimates; reviewed again.", p_source_ref: "Notes v2", p_request_id: uuid() });
{
  const k = `attempt-${uuid()}`;
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: 8 }, () => save(preparer, A, 2026, "Workload Representative Ltd", ridA, [], k).then((v) => ({ ok: true, v: v.outcome, version: v.reportVersion }), (e) => ({ ok: false, e: String(e.message).slice(0, 120) }))));
  const ms = Math.round(performance.now() - t0);
  const versions = await rpc(preparer, "fs_list_saved_versions", { p_company_id: A, p_period_year: 2026 });
  M.concurrency.duplicate_saves = { parallel: 8, wallMs: ms, outcomes: rs, versionsAfter: versions.length };
  log(`        [concurrency] 8 simultaneous saves of one attempt: ${ms} ms wall; ${rs.filter((r) => r.ok).length} answered, ${rs.filter((r) => !r.ok).length} refused; versions now ${versions.length}`);
  const t1 = performance.now();
  const reads = await Promise.all(Array.from({ length: 8 }, () => rpc(preparer, "fs_statement_composition", { p_company_id: A, p_period_year: 2026 }).then(() => true, () => false)));
  M.concurrency.parallel_reads = { parallel: 8, wallMs: Math.round(performance.now() - t1), ok: reads.filter(Boolean).length };
  log(`        [concurrency] 8 simultaneous compositions: ${M.concurrency.parallel_reads.wallMs} ms wall, ${M.concurrency.parallel_reads.ok}/8 ok`);
}

// ── History growth: 30 further versions on the representative lineage ───────────────────────────────────────────────
log("\n== HISTORY: 30 further versions (a disclosure changes before each save)");
for (let i = 1; i <= 30; i++) {
  await rpc(preparer, "fs_record_disclosure", { p_company_id: A, p_period_year: 2026, p_requirement_id: "smes.note.judgements", p_body: `Judgements, revision ${i} of the history measurement.`, p_source_ref: `Notes h${i}`, p_request_id: uuid() });
  const t0 = performance.now(); let saved = null, err = null;
  try { saved = await save(preparer, A, 2026, "Workload Representative Ltd", ridA, []); } catch (e) { err = String(e.message).slice(0, 120); }
  const saveMs = Math.round(performance.now() - t0);
  const v = saved?.reportVersion ?? vA;
  const t1 = performance.now(); const list = await rpc(preparer, "fs_list_saved_versions", { p_company_id: A, p_period_year: 2026 }); const listMs = Math.round(performance.now() - t1);
  const t2 = performance.now(); let ready = null; try { ready = await rpc(partner, "fs_report_readiness", { p_company_id: A, p_report_id: ridA, p_report_version: v }); } catch (e) { err = (err ?? "") + ` readiness: ${String(e.message).slice(0, 80)}`; } const readyMs = Math.round(performance.now() - t2);
  const t3 = performance.now(); const comments = await rpc(partner, "fs_review_comments", { p_company_id: A, p_report_id: ridA, p_report_version: v }); const commentsMs = Math.round(performance.now() - t3);
  const { data: doc } = await owner.c.from("financial_statement_reports").select("report_document").eq("report_id", ridA).eq("report_version", v).single();
  const docBytes = doc ? Buffer.byteLength(JSON.stringify(doc.report_document)) : null;
  M.history.push({ i, version: v, saveMs, listVersionsMs: listMs, versionsListed: list.length, readinessMs: readyMs, ready: ready?.ready ?? null, commentsMs, documentBytes: docBytes, error: err });
  if ([1, 5, 10, 20, 30].includes(i)) log(`        [history] +${i}: version ${v}, save ${saveMs} ms, list ${listMs} ms (${list.length} versions), readiness ${readyMs} ms, comments ${commentsMs} ms, document ${docBytes} B${err ? `, error ${err}` : ""}`);
}

// ── Ledger-size sweep at 18 accounts (a fresh lineage, AFTER concurrency and history: a stored large ledger slows every later save and readiness on the period - measured in run 39273436340) ─────────────────────
log("\n== SWEEP at 18 accounts: ledger sizes 500 / 1,000 (the bound) / 2,000 (over the bound: refused by the intake)");
await ledgerSweep("representative-18", A, "Workload Representative Ltd", `rpt-wl-sweep-${uuid()}`, [500, 1000, 2000]);


// Split every account but the bank into parts; the parts' amounts sum exactly to the parent's in BOTH years.
const scaledRows = (nAccounts) => {
  const parents = TB.filter((r) => r[0] !== CODES.bank);
  const nParts = nAccounts - 1;
  const base = Math.floor(nParts / parents.length), extra = nParts - base * parents.length;
  const rows = [TB.find((r) => r[0] === CODES.bank)];
  parents.forEach((r, pi) => {
    const k = base + (pi < extra ? 1 : 0);
    const cur = minor(r[5] || r[6]), pri = minor(r[7] || r[8]);
    const curDebit = !!r[5], priDebit = !!r[7];
    for (let i = 0; i < k; i++) {
      const cm = i === k - 1 ? cur - Math.floor(cur / k) * (k - 1) : Math.floor(cur / k);
      const pm = i === k - 1 ? pri - Math.floor(pri / k) * (k - 1) : Math.floor(pri / k);
      rows.push([`${r[0]}${String(i).padStart(3, "0")}`, `${r[1]} ${i + 1}`, r[2], r[3], r[4], curDebit ? money(cm) : "", curDebit ? "" : money(cm), priDebit ? money(pm) : "", priDebit ? "" : money(pm)]);
    }
  });
  return rows;
};
const parentOf = (code) => (code === CODES.bank ? code : code.slice(0, -3));
const bigEquity = (() => {
  const lines = EVIDENCE.current.EQUITY_MOVEMENTS.trimEnd().split(String.fromCharCode(10));
  for (let i = 0; lines.length < 51; i++) lines.push(`Retained earnings,PROFIT_OR_LOSS,${i % 2 ? "-1.00" : "1.00"},Netting movement ${i}`);
  return lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
})();
const LEDGER_ROWS = 1000; // the evidence bound (fs_work_bounds evidenceRowsPerBatch = INTAKE_LIMITS.maxRows)
const minor = (t) => (t ? Math.round(Number(t) * 100) : 0);
const money = (m) => (m / 100).toFixed(2);
// ═══ CAPACITY: candidate account envelopes through the real stack ═══════════════════════════════════════════════════
// The supported account count must be VALIDATED at the candidate, with the supported evidence volume (a ledger at the
// evidence bound), retained versions and concurrency — never inferred from the 18-account journey.
const capacityRun = async (n) => {
  const section = `capacity-${n}`;
  M[section] = {};
  const rows = scaledRows(n);
  const csvOf = (col) => "Account code,Account name,Debit,Credit" + String.fromCharCode(10) + rows.map((r) => `${r[0]},${r[1]},${r[col]},${r[col + 1]}`).join(String.fromCharCode(10)) + String.fromCharCode(10);
  const decisions = rows.map(([code, name, cls, st, nb]) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: code === CODES.bank }));
  const assign = rows.map(([code]) => ({ accountKey: code, lineId: ASSIGN[parentOf(code)] }));
  const name = `Workload Capacity ${n} Ltd`;
  const C = await newCompany(name);
  const p25 = await openPeriod(C, 2025, PERIODS.prior.start, PERIODS.prior.end);
  const p26 = await openPeriod(C, 2026, PERIODS.current.start, PERIODS.current.end);
  log(`${String.fromCharCode(10)}== CAPACITY candidate: ${n} accounts in each of two years (${2 * n} read by the composition), evidence at the bound`);
  const out = { accounts: n, accountsRead: 2 * n, failures: [] };
  M.capacity ??= []; M.capacity.push(out);
  try {
    await uploadReviewCertify(C, name, 2025, "1 Jul 2024 - 30 Jun 2025", p25, Buffer.from(csvOf(PRIOR)), decisions, section);
    await uploadReviewCertify(C, name, 2026, "1 Jul 2025 - 30 Jun 2026", p26, Buffer.from(csvOf(CURRENT)), decisions, section);
    for (let i = 0; i < assign.length; i += 500) await measure(section, "fs_assign_presentation_chunk", () => rpc(preparer, "fs_assign_presentation", { p_company_id: C, p_assignments: assign.slice(i, i + 500), p_reason: "Presentation per the chart of accounts", p_request_id: uuid() }));
    await measure(section, "close_review_refresh_and_explain", () => explainFindings(C, 2026));
    await prepareNotes(C, 2026);
    await rpc(preparer, "fs_record_schedule", { p_company_id: C, p_period_year: 2026, p_schedule_id: "ppe", p_rows: PPE_SCHEDULE, p_source_ref: "Fixed asset register FY2026", p_request_id: uuid() });
    await measure(section, "fs_approve_comparatives", () => rpc(partner, "fs_approve_comparatives", { p_company_id: C, p_period_year: 2026, p_approve: true, p_reason: "Agreed to the FY2025 statements", p_request_id: uuid() }));
    for (let i = 0; i < 3; i++) {
      await measure(section, "fs_statement_composition", () => rpc(preparer, "fs_statement_composition", { p_company_id: C, p_period_year: 2026 }));
      await measure(section, "fs_notes_status", () => rpc(preparer, "fs_notes_status", { p_company_id: C, p_period_year: 2026 }));
      await measure(section, "fs_reporting_dependencies", () => rpc(preparer, "fs_reporting_dependencies", { p_company_id: C, p_period_year: 2026 }));
    }
    const ev = [parseEvidence(C, 2026, "TRANSACTION_LEDGER", "CURRENT", paddedLedger(LEDGER_ROWS), PERIODS.current), parseEvidence(C, 2026, "EQUITY_MOVEMENTS", "CURRENT", bigEquity, PERIODS.current),
      parseEvidence(C, 2026, "CASH_ACCOUNT_MAP", "CURRENT", EVIDENCE.current.CASH_ACCOUNT_MAP, PERIODS.current),
      parseEvidence(C, 2026, "TRANSACTION_LEDGER", "COMPARATIVE", EVIDENCE.prior.TRANSACTION_LEDGER, PERIODS.prior), parseEvidence(C, 2026, "EQUITY_MOVEMENTS", "COMPARATIVE", EVIDENCE.prior.EQUITY_MOVEMENTS, PERIODS.prior),
      parseEvidence(C, 2026, "PRIOR_PERIOD_STATEMENTS", "COMPARATIVE", EVIDENCE.prior.PRIOR_PERIOD_STATEMENTS, PERIODS.prior)];
    const rid = `rpt-wl-cap-${n}-${uuid()}`;
    const saved = await measure(section, "save_evidence_and_bind", () => save(preparer, C, 2026, name, rid, ev), { size: `6 batches incl. a ${LEDGER_ROWS}-row ledger` });
    if (saved?.outcome !== "saved") { out.failures.push({ step: "save", detail: JSON.stringify({ outcome: saved?.outcome, reason: saved?.reason }).slice(0, 300) }); throw new Error(`capacity ${n}: the save was not saved`); }
    let v = saved.reportVersion;
    let rd = null;
    for (let i = 0; i < 3; i++) rd = await measure(section, "fs_report_readiness", () => rpc(partner, "fs_report_readiness", { p_company_id: C, p_report_id: rid, p_report_version: v }));
    out.ready = rd?.ready ?? null; out.blockers = (rd?.blockers ?? []).slice(0, 8);
    if (rd?.ready) {
      await measure(section, "set_state_REVIEWED", () => rpc(partner, "fs_set_publication_state", { p_report_id: rid, p_report_version: v, p_company_id: C, p_state: "REVIEWED", p_reason: "Reviewed" }));
      await measure(section, "set_state_FINAL", () => rpc(owner, "fs_set_publication_state", { p_report_id: rid, p_report_version: v, p_company_id: C, p_state: "FINAL", p_reason: "Approved for issue" }));
      const rc = reviewClient(owner.db);
      const ref = rc.outputRef(rid, v);
      const issued = await measure(section, "issue_official_pack", () => rc.issueOfficial(C, 2026, ref, () => {}));
      const list = issued === "delivered" ? await rc.issuances(C, ref) : [];
      const sealed = list.find((x) => x.sealedAt);
      if (sealed) { const vr = await measure(section, "verify_official_pack", () => rc.verify(sealed.issuanceId)); out.officialPack = vr?.outcome ?? null; }
      else out.officialPack = `not sealed (${issued})`;
    }
    // Retained versions: ten further saves (a disclosure changes before each), readiness on each.
    for (let i = 1; i <= 10; i++) {
      await rpc(preparer, "fs_record_disclosure", { p_company_id: C, p_period_year: 2026, p_requirement_id: "smes.note.judgements", p_body: `Judgements, revision ${i} at ${n} accounts.`, p_source_ref: `Notes c${i}`, p_request_id: uuid() });
      const r = await measure(section, "history_save", () => save(preparer, C, 2026, name, rid, []));
      if (r?.outcome === "saved") { v = r.reportVersion; await measure(section, "history_readiness", () => rpc(partner, "fs_report_readiness", { p_company_id: C, p_report_id: rid, p_report_version: v })); }
    }
    await measure(section, "fs_list_saved_versions", () => rpc(preparer, "fs_list_saved_versions", { p_company_id: C, p_period_year: 2026 }));
    // Concurrency: eight simultaneous saves of one attempt, then eight simultaneous readiness reads.
    await rpc(preparer, "fs_record_disclosure", { p_company_id: C, p_period_year: 2026, p_requirement_id: "smes.note.judgements", p_body: `Judgements, concurrent revision at ${n} accounts.`, p_source_ref: "Notes cc", p_request_id: uuid() });
    const k = `attempt-${uuid()}`;
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: 8 }, () => save(preparer, C, 2026, name, rid, [], k).then((x) => ({ ok: x.outcome === "saved", v: x.reportVersion }), (e) => ({ ok: false, e: String(e.message).slice(0, 100) }))));
    out.concurrentSaves = { wallMs: Math.round(performance.now() - t0), answered: rs.filter((x) => x.ok).length, refused: rs.filter((x) => !x.ok).map((x) => x.e).slice(0, 3) };
    const latestV = Math.max(v, ...rs.map((x) => x.v ?? 0));
    const t1 = performance.now();
    const reads = await Promise.all(Array.from({ length: 8 }, () => rpc(partner, "fs_report_readiness", { p_company_id: C, p_report_id: rid, p_report_version: latestV }).then(() => true, (e) => String(e.message).slice(0, 80))));
    out.concurrentReadiness = { wallMs: Math.round(performance.now() - t1), ok: reads.filter((x) => x === true).length, errors: reads.filter((x) => x !== true).slice(0, 3) };
    log(`        [${section}] 8 simultaneous saves ${out.concurrentSaves.wallMs} ms (${out.concurrentSaves.answered} answered); 8 simultaneous readiness ${out.concurrentReadiness.wallMs} ms (${out.concurrentReadiness.ok}/8 ok)`);
  } catch (e) {
    out.failures.push({ step: "run", detail: String(e.message).slice(0, 300) });
    log(`        [${section}] stopped: ${String(e.message).slice(0, 300)} (recorded)`);
  }
  // The margin: the slowest single API call of this candidate against the 8 s statement timeout.
  const calls = Object.entries(M[section]).filter(([, xs]) => Array.isArray(xs)).flatMap(([label, xs]) => xs.map((x) => ({ label, ms: x.ms, ok: x.ok })));
  const single = calls.filter((c) => !/^(save_evidence_and_bind|history_save|close_review_refresh_and_explain|issue_official_pack)$/.test(c.label)); // multi-call steps excluded from the single-call margin
  const slowest = single.reduce((a, c) => (c.ms > (a?.ms ?? -1) ? c : a), null);
  out.slowestSingleCall = slowest; out.timeouts = calls.filter((c) => !c.ok).length;
  out.marginUnder8s = slowest ? Math.round((8000 / slowest.ms) * 100) / 100 : null;
  log(`        [${section}] slowest single call ${slowest?.label} ${slowest?.ms} ms → margin ${out.marginUnder8s}x; timeouts/failures ${out.timeouts}`);
};
for (const n of [500, 1000]) await capacityRun(n);

// ═══ DEMANDING ═══════════════════════════════════════════════════════════════════════════════════════════════════════
log("\n== DEMANDING: 2,000 accounts, a ledger at the evidence bound, 50 equity rows");
let N_ACCOUNTS = 2000;
let bigRows, bigDecisions, bigAssign, D, pD26;
const bigTbCsv = (col) => "Account code,Account name,Debit,Credit" + String.fromCharCode(10) + bigRows.map((r) => `${r[0]},${r[1]},${r[col]},${r[col + 1]}`).join(String.fromCharCode(10)) + String.fromCharCode(10);
for (const n of [2000, 1000]) {
  N_ACCOUNTS = n;
  bigRows = scaledRows(n);
  bigDecisions = bigRows.map(([code, name, cls, st, nb]) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: code === CODES.bank }));
  bigAssign = bigRows.map(([code]) => ({ accountKey: code, lineId: ASSIGN[parentOf(code)] }));
  M.demanding.fixture = { accounts: bigRows.length, csvBytesCurrent: Buffer.byteLength(bigTbCsv(CURRENT)), csvBytesPrior: Buffer.byteLength(bigTbCsv(PRIOR)), ledgerRows: LEDGER_ROWS, equityRows: 50 };
  D = await newCompany(`Workload Demanding ${n} Ltd`);
  const pD25 = await openPeriod(D, 2025, PERIODS.prior.start, PERIODS.prior.end);
  pD26 = await openPeriod(D, 2026, PERIODS.current.start, PERIODS.current.end);
  try {
    await uploadReviewCertify(D, `Workload Demanding ${n} Ltd`, 2025, "1 Jul 2024 - 30 Jun 2025", pD25, Buffer.from(bigTbCsv(PRIOR)), bigDecisions, "demanding");
    await uploadReviewCertify(D, `Workload Demanding ${n} Ltd`, 2026, "1 Jul 2025 - 30 Jun 2026", pD26, Buffer.from(bigTbCsv(CURRENT)), bigDecisions, "demanding");
    M.demanding.fixture.certified = true;
    if (n === 2000) { results.push({ name: "the 2,000-account trial balance (the processing limit) certifies after every account is reviewed in one batch (DEFECT-PTB-MAPPINGS-API-ROW-CAP-001)", ok: true }); log("  PASS  the 2,000-account trial balance certifies after review"); }
    break;
  } catch (e) {
    if (!e?.notCertified || n === 1000) throw e;
    results.push({ name: "the 2,000-account trial balance (the processing limit) certifies after every account is reviewed in one batch (DEFECT-PTB-MAPPINGS-API-ROW-CAP-001)", ok: false });
    log(`  FAIL  the 2,000-account trial balance certifies after review: ${String(e.message).slice(0, 300)}`);
    log(`        [demanding] continuing with 1,000 accounts on a fresh company (the 2,000-account outcome is recorded above)`);
    M.notes.push(`demanding: the ${n}-account trial balance was not certified on this stack; the FS workload below is measured at 1,000 accounts`);
  }
}
for (let i = 0; i < bigAssign.length; i += 500) {
  await measure("demanding", "assign_presentation_chunk_500", () => rpc(preparer, "fs_assign_presentation", { p_company_id: D, p_assignments: bigAssign.slice(i, i + 500), p_reason: "Presentation per the chart of accounts", p_request_id: uuid() }), { size: `${Math.min(500, bigAssign.length - i)} assignments` });
}
await measure("demanding", "close_review_refresh_and_explain", () => explainFindings(D, 2026), { size: `${N_ACCOUNTS} accounts` });
await prepareNotes(D, 2026);
await rpc(preparer, "fs_record_schedule", { p_company_id: D, p_period_year: 2026, p_schedule_id: "ppe", p_rows: PPE_SCHEDULE, p_source_ref: "Fixed asset register FY2026", p_request_id: uuid() });
await measure("demanding", "approve_comparatives", () => rpc(partner, "fs_approve_comparatives", { p_company_id: D, p_period_year: 2026, p_approve: true, p_reason: "Agreed to the FY2025 statements", p_request_id: uuid() }));
for (let i = 0; i < 3; i++) {
  await measure("demanding", "fs_statement_composition", () => rpc(preparer, "fs_statement_composition", { p_company_id: D, p_period_year: 2026 }), { size: `${N_ACCOUNTS} accounts` });
  await measure("demanding", "fs_notes_status", () => rpc(preparer, "fs_notes_status", { p_company_id: D, p_period_year: 2026 }));
  await measure("demanding", "fs_reporting_dependencies", () => rpc(preparer, "fs_reporting_dependencies", { p_company_id: D, p_period_year: 2026 }));
}
// The fixture ledger (7 rows that tie to the bank account's movement) padded to 20,000 rows with netting pairs on the same
// account (a 1.00 receipt and a 1.00 payment, both operating): the movement, and every tie, is unchanged. 50 equity rows:
// the fixture's 6 plus 22 netting pairs inside PROFIT_OR_LOSS. Invented, at the intake limit.
const bigLedger = (() => {
  const base = EVIDENCE.current.TRANSACTION_LEDGER.trimEnd().split(String.fromCharCode(10));
  const lines = [...base];
  for (let i = lines.length - 1; i < LEDGER_ROWS; i++) {
    const m = 7 + (i % 12); const y = m > 12 ? 2026 : 2025; const mm = ((m - 1) % 12) + 1; const d = 1 + (i % 28);
    const date = `${y}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    lines.push(`N${i},${date},${CODES.bank},Invented ${i % 2 ? "payment" : "receipt"} ${i},${i % 2 ? "" : "1.00"},${i % 2 ? "1.00" : ""},OPERATING,${i % 2 ? "Payments to suppliers and employees" : "Receipts from customers"}`);
  }
  return lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
})();
M.demanding.fixture.ledgerRows = bigLedger.trimEnd().split(String.fromCharCode(10)).length - 1;
M.demanding.fixture.equityRows = bigEquity.trimEnd().split(String.fromCharCode(10)).length - 1;
let evD = [];
try {
  evD = [parseEvidence(D, 2026, "TRANSACTION_LEDGER", "CURRENT", bigLedger, PERIODS.current), parseEvidence(D, 2026, "EQUITY_MOVEMENTS", "CURRENT", bigEquity, PERIODS.current),
    parseEvidence(D, 2026, "CASH_ACCOUNT_MAP", "CURRENT", EVIDENCE.current.CASH_ACCOUNT_MAP, PERIODS.current),
    parseEvidence(D, 2026, "TRANSACTION_LEDGER", "COMPARATIVE", EVIDENCE.prior.TRANSACTION_LEDGER, PERIODS.prior), parseEvidence(D, 2026, "EQUITY_MOVEMENTS", "COMPARATIVE", EVIDENCE.prior.EQUITY_MOVEMENTS, PERIODS.prior),
    parseEvidence(D, 2026, "PRIOR_PERIOD_STATEMENTS", "COMPARATIVE", EVIDENCE.prior.PRIOR_PERIOD_STATEMENTS, PERIODS.prior)];
  M.demanding.fixture.ledgerCsvBytes = Buffer.byteLength(bigLedger);
  M.demanding.fixture.ledgerBatchDocumentBytes = Buffer.byteLength(JSON.stringify(evD[0].document));
  M.notes.push(`demanding evidence parsed by the browser intake code: ledger ${M.demanding.fixture.ledgerRows} rows (${M.demanding.fixture.ledgerCsvBytes} CSV bytes, ${M.demanding.fixture.ledgerBatchDocumentBytes} B as a batch document), equity ${M.demanding.fixture.equityRows} rows, plus the comparative evidence`);
} catch (e) { M.failures.push({ section: "demanding", label: "evidence_parse", ok: false, errorClass: "intake_refusal", message: String(e.message).slice(0, 200) }); log(`        [demanding] evidence parse: ${String(e.message).slice(0, 200)}`); }
try { M.demanding.statesBeforeSave = await statesBefore(D, 2026, preparer); } catch (e) { M.demanding.statesBeforeSave = { error: String(e.message).slice(0, 200) }; M.failures.push({ section: "demanding", label: "states_before_save", ok: false, errorClass: /statement timeout/i.test(String(e.message)) ? "statement_timeout" : "error", message: String(e.message).slice(0, 200), accounts: N_ACCOUNTS }); log(`        [demanding] states before the save: ${String(e.message).slice(0, 200)}`); }
const ridD = `rpt-wl-big-${uuid()}`;
try {
// The demanding sweep first stores the small fixture evidence (so composition has every statement), then grows the ledger.
log(`\n== SWEEP at ${N_ACCOUNTS} accounts: ledger sizes 500 / 1,000 (the bound) / 2,000 (over the bound)`);
{
  const small = [parseEvidence(D, 2026, "TRANSACTION_LEDGER", "CURRENT", EVIDENCE.current.TRANSACTION_LEDGER, PERIODS.current), parseEvidence(D, 2026, "EQUITY_MOVEMENTS", "CURRENT", bigEquity, PERIODS.current),
    parseEvidence(D, 2026, "CASH_ACCOUNT_MAP", "CURRENT", EVIDENCE.current.CASH_ACCOUNT_MAP, PERIODS.current),
    parseEvidence(D, 2026, "TRANSACTION_LEDGER", "COMPARATIVE", EVIDENCE.prior.TRANSACTION_LEDGER, PERIODS.prior), parseEvidence(D, 2026, "EQUITY_MOVEMENTS", "COMPARATIVE", EVIDENCE.prior.EQUITY_MOVEMENTS, PERIODS.prior),
    parseEvidence(D, 2026, "PRIOR_PERIOD_STATEMENTS", "COMPARATIVE", EVIDENCE.prior.PRIOR_PERIOD_STATEMENTS, PERIODS.prior)];
  const ridS = `rpt-wl-sweep-${N_ACCOUNTS}-${uuid()}`;
  const base = await measure("demanding", "save_small_evidence_and_bind", () => save(preparer, D, 2026, `Workload Demanding ${N_ACCOUNTS} Ltd`, ridS, small), { size: "6 small batches" });
  if (base?.outcome === "saved") {
    M.demanding.smallSave = { version: base.reportVersion };
    for (let i = 0; i < 2; i++) await measure("demanding", "fs_report_readiness_small_evidence", () => rpc(partner, "fs_report_readiness", { p_company_id: D, p_report_id: ridS, p_report_version: base.reportVersion }));
    await ledgerSweep(`demanding-${N_ACCOUNTS}`, D, `Workload Demanding ${N_ACCOUNTS} Ltd`, ridS, [500, 1000, 2000]);
  } else saveOutcome("demanding-small", base);
}
} catch (e) {
  M.failures.push({ section: "demanding", label: "fs_workload_at_account_count", ok: false, errorClass: /statement timeout/i.test(String(e.message)) ? "statement_timeout" : "error", message: String(e.message).slice(0, 200), accounts: N_ACCOUNTS });
  log(`        [demanding] the FS workload at ${N_ACCOUNTS} accounts stopped: ${String(e.message).slice(0, 200)} (recorded as a measurement)`);
}
const savedD = evD.length ? await measure("demanding", "save_evidence_and_bind", () => save(preparer, D, 2026, `Workload Demanding ${N_ACCOUNTS} Ltd`, ridD, evD), { size: `${LEDGER_ROWS}-row ledger, ${Buffer.byteLength(bigLedger)} bytes` }) : null;
if (evD.length) saveOutcome("demanding", savedD);
const vD = savedD?.outcome === "saved" ? savedD.reportVersion : 0;
if (vD) {
  for (let i = 0; i < 3; i++) {
    const rd = await measure("demanding", "fs_report_readiness", () => rpc(partner, "fs_report_readiness", { p_company_id: D, p_report_id: ridD, p_report_version: vD }));
    if (i === 0) { M.demanding.readiness = { ready: rd?.ready ?? null, blockers: (rd?.blockers ?? []).map((b) => String(b).slice(0, 120)).slice(0, 20), blockerCount: rd?.blockers?.length ?? null }; log(`        [demanding] readiness: ready=${rd?.ready} blockers=${rd?.blockers?.length ?? "?"}`); }
    await measure("demanding", "fs_reporting_dependencies_after_evidence", () => rpc(preparer, "fs_reporting_dependencies", { p_company_id: D, p_period_year: 2026 }));
  }
  await measure("demanding", "fs_list_saved_versions", () => rpc(preparer, "fs_list_saved_versions", { p_company_id: D, p_period_year: 2026 }));
  const { data: docD } = await owner.c.from("financial_statement_reports").select("report_document").eq("report_id", ridD).eq("report_version", vD).single();
  M.demanding.document = { version: vD, documentBytes: docD ? Buffer.byteLength(JSON.stringify(docD.report_document)) : null, facts: docD?.report_document?.facts?.length ?? null };
  log(`        [demanding] document: version ${vD}, ${M.demanding.document.documentBytes} B, ${M.demanding.document.facts} facts`);
  const { data: batches } = await owner.c.from("financial_evidence_batches").select("evidence_type, period_role, version, validation_status").eq("company_id", D);
  M.demanding.evidenceBatches = batches ?? null;
}

// ── Summary ───────────────────────────────────────────────────────────────────────────────────────────────────────────
writeSummary();
function writeSummary() {
const med = (xs) => { const s = xs.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const summary = {};
for (const section of ["representative", "demanding"]) for (const [label, xs] of Object.entries(M[section])) if (Array.isArray(xs)) summary[`${section}.${label}`] = { n: xs.length, medianMs: med(xs), maxMs: Math.max(...xs.map((x) => x.ms)), failures: xs.filter((x) => !x.ok).length };
M.summary = summary;
if (writeSummary.done) { fs.writeFileSync(path.join(OUT, "measurements.json"), JSON.stringify({ ...M, checks: results }, null, 2)); return; }
writeSummary.done = true;
fs.writeFileSync(path.join(OUT, "measurements.json"), JSON.stringify({ ...M, checks: results }, null, 2));
log("\n== Summary (median ms of client-observed API round trips; not CPU)");
for (const [k, v] of Object.entries(summary)) log(`  ${k.padEnd(58)} n=${v.n} median=${v.medianMs} max=${v.maxMs}${v.failures ? ` FAILURES=${v.failures}` : ""}`);
log(`  history: save ${M.history[0]?.saveMs}→${M.history.at(-1)?.saveMs} ms, list ${M.history[0]?.listVersionsMs}→${M.history.at(-1)?.listVersionsMs} ms over ${M.history.length} versions; document ${M.history.at(-1)?.documentBytes} B`);
log(`  failures recorded: ${M.failures.length}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\nchecks: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
console.log(failed.length === 0 && results.length > 0 ? "WORKLOAD_MEASUREMENT: COMPLETE" : "WORKLOAD_MEASUREMENT: INCOMPLETE");
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
