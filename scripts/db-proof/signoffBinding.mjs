#!/usr/bin/env bun
// Real-PostgreSQL proof of sign-off bound to content and dependencies (20261021100000; evidence statements and the
// supported-path refusal 20261111100000), end to end on real certifications and REAL evidence: composition → notes and
// schedules → comparatives → Close Review → evidence (ledger, equity movements, cash account map, prior statements) →
// a report built by the browser's own builder (prepareReportVersion) from the database's composition → REVIEWED → FINAL
// through the ONE canonical path (fs_set_publication_state).
//
//   ready        a complete report on current dependencies has no blocker, and the canonical path signs it
//   binding      every REVIEWED/FINAL records the server's document hash and the dependencies identity, atomically;
//                bindings are append-only
//   figures      a changed figure, a changed account figure under an unchanged line total, an extra figure bound on the
//                composed statements, a missing binding and a stale binding are each refused by name — and the canonical
//                path refuses to sign them
//   immutability FINAL never changes; a later change makes the old version stale (history kept) and needs a new version,
//                which signs with its own binding
//   defence      inserting a publication behind the canonical path's back for a stale report fails in the trigger
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/signoffBinding.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import { applyChain, certifier, chainFiles, clientDb, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, makeWorld, migrationText, openDatabase, prepareReporting, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { canonicalStringify } from "../../src/lib/canonicalStatement/serialization.ts";

const FILE = "20261021100000_fs_signoff_binding.sql";
const { group, check, refused, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
let db;

async function main() {
  db = await openDatabase("signoff_proof");
  group("Replay");
  await check(`${FILE} is in the chain and the whole chain applies`, async () => (!chainFiles().includes(FILE) ? `${FILE} missing` : (await applyChain(db)) ?? true));
  await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");

  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const pre = { d: clientDb(db, U.preparer) }; pre.c = signoffClient(pre.d);
  const parse = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type],
      fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected`);
    return r.batch;
  };
  const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
  const attempt = (rid, newEvidence = []) => prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  const stored = (rid, v) => db.one("SELECT report_document, content_hash, evidence_batch_ids FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=$2", [rid, v]);

  group("Setup — every authority complete, through the real functions");
  let base, baseEvidence;
  await check("certified years, presentation, Close Review findings resolved, notes complete, comparatives approved; the evidence saved through the browser's builder; the dependencies have no blocker", async () => {
    await prepareReporting(db, W, k, { year: Y });
    const r = await attempt(`rpt-base-${uuid()}`, allEvidence());
    if (r.outcome !== "saved") return r;
    const s = await stored(r.reportId, r.reportVersion);
    base = s.report_document; baseEvidence = s.evidence_batch_ids;
    const deps = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y])).r;
    return deps.state === "current" && deps.blockers.length === 0 ? true : { blockers: deps.blockers };
  });
  // A document a defective or tampering client would save: the browser-built document with one change.
  const bump = (doc, factId, delta) => ({ ...doc, facts: doc.facts.map((f) => (f.factId === factId ? { ...f, value: { ...f.value, minorUnits: { __bigint__: (BigInt(f.value.minorUnits.__bigint__) + delta).toString() } } } : f)) });
  const tampered = (tamper) => {
    let doc = base;
    if (tamper === "figure") doc = bump(doc, "fact:current:current_assets:sfp.inventories", 1n);
    if (tamper === "account") { // one account's figure moves while its line's total is unchanged — only the per-account check sees it
      const ids = doc.facts.filter((f) => f.factId.startsWith("fact:current:account:")).map((f) => f.factId).slice(0, 2);
      doc = bump(bump(doc, ids[0], 1n), ids[1], -1n);
    }
    if (tamper === "extra") {
      const sfp = doc.statements.find((s) => s.statementId === "stmt:sfp");
      doc = { ...doc, facts: [...doc.facts, { ...doc.facts[0], factId: "fact:current:current_assets:sfp.made_up" }],
        statements: doc.statements.map((s) => (s.statementId !== "stmt:sfp" ? s : { ...s, sections: [...s.sections, { sectionId: "section:extra", label: "Extra", lines: [{ ...sfp.sections[0].lines[0], lineId: "line:extra", factBindings: [{ periodId: "CURRENT", factId: "fact:current:current_assets:sfp.made_up" }], castingChildLineIds: [] }] }] })) };
    }
    if (tamper === "unbound") { const { reportingDependencies: _d, ...rest } = doc; doc = rest; }
    if (tamper === "stale") doc = { ...doc, reportingDependencies: { ...doc.reportingDependencies, dependenciesSha256: "0".repeat(64) } };
    return doc;
  };
  const save = async (rid, version, doc) => {
    const d = { ...doc, reportIdentity: { ...doc.reportIdentity, reportId: rid, reportVersion: version } };
    const text = canonicalStringify(d);
    await asU(U.preparer, "SELECT * FROM public.fs_save_report_version($1,$2,$3,$4,'TRIAL_BALANCE_DERIVED',$5::jsonb,$6,$7::text[])", [rid, version, A, Y, text, hex(text), baseEvidence]);
    await asU(U.partner, "SELECT * FROM public.fs_save_evaluation($1,$2,$3,$4,'rule-pack','1','engine-1',$5,'[]'::jsonb)", [`ev-${rid}-${version}`, rid, version, A, hex(`e${rid}${version}`)]);
  };
  const readiness = (rid, version = 1) => asU(U.partner, "SELECT public.fs_report_readiness($1,$2,$3) r", [A, rid, version]).then((r) => r.r);
  const setState = (uid, rid, version, state) => asU(uid, "SELECT * FROM public.fs_set_publication_state($1,$2,$3,$4,'sign-off proof step')", [rid, version, A, state]);
  const ours = (r) => r.blockers.filter((b) => /^(REPORTING_DEPENDENCIES|STATEMENT_FIGURE)/.test(b));

  group("Refusals by name — and the canonical path refuses to sign them");
  for (const [tamper, want] of [["figure", /^STATEMENT_FIGURE_MISMATCH:1:fact:current:current_assets:sfp\.inventories$/], ["account", /^STATEMENT_FIGURE_MISMATCH:2:fact:current:account:/], ["extra", /^STATEMENT_FIGURE_NOT_COMPOSED:1:fact:current:current_assets:sfp\.made_up$/],
    ["unbound", /^REPORTING_DEPENDENCIES_UNBOUND$/], ["stale", /^REPORTING_DEPENDENCIES_STALE$/]]) {
    await check(`${tamper}: refused (${want.source.replace(/\\/g, "").replace(/[\^$]/g, "")}); REVIEWED is refused`, async () => {
      const rid = `rpt-${tamper}-${uuid()}`;
      await save(rid, 1, tampered(tamper));
      const r = await readiness(rid);
      let refusal = null;
      try { await setState(U.partner, rid, 1, "REVIEWED"); } catch (e) { refusal = e.code; }
      return ours(r).length === 1 && want.test(ours(r)[0]) && refusal === "PT409" ? true : { b: r.blockers, refusal };
    });
  }

  group("Ready → REVIEWED → FINAL through the one canonical path, each bound");
  const rid = `rpt-final-${uuid()}`;
  let deps1, v1;
  await check("the complete report on current dependencies is ready (no blocker of any kind)", async () => {
    const s = await attempt(rid);
    v1 = s.reportVersion;
    deps1 = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y])).r;
    const r = await readiness(rid, v1);
    return s.outcome === "saved" && r.ready === true && r.blockers.length === 0 ? true : { s, b: r.blockers };
  });
  await check("REVIEWED (review_close) then FINAL (approve_certification); each publication has exactly one binding with the server's document hash and the dependencies identity", async () => {
    const rv = await setState(U.partner, rid, v1, "REVIEWED");
    const fin = await setState(U.owner, rid, v1, "FINAL");
    const b = (await db.admin.query("SELECT publication_id, state, document_sha256, declared_content_hash, dependencies_sha256 FROM public.fs_publication_bindings WHERE report_id=$1 ORDER BY seq", [rid])).rows;
    const st = (await db.one("SELECT encode(sha256(convert_to(report_document::text,'UTF8')),'hex') h, content_hash FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=$2", [rid, v1]));
    return rv.state === "REVIEWED" && fin.state === "FINAL" && b.length === 2 && b[0].publication_id === rv.id && b[1].publication_id === fin.id
      && b.every((x) => x.document_sha256 === st.h && x.declared_content_hash === st.content_hash && x.dependencies_sha256 === deps1.dependenciesSha256)
      && JSON.stringify(b.map((x) => x.state)) === JSON.stringify(["REVIEWED", "FINAL"]) ? true : { b, st };
  });
  await check("FINAL is immutable (PT409)", async () => {
    try { await setState(U.partner, rid, v1, "REVIEWED"); return "reopened"; } catch (e) { return e.code === "PT409" ? true : e.code; }
  });

  group("A later change: the signed version stays as signed; the next sign-off needs a new version");
  let v2;
  await check("a disclosure changes: the FINAL version and its bindings are untouched, but it is now stale against the dependencies", async () => {
    const before = await db.count("SELECT count(*) n FROM public.fs_publication_bindings");
    await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.estimates','Useful lives and residual values.','Notes v2',$3)", [A, Y, uuid()]);
    const r = await readiness(rid, v1);
    const pub = (await db.admin.query("SELECT state FROM public.financial_statement_publications WHERE report_id=$1 ORDER BY seq", [rid])).rows.map((x) => x.state);
    return ours(r).includes("REPORTING_DEPENDENCIES_STALE") && JSON.stringify(pub) === JSON.stringify(["REVIEWED", "FINAL"]) && (await db.count("SELECT count(*) n FROM public.fs_publication_bindings")) === before ? true : { b: r.blockers, pub };
  });
  await check("the next version on the new dependencies is ready and REVIEWED, with its own binding (a different dependencies identity)", async () => {
    const s = await attempt(rid);
    v2 = s.reportVersion;
    const r = await readiness(rid, v2);
    const rv = await setState(U.partner, rid, v2, "REVIEWED");
    const b = (await db.admin.query("SELECT dependencies_sha256 FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2", [rid, v2])).rows;
    return s.outcome === "saved" && v2 === v1 + 1 && r.ready === true && rv.state === "REVIEWED" && b.length === 1 && b[0].dependencies_sha256 !== deps1.dependenciesSha256 ? true : { s, b: r.blockers, rv };
  });
  await check("a dependency's own blocker is the report's: withdrawing the comparative approval blocks the new version's FINAL by name", async () => {
    await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,false,'Re-checking the prior year',$3)", [A, Y, uuid()]);
    const r = await readiness(rid, v2);
    let refusal = null;
    try { await setState(U.owner, rid, v2, "FINAL"); } catch (e) { refusal = String(e.message); }
    return r.blockers.includes("COMPARATIVE_NOT_APPROVED") && r.blockers.includes("REPORTING_DEPENDENCIES_STALE") && /BLOCKED/.test(refusal ?? "") ? true : { b: r.blockers, refusal };
  });

  group("Defence in depth, append-only");
  await check("a publication inserted behind the canonical path's back for a stale report fails in the binding trigger (BINDING_STALE); nothing recorded", async () => {
    const member = (await db.one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.partner])).id;
    const before = await db.count("SELECT count(*) n FROM public.financial_statement_publications");
    let code = null;
    try { await db.admin.query("INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,$2,$3,'FINAL','bypass attempt here',$4)", [rid, v2, A, member]); } catch (e) { code = `${e.code}:${String(e.message).split(":")[0]}`; }
    return code === "PT409:BINDING_STALE" && (await db.count("SELECT count(*) n FROM public.financial_statement_publications")) === before ? true : code;
  });
  await refused("bindings cannot be updated — not even by the database owner", "42501", () => db.admin.query("UPDATE public.fs_publication_bindings SET state='REVIEWED'"));
  await refused("bindings cannot be deleted", "42501", () => db.admin.query("DELETE FROM public.fs_publication_bindings"));
  await refused("clients cannot write bindings", "42501", () => db.asRole("authenticated", U.owner, "INSERT INTO public.fs_publication_bindings (publication_id, company_id, report_id, report_version, state, document_sha256, declared_content_hash, dependencies_sha256, dependencies) VALUES ($1,$2,'x',1,'FINAL',$3,'x',$3,'{}')", [uuid(), A, "a".repeat(64)]));
  await refused("anon cannot read dependencies", "42501", () => db.asRole("anon", null, "SELECT public.fs_reporting_dependencies($1,2026)", [A]));
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("SIGNOFF_BINDING", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
