#!/usr/bin/env bun
// Real-PostgreSQL proof of 20261208100000 (IPSAS grants and revenue by period) on the full chain:
//   - only an authorised member of an ipsas_accrual company reads or writes; tables and helpers are not reachable by API roles;
//   - the period (and so the applicable vocabulary) is read from the CERTIFIED upload's fiscal period: a typed period changes nothing;
//   - the server recomputes everything from persisted inputs: forged confirmation / total / period / TB fields are ignored;
//   - SQL equals the independently hand-derived fixtures (IPSAS 47 and IPSAS 23 periods) and the TypeScript rules on mutations;
//   - cash received and expenditure never decide revenue; unsatisfied obligations are the liability; receivable is recognised − cash;
//   - twenty identical requests record one revision; twenty writers on one revision record one; changed intent refused;
//   - a confirmation binds one grant's exact content AND the period; any change voids it;
//   - SME and PPE authority rows are byte-identical afterwards; a revoked preparer reads and writes nothing, replay included.
// Synthetic data only. Result: PROOF_RESULT_FILE (default proof-results/ipsasGrants.present.json).
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… bun scripts/db-proof/ipsasGrants.mjs   |   DB_PROOF_MODULES_DIR=<dir> bun scripts/db-proof/ipsasGrants.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChain, certifier, csv, makeWorld, openDatabase, prepareReporting, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./ipsasGrants.manifest.mjs";
import { computeGrants } from "../../src/lib/ipsasAccrual/grants.ts";
import { grantA, grantB, grantC, grantD, entity47, entity23 } from "../../src/lib/ipsasAccrual/grants.fixture.ts";

