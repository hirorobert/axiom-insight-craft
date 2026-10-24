#!/usr/bin/env bun
// Real-PostgreSQL proof of the FINAL authority of a reporting scope (20261125100000): one current FINAL per company and
// period across every draft lineage, decided under one scope lock; explicit, capability-checked, audited cross-lineage
// replacement bound to the exact replaced version; the official pack issued and sealed only for the current authority,
// with real transaction barriers at the linearisation point; comparative selection by the explicit authority; tenant and
// scope isolation; the append-only history. Every case has a stable id in publicationAuthority.manifest.mjs and the run
// writes a structured result (PROOF_RESULT_FILE, default proof-results/publicationAuthority.present.json).
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/publicationAuthority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyChain, certifier, chainFiles, clientDb, csv, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, FY2026, makeWorld, migrationText, openDatabase, prepareReporting, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./publicationAuthority.manifest.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const FILE = "20261125100000_fs_final_authority.sql";
const MODE = "present";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.${MODE}.json`);
const { group, check, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: `${e.code ?? ""}:${String(e.message).split("\n")[0]}` }));
const stillPending = async (p, ms) => Promise.race([p.then(() => false, () => false), sleep(ms).then(() => true)]);
let db;

const ids = new Set(CASES.map((c) => c.id));
const recorded = [];
const startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./publicationAuthority.manifest.mjs", import.meta.url), "utf8"));
async function kase(id, title, fn) {
  if (!ids.has(id)) throw new Error(`proof defect: case ${id} is not in the manifest`);
  if (recorded.some((r) => r.id === id)) throw new Error(`proof defect: case ${id} recorded twice`);
  let outcome = "fail", detail = "";
  await check(`[${id}] ${title}`, async () => {
    try { const r = await fn(); if (r === true) { outcome = "pass"; return true; } detail = JSON.stringify(r)?.slice(0, 1200) ?? ""; return r; }
    catch (e) { detail = `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}${e.where ? ` | where: ${String(e.where).slice(0, 300)}` : ""}`; throw e; }
  });
  recorded.push({ id, title, outcome, detail });
}
function writeResult(completed, crashed, crashMessage) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ proof: PROOF, mode: MODE, manifestSha256, startedAt, finishedAt: new Date().toISOString(), completed, crashed, crashMessage: crashMessage ?? null,
    cases: recorded.map(({ id, outcome, detail }) => ({ id, outcome, ...(detail ? { detail } : {}) })) }, null, 2) + "\n");
  console.log(`structured result: ${RESULT_FILE}`);
}

async function main() {
  db = await openDatabase("authority_proof");
  group("Replay");
  await kase("setup.chain", `${FILE} is in the chain and the whole chain applies; re-applying is refused by its preflight`, async () => {
    if (!chainFiles().includes(FILE)) return `${FILE} missing`;
    const err = await applyChain(db); if (err) return err;
    try { await db.admin.query(migrationText(FILE)); return "re-applied"; } catch (e) { return e.code === "P0001" && /PREFLIGHT_REFUSED/.test(e.message) ? true : `${e.code}: ${e.message}`; }
  });

  const W = await makeWorld(db);
  const { U, A, B } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner), ownerB = as(U.ownerB);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const parse = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type], fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
    return r.batch;
  };
  const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
  const attempt = (who, rid, newEvidence = []) => prepareReportVersion(who.d, who.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  const readiness = (rid, v) => partner.c.readiness(A, rid, v);
  const scope = () => db.one("SELECT public._fs_scope_authority($1,$2) r", [A, Y]).then((r) => r.r);
  const pointer = () => db.one("SELECT report_id, report_version, authority_seq FROM public.fs_report_authority WHERE company_id=$1 AND period_year=$2", [A, Y]);
  const events = () => db.admin.query("SELECT kind, report_id, report_version, previous_report_id, previous_report_version, actor_user_id, detail FROM public.fs_report_authority_events WHERE company_id=$1 AND period_year=$2 ORDER BY seq", [A, Y]).then((r) => r.rows);
  const finals = (rid) => db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1 AND state='FINAL'", [rid]);
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code ?? ""}:${String(e.message).split("\n")[0]}`; } };
  const replaceSql = "SELECT to_jsonb(public.fs_replace_final_authority($1,$2,$3,$4,$5,$6)) r";
  const replace = (uid, rid, v, prid, pv, reason) => asU(uid, replaceSql, [A, rid, v, prid, pv, reason]).then((r) => r.r);
  /** A FINAL (or a replacement) run as `who` inside a transaction held open: the function executed and its locks are held until commit(). */
  const inFlight = async (uid, sql, params) => {
    const c = await db.pool.connect();
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const r = await c.query(sql, params);
    return { row: r.rows[0].r, commit: async () => { await c.query("COMMIT"); c.release(); }, rollback: async () => { await c.query("ROLLBACK"); c.release(); } };
  };
  const newLineage = async (label) => {
    const rid = `rpt-auth-${label}-${uuid()}`;
    const r = await attempt(pre, rid);
    if (r.outcome !== "saved") throw new Error(`${label}: ${JSON.stringify(r).slice(0, 200)}`);
    const rd = await readiness(rid, r.reportVersion);
    if (!rd.ready) throw new Error(`${label} not ready: ${rd.blockers.join(";")}`);
    const rv = await partner.c.setState(A, rid, r.reportVersion, "REVIEWED", `Reviewed ${label}`);
    if (rv.state !== "REVIEWED") throw new Error(`${label} not reviewed`);
    return { rid, v: r.reportVersion };
  };

  // The official pack through the Edge Function's own module against this database (service role; in-memory bucket).
  const { issueOfficialPack, verifyOfficialPack } = await import(pathToFileURL(path.join(REPO, "supabase/functions/_shared/reportingPackSeal.mjs")).href);
  const bucket = new Map();
  const serviceRpc = async (fn, args) => {
    const keys = Object.keys(args);
    try { const rows = await db.asRole("service_role", null, `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`, keys.map((k) => args[k])); return { data: rows[0].r, error: null }; }
    catch (e) { return { data: null, error: e }; }
  };
  const storeObject = async (p, b) => {
    if (bucket.has(p)) return { error: { message: "exists" } };
    await db.admin.query("INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('reporting-packs', $1, $2::jsonb)", [p, JSON.stringify({ size: b.byteLength, mimetype: "application/json" })]);
    bucket.set(p, b); return { error: null };
  };
  const deps = { rpc: serviceRpc, put: storeObject, get: async (p) => bucket.get(p) ?? null, sha256Hex: async (b) => hex(b) };
  const issueRpc = async (uid, rid, v, req = uuid()) => (await asU(uid, "SELECT public.issue_official_reporting_pack($1,$2,$3,$4) r", [A, Y, `fs-report:${rid}:v${v}`, req])).r;
  const sealed = (id) => db.count("SELECT count(*) n FROM public.reporting_pack_issuances WHERE id=$1 AND consumed_at IS NOT NULL", [id]);

  group("Setup through the real functions");
  await kase("setup.world", "two certified years, presentation, Close Review, notes (pack 1.2.0), schedule, comparatives approved; the evidence saved once through the browser's builder", async () => {
    await prepareReporting(db, W, k, { year: Y });
    const seed = `rpt-auth-seed-${uuid()}`;
    const r = await attempt(pre, seed, allEvidence());
    return r.outcome === "saved" ? true : r;
  });

  // ── A1/A2: two lineages, two concurrent first FINALs ───────────────────────────────────────────────────────────────
  group("A. Two lineages of one reporting scope; the first FINALs race");
  let L1, L2;
  await kase("a1.two-lineages-reviewed", "two draft lineages of FY2026 are saved through the browser's builder, both ready, both REVIEWED by the partner (drafts and reviews need no authority)", async () => {
    L1 = await newLineage("l1"); L2 = await newLineage("l2");
    const s = await scope();
    return L1.rid !== L2.rid && s.state === "none" ? true : { L1, L2, s };
  });
  await kase("a2.concurrent-first-finals", "the owner's FINAL of L1 is held open (scope lock held); the owner's FINAL of L2 WAITS on the scope lock; after the first commits, the second is refused AUTHORITY_CONFLICT by name; exactly one FINAL stands, the authority is L1, one ESTABLISHED event", async () => {
    const t1 = await inFlight(U.owner, "SELECT to_jsonb(public.fs_set_publication_state($1,$2,$3,'FINAL','Approved for issue (lineage 1)')) r", [L1.rid, L1.v, A]);
    const t2 = settle(asU(U.owner, "SELECT to_jsonb(public.fs_set_publication_state($1,$2,$3,'FINAL','Approved for issue (lineage 2)')) r", [L2.rid, L2.v, A]));
    const waits = await stillPending(t2, 1200);
    await t1.commit();
    const r2 = await t2;
    const p = await pointer(); const ev = await events();
    return waits && t1.row.state === "FINAL" && !r2.ok && /PT409:.*AUTHORITY_CONFLICT/.test(r2.e) && (await finals(L1.rid)) === 1 && (await finals(L2.rid)) === 0
      && p?.report_id === L1.rid && p.report_version === L1.v && p.authority_seq === 1 && ev.map((e) => e.kind).join(",") === "ESTABLISHED" ? true : { waits, t1: t1.row?.state, r2, p, ev: ev.map((e) => e.kind) };
  });
  await kase("a3.competing-final-refused", "a plain FINAL of the competing lineage is refused by name (AUTHORITY_CONFLICT names the current authority); nothing is recorded; readiness says other_lineage", async () => {
    const before = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE company_id=$1", [A]);
    const ref = await refusal(() => owner.c.setState(A, L2.rid, L2.v, "FINAL", "Approved for issue (competing)"));
    const after = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE company_id=$1", [A]);
    const rd = await readiness(L2.rid, L2.v);
    return /PT409:AUTHORITY_CONFLICT:/.test(ref ?? "") && ref.includes(L1.rid) && after === before && rd.ready === true && rd.authority?.relation === "other_lineage" && rd.authority.scope.holder.reportId === L1.rid ? true : { ref, before, after, auth: rd.authority };
  });
  await kase("a4.replacement-authorization", "the preparer (no approve_certification) is refused 42501; the partner who REVIEWED L2 is refused SIGNOFF_SEPARATE_APPROVERS_REQUIRED (separation of duties holds on a replacement); another workspace's owner is refused; nothing is recorded", async () => {
    const before = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE company_id=$1", [A]);
    const a = await refusal(() => replace(U.preparer, L2.rid, L2.v, L1.rid, L1.v, "Preparer attempting a replacement"));
    const b = await refusal(() => replace(U.partner, L2.rid, L2.v, L1.rid, L1.v, "Reviewer approving own review as a replacement"));
    const c = await refusal(() => replace(U.ownerB, L2.rid, L2.v, L1.rid, L1.v, "Outsider attempting a replacement"));
    const after = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE company_id=$1", [A]);
    return /^42501:/.test(a ?? "") && /^42501:.*SIGNOFF_SEPARATE_APPROVERS_REQUIRED/.test(b ?? "") && /^(42501|PT403):/.test(c ?? "") && after === before && (await pointer()).report_id === L1.rid ? true : { a, b, c, before, after };
  });
  await kase("a5.replacement-must-name-current", "a replacement naming a version that is not the current authority is refused AUTHORITY_MISMATCH; one naming the same lineage is refused AUTHORITY_REPLACE_SAME_LINEAGE; nothing is recorded", async () => {
    const before = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE company_id=$1", [A]);
    const a = await refusal(() => replace(U.owner, L2.rid, L2.v, L1.rid, L1.v + 7, "Wrong target version"));
    const b = await refusal(() => replace(U.owner, L2.rid, L2.v, `rpt-does-not-exist-${uuid()}`, 1, "Wrong target lineage"));
    const c = await refusal(() => replace(U.owner, L2.rid, L2.v, L2.rid, L2.v - 1, "Same lineage"));
    const after = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE company_id=$1", [A]);
    return /PT409:AUTHORITY_MISMATCH/.test(a ?? "") && /PT409:AUTHORITY_MISMATCH/.test(b ?? "") && /22023:AUTHORITY_REPLACE_SAME_LINEAGE/.test(c ?? "") && after === before ? true : { a, b, c };
  });

  // ── A6–A10: the explicit replacement and what it leaves behind ────────────────────────────────────────────────────
  group("B. The explicit cross-lineage replacement");
  let l1Pack, l1Pending, l1Rows, l1Bindings;
  await kase("a6.first-authority-issued", "L1's official pack is issued and sealed (intact, official, not superseded); a second L1 issuance is opened and left unsealed", async () => {
    const i = await issueRpc(U.owner, L1.rid, L1.v); l1Pack = i.issuance_id;
    const s = await issueOfficialPack(deps, { userId: U.owner, issuanceId: l1Pack });
    const v = await verifyOfficialPack(deps, U.owner, l1Pack);
    const p = await issueRpc(U.owner, L1.rid, L1.v); l1Pending = p.issuance_id;
    l1Rows = JSON.stringify((await db.admin.query("SELECT id, state, created_at FROM public.financial_statement_publications WHERE report_id=$1 ORDER BY seq", [L1.rid])).rows);
    l1Bindings = JSON.stringify((await db.admin.query("SELECT publication_id, state, document_sha256, dependencies_sha256 FROM public.fs_publication_bindings WHERE report_id=$1 ORDER BY seq", [L1.rid])).rows);
    return i.outcome === "issued" && s.body.outcome === "sealed" && v.outcome === "intact" && v.official === true && v.superseded === false && p.outcome === "issued" ? true : { i: i.outcome, s: s.body.outcome, v, p: p.outcome };
  });
  await kase("a7.explicit-replacement", "the owner finalises L2 as the explicit replacement of L1 v: FINAL recorded on L2, the authority moves to L2 (seq 2), a REPLACED event names both versions and the actor; L1's FINAL row, bindings and sealed bytes are untouched", async () => {
    const r = await replace(U.owner, L2.rid, L2.v, L1.rid, L1.v, "Replaces lineage 1: the board adopted the second set");
    const p = await pointer(); const ev = await events();
    const last = ev[ev.length - 1];
    const rows = JSON.stringify((await db.admin.query("SELECT id, state, created_at FROM public.financial_statement_publications WHERE report_id=$1 ORDER BY seq", [L1.rid])).rows);
    const bind = JSON.stringify((await db.admin.query("SELECT publication_id, state, document_sha256, dependencies_sha256 FROM public.fs_publication_bindings WHERE report_id=$1 ORDER BY seq", [L1.rid])).rows);
    const pack = await verifyOfficialPack(deps, U.owner, l1Pack);
    return r.state === "FINAL" && p.report_id === L2.rid && p.report_version === L2.v && p.authority_seq === 2 && last.kind === "REPLACED" && last.report_id === L2.rid && last.previous_report_id === L1.rid && last.previous_report_version === L1.v && last.actor_user_id === U.owner
      && rows === l1Rows && bind === l1Bindings && pack.outcome === "intact" && pack.official === true && pack.superseded === true && (await finals(L1.rid)) === 1 && (await finals(L2.rid)) === 1 ? true : { r: r.state, p, last, rowsSame: rows === l1Rows, bindSame: bind === l1Bindings, pack };
  });
  await kase("a8.replacement-retry-is-replay", "the same replacement call again (a lost response, a retry) returns the existing FINAL and records nothing new (no publication, no authority event)", async () => {
    const ev0 = (await events()).length; const pub0 = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1", [L2.rid]);
    const r = await replace(U.owner, L2.rid, L2.v, L1.rid, L1.v, "Retry of the replacement");
    const plain = await owner.c.setState(A, L2.rid, L2.v, "FINAL", "Retry as a plain FINAL");
    return r.state === "FINAL" && plain.state === "FINAL" && (await events()).length === ev0 && (await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1", [L2.rid])) === pub0 && (await pointer()).authority_seq === 2 ? true : { r: r.state, plain: plain.state };
  });
  await kase("a9.replaced-lineage-superseded", "L1 is superseded everywhere: a new official issuance is refused (superseded_final_version, naming the authority), its pending issuance cannot be sealed, its sealed pack verifies intact/official with superseded disclosed and the authority named, the versions list and readiness say other_lineage", async () => {
    const i = await issueRpc(U.owner, L1.rid, L1.v);
    const s = await issueOfficialPack(deps, { userId: U.owner, issuanceId: l1Pending });
    const v = await verifyOfficialPack(deps, U.owner, l1Pack);
    const vs = await owner.c.versions(A, Y);
    const old = vs.find((x) => x.reportId === L1.rid && x.reportVersion === L1.v), neu = vs.find((x) => x.reportId === L2.rid && x.reportVersion === L2.v);
    const rd = await readiness(L1.rid, L1.v);
    return i.outcome === "superseded_final_version" && i.authority?.reportId === L2.rid && s.body.outcome === "superseded_final_version" && (await sealed(l1Pending)) === 0
      && v.outcome === "intact" && v.official === true && v.superseded === true && old?.authority?.relation === "other_lineage" && old.authority.superseded === true && old.supersededByFinal === L2.v
      && neu?.authority?.relation === "is_authority" && rd.authority?.relation === "other_lineage" ? true : { i, s: s.body.outcome, v, old: old?.authority, neu: neu?.authority, rd: rd.authority };
  });
  await kase("a10.new-authority-issues", "the new authority (L2) issues officially: sealed; verify intact, official, not superseded", async () => {
    const i = await issueRpc(U.owner, L2.rid, L2.v);
    const s = await issueOfficialPack(deps, { userId: U.owner, issuanceId: i.issuance_id });
    const v = await verifyOfficialPack(deps, U.owner, i.issuance_id);
    return i.outcome === "issued" && s.body.outcome === "sealed" && v.outcome === "intact" && v.official === true && v.superseded === false ? true : { i: i.outcome, s: s.body.outcome, v };
  });

  // ── A11/A12: sealing against replacement, both interleavings, with real transaction barriers ───────────────────────
  group("C. The linearisation point: sealing and FINAL replacement share the scope lock");
  let L3, L4;
  await kase("a11.seal-waits-for-replacement", "a replacement (L3 replaces L2) is held open; an issue→prepare→seal of L2 meanwhile: prepare answers before the lock, the SEAL waits on the scope lock, and after the replacement commits it is refused superseded_final_version; nothing sealed; the authority is L3", async () => {
    L3 = await newLineage("l3");
    const p = await issueRpc(U.owner, L2.rid, L2.v);
    const t1 = await inFlight(U.owner, replaceSql, [A, L3.rid, L3.v, L2.rid, L2.v, "Replaces lineage 2 while a seal is attempted"]);
    const seal = issueOfficialPack(deps, { userId: U.owner, issuanceId: p.issuance_id });
    const waits = await stillPending(seal, 1500);
    await t1.commit();
    const s = await seal;
    return waits && t1.row.state === "FINAL" && s.body.outcome === "superseded_final_version" && (await sealed(p.issuance_id)) === 0 && (await pointer()).report_id === L3.rid ? true : { waits, t1: t1.row?.state, s: s.body, p: await pointer() };
  });
  await kase("a12.replacement-waits-for-seal", "a seal of L3's pack is held open (issuance row lock, then the scope lock); a replacement (L4 replaces L3) meanwhile WAITS; after the seal commits the replacement proceeds: the sealed historical artifact is intact and then disclosed as superseded; the authority is L4", async () => {
    L4 = await newLineage("l4");
    const q = await issueRpc(U.owner, L3.rid, L3.v);
    // prepare + store the bytes, then seal INSIDE a held service-role transaction.
    const prep = await serviceRpc("prepare_official_reporting_pack", { p_user: U.owner, p_issuance_id: q.issuance_id });
    const bytes = new TextEncoder().encode(prep.data.document);
    await storeObject(prep.data.storage_path, bytes);
    const c = await db.pool.connect();
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
    await c.query("SELECT set_config('request.jwt.claim.role','service_role',true), set_config('request.jwt.claim.sub','',true)");
    const sealRow = (await c.query("SELECT public.seal_reporting_pack_server($1,$2,$3) r", [U.owner, q.issuance_id, prep.data.storage_path])).rows[0].r;
    const rep = settle(replace(U.owner, L4.rid, L4.v, L3.rid, L3.v, "Replaces lineage 3 while its pack is being sealed"));
    const waits = await stillPending(rep, 1500);
    await c.query("COMMIT"); c.release();
    const r = await rep;
    const v = await verifyOfficialPack(deps, U.owner, q.issuance_id);
    return prep.data.outcome === "ready" && sealRow.outcome === "sealed" && waits && r.ok && r.v.state === "FINAL" && (await sealed(q.issuance_id)) === 1 && v.outcome === "intact" && v.official === true && v.superseded === true && (await pointer()).report_id === L4.rid
      ? true : { prep: prep.data?.outcome, sealRow, waits, r, v, p: await pointer() };
  });
  await kase("a13.expiry-and-revocation", "an expired issuance of the authority is refused at seal (expired); an issuance by the partner is refused once the owner revokes the partner's issue capability (capability_required) and seals once it is restored", async () => {
    const e = await issueRpc(U.owner, L4.rid, L4.v);
    await db.admin.query("BEGIN"); await db.admin.query("SET LOCAL session_replication_role = replica");
    await db.admin.query("UPDATE public.reporting_pack_issuances SET expires_at = now() - interval '1 minute' WHERE id=$1", [e.issuance_id]);
    await db.admin.query("COMMIT");
    const expired = await issueOfficialPack(deps, { userId: U.owner, issuanceId: e.issuance_id });
    const s = await issueRpc(U.partner, L4.rid, L4.v);
    const rv = (await asU(U.owner, "SELECT public.revoke_member_capability($1,$2,'issue_reporting_pack','Separation for the proof') r", [A, U.partner])).r;
    const refused = await issueOfficialPack(deps, { userId: U.partner, issuanceId: s.issuance_id });
    const gr = (await asU(U.owner, "SELECT public.grant_member_capability($1,$2,'issue_reporting_pack','Restored after the proof step') r", [A, U.partner])).r;
    const ok = await issueOfficialPack(deps, { userId: U.partner, issuanceId: s.issuance_id });
    return expired.body.outcome === "expired" && (await sealed(e.issuance_id)) === 0 && s.outcome === "issued" && rv && refused.body.outcome === "capability_required" && gr && ok.body.outcome === "sealed" ? true : { expired: expired.body.outcome, s: s.outcome, rv, refused: refused.body.outcome, gr, ok: ok.body.outcome };
  });

  // ── A14–A16 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  group("D. Comparative selection, isolation, history");
  await kase("a14.comparative-uses-authority", "FY2027 certified: its prior-FINAL reconciliation names the explicit authority (L4), not the first or the latest FINAL by order", async () => {
    const c = await k.upload(A, Y + 1, csv(FY2026)); await k.certify(A, c);
    const pf = (await asU(U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [A, Y + 1])).r;
    return ["reconciled", "differences"].includes(pf.state) && pf.priorFinal?.reportId === L4.rid && pf.priorFinal.reportVersion === L4.v ? true : pf;
  });
  await kase("a15.tenant-and-scope-isolation", "another workspace's owner reads no authority row of this company (RLS) and is refused replacement and designation; the authority of (company, FY2025) and of the other company stay none", async () => {
    const rows = await ownerB.d.select("fs_report_authority", { company_id: A });
    const rep = await refusal(() => replace(U.ownerB, L1.rid, L1.v, L4.rid, L4.v, "Outsider replacing"));
    const des = await refusal(() => asU(U.ownerB, "SELECT public.fs_designate_final_authority($1,$2,$3,$4,'Outsider designating') r", [A, Y, L1.rid, L1.v]));
    const prior = (await db.one("SELECT public._fs_scope_authority($1,$2) r", [A, Y - 1])).r;
    const other = (await db.one("SELECT public._fs_scope_authority($1,$2) r", [B, Y])).r;
    return (rows.data ?? []).length === 0 && /^(42501|PT403):/.test(rep ?? "") && /^(42501|PT403):/.test(des ?? "") && prior.state === "none" && other.state === "none" ? true : { rows: rows.data?.length, rep, des, prior, other };
  });
  await kase("a16.authority-history", "the scope's history is ESTABLISHED, REPLACED, REPLACED, REPLACED (seq 4), every event with its actor and the previous identity; every replacement is audited with the replaced version", async () => {
    const ev = await events();
    const p = await pointer();
    const audits = (await db.admin.query("SELECT detail FROM public.financial_statement_audit_events WHERE company_id=$1 AND action='PUBLICATION_STATE_SET' AND detail ? 'replacesFinal' ORDER BY seq", [A])).rows;
    return ev.map((e) => e.kind).join(",") === "ESTABLISHED,REPLACED,REPLACED,REPLACED" && p.authority_seq === 4 && p.report_id === L4.rid && ev.every((e) => e.actor_user_id === U.owner)
      && ev.slice(1).every((e) => e.previous_report_id && e.previous_report_version) && audits.length === 3 && audits.every((a) => a.detail.replacesFinal?.reportId) ? true : { kinds: ev.map((e) => e.kind), p, audits: audits.length };
  });

  const missing = CASES.map((c) => c.id).filter((id) => !recorded.some((r) => r.id === id));
  if (missing.length) throw new Error(`proof defect: cases never reached: ${missing.join(", ")}`);
}

main().then(async () => { writeResult(true, false); const ok = finish("publication authority", false); await db?.close(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error("CRASH:", e); writeResult(false, true, String(e?.message ?? e)); finish("publication authority", true); await db?.close(); process.exit(1); });
