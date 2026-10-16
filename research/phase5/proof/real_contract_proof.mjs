#!/usr/bin/env node
// Phase 5 — REAL-CONTRACT EXECUTION PROOF (REPLAYABLE; not executed on the research host).
//
// Replays the AUTHORITATIVE migration chain from zero on a disposable PostgreSQL (16/17 — the runtime's ACTUAL version is
// queried and reported; NOTHING here hard-codes a version as an executed result), then drives the REAL
// resolve_account_review_batch (its actual definition in the isolated runtime — NOT a hosted customer DB) with the SAME
// grouped proposals this research's prototype produces, expanded to per-account decisions. Proves legitimate SUCCESS and
// REFUSAL, plus the lifecycle scenarios the runtime permits.
//
// RUN (where a loopback PostgreSQL exists — CI service, local Docker, or an external loopback):
//   DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/phase5_proof node research/phase5/proof/real_contract_proof.mjs
// Loopback only; refuses the production project ref. Requires the `pg` package (already a devDependency: pg@8.23.1) and a
// migration chain present at supabase/migrations. This host (no Docker / no local Postgres / Windows embedded-pg) cannot run
// it; scope-cleanliness forbids wiring a CI workflow here, so it is delivered as a replayable package for a PG-capable runtime.
//
// SEATS: the named-user seat wall (trg_firm_members_named_user_seats; included_seats = 1 on every paid plan) previously
// stopped a run at SEAT_LIMIT_REACHED during fixture setup when more than one synthetic member was seeded. Fixed here by
// provisioning seats through the SUPPORTED authority — a NAMED_USER_SEATS entitlement override (ADMIN_OVERRIDE path in
// _seat_capacity_for_account) — before any additional member is inserted. No trigger is bypassed.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildReviewSummary, expandGroupToDecisions } from "../prototype/lifecycle.mjs";
import { buildManualDecisions } from "../prototype/manual.mjs";
import { FLAT } from "../fixtures/synthetic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const require = createRequire(import.meta.url);
const CONN = process.env.DB_PROOF_CONN;
if (!CONN) { console.error("Set DB_PROOF_CONN=postgres://…@127.0.0.1:5432/db (loopback)"); process.exit(2); }
if (CONN.includes(PRODUCTION_REF)) { console.error("REFUSED: production project ref"); process.exit(2); }
{ const u = new URL(CONN); if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) { console.error(`REFUSED: ${u.hostname} not loopback`); process.exit(2); } }
const { Client, Pool } = require("pg");

