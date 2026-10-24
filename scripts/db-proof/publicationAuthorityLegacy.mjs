#!/usr/bin/env bun
// Real-PostgreSQL proof of 20261125100000 over EXISTING data: a database that, before the migration, already holds FINAL
// versions in TWO lineages of one company and period (possible until then), and another company whose period has FINALs in
// ONE lineage. The migration records the conflict (CONFLICT_DETECTED, no pointer: nothing is chosen by order or timestamp)
// and the single lineage's pointer; while unresolved, every FINAL, official issuance and the next year's comparative
// selection refuse by name; only a holder of approve_certification designates one existing FINAL, once, audited; afterwards
// the other lineage is superseded everywhere and the ordinary rules apply. Every case has a stable id in
// publicationAuthorityLegacy.manifest.mjs; the run writes a structured result (PROOF_RESULT_FILE).
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/publicationAuthorityLegacy.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyChainBefore, certifier, chainFiles, clientDb, csv, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, FY2026, makeWorld, migrationText, openDatabase, prepareReporting, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./publicationAuthorityLegacy.manifest.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const AUTHORITY = "20261125100000_fs_final_authority.sql";
const STRUCTURE = "20261126100000_fs_document_structure.sql";
const MODE = "present";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.${MODE}.json`);
const { group, check, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
let db;

const ids = new Set(CASES.map((c) => c.id));
const recorded = [];
const startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./publicationAuthorityLegacy.manifest.mjs", import.meta.url), "utf8"));
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
  db = await openDatabase("authority_legacy_proof");
  group("Replay: the chain BEFORE the FINAL authority (20261123100000 and 20261124100000 included)");
  await kase("setup.chain-before-authority", `${AUTHORITY} and ${STRUCTURE} are in the chain; the chain before ${AUTHORITY} applies`, async () => {
    if (!chainFiles().includes(AUTHORITY) || !chainFiles().includes(STRUCTURE)) return "missing from the chain";
    return (await applyChainBefore(db, AUTHORITY)) ?? true;
  });

  const Y = 2026;
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code ?? ""}:${String(e.message).split("\n")[0]}`; } };
  /** A world: company, users, certifier, and the browser's builder bound to it. */
  const world = async (label) => {
    const W = await makeWorld(db); await W.rollout(W.A, true);
    const k = await certifier(db, W.U);
    await prepareReporting(db, W, k, { year: Y });
    const { U, A } = W;
    const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
    const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
    const parse = (type, role = "CURRENT") => {
      const y = role === "CURRENT" ? Y : Y - 1;
      const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type], fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
      if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
      return r.batch;
    };
    const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
    const attempt = (who, rid, newEvidence = []) => prepareReportVersion(who.d, who.c, { companyId: A, periodYear: Y, legalName: "ignored", reportId: rid, newEvidence, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
    const seed = await attempt(pre, `rpt-legacy-seed-${label}-${uuid()}`, allEvidence());
    if (seed.outcome !== "saved") throw new Error(`${label} seed: ${JSON.stringify(seed).slice(0, 300)}`);
    const reviewed = async (lbl) => {
      const rid = `rpt-legacy-${label}-${lbl}-${uuid()}`;
      const r = await attempt(pre, rid);
      if (r.outcome !== "saved") throw new Error(`${lbl}: ${JSON.stringify(r).slice(0, 200)}`);
      const rd = await partner.c.readiness(A, rid, r.reportVersion);
      if (!rd.ready) throw new Error(`${lbl} not ready: ${rd.blockers.join(";")}`);
      const rv = await partner.c.setState(A, rid, r.reportVersion, "REVIEWED", `Reviewed ${lbl}`);
      if (rv.state !== "REVIEWED") throw new Error(`${lbl} not reviewed`);
      return { rid, v: r.reportVersion };
    };
    const scope = (year = Y) => db.one("SELECT public._fs_scope_authority($1,$2) r", [A, year]).then((r) => r.r);
    const pointer = () => db.one("SELECT report_id, report_version, authority_seq FROM public.fs_report_authority WHERE company_id=$1 AND period_year=$2", [A, Y]);
    const events = () => db.admin.query("SELECT kind, report_id, report_version, actor_user_id, detail, reason FROM public.fs_report_authority_events WHERE company_id=$1 AND period_year=$2 ORDER BY seq", [A, Y]).then((r) => r.rows);
    const finals = (rid) => db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1 AND state='FINAL'", [rid]);
    const issueRpc = async (uid, rid, v) => (await asU(uid, "SELECT public.issue_official_reporting_pack($1,$2,$3,$4) r", [A, Y, `fs-report:${rid}:v${v}`, uuid()])).r;
    const designate = (uid, rid, v, reason) => asU(uid, "SELECT public.fs_designate_final_authority($1,$2,$3,$4,$5) r", [A, Y, rid, v, reason]).then((r) => r.r);
    const replace = (uid, rid, v, prid, pv, reason) => asU(uid, "SELECT to_jsonb(public.fs_replace_final_authority($1,$2,$3,$4,$5,$6)) r", [A, rid, v, prid, pv, reason]).then((r) => r.r);
    return { W, U, A, k, pre, partner, owner, attempt, reviewed, scope, pointer, events, finals, issueRpc, designate, replace };
  };

  // The official pack through the Edge Function's own module (service role; in-memory bucket).
  const { issueOfficialPack, verifyOfficialPack } = await import(pathToFileURL(path.join(REPO, "supabase/functions/_shared/reportingPackSeal.mjs")).href);
  const bucket = new Map();
  const deps = {
    rpc: async (fn, args) => {
      const keys = Object.keys(args);
      try { const rows = await db.asRole("service_role", null, `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`, keys.map((k) => args[k])); return { data: rows[0].r, error: null }; }
      catch (e) { return { data: null, error: e }; }
    },
    put: async (p, b) => {
      if (bucket.has(p)) return { error: { message: "exists" } };
      await db.admin.query("INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('reporting-packs', $1, $2::jsonb)", [p, JSON.stringify({ size: b.byteLength, mimetype: "application/json" })]);
      bucket.set(p, b); return { error: null };
    },
    get: async (p) => bucket.get(p) ?? null, sha256Hex: async (b) => hex(b),
  };

  group("Setup: two worlds through the real functions");
  let X, S;
  await kase("setup.world", "company X (the conflict) and company S (one lineage): two certified years, presentation, Close Review, notes, schedule, comparatives approved; the evidence saved once through the browser's builder", async () => {
    X = await world("x"); S = await world("s");
    return X.A !== S.A ? true : "same company";
  });

  group("L. Legacy data: what the database holds BEFORE 20261125100000");
  let L1, L2, L1Pack, S1, s1v2;
  await kase("l1.legacy-two-finals", "company X: two lineages of FY2026 both reach FINAL (the old rule allowed it); L1's official pack is issued and sealed", async () => {
    L1 = await X.reviewed("l1"); L2 = await X.reviewed("l2");
    const f1 = await X.owner.c.setState(X.A, L1.rid, L1.v, "FINAL", "Approved for issue (lineage 1, legacy)");
    const f2 = await X.owner.c.setState(X.A, L2.rid, L2.v, "FINAL", "Approved for issue (lineage 2, legacy)");
    const i = await X.issueRpc(X.U.owner, L1.rid, L1.v); L1Pack = i.issuance_id;
    const s = await issueOfficialPack(deps, { userId: X.U.owner, issuanceId: L1Pack });
    return f1.state === "FINAL" && f2.state === "FINAL" && i.outcome === "issued" && s.body.outcome === "sealed" ? true : { f1: f1.state, f2: f2.state, i: i.outcome, s: s.body.outcome };
  });
  await kase("l2.legacy-single-lineage", "company S: one lineage with two FINAL versions (v1, then a correction v2 FINAL)", async () => {
    S1 = await S.reviewed("s1");
    const f1 = await S.owner.c.setState(S.A, S1.rid, S1.v, "FINAL", "Approved for issue (S, v1)");
    const w = (await asU(S.U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.judgements','No significant judgements beyond the estimates disclosed.','Notes v2',$3) r", [S.A, Y, uuid()])).r;
    const r = await S.attempt(S.pre, S1.rid);
    s1v2 = r.reportVersion;
    const rv = await S.partner.c.setState(S.A, S1.rid, s1v2, "REVIEWED", "Reviewed the correction");
    const f2 = await S.owner.c.setState(S.A, S1.rid, s1v2, "FINAL", "Approved for issue (S, v2)");
    return f1.state === "FINAL" && w.outcome === "recorded" && r.outcome === "saved" && s1v2 === S1.v + 1 && rv.state === "REVIEWED" && f2.state === "FINAL" ? true : { f1: f1.state, w, r: r.outcome, s1v2, rv: rv.state, f2: f2.state };
  });

  group("M. The migration over that data");
  await kase("l3.migration-detects-conflict", `${AUTHORITY} applies (then ${STRUCTURE}); company X FY2026: no pointer, one CONFLICT_DETECTED event naming both lineages, scope unresolved; company S FY2026: pointer = the single lineage's LATEST FINAL version (v2), one ESTABLISHED backfill event; nothing else is written`, async () => {
    const before = await db.count("SELECT count(*) n FROM public.financial_statement_publications");
    await db.admin.query(migrationText(AUTHORITY));
    await db.admin.query(migrationText(STRUCTURE));
    const after = await db.count("SELECT count(*) n FROM public.financial_statement_publications");
    const xs = await X.scope(); const xp = await X.pointer(); const xe = await X.events();
    const ss = await S.scope(); const sp = await S.pointer(); const se = await S.events();
    const cands = (xe[0]?.detail?.candidates ?? []).slice().sort();
    return before === after && xs.state === "unresolved" && !xp && xe.length === 1 && xe[0].kind === "CONFLICT_DETECTED" && xe[0].detail.backfill === true && JSON.stringify(cands) === JSON.stringify([L1.rid, L2.rid].sort())
      && ss.state === "held" && ss.source === "recorded" && sp?.report_id === S1.rid && sp.report_version === s1v2 && sp.authority_seq === 1 && se.length === 1 && se[0].kind === "ESTABLISHED" && se[0].detail.backfill === true
      ? true : { before, after, xs, xp, xe, ss, sp, se };
  });

  group("U. While unresolved: every authority-bearing step refuses by name; nothing is chosen for the user");
  let L3;
  await kase("l4.unresolved-refuses-final", "a third lineage L3 is REVIEWED; its FINAL is refused AUTHORITY_CONFLICT_UNRESOLVED; a replacement naming L1 is refused the same way; readiness says unresolved; nothing recorded", async () => {
    L3 = await X.reviewed("l3");
    const a = await refusal(() => X.owner.c.setState(X.A, L3.rid, L3.v, "FINAL", "Approved for issue (while unresolved)"));
    const b = await refusal(() => X.replace(X.U.owner, L3.rid, L3.v, L1.rid, L1.v, "Replacement while unresolved"));
    const rd = await X.partner.c.readiness(L3.rid ? X.A : X.A, L3.rid, L3.v);
    return /PT409:AUTHORITY_CONFLICT_UNRESOLVED/.test(a ?? "") && /PT409:AUTHORITY_CONFLICT_UNRESOLVED/.test(b ?? "") && (await X.finals(L3.rid)) === 0 && rd.ready === true && rd.authority?.relation === "unresolved" && !(await X.pointer()) ? true : { a, b, rd: rd.authority };
  });
  await kase("l5.unresolved-refuses-issuance", "no official issuance of L1 or L2 (authority_unresolved, audited); L1's existing sealed pack stays intact and official (history untouched); the versions list says unresolved for both", async () => {
    const i1 = await X.issueRpc(X.U.owner, L1.rid, L1.v); const i2 = await X.issueRpc(X.U.owner, L2.rid, L2.v);
    const v = await verifyOfficialPack(deps, X.U.owner, L1Pack);
    const vs = await X.owner.c.versions(X.A, Y);
    const a1 = vs.find((x) => x.reportId === L1.rid && x.reportVersion === L1.v)?.authority, a2 = vs.find((x) => x.reportId === L2.rid && x.reportVersion === L2.v)?.authority;
    const audited = await db.count("SELECT count(*) n FROM public.reporting_pack_issuance_events WHERE company_id=$1 AND event='REFUSED' AND detail ->> 'code' = 'AUTHORITY_UNRESOLVED'", [X.A]).catch(() => -1);
    return i1.outcome === "authority_unresolved" && i2.outcome === "authority_unresolved" && v.outcome === "intact" && v.official === true && a1?.relation === "unresolved" && a2?.relation === "unresolved" && audited !== 0 ? true : { i1, i2, v, a1, a2, audited };
  });
  await kase("l6.unresolved-blocks-next-year", "FY2027 certified: its prior-FINAL reconciliation is prior_authority_unresolved with blocker PRIOR_FINAL_AUTHORITY_UNRESOLVED:2026 naming both candidates (no FINAL is picked by order)", async () => {
    const c = await X.k.upload(X.A, Y + 1, csv(FY2026)); await X.k.certify(X.A, c);
    const pf = (await asU(X.U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [X.A, Y + 1])).r;
    return pf.state === "prior_authority_unresolved" && JSON.stringify(pf.blockers) === JSON.stringify([`PRIOR_FINAL_AUTHORITY_UNRESOLVED:${Y}`]) && (pf.candidates ?? []).length === 2 ? true : pf;
  });

  group("D. Designation: one existing FINAL becomes the authority, by an authorised person, once");
  await kase("l7.designation-authorization", "the preparer is refused 42501; another company's owner is refused; a version that is not FINAL answers not_final; company S (held) answers not_unresolved; nothing recorded", async () => {
    const a = await refusal(() => X.designate(X.U.preparer, L2.rid, L2.v, "Preparer designating"));
    const b = await refusal(() => X.designate(S.U.owner, L2.rid, L2.v, "Outsider designating"));
    const c = await X.designate(X.U.owner, L3.rid, L3.v, "Designating a version that is not FINAL");
    const d = await S.designate(S.U.owner, S1.rid, S1.v, "Designating where the authority is held");
    return /^(42501|PT403):/.test(a ?? "") && /^(42501|PT403):/.test(b ?? "") && c.outcome === "not_final" && d.outcome === "not_unresolved" && !(await X.pointer()) && (await X.events()).length === 1 ? true : { a, b, c, d };
  });
  await kase("l8.designation", "the owner designates L2: pointer L2 (seq 1), a DESIGNATED event with the candidates, actor and reason, an audit event authorityDesignated; a second designation answers already_designated and writes nothing", async () => {
    const r = await X.designate(X.U.owner, L2.rid, L2.v, "The board adopted the second set of statements");
    const p = await X.pointer(); const ev = await X.events();
    const audit = await db.count("SELECT count(*) n FROM public.financial_statement_audit_events WHERE company_id=$1 AND action='PUBLICATION_STATE_SET' AND (detail ->> 'authorityDesignated') = 'true'", [X.A]);
    const again = await X.designate(X.U.owner, L2.rid, L2.v, "The board adopted the second set of statements");
    return r.outcome === "designated" && p?.report_id === L2.rid && p.report_version === L2.v && p.authority_seq === 1 && ev.length === 2 && ev[1].kind === "DESIGNATED" && ev[1].actor_user_id === X.U.owner && (ev[1].detail.candidates ?? []).length === 2 && ev[1].reason.length > 8 && audit === 1
      && again.outcome === "already_designated" && (await X.events()).length === 2 ? true : { r, p, ev, audit, again };
  });
  await kase("l9.after-designation", "L1 is superseded (issuance refused superseded_final_version; its pack intact, official, superseded); L2 issues officially; L3's plain FINAL is refused AUTHORITY_CONFLICT and its explicit replacement of L2 succeeds (REPLACED); FY2027's prior FINAL is then L3", async () => {
    const i1 = await X.issueRpc(X.U.owner, L1.rid, L1.v);
    const v1 = await verifyOfficialPack(deps, X.U.owner, L1Pack);
    const i2 = await X.issueRpc(X.U.owner, L2.rid, L2.v);
    const s2 = await issueOfficialPack(deps, { userId: X.U.owner, issuanceId: i2.issuance_id });
    const plain = await refusal(() => X.owner.c.setState(X.A, L3.rid, L3.v, "FINAL", "Approved for issue (plain, after designation)"));
    const rep = await X.replace(X.U.owner, L3.rid, L3.v, L2.rid, L2.v, "Replaces lineage 2 after the designation");
    const p = await X.pointer(); const ev = await X.events();
    const pf = (await asU(X.U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [X.A, Y + 1])).r;
    return i1.outcome === "superseded_final_version" && v1.outcome === "intact" && v1.official === true && v1.superseded === true && i2.outcome === "issued" && s2.body.outcome === "sealed"
      && /PT409:AUTHORITY_CONFLICT:/.test(plain ?? "") && rep.state === "FINAL" && p.report_id === L3.rid && p.authority_seq === 2 && ev.map((e) => e.kind).join(",") === "CONFLICT_DETECTED,DESIGNATED,REPLACED"
      && ["reconciled", "differences"].includes(pf.state) && pf.priorFinal?.reportId === L3.rid ? true : { i1: i1.outcome, v1, i2: i2.outcome, s2: s2.body.outcome, plain, rep: rep.state, p, kinds: ev.map((e) => e.kind), pf: pf.state };
  });
  await kase("l10.single-lineage-unchanged", "company S: a further version of its one lineage goes FINAL as succession (SUCCEEDED, seq 2); v1 and v2 are superseded by the current authority v3 (supersededByFinal names the authority); its official pack issues; no designation is possible", async () => {
    const w = (await asU(S.U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.estimates','Useful lives, reviewed annually.','Notes v3',$3) r", [S.A, Y, uuid()])).r;
    const r = await S.attempt(S.pre, S1.rid);
    const rv = await S.partner.c.setState(S.A, S1.rid, r.reportVersion, "REVIEWED", "Reviewed v3");
    const f = await S.owner.c.setState(S.A, S1.rid, r.reportVersion, "FINAL", "Approved for issue (S, v3)");
    const p = await S.pointer(); const ev = await S.events();
    const vs = await S.owner.c.versions(S.A, Y);
    // The period's versions list also holds the seed lineage; match the lineage, not the version number alone.
    const v1 = vs.find((x) => x.reportId === S1.rid && x.reportVersion === S1.v), v2 = vs.find((x) => x.reportId === S1.rid && x.reportVersion === s1v2);
    const i = await S.issueRpc(S.U.owner, S1.rid, r.reportVersion);
    const s = await issueOfficialPack(deps, { userId: S.U.owner, issuanceId: i.issuance_id });
    const d = await S.designate(S.U.owner, S1.rid, S1.v, "Designating in a held scope");
    return w.outcome === "recorded" && r.outcome === "saved" && rv.state === "REVIEWED" && f.state === "FINAL" && p.report_version === r.reportVersion && p.authority_seq === 2 && ev.map((e) => e.kind).join(",") === "ESTABLISHED,SUCCEEDED"
      && v1?.supersededByFinal === r.reportVersion && v1.authority?.relation === "same_lineage" && v1.authority.superseded === true && v2?.supersededByFinal === r.reportVersion && i.outcome === "issued" && s.body.outcome === "sealed" && d.outcome === "not_unresolved"
      ? true : { w, r: r.outcome, rv: rv.state, f: f.state, p, kinds: ev.map((e) => e.kind), v1: v1?.authority, v2: v2?.supersededByFinal, i: i.outcome, s: s.body.outcome, d };
  });

  const missing = CASES.map((c) => c.id).filter((id) => !recorded.some((r) => r.id === id));
  if (missing.length) throw new Error(`proof defect: cases never reached: ${missing.join(", ")}`);
}

main().then(async () => { writeResult(true, false); const ok = finish("publication authority (legacy data)", false); await db?.close(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error("CRASH:", e); writeResult(false, true, String(e?.message ?? e)); finish("publication authority (legacy data)", true); await db?.close(); process.exit(1); });