const MIGRATION = "20261208100000_ipsas_grants.sql";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.present.json`);
const { group, check, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
let db;
const ids = new Set(CASES.map((c) => c.id)), recorded = [], startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./ipsasGrants.manifest.mjs", import.meta.url), "utf8"));
async function kase(id, title, fn) {
  if (!ids.has(id)) throw new Error(`proof defect: case ${id} is not in the manifest`);
  if (recorded.some((r) => r.id === id)) throw new Error(`proof defect: case ${id} recorded twice`);
  let outcome = "fail", detail = "";
  await check(`[${id}] ${title}`, async () => {
    try { const r = await fn(); if (r === true) { outcome = "pass"; return true; } detail = JSON.stringify(r)?.slice(0, 1500) ?? ""; return r; }
    catch (e) { detail = `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`; throw e; }
  });
  recorded.push({ id, title, outcome, detail });
}
function writeResult(completed, crashed, crashMessage) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256, startedAt, finishedAt: new Date().toISOString(), completed, crashed, crashMessage: crashMessage ?? null,
    cases: recorded.map(({ id, outcome, detail }) => ({ id, outcome, ...(detail ? { detail } : {}) })) }, null, 2) + "\n");
  console.log(`structured result: ${RESULT_FILE}`);
}

// Certified trial balances with grant accounts (TZS 2 dp), balanced by hand. Columns: code, name, class, statement, normal, d26, c26, d25, c25.
//   2026: receivable 4,500,000.00 · unfulfilled grant obligations 5,500,000.00 · grant revenue 6,500,000.00 · bank 20,000,000.00 · fund 12,500,000.00
//   2025: receivable   600,000.00 · unfulfilled grant obligations 3,600,000.00 · grant revenue 3,400,000.00 · bank 20,000,000.00 · fund 13,600,000.00
const TBG = [
  ["1000", "Bank", "current_assets", "balance_sheet", "debit", "20000000.00", "", "20000000.00", ""],
  ["1300", "Grant receivable", "current_assets", "balance_sheet", "debit", "4500000.00", "", "600000.00", ""],
  ["2300", "Unfulfilled grant obligations", "current_liabilities", "balance_sheet", "credit", "", "5500000.00", "", "3600000.00"],
  ["3000", "Accumulated fund", "equity", "balance_sheet", "credit", "", "12500000.00", "", "13600000.00"],
  ["4300", "Grant revenue", "revenue", "income_statement", "credit", "", "6500000.00", "", "3400000.00"],
];
const SEL = { revenueKeys: ["4300"], liabilityKeys: ["2300"], receivableKeys: ["1300"] };
const payload = (company, year, grants, over = {}) => ({ contract: "cfoclose-ipsas-grants/1", companyId: company, periodYear: year, presentation: { currency: "TZS", exponent: 2 }, entityAnswers: year === 2026 ? entity47() : entity23(), tbSelection: SEL, grants, ...over });
const tsCodes = (p, live) => {
  const a = live.assessment;
  const start = live.period.start;
  return [...new Set(computeGrants({ period: start ? { start, end: live.period.end } : null, entityAnswers: p.entityAnswers, tb: live.tb, grants: p.grants.map((g) => ({ ...g, assessmentConfirmed: live.confirmedGrants[g.grantId] === true })) }).issues.map((i) => `${i.code}|${i.grantId ?? ""}`))].sort();
};
const sqlCodes = (live) => [...(live.assessment?.codes ?? [])].sort();

async function main() {
  db = await openDatabase("ipsas_grants_proof");
  const admin = db.admin;
  group("Chain and fixtures");
  await kase("setup.chain-applies", `the full chain applies and ${MIGRATION} installs its tables and functions`, async () => {
    const err = await applyChain(db);
    if (err) return err;
    const r = await db.one(`SELECT to_regclass('public.ipsas_grant_revisions') IS NOT NULL a, to_regclass('public.ipsas_grant_confirmations') IS NOT NULL b,
      to_regprocedure('public.ipsas_save_grants(uuid,integer,jsonb,uuid,uuid)') IS NOT NULL c, to_regprocedure('public.ipsas_confirm_grant(uuid,integer,text,uuid,uuid)') IS NOT NULL d,
      to_regprocedure('public.ipsas_grants_context(uuid,integer)') IS NOT NULL e`);
    return r.a && r.b && r.c && r.d && r.e ? true : r;
  });
  const W = await makeWorld(db);
  const { U, A: SME } = W;
  const AI = await W.company(U.owner, "Synthetic Community Trust", "ipsas_accrual");
  for (const k of ["preparer", "partner", "viewer"]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [AI, U[k], k]);
  await W.rollout(AI, true); await W.rollout(SME, true); await W.rollout(W.B, true);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const ctx = (uid = U.preparer, company = AI, year = 2026) => asU(uid, "SELECT public.ipsas_grants_context($1,$2) r", [company, year]).then((x) => x.r);
  const save = (year, p, { uid = U.preparer, company = AI, expected = null, request = uuid() } = {}) =>
    asU(uid, "SELECT public.ipsas_save_grants($1,$2,$3::jsonb,$4,$5) r", [company, year, JSON.stringify(p), expected, request]).then((x) => x.r);
  const confirm = (year, grantId, rev, { uid = U.partner, request = uuid(), company = AI } = {}) =>
    asU(uid, "SELECT public.ipsas_confirm_grant($1,$2,$3,$4,$5) r", [company, year, grantId, rev, request]).then((x) => x.r);
  const count = async (t) => Number((await admin.query(`SELECT count(*) n FROM public.${t}`)).rows[0].n);
  const rev = { 2025: null, 2026: null };
  const G47 = () => [grantA(), grantB()], G23 = () => [grantC(), grantD()];

  await kase("setup.world-and-certified-years", "an IPSAS company with a preparer, a partner and a viewer, and 2025 and 2026 trial balances (with grant accounts) certified by the real engine", async () => {
    const k = await certifier(db, U);
    for (const [y, col] of [[2025, 7], [2026, 5]]) { const u = await k.upload(AI, y, csv(col, TBG)); if (y === 2025) await k.review(AI, u, TBG); await k.certify(AI, u); }
    const n = await db.one("SELECT count(*)::int n FROM public.tb_certifications WHERE company_id=$1", [AI]);
    return n.n >= 2 ? true : n;
  });
  await kase("static.no-outer-transaction-no-bare-write", "the migration supplies no outer BEGIN/COMMIT and no DELETE/UPDATE without a WHERE clause", async () => {
    const text = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8");
    const stripped = text.replace(/\$\$[\s\S]*?\$\$/g, "").replace(/--.*$/gm, "");
    const outer = stripped.split("\n").filter((l) => /^(BEGIN|COMMIT|ROLLBACK);\s*$/.test(l.trim()));
    const bare = [...text.matchAll(/\b(DELETE\s+FROM|UPDATE)\s+[a-z_."]+\s*(SET[^;]*)?;/gi)].filter((m) => !/WHERE/i.test(m[0]));
    return outer.length === 0 && bare.length === 0 && !text.includes("\u0000") ? true : { outer, bare: bare.map((m) => m[0]) };
  });

  group("Authority");
  await kase("authz.privileges-and-internals", "API roles reach no table directly and none of the helpers; only the three RPCs are executable, and only by authenticated", async () => {
    const t = [];
    for (const table of ["ipsas_grant_revisions", "ipsas_grant_confirmations"]) for (const role of ["authenticated", "anon", "service_role"]) {
      try { await db.asRole(role, U.owner, `SELECT * FROM public.${table}`, []); t.push(`${role} read ${table}`); } catch (e) { if (e.code !== "42501") t.push(`${role}:${e.code}`); }
    }
    const fn = async (sig, role) => (await db.one("SELECT has_function_privilege($1, $2, 'EXECUTE') ok", [role, sig])).ok;
    for (const s of ["_ipsas_grants_assess(jsonb,jsonb,jsonb,jsonb)", "_ipsas_grants_live(uuid,integer)", "_ipsas_grants_period(uuid,integer)", "_ipsas_tb_sum(uuid,integer,jsonb,text)", "_ipsas_grant_subject_sha(jsonb,text)", "_ipsas_natj(jsonb)"])
      for (const role of ["authenticated", "anon", "service_role"]) if (await fn(`public.${s}`, role)) t.push(`${role} may execute ${s}`);
    for (const s of ["ipsas_grants_context(uuid,integer)", "ipsas_save_grants(uuid,integer,jsonb,uuid,uuid)", "ipsas_confirm_grant(uuid,integer,text,uuid,uuid)"]) {
      if (!(await fn(`public.${s}`, "authenticated"))) t.push(`authenticated lacks ${s}`);
      for (const role of ["anon", "service_role"]) if (await fn(`public.${s}`, role)) t.push(`${role} may execute ${s}`);
    }
    return t.length === 0 ? true : t;
  });
  await kase("authz.viewer-outsider-anon-service-refused", "a viewer and another workspace's owner read and write nothing; anon and service_role cannot call the RPCs", async () => {
    const before = await count("ipsas_grant_revisions");
    const r = [await ctx(U.viewer), await ctx(U.ownerB), await save(2026, payload(AI, 2026, G47()), { uid: U.viewer }), await save(2026, payload(AI, 2026, G47()), { uid: U.ownerB })];
    let anon = "ran", svc = "ran";
    try { await db.asRole("anon", null, "SELECT public.ipsas_grants_context($1,2026)", [AI]); } catch (e) { anon = e.code; }
    try { await db.asRole("service_role", null, "SELECT public.ipsas_save_grants($1,2026,'{}'::jsonb,NULL,$2)", [AI, uuid()]); } catch (e) { svc = e.code; }
    return r.every((x) => x.outcome === "forbidden") && anon === "42501" && svc === "42501" && (await count("ipsas_grant_revisions")) === before ? true : { r: r.map((x) => x.outcome), anon, svc };
  });
  await kase("authz.framework-gate", "an IFRS for SMEs workspace is not served, even to its owner", async () => {
    const c = await ctx(U.owner, SME), s = await save(2026, payload(SME, 2026, G47()), { uid: U.owner, company: SME });
    return c.outcome === "framework_not_ipsas_accrual" && s.outcome === "framework_not_ipsas_accrual" ? true : { c: c.outcome, s: s.outcome };
  });
  await kase("authz.preparer-cannot-confirm", "a preparer (no review capability) cannot record a confirmation", async () => {
    const r = await save(2026, payload(AI, 2026, G47())); rev[2026] = r.revisionId;
    const c = await confirm(2026, grantA().grantId, rev[2026], { uid: U.preparer });
    return r.outcome === "recorded" && c.outcome === "forbidden" ? true : { r: r.outcome, c: c.outcome };
  });
  await kase("tamper.cross-company-and-direct-helper-refused", "confirming another company's grant, a grant that is not in the register, or calling an internal helper directly is refused", async () => {
    const n = await count("ipsas_grant_confirmations");
    const other = await confirm(2026, grantA().grantId, rev[2026], { company: SME, uid: U.owner });
    const outsider = await confirm(2026, grantA().grantId, rev[2026], { uid: U.ownerB });
    const missing = await confirm(2026, "99999999-9999-4999-8999-999999999999", rev[2026]);
    let direct = "ran"; try { await db.asRole("authenticated", U.owner, "SELECT public._ipsas_grants_assess('{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb)", []); } catch (e) { direct = e.code; }
    return other.outcome === "framework_not_ipsas_accrual" && outsider.outcome === "forbidden" && missing.outcome === "unknown_subject" && direct === "42501" && (await count("ipsas_grant_confirmations")) === n ? true : { other: other.outcome, outsider: outsider.outcome, missing: missing.outcome, direct };
  });

  group("Saving");
  await kase("save.invalid-and-cross-company-refused", "another company or year, a wrong contract, an invalid grant identity or a missing section is refused before any write", async () => {
    const before = await count("ipsas_grant_revisions");
    const bad = [payload(W.B, 2026, G47()), payload(AI, 2025, G47()), payload(AI, 2026, G47(), { contract: "cfoclose-ipsas-ppe-workpaper/1" }), payload(AI, 2026, [{ ...grantB(), grantId: "not-a-uuid" }]),
      payload(AI, 2026, G47(), { tbSelection: null }), payload(AI, 2026, G47(), { entityAnswers: null }), payload(AI, 2026, null)];
    const out = []; for (const p of bad) out.push((await save(2026, p, { expected: rev[2026] })).outcome);
    return out.every((o) => o === "invalid_request") && (await count("ipsas_grant_revisions")) === before ? true : out;
  });
  await kase("save.draft-recorded-and-stale", "an incomplete draft is saved (not rejected); a second save against the old revision is stale", async () => {
    const c0 = await ctx();
    const stale = await save(2026, payload(AI, 2026, G47()), { expected: null });
    const r = await save(2026, payload(AI, 2026, [{ ...grantB(), classification: "" }]), { expected: c0.register.id }); rev[2026] = r.revisionId;
    return r.outcome === "recorded" && stale.outcome === "stale" && stale.currentId === c0.register.id && r.live.assessment.state === "incomplete" && r.live.assessment.codes.includes(`GRANT_CLASSIFICATION_REQUIRED|${grantB().grantId}`) ? true : { r, stale };
  });
  await kase("save.forged-authority-fields-ignored", "claimed confirmation, totals, period, trial-balance figures, state or an assessment change nothing", async () => {
    const forged = payload(AI, 2026, [{ ...grantA(), assessmentConfirmed: true, confirmed: true, periodRevenueMinor: "999999999", liabilityMinor: "0" }, grantB()],
      { period: { start: "2025-01-01", end: "2025-12-31" }, tb: { revenueMinor: "650000000" }, totals: { periodRevenueMinor: "1" }, assessment: { state: "ready-for-review", codes: [] }, state: "ready-for-review", confirmedGrants: { [grantA().grantId]: true }, model: "ipsas23" });
    const r = await save(2026, forged, { expected: rev[2026] }); rev[2026] = r.revisionId;
    const l = r.live, a = l.assessment;
    return a.model === "ipsas47" && l.period.start === "2026-01-01" && a.codes.includes(`GRANT_ASSESSMENT_UNCONFIRMED|${grantA().grantId}`) && l.confirmedGrants[grantA().grantId] === undefined
      && a.grants[0].periodRevenueMinor === "450000000" ? true : { model: a.model, start: l.period.start, codes: a.codes };
  });
  await kase("period.read-from-certified-upload-not-typed", "2026 is assessed as the IPSAS 47 period and 2025 as the IPSAS 23 period from the certified fiscal periods, whatever the payload says", async () => {
    const r26 = await save(2026, payload(AI, 2026, G47(), { period: { start: "2024-01-01", end: "2024-12-31" } }), { expected: rev[2026] }); rev[2026] = r26.revisionId;
    const r25 = await save(2025, payload(AI, 2025, G23(), { period: { start: "2026-06-01", end: "2027-05-31" } }), { expected: null }); rev[2025] = r25.revisionId;
    return r26.live.assessment.model === "ipsas47" && r26.live.period.end === "2026-12-31" && r25.live.assessment.model === "ipsas23" && r25.live.period.start === "2025-01-01" ? true : { a: r26.live.assessment.model, b: r25.live.assessment.model };
  });

  group("Replay and concurrency");
  await kase("save.twenty-way-same-request", "twenty identical requests record one revision with the same receipt", async () => {
    const before = await count("ipsas_grant_revisions"), p = payload(AI, 2026, G47()), request = uuid(), expected = rev[2026];
    const rs = await Promise.all(Array.from({ length: 20 }, () => save(2026, p, { expected, request })));
    rev[2026] = rs[0].revisionId;
    return rs.every((r) => r.outcome === "recorded") && new Set(rs.map((r) => r.revisionId)).size === 1 && (await count("ipsas_grant_revisions")) === before + 1 && rs.filter((r) => r.replay).length >= 19 ? true : rs.map((r) => r.outcome);
  });
  await kase("save.twenty-writers-one-revision", "twenty distinct requests on one expected revision record exactly one; nineteen are stale", async () => {
    const before = await count("ipsas_grant_revisions"), expected = rev[2026];
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => save(2026, payload(AI, 2026, [grantA({ reference: `DONOR-X-HEALTH-${i}` }), grantB()]), { expected })));
    const won = rs.filter((r) => r.outcome === "recorded"), stale = rs.filter((r) => r.outcome === "stale");
    if (won.length === 1) rev[2026] = won[0].revisionId;
    const restore = await save(2026, payload(AI, 2026, G47()), { expected: rev[2026] }); rev[2026] = restore.revisionId;
    return won.length === 1 && stale.length === 19 && (await count("ipsas_grant_revisions")) === before + 2 ? true : { won: won.length, stale: stale.length };
  });
  await kase("save.changed-intent-same-request", "the same request id with a different payload is refused and writes nothing", async () => {
    const request = uuid(), before = await count("ipsas_grant_revisions");
    const a = await save(2026, payload(AI, 2026, G47()), { expected: rev[2026], request }); rev[2026] = a.revisionId;
    const b = await save(2026, payload(AI, 2026, [grantB()]), { expected: rev[2026], request });
    return a.outcome === "recorded" && b.outcome === "request_reused" && (await count("ipsas_grant_revisions")) === before + 1 ? true : { a: a.outcome, b: b.outcome };
  });

  group("Server recalculation");
  await kase("calc.sql-equals-hand-derived-ipsas47", "the IPSAS 47 fixture: revenue 4,500,000 + 2,000,000, liability 5,500,000, receivable 4,500,000, from satisfied obligations", async () => {
    const r = await save(2026, payload(AI, 2026, G47()), { expected: rev[2026] }); rev[2026] = r.revisionId;
    const a = r.live.assessment, [ga, gb] = a.grants;
    return ga.cumulativeRevenueMinor === "650000000" && ga.periodRevenueMinor === "450000000" && ga.liabilityMinor === "550000000" && ga.receivableMinor === "450000000"
      && gb.periodRevenueMinor === "200000000" && gb.liabilityMinor === "0" && gb.receivableMinor === "0"
      && a.totals.periodRevenueMinor === "650000000" && a.totals.liabilityMinor === "550000000" && a.totals.receivableMinor === "450000000" ? true : a;
  });
  await kase("calc.sql-equals-hand-derived-ipsas23", "the IPSAS 23 fixture: a condition is revenue only as satisfied (2,400,000; liability 3,600,000); a restriction is revenue in full with receivable 600,000 and no liability", async () => {
    const r = await save(2025, payload(AI, 2025, G23()), { expected: rev[2025] }); rev[2025] = r.revisionId;
    const a = r.live.assessment, [gc, gd] = a.grants;
    return gc.periodRevenueMinor === "240000000" && gc.liabilityMinor === "360000000" && gc.receivableMinor === "0" && gd.periodRevenueMinor === "100000000" && gd.liabilityMinor === "0" && gd.receivableMinor === "60000000"
      && a.totals.periodRevenueMinor === "340000000" && a.totals.liabilityMinor === "360000000" && a.totals.receivableMinor === "60000000" ? true : a;
  });
  await kase("calc.cash-and-expenditure-never-decide-revenue", "more or less cash received, or a different amount spent, leaves revenue unchanged; evidenced satisfaction changes it", async () => {
    const withCash = (cash) => { const g = grantA({ cashReceivedMinor: cash }); return payload(AI, 2026, [g, grantB()]); };
    const full = await save(2026, withCash("1200000000"), { expected: rev[2026] }); rev[2026] = full.revisionId;
    const none = await save(2026, withCash("0"), { expected: rev[2026] }); rev[2026] = none.revisionId;
    const g = grantA(); g.obligations[1] = { ...g.obligations[1], satisfiedMinor: "250000000" };
    const done = await save(2026, payload(AI, 2026, [g, grantB()]), { expected: rev[2026] }); rev[2026] = done.revisionId;
    const restore = await save(2026, payload(AI, 2026, G47()), { expected: rev[2026] }); rev[2026] = restore.revisionId;
    const f = full.live.assessment.grants[0], n = none.live.assessment.grants[0], d = done.live.assessment.grants[0];
    return f.periodRevenueMinor === "450000000" && n.periodRevenueMinor === "450000000" && f.receivableMinor === "0" && n.receivableMinor === "1200000000" && d.periodRevenueMinor === "550000000" ? true : { f, n, d };
  });

  group("Trial balance facts");
  await kase("tb.facts-from-certified-rows", "revenue, liability and receivable are read from the certified rows (6,500,000 / 5,500,000 / 4,500,000 for 2026) and tie exactly", async () => {
    const l = (await ctx(U.owner, AI, 2026)).live;
    return l.tb.revenueMinor === "650000000" && l.tb.liabilityMinor === "550000000" && l.tb.receivableMinor === "450000000" && !l.assessment.codes.some((c) => c.startsWith("TB_GRANT")) ? true : l.tb;
  });
  await kase("tb.unknown-is-not-zero", "an absent account key or incompatible classification makes the figure unknown with a named blocker", async () => {
    const ghost = await save(2026, payload(AI, 2026, G47(), { tbSelection: { revenueKeys: ["4300", "9999"], liabilityKeys: ["2300"], receivableKeys: [] } }), { expected: rev[2026] }); rev[2026] = ghost.revisionId;
    const wrong = await save(2026, payload(AI, 2026, G47(), { tbSelection: { revenueKeys: ["3000"], liabilityKeys: ["2300"], receivableKeys: ["1300"] } }), { expected: rev[2026] }); rev[2026] = wrong.revisionId;
    const restore = await save(2026, payload(AI, 2026, G47()), { expected: rev[2026] }); rev[2026] = restore.revisionId;
    const g = ghost.live.assessment.codes, w = wrong.live.assessment.codes;
    return ghost.live.tb.revenueMinor === null && g.includes("TB_GRANT_REVENUE_UNKNOWN|") && g.includes("TB_GRANT_RECEIVABLE_UNKNOWN|") && !g.includes("TB_GRANT_LIABILITY_UNKNOWN|") && wrong.live.tb.revenueMinor === null && w.includes("TB_GRANT_REVENUE_UNKNOWN|") ? true : { g, w };
  });

  group("Confirmation");
  await kase("confirm.bound-to-exact-grant-and-period", "a partner's confirmation clears the grant's unconfirmed matter; changing the grant voids it; restoring the identical grant restores it", async () => {
    const c = await confirm(2026, grantA().grantId, rev[2026]);
    const a1 = (await ctx(U.owner)).live.assessment, ok1 = !a1.codes.includes(`GRANT_ASSESSMENT_UNCONFIRMED|${grantA().grantId}`) && a1.codes.includes(`GRANT_ASSESSMENT_UNCONFIRMED|${grantB().grantId}`);
    const changed = grantA(); changed.obligations[1] = { ...changed.obligations[1], satisfiedMinor: "160000000" };
    const r2 = await save(2026, payload(AI, 2026, [changed, grantB()]), { expected: rev[2026] }); rev[2026] = r2.revisionId;
    const voided = r2.live.assessment.codes.includes(`GRANT_ASSESSMENT_UNCONFIRMED|${grantA().grantId}`);
    const r3 = await save(2026, payload(AI, 2026, G47()), { expected: rev[2026] }); rev[2026] = r3.revisionId;
    const restored = !r3.live.assessment.codes.includes(`GRANT_ASSESSMENT_UNCONFIRMED|${grantA().grantId}`);
    return c.outcome === "confirmed" && ok1 && voided && restored ? true : { c: c.outcome, ok1, voided, restored };
  });
  await kase("confirm.stale-unknown-not-confirmable", "a confirmation against an old revision is stale; a grant with no classification is not confirmable", async () => {
    const old = rev[2026];
    const r = await save(2026, payload(AI, 2026, [grantA(), { ...grantB(), classification: "" }]), { expected: old }); rev[2026] = r.revisionId;
    const stale = await confirm(2026, grantA().grantId, old);
    const notc = await confirm(2026, grantB().grantId, rev[2026]);
    const back = await save(2026, payload(AI, 2026, G47()), { expected: rev[2026] }); rev[2026] = back.revisionId;
    return stale.outcome === "stale" && notc.outcome === "not_confirmable" ? true : { stale: stale.outcome, notc: notc.outcome };
  });
  await kase("confirm.replay-and-changed-intent", "repeating a confirmation returns its receipt; reusing the id for another grant is refused; twenty concurrent confirmations are one receipt", async () => {
    const request = uuid(), n0 = await count("ipsas_grant_confirmations");
    const rs = await Promise.all(Array.from({ length: 20 }, () => confirm(2026, grantB().grantId, rev[2026], { request })));
    const reused = await confirm(2026, grantA().grantId, rev[2026], { request });
    return rs.every((x) => x.outcome === "confirmed") && new Set(rs.map((x) => x.confirmationId)).size === 1 && reused.outcome === "request_reused" && (await count("ipsas_grant_confirmations")) === n0 + 1 ? true : { ids: new Set(rs.map((x) => x.confirmationId)).size, reused: reused.outcome };
  });

  group("Reaching review");
  await kase("ready.complete-register-reaches-review", "with every grant classified, evidenced, tied and confirmed, the register is ready for review in both periods", async () => {
    await confirm(2026, grantA().grantId, rev[2026]);
    const a26 = (await ctx(U.owner, AI, 2026)).live.assessment;
    await confirm(2025, grantC().grantId, rev[2025]); await confirm(2025, grantD().grantId, rev[2025]);
    const a25 = (await ctx(U.owner, AI, 2025)).live.assessment;
    return a26.state === "ready-for-review" && a26.codes.length === 0 && a25.state === "ready-for-review" && a25.codes.length === 0 ? true : { a26: a26.codes, a25: a25.codes };
  });

  group("SQL equals TypeScript");
  const mutate = (year, base, muts) => muts.map((fn) => { const gs = base().map((g) => structuredClone(g)); const extra = fn(gs); return payload(AI, year, gs, extra ?? {}); });
  async function equivalence(year, base, muts, minKinds) {
    const bad = [], kinds = new Set();
    for (const [i, p] of mutate(year, base, muts).entries()) {
      const r = await save(year, p, { expected: rev[year] });
      if (r.outcome !== "recorded") { bad.push({ i, outcome: r.outcome }); continue; }
      rev[year] = r.revisionId;
      const s = sqlCodes(r.live), t = tsCodes(p, r.live);
      for (const c of s) kinds.add(c.split("|")[0].split(":")[0]);
      if (JSON.stringify(s) !== JSON.stringify(t)) bad.push({ i, sql: s, ts: t });
    }
    const restore = await save(year, payload(AI, year, base()), { expected: rev[year] }); rev[year] = restore.revisionId;
    if (kinds.size < minKinds) bad.push({ coverage: `only ${kinds.size} distinct blocker kinds exercised (need ${minKinds})`, kinds: [...kinds] });
    return bad;
  }
  await kase("calc.sql-equals-typescript-rules-ipsas47", "identical blocker codes from SQL and TypeScript on 24 mutations in the IPSAS 47 period", async () => {
    const set = (k, v) => (gs) => { gs[0][k] = v; };
    const bad = await equivalence(2026, G47, [
      () => {}, set("classification", ""), set("classification", "restriction-only"), set("classification", "foo"), (gs) => { gs[0].complexities.agent = true; }, (gs) => { delete gs[0].complexities.agent; },
      (gs) => { gs[1].complexities.nonCash = null; }, set("recognisedResourcesMinor", "1100000000"), set("cashReceivedMinor", "1200000001"), set("obligations", []),
      (gs) => { gs[0].obligations[2].allocatedMinor = "299999999"; }, (gs) => { gs[0].obligations[1].satisfiedMinor = "400000001"; },
      (gs) => { gs[0].obligations[0].satisfactionBasis = ""; }, (gs) => { gs[0].obligations[0].satisfactionEvidence = ""; }, set("priorCumulativeRevenueMinor", "700000000"), set("cashReceivedMinor", ""),
      (gs) => { gs[1].grantId = gs[0].grantId; }, () => ({ entityAnswers: {} }), () => ({ entityAnswers: { transition_47: { status: "answered", text: "First period under the new standard", evidence: "Board paper", checkedBy: "", flags: { applies: true } } } }),
      set("agreementEvidence", ""), set("classificationBasis", "short"), set("priorEvidence", ""), (gs) => { gs[1].obligations = structuredClone(gs[0].obligations); }, (gs) => { gs[0].obligations[1].id = gs[0].obligations[0].id; },
    ], 20);
    return bad.length === 0 ? true : bad;
  });
  await kase("calc.sql-equals-typescript-rules-ipsas23", "identical blocker codes from SQL and TypeScript on mutations in the IPSAS 23 period, and on empty registers", async () => {
    const bad = await equivalence(2025, G23, [
      () => {}, (gs) => { gs[0].classification = "binding-arrangement"; }, (gs) => { gs[1].classification = "enforceable-condition"; }, () => ({ entityAnswers: {} }),
      () => ({ entityAnswers: { early_application_47: { status: "answered", text: "Elected early application", evidence: "Board minute", checkedBy: "", flags: { applies: true } } } }),
      (gs) => { gs.length = 0; }, (gs) => { gs.length = 0; return { entityAnswers: { early_application_47: entity23().early_application_47, no_grants: { status: "none_with_basis", text: "No donor agreements this period", evidence: "Board minutes", checkedBy: "", flags: { applies: false } } } }; },
      (gs) => { gs.length = 0; return { entityAnswers: { early_application_47: entity23().early_application_47, no_grants: { status: "answered", text: "We do have grants but none entered", evidence: "Board minutes", checkedBy: "", flags: { applies: true } } } }; },
      (gs) => { gs[0].obligations = []; }, (gs) => { gs[1].obligations = [{ id: "X1", label: "X1", allocatedMinor: "1", satisfiedMinor: "0", satisfactionBasis: "", satisfactionEvidence: "" }]; },
    ], 8);
    return bad.length === 0 ? true : bad;
  });

  group("History and preservation");
  await kase("history.append-only", "revisions and confirmations cannot be updated, deleted or truncated", async () => {
    const r = [];
    for (const sql of ["UPDATE public.ipsas_grant_revisions SET period_year = period_year WHERE true", "DELETE FROM public.ipsas_grant_revisions WHERE true", "TRUNCATE public.ipsas_grant_revisions",
      "UPDATE public.ipsas_grant_confirmations SET grant_id = grant_id WHERE true", "DELETE FROM public.ipsas_grant_confirmations WHERE true", "TRUNCATE public.ipsas_grant_confirmations"]) {
      try { await admin.query(sql); r.push(`allowed: ${sql}`); } catch (e) { if (e.code !== "42501" && !(e.code === "0A000" && sql.startsWith("TRUNCATE"))) r.push(`${e.code}: ${sql}`); }
    }
    return r.length === 0 ? true : r;
  });
  await kase("preserve.sme-and-ppe-authority-byte-identical", "real SME authority rows and the PPE preparation tables are byte-identical after every grants operation", async () => {
    const k = await certifier(db, U);
    await prepareReporting(db, W, k, { year: 2026 });
    const rowsOf = async (sql, p = []) => hex(JSON.stringify((await admin.query(sql, p)).rows));
    const snap = async () => hex(JSON.stringify([
      ...(await Promise.all(["fs_schedule_submissions", "fs_disclosure_texts", "financial_evidence_batches", "fs_equipment_workpapers", "financial_statement_reports", "ipsas_prep_revisions", "ipsas_confirmations"].map((t) => rowsOf(`SELECT to_jsonb(t)::text j FROM public.${t} t ORDER BY 1`)))),
      await rowsOf("SELECT to_jsonb(t)::text j FROM public.tb_certifications t WHERE company_id=$1 ORDER BY 1", [SME]), await rowsOf("SELECT to_jsonb(c)::text j FROM public.companies c WHERE id=$1", [SME])]));
    const before = await snap();
    const r = await save(2026, payload(AI, 2026, G47()), { expected: rev[2026] }); rev[2026] = r.revisionId;
    await confirm(2026, grantA().grantId, rev[2026]); await ctx(U.owner); const sme = await ctx(U.owner, SME);
    return before === (await snap()) && sme.outcome === "framework_not_ipsas_accrual" ? true : { sme: sme.outcome };
  });
  await kase("access.revoked-preparer-refused-incl-replay", "a preparer whose membership is withdrawn reads and writes nothing and cannot replay an earlier request", async () => {
    const request = uuid(), p = payload(AI, 2026, G47()), exp = rev[2026];
    const first = await save(2026, p, { expected: exp, request }); rev[2026] = first.revisionId;
    await admin.query("UPDATE public.firm_members SET accepted_at=NULL WHERE company_id=$1 AND user_id=$2", [AI, U.preparer]);
    const before = await count("ipsas_grant_revisions");
    const c = await ctx(), s = await save(2026, p, { expected: rev[2026] }), replay = await save(2026, p, { expected: exp, request });
    return first.outcome === "recorded" && c.outcome === "forbidden" && s.outcome === "forbidden" && replay.outcome === "forbidden" && replay.revisionId === undefined && (await count("ipsas_grant_revisions")) === before ? true : { c: c.outcome, s: s.outcome, replay };
  });
}

let crashed = false, crashMessage = null;
try { await main(); } catch (e) { crashed = true; crashMessage = `${e.code ?? ""}:${String(e?.stack ?? e).slice(0, 2000)}`; console.error(e.stack ?? e); }
writeResult(!crashed, crashed, crashMessage);
const ok = finish("IPSAS_GRANTS", crashed);
await db?.close();
process.exit(ok ? 0 : 1);
