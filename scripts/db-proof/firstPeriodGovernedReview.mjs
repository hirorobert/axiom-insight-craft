#!/usr/bin/env bun
// Real-PostgreSQL proof of the first-period governed review on MAIN (20261223100000, defect S2-A03). Standalone port of the
// draft PR #256 proof (20261217100000, stacked on the Ready for Reporting pilot): the same first-period scenarios, without
// the pilot scope. Every case has a stable id in firstPeriodGovernedReview.manifest.mjs; the run writes a structured result
// (PROOF_RESULT_FILE, default proof-results/firstPeriodGovernedReview.<mode>.json) for scripts/ci/validateProofResult.mjs.
//
//   PRE   the chain BEFORE the migration (main): issued history (a FINAL on the comparative path), legacy declarations and
//         open engagements, the read-only rollout preflight (docs/release/first-period-governed-review/preflight.sql), and
//         the bypass itself on the old rule (a 2018 certificate clears COMPARATIVE_PERIOD_MISSING)
//   W     the weakness cases: they FAIL without the migration and PASS with it
//   MIG   the migration applies, its preflight refuses a re-run, fs_publication_blockers keeps every splice VERBATIM (the pre-
//         migration text is a line-subsequence of the new one with exactly the six added lines), no bare DELETE/UPDATE
//   ROLL  rollout effect: legacy declarations stay recorded but are NOT promoted; issued history is byte-identical
//   S1-S7 the old-certificate bypass through the governed route, a genuine first period, activity before bookkeeping,
//         dormancy, opening support, and later evidence / facts / period / identity making a decision stale
//   CMP   a valid comparative path still reaches REVIEWED and FINAL, and the server-compilation splice still bites
//   RACE  an evidence change and a decision change racing with sign-off, BOTH orderings, through the scope lock
//   UI    the Comparatives page's calls in its order through its own client (src/lib/comparatives/firstPeriodReview.ts) over
//         the real client transport: prepare, the same person refused, a second person approves, the blocker clears, new
//         evidence stales it, a decision on the binding shown before is refused, a re-review restores it
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/firstPeriodGovernedReview.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
//   FIRST_PERIOD_GATE_ABSENT=1 runs the chain WITHOUT the migration (mode absent): the weakness cases must fail, nothing else.
//
// The browser client's reporting-input schema cannot read a missing comparative that carries no dates (src/lib/reporting/
// signoff.ts, inside the pinned statement-compiler closure, not changed here): the harness wraps the transport so a missing
// comparative has null dates (lib/firstPeriodKit.mjs withMissingComparativeDates), exactly as PR #256 did.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, FY2026, applyChainBefore, certifier, chainFiles, clientDb, csv, makeWorld, migrationText, openDatabase, prepareReporting, reporter, REPO, uuid } from "./lib/reportingKit.mjs";
import { blockersOf, decide, recordEvidence, sha, status as fpStatus, submitClaim, verifyGenuineFirstPeriod, withMissingComparativeDates } from "./lib/firstPeriodKit.mjs";
import { CASES, PROOF } from "./firstPeriodGovernedReview.manifest.mjs";
import { firstPeriodClient, firstPeriodFacts, reviewView } from "../../src/lib/comparatives/firstPeriodReview.ts";
import { FIRST_PERIOD_NEXT_ACTIONS } from "../../src/lib/comparatives/firstPeriodNextActions.ts";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { canonicalStringify } from "../../src/lib/canonicalStatement/serialization.ts";