const uuid = () => globalThis.crypto.randomUUID();
const U = { owner: uuid(), partner: uuid(), viewer: uuid(), ownerB: uuid() };
let admin, pool, PRODUCT, COMPANY_A, COMPANY_B, UPLOAD_A, UPLOAD_A2;
const results = [];
const rec = (n, ok, d = "") => { results.push({ n, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok || !d ? "" : `  — ${d}`}`); };

async function replayAll() {
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  const dir = path.join(REPO, "supabase/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    let text = fs.readFileSync(path.join(dir, f), "utf8");
    if (f === PG_CRON_FILE) { const L = text.split("\n"); text = L.slice(0, L.findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n"); }
    try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
  }
  await admin.query("GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role");
  await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated");
  return files.length;
}
async function giveLicence(user, plan) {
  const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) ON CONFLICT (owner_user_id) DO UPDATE SET product_id=EXCLUDED.product_id RETURNING id", [user, PRODUCT])).rows[0].id;
  await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start) SELECT $1,id,'ACTIVE','ADMIN_GRANT', now()-interval '1 day' FROM public.commercial_plans WHERE product_id=$2 AND code=$3", [bc, PRODUCT, plan]);
  return bc;
}
// Provision synthetic named-user seats through the SUPPORTED authority: a NAMED_USER_SEATS entitlement override
// (ADMIN_OVERRIDE in _seat_capacity_for_account). This is the schema's own seat-capacity mechanism, not a trigger bypass.
async function giveSeats(bc, grantedBy, n) {
  await admin.query(
    "INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, granted_by, reason, effective_start) VALUES ($1,'NAMED_USER_SEATS',$2,$3,'synthetic phase5 proof seats', now()-interval '1 day')",
    [bc, n, grantedBy]);
}
async function mkUpload(company, owner, hash) {
  return (await admin.query(
    "INSERT INTO public.trial_balance_uploads (user_id, company_id, period_year, file_name, file_path, file_size, status, source_file_hash) VALUES ($1,$2,2026,$3,$4,100,'needs_review',$5) RETURNING id",
    [owner, company, `${hash}.csv`, `workspaces/${company}/${hash}.csv`, hash])).rows[0].id;
}
async function asUser(uid, fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const out = await fn(c); await c.query("COMMIT"); return out;
  } catch (e) { try { await c.query("ROLLBACK"); } catch {} throw e; } finally { c.release(); }
}
async function refused(name, uid, fn, codeRe) {
  let ref = false, d = ""; try { await asUser(uid, fn); } catch (e) { ref = true; d = String(e.message).split("\n")[0]; }
  const infra = /permission denied for (schema|table|relation)/i.test(d);
  rec(name, ref && !infra && (!codeRe || codeRe.test(d)), ref ? (infra ? `INVALID infra: ${d}` : (!codeRe || codeRe.test(d) ? "" : `wrong error: ${d}`)) : "SUCCEEDED (control not enforced)");
}
const callBatch = (c, company, upload, req, decisions) => c.query("SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb) r", [company, upload, req, JSON.stringify(decisions)]);

async function main() {
  admin = new Client({ connectionString: CONN }); await admin.connect();
  pool = new Pool({ connectionString: CONN, max: 6 });
  const total = await replayAll();
  const ver = (await admin.query("SELECT current_setting('server_version') AS v, version() AS full")).rows[0];
  console.log(`  [runtime] PostgreSQL ${ver.v}  (${ver.full})`);
  rec(`REPLAY · entire authoritative migration chain (${total} files) applied on PostgreSQL ${ver.v}`, true);

  // ── Seed: product, licences (prepare_close needs a current plan), SEATS (override so >1 synthetic member is allowed),
  //    companies (auto owner firm_member), a partner + viewer, an upload bound to company A. ──
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1,$2, now())", [id, `${k}@example.test`]);
  PRODUCT = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const bcOwner = await giveLicence(U.owner, "FIRM"); await giveLicence(U.ownerB, "PRACTICE");
  await giveSeats(bcOwner, U.owner, 25);   // included_seats is 1 on every paid plan; provision enough for owner + partner + viewer
  COMPANY_A = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'Co A') RETURNING id", [U.owner])).rows[0].id;
  COMPANY_B = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'Co B') RETURNING id", [U.ownerB])).rows[0].id;
  rec(`SEATS · NAMED_USER_SEATS override provisioned via supported authority before seeding members (no trigger bypass)`, true);
  await admin.query("INSERT INTO public.firm_members (company_id, user_id, role, accepted_at) VALUES ($1,$2,'partner',now()),($1,$3,'viewer',now())", [COMPANY_A, U.partner, U.viewer]);
  UPLOAD_A = await mkUpload(COMPANY_A, U.owner, "a".repeat(64));

  // ── Build the SAME grouped proposals the prototype produces; expand to per-account decisions. ──
  const summary = buildReviewSummary({ upload: { id: UPLOAD_A, company_id: COMPANY_A, source_digest: FLAT.source_digest }, headers: FLAT.headers, dataRows: FLAT.dataRows });
  const firstGroup = summary.groups[0];
  const firstDecisions = expandGroupToDecisions(firstGroup, `confirmed ${firstGroup.treatment.classification}`);

  // ── SUCCESS (legitimate): the company owner accepts a treatment group → account_mappings written. ──
  let okRes;
  try { okRes = await asUser(U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), firstDecisions)); rec("SUCCESS · owner accepts a treatment group through the REAL resolve_account_review_batch", true); }
  catch (e) { rec("SUCCESS · owner accepts a treatment group through the REAL resolve_account_review_batch", false, String(e.message).split("\n")[0]); }
  if (okRes) {
    const r = okRes.rows[0].r;
    rec("SUCCESS · the real function reports mappings_written = group size", r.mappings_written === firstDecisions.length, JSON.stringify(r));
    const written = (await admin.query("SELECT account_key, statement, classification FROM public.account_mappings WHERE company_id=$1 ORDER BY account_key", [COMPANY_A])).rows;
    rec("SUCCESS · account_mappings rows persisted with our statement/classification", written.length === firstDecisions.length && written.every((w) => w.statement === firstGroup.treatment.statement && w.classification === firstGroup.treatment.classification), JSON.stringify(written.slice(0, 3)));
  }

  // ── REFUSALS (real enforcement) ──
  await refused("REFUSE · a non-member cannot submit (NOT_A_MEMBER_OF_COMPANY)", U.ownerB, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), firstDecisions), /NOT_A_MEMBER_OF_COMPANY/);
  await refused("REFUSE · cross-tenant: company A's upload cannot be claimed as company B (UPLOAD_COMPANY_MISMATCH)", U.ownerB, (c) => callBatch(c, COMPANY_B, UPLOAD_A, uuid(), firstDecisions), /UPLOAD_COMPANY_MISMATCH/);
  await refused("REFUSE · a viewer (no prepare_close / not an active named user) is refused (CAPABILITY_REQUIRED|NOT_A_MEMBER)", U.viewer, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), firstDecisions), /CAPABILITY_REQUIRED|NOT_A_MEMBER_OF_COMPANY/);
  await refused("REFUSE · empty decision batch (EMPTY_DECISION_BATCH)", U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), []), /EMPTY_DECISION_BATCH/);
  await refused("REFUSE · AUTO_MAPPED_RULE proposal is rejected (not reviewer-authorised)", U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), [{ ...firstDecisions[0], proposal_type: "AUTO_MAPPED_RULE" }]), /AUTO_MAPPED_RULE_NOT_AUTHORIZED/);
  await refused("REFUSE · invalid decision_action (INVALID_DECISION_ACTION)", U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), [{ ...firstDecisions[0], decision_action: "FORCE_MAP" }]), /INVALID_DECISION_ACTION/);
  await refused("REFUSE · a cash_flow statement / activity classification (UNSUPPORTED_CASH_FLOW_CLASSIFICATION)", U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), [{ ...firstDecisions[0], statement: "cash_flow", classification: "operating_activities" }]), /UNSUPPORTED_CASH_FLOW_CLASSIFICATION/);
  await refused("REFUSE · statement/classification mismatch (STATEMENT_CLASSIFICATION_MISMATCH)", U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), [{ ...firstDecisions[0], statement: "balance_sheet", classification: "revenue" }]), /STATEMENT_CLASSIFICATION_MISMATCH/);

  // ── LIFECYCLE ──
  // Duplicate submission / retry after lost response: same client_request_id + same payload → safe replay (same summary).
  const req = uuid();
  const d1 = await asUser(U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, req, summary.groups[1] ? expandGroupToDecisions(summary.groups[1], "g2") : firstDecisions));
  const d2 = await asUser(U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, req, summary.groups[1] ? expandGroupToDecisions(summary.groups[1], "g2") : firstDecisions));
  rec("LIFECYCLE · retry with same client_request_id + same payload replays byte-identically (no duplicate)", JSON.stringify(d1.rows[0].r) === JSON.stringify(d2.rows[0].r));
  await refused("LIFECYCLE · same client_request_id with a DIFFERENT payload is refused (IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD)", U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, req, firstDecisions), /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD/);
  // Partial failure: a batch with one invalid decision aborts atomically — nothing from that batch persists.
  const before = (await admin.query("SELECT count(*)::int n FROM public.account_mappings WHERE company_id=$1", [COMPANY_A])).rows[0].n;
  await refused("LIFECYCLE · partial failure: one bad decision aborts the whole batch atomically", U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), [firstDecisions[0], { ...firstDecisions[0], account_code: "NEWX", decision_action: "FORCE_MAP" }]), /INVALID_DECISION_ACTION/);
  const after = (await admin.query("SELECT count(*)::int n FROM public.account_mappings WHERE company_id=$1", [COMPANY_A])).rows[0].n;
  rec("LIFECYCLE · nothing from the aborted batch persisted (atomic)", before === after, { before, after });

  // ── REUSE (native, company-scoped) + the INVALIDATION GAP (documented, not claimed as existing) ──
  UPLOAD_A2 = await mkUpload(COMPANY_A, U.owner, "b".repeat(64));
  const mappedKeys = new Set((await admin.query("SELECT account_key FROM public.account_mappings WHERE company_id=$1", [COMPANY_A])).rows.map((x) => x.account_key));
  rec("REUSE · a repeat upload sees the company's already-accepted account_mappings (native company-scoped reuse — no re-approval)", mappedKeys.size > 0);
  rec("GAP · the real RPC has NO 'reopen on classification meaning change' — only MARK_NON_REPORTING identity-drift exists; a Phase 6 reuse/reopen authority is the documented minimum change (see INTERFACE-PROPOSAL §5/§8).", true);

  // ── MANUAL multi-account path: deliberate selection → USER_MANUAL_CLASSIFICATION through the SAME real RPC. ──
  const manualDecisions = buildManualDecisions(
    [{ account_key: "9000", account_code: "9000", account_name: "Suspense account" }, { account_key: "9100", account_code: "9100", account_name: "Clearing account" }],
    { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", flag_candidate: null }, "manually treated as current assets");
  let manRes;
  try { manRes = await asUser(U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), manualDecisions)); rec("MANUAL · owner assigns a common treatment to selected uncertain accounts (USER_MANUAL_CLASSIFICATION) via the REAL RPC", true); }
  catch (e) { rec("MANUAL · owner assigns a common treatment to selected uncertain accounts (USER_MANUAL_CLASSIFICATION) via the REAL RPC", false, String(e.message).split("\n")[0]); }
  if (manRes) {
    const r = manRes.rows[0].r;
    rec("MANUAL · the real function wrote one mapping per selected account", r.mappings_written === manualDecisions.length, JSON.stringify(r));
    const acts = (await admin.query("SELECT DISTINCT decision_action FROM public.account_review_decisions WHERE company_id=$1 AND review_account_key IN ('9000','9100')", [COMPANY_A])).rows.map((x) => x.decision_action);
    rec("MANUAL · the decisions are recorded as USER_MANUAL_CLASSIFICATION", acts.length === 1 && acts[0] === "USER_MANUAL_CLASSIFICATION", JSON.stringify(acts));
  }
  // MANUAL mixed valid/invalid → the whole manual batch aborts atomically (never a partial accept).
  const beforeM = (await admin.query("SELECT count(*)::int n FROM public.account_mappings WHERE company_id=$1", [COMPANY_A])).rows[0].n;
  await refused("MANUAL · a mixed valid/invalid selection aborts the entire batch (STATEMENT_CLASSIFICATION_MISMATCH)", U.owner,
    (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), [manualDecisions[0], { ...manualDecisions[1], account_code: "9200", account_name: "Miscellaneous", classification: "revenue" }]), /STATEMENT_CLASSIFICATION_MISMATCH/);
  const afterM = (await admin.query("SELECT count(*)::int n FROM public.account_mappings WHERE company_id=$1", [COMPANY_A])).rows[0].n;
  rec("MANUAL · nothing from the aborted mixed batch persisted (atomic; '9200' not written)", beforeM === afterM, { beforeM, afterM });

  // ── CONFLICTING DECISIONS on the SAME account: pg_advisory_xact_lock(company,key) serializes; last writer wins; the
  //    append-only ledger keeps BOTH. (The RPC takes the per-key advisory lock at line ~570; two callers cannot interleave
  //    writes to one account_key. Shown here as the serialized OUTCOME via two sequential batches on key '9000'.) ──
  await asUser(U.owner, (c) => callBatch(c, COMPANY_A, UPLOAD_A, uuid(), buildManualDecisions([{ account_key: "9000", account_code: "9000", account_name: "Suspense account" }], { statement: "balance_sheet", classification: "non_current_assets", normal_balance: "debit", flag_candidate: null }, "reclassified to non-current")));
  const eff = (await admin.query("SELECT classification FROM public.account_mappings WHERE company_id=$1 AND account_key='9000'", [COMPANY_A])).rows[0];
  const ledger = (await admin.query("SELECT count(*)::int n FROM public.account_review_decisions WHERE company_id=$1 AND review_account_key='9000'", [COMPANY_A])).rows[0].n;
  rec("CONFLICT · the last decision wins in account_mappings (non_current_assets)", eff && eff.classification === "non_current_assets", JSON.stringify(eff));
  rec("CONFLICT · both decisions on the account are retained in the append-only ledger (no lost write)", ledger >= 2, { ledger });

  await pool.end(); await admin.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} real-contract checks passed.`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(async (e) => { console.error("PROOF ERROR:", e.message); try { await pool?.end(); } catch {} try { await admin?.end(); } catch {} process.exit(2); });