const FILE = "20261223100000_first_period_governed_review_standalone.sql";
const PREVIOUS = "20261215100000_api_cache_control_headers.sql";
const ABSENT = process.env.FIRST_PERIOD_GATE_ABSENT === "1";
const MODE = ABSENT ? "absent" : "present";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.${MODE}.json`);
const { group, check, finish } = reporter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stillPending = (p, ms) => Promise.race([p.then(() => false, () => false), sleep(ms).then(() => true)]);
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: `${e.code ?? ""}:${String(e.message).split("\n")[0]}` }));
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const MINE = /^(COMPARATIVE_|FIRST_PERIOD_|OPENING_SUPPORT_)/;
const ours = (b) => b.filter((x) => MINE.test(x));
const Y = 2026;
let db;

// ── Structured result ────────────────────────────────────────────────────────────────────────────────────────────────
const ids = new Map(CASES.map((c) => [c.id, c]));
const recorded = [];
const startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./firstPeriodGovernedReview.manifest.mjs", import.meta.url), "utf8"));
async function kase(id, title, fn) {
  const c = ids.get(id);
  if (!c) throw new Error(`proof defect: case ${id} is not in the manifest`);
  if (!(c.modes ?? ["present", "absent"]).includes(MODE)) throw new Error(`proof defect: case ${id} is not a ${MODE}-mode case`);
  if (recorded.some((r) => r.id === id)) throw new Error(`proof defect: case ${id} recorded twice`);
  let outcome = "fail", detail = "";
  await check(`[${id}] ${title}`, async () => {
    try { const r = await fn(); if (r === true) { outcome = "pass"; return true; } detail = JSON.stringify(r)?.slice(0, 1500) ?? ""; return r; }
    catch (e) { detail = `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}${e.where ? ` | where: ${String(e.where).slice(0, 300)}` : ""}`; throw e; }
  });
  recorded.push({ id, outcome, detail });
}
/** A case that passes only when `fn` is refused with `code` (and, if given, a message containing `text`). */
const refusedCase = (id, title, code, fn, text) => kase(id, title, async () => {
  try { await fn(); return "was not refused"; } catch (e) { return e.code === code && (!text || String(e.message).includes(text)) ? true : `expected ${code}${text ? ` ${text}` : ""}, got ${e.code}: ${String(e.message).split("\n")[0]}`; }
});
function writeResult(completed, crashed, crashMessage) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ proof: PROOF, mode: MODE, manifestSha256, startedAt, finishedAt: new Date().toISOString(), completed, crashed, crashMessage: crashMessage ?? null,
    cases: recorded.map(({ id, outcome, detail }) => ({ id, outcome, ...(detail ? { detail } : {}) })) }, null, 2) + "\n");
  console.log(`structured result: ${RESULT_FILE}`);
}

async function main() {
  db = await openDatabase(ABSENT ? "firstperiod_absent" : "firstperiod_proof");
  group(ABSENT ? "Replay WITHOUT the migration (regression run: exactly the weakness cases must fail)" : "Replay (the chain before the migration)");
  await kase("setup.chain-before", `the chain before ${FILE} applies`, async () => (await applyChainBefore(db, FILE)) ?? true);
  // The reviewed pending tail after main's PREVIOUS, in timestamp order: the financial-table revocation, the cash-transfer /
  // post-closing pair and its compiler identity, this migration, the contra-account designation, then the consolidated Ready for
  // Reporting stack renumbered after it (pilot, issued comparatives, prior-pack basis) and the third compiler identity. #256's
  // 20261217100000 (the same objects as this file) is never in the chain.
  const TAIL = [PREVIOUS, "20261221100000_financial_table_member_write_revocation.sql", "20261222100000_fs_cash_transfers_and_post_closing.sql",
    "20261222200000_statement_compiler_transfers_post_closing.sql", FILE, "20261224100000_contra_account_designation.sql",
    "20261225100000_ready_for_reporting_pilot.sql", "20261226100000_issued_comparative_schedules.sql", "20261227100000_rfr_prior_pack_basis.sql",
    "20261228100000_statement_compiler_casting_declaration.sql", "20261229100000_checkout_terms_acceptance.sql"];
  await kase("setup.chain-tail", `${FILE} sits in the reviewed pending tail after main's ${PREVIOUS} (${TAIL.length - 1} files, timestamp order; the Ready for Reporting stack follows it, #256's duplicate never present)`, async () =>
    JSON.stringify(chainFiles().slice(-TAIL.length)) === JSON.stringify(TAIL) && !chainFiles().some((f) => /20261217100000|20261216100000|20261220100000/.test(f)) ? true : chainFiles().slice(-TAIL.length));

  const W = await makeWorld(db);
  const { U, A } = W;
  // This proof creates many workspaces under one owner: lift the plan's entity capacity (a commercial rule, not under test).
  await db.admin.query("SET session_replication_role = replica");
  await db.admin.query("UPDATE public.commercial_licences SET plan_id = (SELECT p.id FROM public.commercial_plans p JOIN public.commercial_products pr ON pr.id = p.product_id WHERE pr.code='CFOCLOSE' AND p.code='FIRM'), additional_seats = 50 WHERE billing_customer_id = (SELECT id FROM public.billing_customers WHERE owner_user_id = $1)", [U.owner]);
  await db.admin.query("SET session_replication_role = origin");
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const as = (uid) => { const d = withMissingComparativeDates(clientDb(db, uid)); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const parse = (company, type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const r = ingestEvidence({ companyId: company, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type], fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected`);
    return r.batch;
  };
  const allEvidence = (company) => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(company, t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(company, t, "COMPARATIVE"))];
  const attempt = (company, who, rid, ev = [], name = "Synthetic SME Limited") => prepareReportVersion(who.d, who.c, { companyId: company, periodYear: Y, legalName: name, reportId: rid, newEvidence: ev, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code ?? ""}:${String(e.message).split("\n")[0]}`; } };
  const members = async (company) => { for (const m of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [company, U[m], m]); };
  /** A workspace whose ONLY trial balance is FY2026 (no earlier CFOClose books), with its exact reporting dates. */
  const entity = async (name, { start = `${Y}-01-01`, end = `${Y}-12-31`, prepared = true } = {}) => {
    const co = await W.company(U.owner, name); await members(co); await W.rollout(co, true);
    const up = await k.upload(co, Y, csv(FY2026), { start, end }); await k.review(co, up); await k.certify(co, up);
    if (prepared) await prepareReporting(db, { U, A: co }, k, { year: Y, uploads: false, comparativesApproved: false });
    return co;
  };
  const light = async (co, name) => { const rid = `rpt-fp-${uuid()}`; const r = await attempt(co, pre, rid, [], name); if (r.outcome !== "saved") throw new Error(`no version: ${JSON.stringify(r).slice(0, 300)}`); return { rid, v: r.reportVersion }; };
  const bl = (co, rep) => blockersOf(db, U.partner, co, rep.rid, rep.v);
  const reviewed = (co, rep, who = partner) => who.c.setState(co, rep.rid, rep.v, "REVIEWED", "Reviewed for the first-period proof");
  const pubs = (company) => db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE company_id=$1", [company]);
  const FP_DECLARE = (uid, co, kind, ref, date) => asU(uid, "SELECT public.fs_declare_first_period($1,$2,true,'First reporting period in CFOClose',$3,$4,$5::date) r", [co, Y, kind, ref, date]).then((r) => r.r);
  const status = (co, uid = U.owner) => fpStatus(db, uid, co, Y);
  const comparatives = async (co) => (await asU(U.owner, "SELECT public.fs_comparatives_status($1,$2) r", [co, Y])).r.comparative;

  // ── PRE: issued history, legacy declarations, open engagements ───────────────────────────────────────────────────────
  group("PRE. Before the migration: issued history, legacy declarations and open engagements");
  let finalA, snapA, L1, L2, L3, repL1, repL2;
  await kase("setup.issued-history", "A (comparative path): two certified years, evidence, REVIEWED then FINAL; the issued history is captured", async () => {
    await prepareReporting(db, W, k, { year: Y });
    const rid = `rpt-final-${uuid()}`;
    const r = await attempt(A, pre, rid, allEvidence(A));
    await partner.c.setState(A, rid, r.reportVersion, "REVIEWED", "Reviewed");
    const f = await owner.c.setState(A, rid, r.reportVersion, "FINAL", "Approved");
    finalA = { rid, v: r.reportVersion };
    const capture = async () => ({
      pub: (await db.admin.query("SELECT id, report_id, report_version, state FROM public.financial_statement_publications WHERE company_id=$1 ORDER BY seq", [A])).rows,
      bind: (await db.admin.query("SELECT state, document_sha256, declared_content_hash, dependencies_sha256 FROM public.fs_publication_bindings WHERE report_id=$1 ORDER BY seq", [rid])).rows,
      rep: (await db.admin.query("SELECT report_version, content_hash, encode(sha256(convert_to(report_document::text,'UTF8')),'hex') h FROM public.financial_statement_reports WHERE report_id=$1 ORDER BY report_version", [rid])).rows,
      evidence: (await db.admin.query("SELECT evidence_batch_id, content_hash, version FROM public.financial_evidence_batches WHERE company_id=$1 ORDER BY evidence_batch_id", [A])).rows,
      blockers: await blockersOf(db, U.partner, A, rid, r.reportVersion),
    });
    snapA = { capture, before: await capture() };
    return r.outcome === "saved" && f.state === "FINAL" && snapA.before.pub.length === 2 && snapA.before.bind.length === 2 ? true : { r: r.outcome, f: f.state, pubs: snapA.before.pub.length };
  });
  await kase("setup.legacy-workspaces", "legacy workspaces: L1 an established entity (2018 certificate), L2 a new entity (2026 certificate), L3 declared then voided by an earlier trial balance; L1 and L2 have an open engagement; each declaration is by ONE approve_certification holder (the owner) alone", async () => {
    L1 = await entity("Established Trading Limited"); L2 = await entity("Newly Formed Limited"); L3 = await entity("Voided Declaration Limited", { prepared: false });
    const a = await FP_DECLARE(U.owner, L1, "certificate_of_incorporation", "Certificate of incorporation no. 4471 (issued 2018)", "2018-03-02");
    const b = await FP_DECLARE(U.owner, L2, "certificate_of_incorporation", "Certificate of incorporation no. 9902", "2026-01-12");
    const c = await FP_DECLARE(U.owner, L3, "certificate_of_incorporation", "Certificate of incorporation no. 1", "2026-01-02");
    // L3 gains an earlier-period trial balance AFTER its declaration (the declaration is refused outright when one exists first).
    await db.admin.query("INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, user_id) VALUES ('old.csv',$1,1,'processing',$2,$3,$4)", [`${U.owner}/${uuid()}.csv`, L3, Y - 1, U.owner]);
    repL1 = await light(L1, "Established Trading Limited"); repL2 = await light(L2, "Newly Formed Limited");
    return [a, b, c].every((x) => x.outcome === "recorded") ? true : { a, b, c };
  });
  await kase("pre.rollout-preflight-read-only", "the read-only rollout preflight reports the active legacy declarations, the open engagements and the certificate that predates its period - and writes nothing", async () => {
    const sql = fs.readFileSync(path.join(REPO, "docs/release/first-period-governed-review/preflight.sql"), "utf8");
    const total = async () => Number((await db.admin.query("SELECT (SELECT count(*) FROM public.fs_first_period_declarations)+(SELECT count(*) FROM public.financial_statement_reports)+(SELECT count(*) FROM public.financial_statement_publications)+(SELECT count(*) FROM public.companies) n")).rows[0].n);
    const rowsBefore = await total();
    const res = await db.admin.query(sql);
    const out = Array.isArray(res) ? res.find((r) => r.rows?.[0]?.preflight) : res;
    const preflight = out.rows[0].preflight;
    const rowsAfter = await total();
    const s = preflight.summary;
    const bad = [];
    if (s.activeLegacyDeclarations !== 2) bad.push(["active", s.activeLegacyDeclarations]);
    if (s.withOpenEngagement !== 2) bad.push(["open", s.withOpenEngagement]);
    if (s.openReportLineages !== 2) bad.push(["lineages", s.openReportLineages]);
    if (s.certificatePredatesPeriod !== 1) bad.push(["predates", s.certificatePredatesPeriod]);
    if (s.periodNotDeterminable !== 0) bad.push(["period", s.periodNotDeterminable]);
    if (s.withIssuedFinalWithoutComparatives !== 0) bad.push(["final", s.withIssuedFinalWithoutComparatives]);
    if (s.declarationRowsTotal !== 3) bad.push(["rows", s.declarationRowsTotal]);
    const ws = Object.fromEntries(preflight.workspaces.map((w) => [w.company_name, w]));
    if (!ws["Established Trading Limited"]?.evidence_predates_period || ws["Newly Formed Limited"]?.evidence_predates_period || ws["Voided Declaration Limited"]) bad.push("workspace flags");
    return bad.length === 0 && rowsBefore === rowsAfter ? true : { bad, s, rowsBefore, rowsAfter };
  });
  await kase("pre.old-rule-bypass-reproduces", "BEFORE (the old rule, main): the 2018 certificate is the exception - COMPARATIVE_PERIOD_MISSING is absent for L1 and its comparatives status is first_period_exception with no COMPARATIVE_REQUIRED_MISSING", async () => {
    const b = await bl(L1, repL1); const c = await comparatives(L1);
    return !b.includes("COMPARATIVE_PERIOD_MISSING") && c.state === "first_period_exception" && !c.blockers.includes("COMPARATIVE_REQUIRED_MISSING") ? true : { b: ours(b), c };
  });
  const defBefore = (await db.one("SELECT pg_get_functiondef('public.fs_publication_blockers(uuid,text,integer)'::regprocedure) d")).d;

  // The weakness cases: run AFTER the migration in present mode, directly on the old chain in absent mode.
  const weaknesses = async () => {
    group(ABSENT ? "W. The defect on the chain without the migration (each case MUST fail)" : "W. The defect is closed");
    await kase("w1.old-certificate-does-not-clear-blocker", "an established entity's 2018 certificate (declared by one authorised user) does NOT clear COMPARATIVE_PERIOD_MISSING: the blocker names FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED and the comparatives status is missing with COMPARATIVE_REQUIRED_MISSING", async () => {
      const b = await bl(L1, repL1); const c = await comparatives(L1);
      return b.includes("COMPARATIVE_PERIOD_MISSING") && b.includes("FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED") && c.state === "missing" && c.blockers.includes("COMPARATIVE_REQUIRED_MISSING") && c.firstPeriodDeclared === false
        ? true : { blockers: ours(b), comparative: { state: c.state, blockers: c.blockers, firstPeriodDeclared: c.firstPeriodDeclared } };
    });
    await kase("w2.declaration-alone-never-grants", "even with a 2026 certificate, a declaration by a single approve_certification holder never grants the exception (no different approver, no bound evidence): L2 keeps COMPARATIVE_PERIOD_MISSING", async () => {
      const b = await bl(L2, repL2); const c = await comparatives(L2);
      return b.includes("COMPARATIVE_PERIOD_MISSING") && c.state === "missing" ? true : { blockers: ours(b), comparative: c.state };
    });
    await kase("w3.signoff-names-unmet-requirement", "the L1 sign-off (REVIEWED) is refused naming COMPARATIVE_PERIOD_MISSING and FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED; nothing is published", async () => {
      const r = await refusal(() => reviewed(L1, repL1));
      return /COMPARATIVE_PERIOD_MISSING/.test(r ?? "") && /FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED/.test(r ?? "") && (await pubs(L1)) === 0 ? true : { refusal: (r ?? "accepted").slice(0, 400) };
    });
  };
  if (ABSENT) { await weaknesses(); return; }

  // ── MIG ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("MIG. The migration applies and keeps every splice");
  await kase("mig.applies", `${FILE} applies on main's chain`, async () => { try { await db.admin.query(migrationText(FILE)); return true; } catch (e) { return `${e.code}: ${e.message}`; } });
  await refusedCase("mig.rerun-refused", "re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");
  const defAfter = (await db.one("SELECT pg_get_functiondef('public.fs_publication_blockers(uuid,text,integer)'::regprocedure) d")).d;
  await kase("mig.splice-line-subsequence", "fs_publication_blockers: every line of main's pre-migration text survives in order; exactly the six first-period lines were added (nothing re-typed, nothing lost)", async () => {
    const a = defBefore.split("\n"), b = defAfter.split("\n");
    let i = 0; const added = [];
    for (const line of b) { if (i < a.length && line === a[i]) i += 1; else added.push(line); }
    const expectedAdded = added.every((l) => /\[20261223100000\]|_fs_first_period_pending|_fs_opening_pending|AND public\.fs_first_period_declared|^\s*END IF;$/.test(l));
    return i === a.length && added.length === 6 && expectedAdded ? true : { matched: i, of: a.length, added };
  });
  await kase("mig.splices-present", "the server-compilation splice, the document-structure gate, account capacity and review comments are all still in the live function, beside the two first-period calls", async () =>
    ["fs_server_compilation_blocker", "_fs_document_structure_blockers", "DOCUMENT_FACT_NOT_COMPOSED", "ACCOUNT_CAPACITY_EXCEEDED", "REVIEW_COMMENT_UNRESOLVED", "_fs_first_period_pending", "_fs_opening_pending"].every((m) => defAfter.includes(m)) ? true : "a splice is missing");
  await kase("mig.no-bare-delete-update", "static contract: no bare DELETE or UPDATE without a WHERE clause in the migration (safeupdate)", async () => {
    const code = migrationText(FILE).replace(/--[^\n]*/g, "");
    const bare = [...code.matchAll(/\bDELETE\s+FROM\s+[\w.]+\s*;/gi), ...code.matchAll(/\bUPDATE\s+[\w.]+\s+SET\b(?:(?!\bWHERE\b)[^;])*;/gi)].map((m) => m[0].slice(0, 60));
    return bare.length === 0 ? true : bare;
  });
  await kase("mig.access", "access: the assessment, the digests and the blockers are not callable by clients; the writers are authenticated-only; anon reaches nothing", async () => {
    const q = await db.one(`SELECT
      has_function_privilege('authenticated','public._fs_first_period_assess(uuid,integer)','EXECUTE') a, has_function_privilege('authenticated','public.fs_publication_blockers(uuid,text,integer)','EXECUTE') b,
      has_function_privilege('anon','public.fs_decide_first_period(uuid,integer,text,boolean,text,uuid,text)','EXECUTE') c, has_function_privilege('anon','public.fs_record_first_period_evidence(uuid,integer,text,text,date,date,text,text,boolean,uuid)','EXECUTE') d,
      has_function_privilege('authenticated','public.fs_decide_first_period(uuid,integer,text,boolean,text,uuid,text)','EXECUTE') e`);
    return !q.a && !q.b && !q.c && !q.d && q.e ? true : q;
  });

  group("ROLL. Rollout effect: legacy declarations are kept, never promoted; issued history is untouched");
  await kase("roll.no-claim-or-decision-created", "the declarations stay recorded and append-only; no claim and no decision was created by the migration", async () =>
    (await db.count("SELECT count(*) n FROM public.fs_first_period_declarations")) === 3 && (await db.count("SELECT count(*) n FROM public.fs_first_period_claims")) === 0 && (await db.count("SELECT count(*) n FROM public.fs_first_period_decisions")) === 0 ? true : "changed");
  await weaknesses();
  await kase("roll.legacy-one-reason-and-action", "L1 and L2 (open engagements): the exception no longer applies; COMPARATIVE_PERIOD_MISSING returns with ONE specific reason and next action; the comparatives status is missing", async () => {
    const out = [];
    for (const [co, rep] of [[L1, repL1], [L2, repL2]]) {
      const b = await bl(co, rep); const s = await status(co); const c = await comparatives(co);
      const item = s.firstPeriod.items[0];
      if (!(b.includes("COMPARATIVE_PERIOD_MISSING") && b.includes("FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED") && s.firstPeriod.state === "pending" && s.firstPeriod.items.length === 1
            && item.code === "FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED" && /first-period facts/i.test(item.nextAction) && c.state === "missing" && c.firstPeriodDeclared === false && s.legacyDeclaration.satisfiesRequirement === false)) out.push({ co, b: ours(b), s: s.firstPeriod, c: c.state });
    }
    return out.length === 0 ? true : out;
  });
  await kase("roll.voided-declaration-names-earlier-books", "the L3 declaration (voided by an earlier trial balance) names the earlier books, not the legacy declaration", async () => {
    const s3 = await status(L3);
    return s3.firstPeriod.state === "not_eligible" && s3.firstPeriod.items[0].code === "FIRST_PERIOD_EARLIER_BOOKS_EXIST" ? true : s3.firstPeriod;
  });
  await kase("roll.issued-history-identical", "issued history is byte-identical: A's FINAL publications, bindings, documents, evidence and its own blockers are unchanged by the migration", async () => {
    const now = await snapA.capture();
    return JSON.stringify(now) === JSON.stringify(snapA.before) ? true : { before: snapA.before.blockers, now: now.blockers };
  });
  await kase("roll.comparative-path-blockers-unchanged", "the comparative path is unaffected for A: its blockers are exactly what they were; it needs no first-period review", async () =>
    JSON.stringify(await blockersOf(db, U.partner, A, finalA.rid, finalA.v)) === JSON.stringify(snapA.before.blockers) ? true : "changed");

  // ── S1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("S1. The old-certificate bypass through the governed route");
  const S1 = L1, repS1 = repL1;
  let oldCert;
  await kase("s1.honest-old-registration-not-eligible", "governed route, honest facts: a 2018 registration date is NOT a first period on the evidence; the approver cannot verify it (not_ready), whatever the capability", async () => {
    oldCert = await recordEvidence(db, U.preparer, S1, Y, "certificate_of_incorporation", "Certificate of incorporation no. 4471", { asserted: "2018-03-02", issuedOn: "2018-03-02" });
    const facts = { legalName: "Established Trading Limited", registrationNumber: "4471", basis: "incorporated_in_period", registrationDate: "2018-03-02", effectiveStart: "2018-03-02", reportingStart: `${Y}-01-01`, reportingEnd: `${Y}-12-31`, priorStatementsPrepared: false };
    const c = await submitClaim(db, U.preparer, S1, Y, "first_period", facts, "Cited the certificate of incorporation held on file for this entity.", [oldCert.evidenceId]);
    const d1 = await decide(db, U.partner, S1, Y, "first_period", true); const d2 = await decide(db, U.owner, S1, Y, "first_period", true);
    const s = await status(S1);
    return c.outcome === "recorded" && c.state === "not_eligible" && c.pending.includes("FIRST_PERIOD_NOT_FIRST_ON_EVIDENCE") && d1.outcome === "not_ready" && d2.outcome === "not_ready" && s.firstPeriod.state === "not_eligible" ? true : { c, d1, d2 };
  });
  await kase("s1.forged-registration-date-refused", "governed route, forged dates: claiming a 2026 registration date while citing the 2018 certificate fails - the certificate's own date must be the registration date", async () => {
    const facts = { legalName: "Established Trading Limited", registrationNumber: "4471", basis: "incorporated_in_period", registrationDate: `${Y}-01-05`, effectiveStart: `${Y}-01-05`, reportingStart: `${Y}-01-01`, reportingEnd: `${Y}-12-31`, priorStatementsPrepared: false };
    const c = await submitClaim(db, U.preparer, S1, Y, "first_period", facts, "Registration date stated as 5 January 2026 for this entity.", [oldCert.evidenceId]);
    const d = await decide(db, U.partner, S1, Y, "first_period", true);
    return c.pending.includes("FIRST_PERIOD_IDENTITY_EVIDENCE_MISSING") && d.outcome === "not_ready" && d.pending.includes("FIRST_PERIOD_IDENTITY_EVIDENCE_MISSING") ? true : { c, d };
  });
  await kase("s1.wrong-entity-or-dates-named", "wrong entity or wrong dates are caught: another legal name, other reporting dates, and (once the company has a TIN) another TIN each name their own reason", async () => {
    const e2 = await recordEvidence(db, U.preparer, S1, Y, "certificate_of_incorporation", "Certificate of incorporation no. 5", { asserted: `${Y}-01-05`, issuedOn: `${Y}-01-05` });
    const base = { legalName: "Some Other Company Limited", registrationNumber: "CN-5", basis: "incorporated_in_period", registrationDate: `${Y}-01-05`, effectiveStart: `${Y}-01-05`, reportingStart: `${Y}-02-01`, reportingEnd: `${Y}-12-31`, priorStatementsPrepared: false };
    const c1 = await submitClaim(db, U.preparer, S1, Y, "first_period", base, "A statement about a different entity and different dates, to prove the server compares them.", [e2.evidenceId]);
    await db.admin.query("UPDATE public.companies SET tin='123456789' WHERE id=$1", [S1]);
    const c2 = await submitClaim(db, U.preparer, S1, Y, "first_period", { ...base, tin: "987654321" }, "The same statement now also names a TIN that is not the company's.", [e2.evidenceId]);
    const k1 = c1.pending.map((x) => x.split(":")[0]), k2 = c2.pending.map((x) => x.split(":")[0]);
    return k1.includes("FIRST_PERIOD_ENTITY_NAME_MISMATCH") && k1.includes("FIRST_PERIOD_DATES_MISMATCH") && k2.includes("FIRST_PERIOD_ENTITY_TIN_MISMATCH") ? true : { k1, k2 };
  });
  await kase("s1.nothing-published", "sign-off is refused on every route and nothing is published: REVIEWED names the unmet comparative requirement; FINAL is refused; no publication row exists for the workspace", async () => {
    const r = await refusal(() => reviewed(S1, repS1)); const f = await refusal(() => owner.c.setState(S1, repS1.rid, repS1.v, "FINAL", "Approve"));
    return /COMPARATIVE_PERIOD_MISSING/.test(r ?? "") && f !== null && (await pubs(S1)) === 0 ? true : { r, f, pubs: await pubs(S1) };
  });
  await kase("s1.separation-of-duties", "a preparer cannot decide; the approver cannot be the person who recorded the facts; the viewer and another workspace's owner are refused", async () => {
    const own = await submitClaim(db, U.partner, S1, Y, "first_period", { legalName: "Established Trading Limited", registrationNumber: "4471", basis: "incorporated_in_period", registrationDate: `${Y}-01-05`, effectiveStart: `${Y}-01-05`, reportingStart: `${Y}-01-01`, reportingEnd: `${Y}-12-31`, priorStatementsPrepared: false }, "Recorded by the partner so the same partner cannot also approve it.", []);
    const selfDecide = await decide(db, U.partner, S1, Y, "first_period", true); const prep = await decide(db, U.preparer, S1, Y, "first_period", true);
    const viewer = await asU(U.viewer, "SELECT public.fs_record_first_period_evidence($1,$2,'certificate_of_incorporation','x y z','2026-01-01'::date,'2026-01-01'::date,$3,NULL,false,$4) r", [S1, Y, sha("v"), uuid()]).then((r) => r.r);
    const other = await asU(U.ownerB, "SELECT public.fs_first_period_status($1,$2) r", [S1, Y]).then((r) => r.r);
    return own.outcome === "recorded" && selfDecide.outcome === "separate_approver_required" && prep.outcome === "forbidden" && viewer.outcome === "forbidden" && other.state === "unavailable" ? true : { own, selfDecide, prep, viewer, other };
  });

  // ── S2 + S5 ────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("S2. A genuine first period: verified by a different approver");
  const S2 = await entity("Newco Limited", { start: "2026-02-03", end: `${Y}-12-31` });
  const repS2 = await light(S2, "Newco Limited");
  await kase("s2.facts-missing-named", "before any review: COMPARATIVE_PERIOD_MISSING with FIRST_PERIOD_FACTS_MISSING", async () => { const b = await bl(S2, repS2); return b.includes("COMPARATIVE_PERIOD_MISSING") && b.includes("FIRST_PERIOD_FACTS_MISSING") ? true : ours(b); });
  await kase("s2.claim-pending-review", "the preparer records the certificate and the facts; the claim is complete but NOT effective until a different approver decides: FIRST_PERIOD_REVIEW_PENDING", async () => {
    const cert = await recordEvidence(db, U.preparer, S2, Y, "certificate_of_incorporation", "Certificate of incorporation CN-2026-0042", { asserted: "2026-02-03", issuedOn: "2026-02-03" });
    const facts = { legalName: "Newco Limited", registrationNumber: "CN-2026-0042", basis: "incorporated_in_period", registrationDate: "2026-02-03", effectiveStart: "2026-02-03", reportingStart: "2026-02-03", reportingEnd: `${Y}-12-31`, priorStatementsPrepared: false };
    const c = await submitClaim(db, U.preparer, S2, Y, "first_period", facts, "Incorporated on 3 February 2026; this is the entity's first period and no earlier period exists.", [cert.evidenceId]);
    const b = await bl(S2, repS2);
    return c.outcome === "recorded" && c.state === "pending" && JSON.stringify(c.pending) === JSON.stringify(["FIRST_PERIOD_REVIEW_PENDING"]) && b.includes("COMPARATIVE_PERIOD_MISSING") && b.includes("FIRST_PERIOD_REVIEW_PENDING") ? true : { c, b: ours(b) };
  });
  await kase("s2.different-approver-grants", "a different approver verifies: COMPARATIVE_PERIOD_MISSING clears and the comparatives status is first_period_exception", async () => {
    const d = await decide(db, U.partner, S2, Y, "first_period", true, "Certificate agrees to the registration date; period dates agree to the reviewed trial balance.");
    const b = await bl(S2, repS2); const c = await comparatives(S2); const s = await status(S2);
    return d.outcome === "recorded" && !b.includes("COMPARATIVE_PERIOD_MISSING") && !b.some((x) => x.startsWith("FIRST_PERIOD_")) && c.state === "first_period_exception" && c.firstPeriodDeclared === true && s.firstPeriod.state === "verified" ? true : { d, b: ours(b), c };
  });
  group("S5. A verified first period addresses the comparatives only: the openings need their own support");
  await kase("s5.opening-support-missing", "with the exception verified and no opening support recorded: OPENING_SUPPORT_MISSING is a blocker of its own, with its next action; the comparative blocker stays cleared", async () => {
    const b = await bl(S2, repS2); const s = await status(S2);
    return b.includes("OPENING_SUPPORT_MISSING") && !b.includes("COMPARATIVE_PERIOD_MISSING") && s.openingBalances.items[0].code === "OPENING_SUPPORT_MISSING" && /opening-balance support/i.test(s.openingBalances.items[0].nextAction) ? true : { b: ours(b), s: s.openingBalances };
  });
  await kase("s5.nil-opening-needs-evidence", "a nil opening is not accepted from a statement alone: books starting after the entity's start do not support a nil opening (NOT_RECONCILED), and it needs evidence (EVIDENCE_MISSING)", async () => {
    const c = await submitClaim(db, U.preparer, S2, Y, "opening_balances", { basis: "nil_opening", bookkeepingStart: `${Y}-04-01` }, "The entity states that it held nothing at the start of the period.", []);
    const d = await decide(db, U.partner, S2, Y, "opening_balances", true);
    return c.pending.includes("OPENING_SUPPORT_NOT_RECONCILED") && c.pending.includes("OPENING_SUPPORT_EVIDENCE_MISSING") && d.outcome === "not_ready" ? true : { c, d };
  });
  await kase("s5.reconciliation-refused", "a reconciliation that does not add up is refused with the difference (1,000,000 listed - 900,000 stated = 100,000 minor units); an item before the entity's start is outside the window", async () => {
    const e1 = await recordEvidence(db, U.preparer, S2, Y, "pre_setup_activity_support", "Bank statement February 2026", { asserted: "2026-02-10", issuedOn: "2026-03-01" });
    const e2 = await recordEvidence(db, U.preparer, S2, Y, "pre_setup_activity_support", "Bank statement January 2026", { asserted: "2026-01-20", issuedOn: "2026-03-01" });
    const bad = (items, net) => ({ basis: "reconciled_pre_setup_activity", bookkeepingStart: `${Y}-04-01`, preSetupNetMinor: net, items });
    const c1 = await submitClaim(db, U.preparer, S2, Y, "opening_balances", bad([{ description: "Share subscription received", date: "2026-02-10", amountMinor: "1000000", evidenceId: e1.evidenceId }], "900000"), "Items listed from the bank statement; the total is stated separately.", [e1.evidenceId]);
    const c2 = await submitClaim(db, U.preparer, S2, Y, "opening_balances", bad([{ description: "Deposit before the entity existed", date: "2026-01-20", amountMinor: "500000", evidenceId: e2.evidenceId }], "500000"), "An item dated before the entity's effective start date.", [e2.evidenceId]);
    return c1.pending.some((x) => x === "OPENING_SUPPORT_NOT_RECONCILED:100000") && c2.pending.includes("OPENING_SUPPORT_ITEM_OUTSIDE_WINDOW") ? true : { c1: c1.pending, c2: c2.pending };
  });
  await kase("s5.supported-nil-opening", "a supported nil opening (books begin on the entity's start day, with the opening statement cited) verified by a different approver clears OPENING_SUPPORT_*", async () => {
    const e = await recordEvidence(db, U.preparer, S2, Y, "opening_position_support", "Bank account opening letter 3 Feb 2026", { asserted: "2026-02-03", issuedOn: "2026-02-04" });
    const c = await submitClaim(db, U.preparer, S2, Y, "opening_balances", { basis: "nil_opening", bookkeepingStart: "2026-02-03" }, "Books begin on the day the entity was registered; the bank's opening letter shows a nil position.", [e.evidenceId]);
    const d = await decide(db, U.partner, S2, Y, "opening_balances", true, "Opening letter agrees; books start on the registration date.");
    const b = await bl(S2, repS2);
    return c.pending.length === 1 && c.pending[0] === "OPENING_SUPPORT_REVIEW_PENDING" && d.outcome === "recorded" && ours(b).length === 0 ? true : { c, d, b: ours(b) };
  });
  await kase("s2.signoff-stops-at-independent-blockers", "sign-off then stops ONLY at independent blockers (statement evidence the engine builds from comparative balances); none of ours remains; nothing is published", async () => {
    const b = await bl(S2, repS2); const r = await refusal(() => reviewed(S2, repS2));
    SIGNOFF_REMAINDER = b;
    return ours(b).length === 0 && b.length > 0 && r !== null && (await pubs(S2)) === 0 ? true : { b, r };
  });
  await kase("s2.cashflow-gap-independent", "the remaining gap is independent and pre-existing: with the period's current evidence supplied, the cash-flow roll-forward still needs a prior balance for the cash account (CASHFLOW_ROLLFORWARD_BALANCE_MISSING) - no first-period path exists in the statement engine, and none of ours remains", async () => {
    const r = await attempt(S2, pre, repS2.rid, ["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((ty) => parse(S2, ty)), "Newco Limited");
    const b = await partner.c.readiness(S2, repS2.rid, r.reportVersion);
    FINDING_CASHFLOW = b.blockers.filter((x) => /^CASHFLOW_/.test(x));
    return r.outcome === "saved" && ours(b.blockers).length === 0 && b.blockers.some((x) => x.startsWith("CASHFLOW_ROLLFORWARD_BALANCE_MISSING")) ? true : { r: r.outcome, b: b.blockers };
  });

  // ── S3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("S3. Legitimate activity before bookkeeping began is reconciled, never a contradiction");
  const S3 = await entity("Lateboks Limited", { start: "2026-01-10", end: `${Y}-12-31` });
  const repS3 = await light(S3, "Lateboks Limited");
  let s3ev;
  await kase("s3.pre-bookkeeping-activity-not-contradiction", "activity recorded between the entity's start and the day bookkeeping began does NOT contradict the first period; the first period verifies", async () => {
    s3ev = {
      sub: await recordEvidence(db, U.preparer, S3, Y, "pre_setup_activity_support", "Bank statement 15 Jan 2026", { asserted: "2026-01-15", issuedOn: "2026-04-02" }),
      fee: await recordEvidence(db, U.preparer, S3, Y, "pre_setup_activity_support", "Registration fee receipt 20 Feb 2026", { asserted: "2026-02-20", issuedOn: "2026-04-02" }),
      act: await recordEvidence(db, U.preparer, S3, Y, "prior_activity_record", "Bank statement February 2026 (activity before bookkeeping)", { asserted: "2026-02-20", issuedOn: "2026-04-02" }),
    };
    const v = await verifyGenuineFirstPeriod(db, U, S3, Y, { name: "Lateboks Limited", start: "2026-01-10", end: `${Y}-12-31`, registrationDate: "2026-01-10", regNo: "CN-2026-0077" });
    const s = await status(S3);
    return v.decision.outcome === "recorded" && s.firstPeriod.state === "verified" && !(await bl(S3, repS3)).includes("COMPARATIVE_PERIOD_MISSING") ? true : { v: v.decision, s: s.firstPeriod };
  });
  await kase("s3.items-reconciled", "the pre-setup items reconcile to the opening position stated (share subscription +1,000,000; registration costs -200,000; net 800,000 minor units) and a different approver verifies them", async () => {
    const claim = await submitClaim(db, U.preparer, S3, Y, "opening_balances", { basis: "reconciled_pre_setup_activity", bookkeepingStart: `${Y}-04-01`, preSetupNetMinor: "800000", items: [
      { description: "Share subscription received", date: "2026-01-15", amountMinor: "1000000", evidenceId: s3ev.sub.evidenceId },
      { description: "Registration costs paid", date: "2026-02-20", amountMinor: "-200000", evidenceId: s3ev.fee.evidenceId }] },
      "Two transactions occurred between registration and the start of bookkeeping; each is supported by a bank record and they net to the opening position.", [s3ev.sub.evidenceId, s3ev.fee.evidenceId]);
    const d = await decide(db, U.partner, S3, Y, "opening_balances", true, "Items agree to bank records; net agrees to the opening journal total.");
    const b = await bl(S3, repS3); const s = await status(S3);
    return claim.outcome === "recorded" && d.outcome === "recorded" && ours(b).length === 0 && s.firstPeriod.state === "verified" && s.openingBalances.state === "verified" ? true : { claim, d, b: ours(b) };
  });

  // ── S4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("S4. Unresolved dormancy: a dormant entity never qualifies from a date or a checkbox alone");
  const S4 = await entity("Sleeper Limited", { start: "2026-03-01", end: `${Y}-12-31` });
  const repS4 = await light(S4, "Sleeper Limited");
  const dormFacts = (o = {}) => ({ legalName: "Sleeper Limited", registrationNumber: "CN-2019-0311", basis: "commenced_after_dormancy", registrationDate: "2019-05-01", effectiveStart: "2026-03-01", reportingStart: "2026-03-01", reportingEnd: `${Y}-12-31`, priorStatementsPrepared: false, dormantFrom: "2019-05-01", dormantThrough: "2026-02-28", ...o });
  let s4cert, commence;
  await kase("s4.dormancy-unevidenced", "(a) the box ticked and the dates stated, nothing cited beyond the certificate: DORMANCY_EVIDENCE_MISSING and COMMENCEMENT_EVIDENCE_MISSING; the approver cannot verify; the report stays blocked with both reasons", async () => {
    s4cert = await recordEvidence(db, U.preparer, S4, Y, "certificate_of_incorporation", "Certificate of incorporation CN-2019-0311", { asserted: "2019-05-01", issuedOn: "2019-05-01" });
    const c = await submitClaim(db, U.preparer, S4, Y, "first_period", dormFacts(), "The company was registered in 2019 and has been dormant; it began trading on 1 March 2026.", [s4cert.evidenceId]);
    const d = await decide(db, U.partner, S4, Y, "first_period", true); const b = await bl(S4, repS4);
    return c.pending.includes("FIRST_PERIOD_DORMANCY_EVIDENCE_MISSING") && c.pending.includes("FIRST_PERIOD_COMMENCEMENT_EVIDENCE_MISSING") && d.outcome === "not_ready"
      && b.includes("COMPARATIVE_PERIOD_MISSING") && b.includes("FIRST_PERIOD_DORMANCY_EVIDENCE_MISSING") ? true : { c, d, b: ours(b) };
  });
  await kase("s4.dormancy-coverage-gap", "(b) dormancy evidence that stops short of the start date is a COVERAGE_GAP, with its own next action", async () => {
    commence = await recordEvidence(db, U.preparer, S4, Y, "commencement_resolution", "Board resolution to commence trading 1 Mar 2026", { asserted: "2026-03-01", issuedOn: "2026-03-01" });
    const shortDorm = await recordEvidence(db, U.preparer, S4, Y, "dormancy_confirmation", "Dormant status letter to 31 Dec 2024", { asserted: "2024-12-31", issuedOn: "2025-01-15" });
    const c = await submitClaim(db, U.preparer, S4, Y, "first_period", dormFacts(), "Dormant since registration; the letter on file covers until the end of 2024.", [s4cert.evidenceId, commence.evidenceId, shortDorm.evidenceId]);
    const s = await status(S4);
    return c.pending.includes("FIRST_PERIOD_DORMANCY_COVERAGE_GAP") && !c.pending.includes("FIRST_PERIOD_COMMENCEMENT_EVIDENCE_MISSING") && /whole time/i.test(s.firstPeriod.items.find((i) => i.code === "FIRST_PERIOD_DORMANCY_COVERAGE_GAP").nextAction) ? true : { c: c.pending };
  });
  await kase("s4.prior-statements-not-eligible", "(c) statements prepared for an earlier period make it NOT eligible: comparatives are required (PRIOR_STATEMENTS_EXIST)", async () => {
    const c = await submitClaim(db, U.preparer, S4, Y, "first_period", dormFacts({ priorStatementsPrepared: true }), "Statements were once prepared for 2022 even though the company is now said to have been dormant.", [s4cert.evidenceId, commence.evidenceId]);
    const s = await status(S4);
    return c.state === "not_eligible" && c.pending.includes("FIRST_PERIOD_PRIOR_STATEMENTS_EXIST") && s.firstPeriod.state === "not_eligible" ? true : c;
  });
  await kase("s4.dormancy-verified-by-other-approver", "(d) with full dormancy evidence the claim is complete but still needs a decision; the person who recorded it cannot approve it; a different approver verifies - the exception applies", async () => {
    const dorm = await recordEvidence(db, U.preparer, S4, Y, "dormancy_confirmation", "Tax authority dormant status and nil returns to 28 Feb 2026", { asserted: "2026-02-28", issuedOn: "2026-03-10" });
    const c = await submitClaim(db, U.partner, S4, Y, "first_period", dormFacts(), "Dormant from registration to 28 February 2026 (tax authority status and nil returns); commenced trading on 1 March 2026 per the board resolution.", [s4cert.evidenceId, commence.evidenceId, dorm.evidenceId]);
    const self = await decide(db, U.partner, S4, Y, "first_period", true); const d = await decide(db, U.owner, S4, Y, "first_period", true, "Dormancy evidence covers registration to the day before commencement.");
    const b = await bl(S4, repS4);
    return JSON.stringify(c.pending) === JSON.stringify(["FIRST_PERIOD_REVIEW_PENDING"]) && self.outcome === "separate_approver_required" && d.outcome === "recorded" && !b.includes("COMPARATIVE_PERIOD_MISSING") && b.includes("OPENING_SUPPORT_MISSING") ? true : { c: c.pending, self, d, b: ours(b) };
  });

  // ── S6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("S6. Contradictory evidence arriving after approval ends the exception; a re-review restores it; history is kept");
  await kase("s6.contradiction-after-approval-stales", "S2 is verified; a record of activity on 30 Nov 2025 (before the stated start) arrives AFTER approval: the exception stops applying and the blocker names the contradiction and the stale decision", async () => {
    const before = (await status(S2)).firstPeriod.state;
    const e = await recordEvidence(db, U.preparer, S2, Y, "prior_activity_record", "Bank statement November 2025 showing a deposit", { asserted: "2025-11-30", issuedOn: "2026-06-10" });
    const b = await bl(S2, repS2); const c = await comparatives(S2); const s = await status(S2);
    return before === "verified" && e.outcome === "recorded" && b.includes("COMPARATIVE_PERIOD_MISSING") && b.includes("FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS:1") && b.includes("FIRST_PERIOD_DECISION_STALE")
      && c.state === "missing" && s.firstPeriod.state === "pending" && !b.includes("OPENING_SUPPORT_MISSING") ? true : { b: ours(b), c: c.state };
  });
  await kase("s6.cannot-reverify-while-contradicted", "the approver cannot re-verify while the contradiction stands (not_ready names it); sign-off is refused", async () => {
    const d = await decide(db, U.partner, S2, Y, "first_period", true); const r = await refusal(() => reviewed(S2, repS2));
    return d.outcome === "not_ready" && d.pending.some((x) => x.startsWith("FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS")) && /FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS/.test(r ?? "") ? true : { d, r };
  });
  await kase("s6.retract-then-rereview", "the record is retracted as erroneous: the contradiction clears but the decision stays STALE (the evidence set changed) until a re-review; the re-review restores the exception", async () => {
    const ret = await recordEvidence(db, U.preparer, S2, Y, "prior_activity_record", "Bank statement November 2025 showing a deposit", { asserted: "2025-11-30", issuedOn: "2026-06-10", retract: true, note: "Statement belongs to a different account holder" });
    const mid = await bl(S2, repS2);
    const d = await decide(db, U.partner, S2, Y, "first_period", true, "Contradicting record retracted as belonging to another holder; facts re-read against the certificate.");
    const after = await bl(S2, repS2);
    return ret.outcome === "recorded" && ret.revision === 2 && mid.includes("FIRST_PERIOD_DECISION_STALE") && !mid.some((x) => x.startsWith("FIRST_PERIOD_PRIOR_ACTIVITY")) && d.outcome === "recorded" && !after.includes("COMPARATIVE_PERIOD_MISSING") ? true : { ret, mid: ours(mid), d, after: ours(after) };
  });
  await kase("s6.history-kept-and-benign-copy-stales", "history is kept: two verified decisions, one claim, the contradicting revision and its retraction are all still recorded; a benign extra certificate copy also stales the decision, and only a decision refreshes it; the opening-balance decision rests on prior-activity evidence too, so it stays stale until its own re-review", async () => {
    const n = { dec: await db.count("SELECT count(*) n FROM public.fs_first_period_decisions WHERE company_id=$1 AND subject='first_period' AND outcome='verified'", [S2]), claims: await db.count("SELECT count(*) n FROM public.fs_first_period_claims WHERE company_id=$1 AND subject='first_period'", [S2]), rev: await db.count("SELECT count(*) n FROM public.fs_first_period_evidence WHERE company_id=$1 AND kind='prior_activity_record'", [S2]) };
    await recordEvidence(db, U.preparer, S2, Y, "certificate_of_registration", "Certified copy of the certificate (second copy)", { asserted: "2026-02-03", issuedOn: "2026-07-01" });
    const stale = await bl(S2, repS2);
    const d = await decide(db, U.partner, S2, Y, "first_period", true, "Second certificate copy agrees to the first; review refreshed.");
    const fresh = await bl(S2, repS2);
    return n.dec === 2 && n.claims === 1 && n.rev === 2 && stale.includes("FIRST_PERIOD_DECISION_STALE") && !stale.some((x) => x.startsWith("FIRST_PERIOD_PRIOR_ACTIVITY")) && d.outcome === "recorded"
      && !fresh.includes("COMPARATIVE_PERIOD_MISSING") && !fresh.some((x) => x.startsWith("FIRST_PERIOD_")) && JSON.stringify(fresh.filter((x) => x.startsWith("OPENING_SUPPORT_"))) === JSON.stringify(["OPENING_SUPPORT_DECISION_STALE"]) ? true : { n, stale: ours(stale), d, fresh: ours(fresh) };
  });
  await refusedCase("s6.append-only", "evidence, claims and decisions are append-only - not even the database owner may change them", "42501", () => db.admin.query("UPDATE public.fs_first_period_decisions SET reason = 'x y z' WHERE true"));
  await refusedCase("s6.client-direct-write-refused", "a direct write to the evidence table by a client is refused", "42501", () => db.asRole("authenticated", U.owner, "INSERT INTO public.fs_first_period_evidence (company_id, period_year, kind, reference, issued_on, asserted_date, document_sha256, revision, request_id, intent_sha256, actor_user_id) VALUES ($1,$2,'certificate_of_incorporation','forged ref','2026-01-01','2026-01-01',$3,1,$4,'x',$5)", [S1, Y, sha("f"), uuid(), U.owner]));
  await kase("s6.replay-and-request-reuse", "a replay returns the original receipt; the same request id with different content is refused (request_reused); malformed facts are invalid, never defaulted", async () => {
    const req = uuid(); const call = (ref) => asU(U.preparer, "SELECT public.fs_record_first_period_evidence($1,$2,'commencement_resolution',$3,'2026-02-01'::date,'2026-02-01'::date,$4,NULL,false,$5) r", [S4, Y, ref, sha(ref), req]).then((r) => r.r);
    const a = await call("Replay test resolution"); const b = await call("Replay test resolution"); const c = await call("A different resolution");
    const bad = await submitClaim(db, U.preparer, S4, Y, "first_period", { legalName: "x" }, "A claim with missing facts must be refused outright.", []);
    const unknown = await submitClaim(db, U.preparer, S4, Y, "first_period", { ...dormFacts(), comparativesNotRequired: true }, "A claim carrying a fact the rules do not define.", []);
    return a.outcome === "recorded" && b.outcome === "replay" && b.evidenceId === a.evidenceId && c.outcome === "request_reused" && bad.outcome === "invalid_request" && unknown.outcome === "invalid_request" ? true : { a, b, c, bad, unknown };
  });

  // ── S7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("S7. Later facts, a changed period and a changed company identity end the exception");
  const S7 = await entity("Freshstart Limited", { start: "2026-02-03", end: `${Y}-12-31` });
  const repS7 = await light(S7, "Freshstart Limited");
  const g7 = await verifyGenuineFirstPeriod(db, U, S7, Y, { name: "Freshstart Limited", start: "2026-02-03", end: `${Y}-12-31`, registrationDate: "2026-02-03", regNo: "CN-2026-0201" });
  await kase("s7.new-facts-end-exception", "verified; the preparer then records NEW facts (a later effective start with its commencement evidence): the earlier decision does not carry over - FIRST_PERIOD_REVIEW_PENDING and COMPARATIVE_PERIOD_MISSING return; a different approver's decision on the new facts restores it", async () => {
    const before = await bl(S7, repS7);
    const comm = await recordEvidence(db, U.preparer, S7, Y, "commencement_resolution", "Board resolution to commence trading 1 Mar 2026", { asserted: "2026-03-01", issuedOn: "2026-03-01" });
    const c = await submitClaim(db, U.preparer, S7, Y, "first_period", { ...g7.facts, effectiveStart: "2026-03-01" }, "Registered 3 February 2026; trading began on 1 March 2026 under the board's resolution.", [g7.cert.evidenceId, comm.evidenceId]);
    const mid = await bl(S7, repS7); const midC = await comparatives(S7);
    const d = await decide(db, U.partner, S7, Y, "first_period", true, "New start date agrees to the board resolution.");
    const after = await bl(S7, repS7);
    return g7.decision.outcome === "recorded" && !before.includes("COMPARATIVE_PERIOD_MISSING") && c.outcome === "recorded" && mid.includes("COMPARATIVE_PERIOD_MISSING") && mid.includes("FIRST_PERIOD_REVIEW_PENDING") && midC.state === "missing"
      && d.outcome === "recorded" && !after.includes("COMPARATIVE_PERIOD_MISSING") ? true : { before: ours(before), c, mid: ours(mid), d, after: ours(after) };
  });
  await kase("s7.period-change-stales", "the server's reporting dates for the period change after approval (the certified period's start moved, disposable database, triggers bypassed to simulate it): FIRST_PERIOD_DATES_MISMATCH and FIRST_PERIOD_DECISION_STALE; the exception stops; restoring the dates restores the bound decision", async () => {
    const pid = (await db.one("SELECT u.period_id FROM public.get_authoritative_certification($1,$2) c JOIN public.trial_balance_uploads u ON u.id = c.upload_id", [S7, Y])).period_id;
    const move = async (d) => { await db.admin.query("SET session_replication_role = replica"); await db.admin.query("UPDATE public.fiscal_periods SET reporting_start=$2::date WHERE id=$1", [pid, d]); await db.admin.query("SET session_replication_role = origin"); };
    await move("2026-01-01");
    const mid = await bl(S7, repS7); const s = await status(S7);
    await move("2026-02-03");
    const after = await bl(S7, repS7);
    const codes = s.firstPeriod.pending.map((x) => x.split(":")[0]);
    return mid.includes("COMPARATIVE_PERIOD_MISSING") && codes.includes("FIRST_PERIOD_DATES_MISMATCH") && codes.includes("FIRST_PERIOD_DECISION_STALE") && !after.includes("COMPARATIVE_PERIOD_MISSING") ? true : { mid: ours(mid), pending: s.firstPeriod.pending, after: ours(after) };
  });
  await kase("s7.identity-change-stales", "the company's legal name changes after approval: FIRST_PERIOD_ENTITY_NAME_MISMATCH and FIRST_PERIOD_DECISION_STALE; the exception stops (the decision is bound to the entity)", async () => {
    const before = (await db.one("SELECT public.fs_first_period_declared($1,$2) d", [S7, Y])).d;
    await db.admin.query("UPDATE public.companies SET name='Renamed Holdings Limited' WHERE id=$1", [S7]);
    const s = await status(S7); const after = (await db.one("SELECT public.fs_first_period_declared($1,$2) d", [S7, Y])).d;
    const codes = s.firstPeriod.pending.map((x) => x.split(":")[0]);
    return before === true && codes.includes("FIRST_PERIOD_ENTITY_NAME_MISMATCH") && codes.includes("FIRST_PERIOD_DECISION_STALE") && after === false ? true : { before, pending: s.firstPeriod.pending, after };
  });

  // ── CMP ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("CMP. A valid comparative path still signs off, and the compilation splice still bites");
  let C, docC;
  await kase("cmp.comparative-path-final", "a company with two certified years and comparatives approved reaches REVIEWED and FINAL on the migrated schema, without any first-period review", async () => {
    C = await W.company(U.owner, "Comparative SME Limited"); await members(C); await W.rollout(C, true);
    await prepareReporting(db, { U, A: C }, k, { year: Y });
    const rid = `rpt-cmp-${uuid()}`; const r = await attempt(C, pre, rid, allEvidence(C), "Comparative SME Limited");
    const rd = await partner.c.readiness(C, rid, r.reportVersion);
    await partner.c.setState(C, rid, r.reportVersion, "REVIEWED", "Reviewed"); const f = await owner.c.setState(C, rid, r.reportVersion, "FINAL", "Approved");
    docC = (await db.one("SELECT report_document, evidence_batch_ids FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=$2", [rid, r.reportVersion]));
    return r.outcome === "saved" && rd.ready === true && f.state === "FINAL" && ours(await blockersOf(db, U.partner, C, rid, r.reportVersion)).length === 0 ? true : { r: r.outcome, ready: rd.blockers, f: f.state };
  });
  await kase("cmp.server-compilation-bites", "the server-compilation blocker still bites: a document saved without the independent server compilation is refused by name (SERVER_COMPILATION_REQUIRED)", async () => {
    const rid = `rpt-nocompile-${uuid()}`; const d = { ...docC.report_document, reportIdentity: { ...docC.report_document.reportIdentity, reportId: rid, reportVersion: 1 } };
    const text = canonicalStringify(d);
    await asU(U.preparer, "SELECT * FROM public.fs_save_report_version($1,1,$2,$3,'TRIAL_BALANCE_DERIVED',$4::jsonb,$5,$6::text[])", [rid, C, Y, text, hex(text), docC.evidence_batch_ids]);
    await asU(U.partner, "SELECT * FROM public.fs_save_evaluation($1,$2,1,$3,'rule-pack','1','engine-1',$4,'[]'::jsonb)", [`ev-${rid}`, rid, C, hex(`e${rid}`)]);
    const b = await blockersOf(db, U.partner, C, rid, 1);
    const raw = await refusal(() => asU(U.partner, "SELECT * FROM public.fs_set_publication_state($1,1,$2,'REVIEWED','Attempt without compilation')", [rid, C]));
    return b.includes("SERVER_COMPILATION_REQUIRED") && /SERVER_COMPILATION_REQUIRED/.test(raw ?? "") && (await pubs(C)) === 2 ? true : { b, raw, pubs: await pubs(C) };
  });

  // ── RACE ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("RACE. An evidence or decision change racing with sign-off, both orderings, through the scope lock");
  const asUid = async (c, uid) => { await c.query("SET LOCAL ROLE authenticated"); await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]); };
  /** A writer transaction held open after its write ran (it holds the scope lock until released). */
  const holdWriter = async (uid, sql, params) => {
    const c = await db.pool.connect(); await c.query("BEGIN"); await asUid(c, uid);
    const r = (await c.query(sql, params)).rows[0].r;
    return { r, release: async () => { await c.query("COMMIT"); c.release(); } };
  };
  /** A sign-off transaction that holds the scope lock first (the lock fs_set_publication_state takes before anything else),
   *  evaluates the REAL sign-off under it, and stays open: what it observed is the state BEFORE any waiting writer. */
  const holdSignoff = async (uid, co, rep) => {
    const c = await db.pool.connect(); await c.query("BEGIN");
    await c.query("SELECT public._fs_scope_lock($1,$2)", [co, Y]);
    await asUid(c, uid); await c.query("SAVEPOINT s");
    let observed;
    try { await c.query("SELECT * FROM public.fs_set_publication_state($1,$2,$3,'REVIEWED','race ordering')", [rep.rid, rep.v, co]); observed = "ACCEPTED"; }
    catch (e) { observed = e.message; await c.query("ROLLBACK TO SAVEPOINT s"); }
    return { observed, release: async () => { await c.query("COMMIT"); c.release(); } };
  };
  const RA = await entity("Raceco Evidence Limited", { start: "2026-02-03", end: `${Y}-12-31` });
  const repRA = await light(RA, "Raceco Evidence Limited");
  await verifyGenuineFirstPeriod(db, U, RA, Y, { name: "Raceco Evidence Limited", start: "2026-02-03", end: `${Y}-12-31`, registrationDate: "2026-02-03", regNo: "CN-2026-0101" });
  const RD = await entity("Raceco Decision Limited", { start: "2026-02-03", end: `${Y}-12-31` });
  const repRD = await light(RD, "Raceco Decision Limited");
  {
    const cert = await recordEvidence(db, U.preparer, RD, Y, "certificate_of_incorporation", "Certificate of incorporation CN-2026-0102", { asserted: "2026-02-03", issuedOn: "2026-02-03" });
    await submitClaim(db, U.preparer, RD, Y, "first_period", { legalName: "Raceco Decision Limited", registrationNumber: "CN-2026-0102", basis: "incorporated_in_period", registrationDate: "2026-02-03", effectiveStart: "2026-02-03", reportingStart: "2026-02-03", reportingEnd: `${Y}-12-31`, priorStatementsPrepared: false }, "Incorporated on 3 February 2026; first period; no earlier period exists.", [cert.evidenceId]);
  }
  const contradiction = (co, ref) => ["SELECT public.fs_record_first_period_evidence($1,$2,'prior_activity_record',$3,'2026-06-10'::date,'2025-11-30'::date,$4,NULL,false,$5) r", [co, Y, ref, sha(ref), uuid()]];
  let RA2;
  await kase("race.e1-evidence-first", "E1 evidence first: a contradicting record is being written (lock held); sign-off waits, then sees it and is refused naming the contradiction", async () => {
    const w = await holdWriter(U.preparer, ...contradiction(RA, "Bank statement Nov 2025 (race E1)"));
    const s = settle(reviewed(RA, repRA)); const waited = await stillPending(s, 700);
    await w.release(); const out = await s;
    return w.r.outcome === "recorded" && waited && !out.ok && /FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS/.test(out.e) && /COMPARATIVE_PERIOD_MISSING/.test(out.e) ? true : { waited, out, w: w.r };
  });
  await kase("race.e2-signoff-first", "E2 sign-off first: sign-off holds the scope and evaluates; the writer waits; sign-off saw NO first-period reason (the state before the write); after it ends the write lands and the next sign-off sees it", async () => {
    RA2 = await entity("Raceco Evidence Two Limited", { start: "2026-02-03", end: `${Y}-12-31` }); const rep2 = await light(RA2, "Raceco Evidence Two Limited");
    await verifyGenuineFirstPeriod(db, U, RA2, Y, { name: "Raceco Evidence Two Limited", start: "2026-02-03", end: `${Y}-12-31`, registrationDate: "2026-02-03", regNo: "CN-2026-0103" });
    const h = await holdSignoff(U.partner, RA2, rep2);
    const [sql, p] = contradiction(RA2, "Bank statement Nov 2025 (race E2)");
    const w = settle(asU(U.preparer, sql, p).then((r) => r.r)); const waited = await stillPending(w, 700);
    await h.release(); const wr = await w;
    const after = await refusal(() => reviewed(RA2, rep2));
    return waited && !/COMPARATIVE_PERIOD_MISSING|FIRST_PERIOD_/.test(h.observed) && wr.ok && wr.v.outcome === "recorded" && /FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS/.test(after ?? "") ? true : { waited, observed: h.observed.slice(0, 300), wr, after };
  });
  await kase("race.d1-decision-first", "D1 decision first: the approver's decision is being written (lock held); sign-off waits, then sees the exception in force (no COMPARATIVE_PERIOD_MISSING, no FIRST_PERIOD_*)", async () => {
    const w = await holdWriter(U.partner, "SELECT public.fs_decide_first_period($1,$2,'first_period',true,'Certificate agrees; dates agree to the trial balance',$3) r", [RD, Y, uuid()]);
    const s = settle(reviewed(RD, repRD)); const waited = await stillPending(s, 700);
    await w.release(); const out = await s;
    return w.r.outcome === "recorded" && waited && !out.ok && !/COMPARATIVE_PERIOD_MISSING|FIRST_PERIOD_/.test(out.e) ? true : { waited, out, w: w.r };
  });
  await kase("race.d2-signoff-first-withdraw", "D2 sign-off first: sign-off holds the scope and sees the exception in force; a decision to WITHDRAW waits and lands after; the next sign-off sees FIRST_PERIOD_REVIEW_PENDING", async () => {
    const h = await holdSignoff(U.partner, RD, repRD);
    const w = settle(asU(U.partner, "SELECT public.fs_withdraw_first_period($1,$2,'first_period','Withdrawn after the sign-off attempt began',$3) r", [RD, Y, uuid()]).then((r) => r.r)); const waited = await stillPending(w, 700);
    await h.release(); const wr = await w; const after = await refusal(() => reviewed(RD, repRD));
    return waited && !/COMPARATIVE_PERIOD_MISSING|FIRST_PERIOD_/.test(h.observed) && wr.ok && wr.v.outcome === "recorded" && /FIRST_PERIOD_REVIEW_PENDING/.test(after ?? "") ? true : { waited, observed: h.observed.slice(0, 300), wr, after };
  });
  await kase("race.history-after", "after every race: issued history is still byte-identical and no publication was created for any raced scope", async () => {
    const now = await snapA.capture();
    const n = [await pubs(RA), await pubs(RA2), await pubs(RD), await pubs(S2), await pubs(S7)];
    return JSON.stringify(now) === JSON.stringify(snapA.before) && n.every((x) => x === 0) ? true : { pubs: n };
  });

  // ── UI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // The Comparatives page (src/components/reporting/FirstPeriodReview.tsx) calls ONLY the four RPCs through
  // src/lib/comparatives/firstPeriodReview.ts. These cases make exactly those calls, in the page's order, through that client
  // over the real client transport (clientDb: PostgREST's argument binding, a STABLE read in a READ ONLY transaction), and
  // read each state through the page's own mapping (reviewView) - the state the person would see.
  group("UI. The Comparatives page's calls, in its order, through the browser client over the real client transport");
  const UIC = await entity("Uiflow Limited", { start: "2026-02-03", end: `${Y}-12-31` });
  const repUI = await light(UIC, "Uiflow Limited");
  const fpc = (uid) => firstPeriodClient(clientDb(db, uid));
  const BOTH = { canPrepare: true, canApprove: true }, VIEW = { canPrepare: false, canApprove: false };
  const decisionsUI = () => db.count("SELECT count(*) n FROM public.fs_first_period_decisions WHERE company_id=$1", [UIC]);
  let shownAtApproval = null;
  await kase("ui.prepare-through-client", "the person preparing (a partner, who also holds the approval capability) reads the review (not started), records the certificate, reads again, and submits facts built from the SERVER's reporting dates with the evidence chosen from the server's list; the page then shows awaiting approval with no approve control for them", async () => {
    const c = fpc(U.partner);
    const s0 = await c.status(UIC, Y);
    if (s0.state !== "evaluated") return s0;
    const v0 = reviewView(s0.firstPeriod, "first_period", BOTH);
    const e = await c.recordEvidence(UIC, Y, { kind: "certificate_of_incorporation", reference: "Certificate of incorporation CN-2026-0301", issuedOn: "2026-02-03", assertedDate: "2026-02-03",
      documentSha256: sha("synthetic certificate CN-2026-0301"), note: null, retract: false }, uuid());
    const s1 = await c.status(UIC, Y);
    const cited = s1.evidence.filter((x) => x.kind === "certificate_of_incorporation").map((x) => x.id);
    const facts = firstPeriodFacts({ legalName: s1.entity.legalName, registrationNumber: "CN-2026-0301", tin: s1.entity.tin ?? "", basis: "incorporated_in_period", registrationDate: "2026-02-03",
      effectiveStart: "2026-02-03", priorStatementsPrepared: false, dormantFrom: "", dormantThrough: "" }, s1.period);
    const r = await c.submitClaim(UIC, Y, "first_period", facts, "Incorporated on 3 February 2026; the certificate establishes the registration date; no earlier period exists.", cited, uuid());
    const s2 = await c.status(UIC, Y);
    const v2 = reviewView(s2.firstPeriod, "first_period", BOTH);
    return v0.kind === "not_started" && v0.primary === "record_facts" && e.outcome === "recorded" && cited.length === 1 && s1.period.reportingStart === "2026-02-03" && s1.period.reportingEnd === `${Y}-12-31`
      && r.outcome === "recorded" && v2.kind === "awaiting_approval" && v2.primary === null && s2.firstPeriod.claim?.recordedByYou === true ? true : { v0, e, cited, period: s1.period, r, v2 };
  });
  await kase("ui.same-person-cannot-approve", "if the person who recorded the facts calls the decision anyway (with the binding shown), the server refuses it (separate_approver_required); a preparer without the approval capability is refused (forbidden); nothing is recorded", async () => {
    const s = await fpc(U.partner).status(UIC, Y);
    const d = await fpc(U.partner).decide(UIC, Y, "first_period", true, "Approving my own facts", uuid(), s.firstPeriod.binding);
    const p = await fpc(U.preparer).decide(UIC, Y, "first_period", true, "A preparer approving", uuid(), s.firstPeriod.binding);
    const n = await decisionsUI();
    return d.outcome === "separate_approver_required" && p.outcome === "forbidden" && n === 0 ? true : { d, p, n };
  });
  await kase("ui.second-person-approves", "a second person (the owner) is offered the review, reads exactly what is bound (company name, the server's dates, the one cited current revision, the rule version) and decides with the binding shown: recorded; COMPARATIVE_PERIOD_MISSING clears; the page shows approved and the comparatives a first-period exception", async () => {
    const c = fpc(U.owner);
    const s = await c.status(UIC, Y);
    const v = reviewView(s.firstPeriod, "first_period", BOTH);
    const bound = s.entity.legalName === "Uiflow Limited" && s.period.reportingStart === "2026-02-03" && s.period.reportingEnd === `${Y}-12-31` && s.firstPeriod.rules === "first-period-rules/1"
      && s.firstPeriod.cited.length === 1 && s.firstPeriod.cited[0].current === true && s.firstPeriod.cited[0].reference === "Certificate of incorporation CN-2026-0301" && /^[0-9a-f]{64}$/.test(s.firstPeriod.binding ?? "");
    shownAtApproval = s.firstPeriod.binding;
    const d = await c.decide(UIC, Y, "first_period", true, "Certificate agrees to the registration date; dates agree to the reviewed trial balance.", uuid(), s.firstPeriod.binding);
    const after = await c.status(UIC, Y); const b = await bl(UIC, repUI); const cmp = await comparatives(UIC);
    const va = reviewView(after.firstPeriod, "first_period", BOTH);
    return v.kind === "awaiting_approval" && v.primary === "review" && bound && d.outcome === "recorded" && va.kind === "approved" && !b.includes("COMPARATIVE_PERIOD_MISSING") && !b.some((x) => x.startsWith("FIRST_PERIOD_"))
      && cmp.state === "first_period_exception" ? true : { v, bound, d, va, b: ours(b), cmp: cmp.state };
  });
  await kase("ui.new-evidence-stales", "new evidence recorded through the page (a certified copy of the certificate) makes the approval stale: the page shows 'approval out of date' with the server's ONE named reason and its next action; COMPARATIVE_PERIOD_MISSING returns with FIRST_PERIOD_DECISION_STALE", async () => {
    const e = await fpc(U.preparer).recordEvidence(UIC, Y, { kind: "certificate_of_registration", reference: "Certified copy of certificate CN-2026-0301", issuedOn: "2026-03-01", assertedDate: "2026-02-03",
      documentSha256: sha("synthetic certified copy CN-2026-0301"), note: null, retract: false }, uuid());
    const s = await fpc(U.owner).status(UIC, Y); const v = reviewView(s.firstPeriod, "first_period", BOTH);
    const b = await bl(UIC, repUI);
    return e.outcome === "recorded" && v.kind === "stale" && v.primary === "review" && v.nextAction === FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_DECISION_STALE && JSON.stringify(v.codes) === JSON.stringify(["FIRST_PERIOD_DECISION_STALE"])
      && b.includes("COMPARATIVE_PERIOD_MISSING") && b.includes("FIRST_PERIOD_DECISION_STALE") ? true : { e, v, b: ours(b) };
  });
  await kase("ui.decision-on-old-binding-refused", "a decision sent with the binding the approver was shown BEFORE the new evidence is refused (changed_since_viewed): nothing is recorded and the exception stays off", async () => {
    const before = await decisionsUI();
    const d = await fpc(U.owner).decide(UIC, Y, "first_period", true, "Approving what I was shown earlier", uuid(), shownAtApproval);
    const after = await decisionsUI(); const b = await bl(UIC, repUI);
    return d.outcome === "changed_since_viewed" && before === after && b.includes("COMPARATIVE_PERIOD_MISSING") ? true : { d, before, after, b: ours(b) };
  });
  await kase("ui.re-review-restores", "the approver reads the review again (the new revision is now in the evidence set) and decides on what is shown now: recorded; approved again; COMPARATIVE_PERIOD_MISSING clears; both decisions are kept", async () => {
    const c = fpc(U.owner);
    const s = await c.status(UIC, Y);
    const d = await c.decide(UIC, Y, "first_period", true, "Certified copy agrees to the original certificate; review refreshed.", uuid(), s.firstPeriod.binding);
    const after = await c.status(UIC, Y); const b = await bl(UIC, repUI);
    return s.firstPeriod.binding !== shownAtApproval && d.outcome === "recorded" && reviewView(after.firstPeriod, "first_period", BOTH).kind === "approved" && !b.includes("COMPARATIVE_PERIOD_MISSING")
      && (await decisionsUI()) === 2 ? true : { d, b: ours(b), n: await decisionsUI() };
  });
  await kase("ui.legacy-and-viewer", "through the same client, a legacy declaration reads as an unverified claim that needs a governed review (never approved); a viewer reads the review and is offered no action", async () => {
    const s = await fpc(U.owner).status(L2, Y); const v = reviewView(s.firstPeriod, "first_period", BOTH);
    const sv = await fpc(U.viewer).status(UIC, Y); const vv = reviewView(sv.state === "evaluated" ? sv.firstPeriod : null, "first_period", VIEW);
    return v.kind === "legacy_claim" && s.legacyDeclaration?.satisfiesRequirement === false && vv.kind === "approved" && vv.primary === null ? true : { v, legacy: s.legacyDeclaration, vv, sv: sv.state };
  });
}

let SIGNOFF_REMAINDER = [];
let FINDING_CASHFLOW = [];
let crashed = false, crashMessage = null;
try { await main(); } catch (e) { crashed = true; crashMessage = String(e?.message ?? e).slice(0, 500); console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
if (SIGNOFF_REMAINDER.length) console.log(`\n(note) S2: blockers that remain after the first-period and opening reviews: ${JSON.stringify(SIGNOFF_REMAINDER)}`);
if (FINDING_CASHFLOW.length) console.log(`(note) S2 with the period's evidence supplied: cash-flow blockers that remain: ${JSON.stringify(FINDING_CASHFLOW)}`);
const ok = finish(ABSENT ? "FIRST PERIOD (gate absent - the weakness cases must fail)" : "FIRST PERIOD GOVERNED REVIEW", crashed);
writeResult(!crashed, crashed, crashMessage);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
