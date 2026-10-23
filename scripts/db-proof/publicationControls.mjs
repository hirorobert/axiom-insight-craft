#!/usr/bin/env bun
// Real-PostgreSQL proof of the publication controls (20261111100000) — the executed acceptance cases of the first complete
// IFRS for SMEs reporting slice, through the browser's own client code (src/lib/reporting) where a page would act and
// through the database directly where an attacker or a defect would:
//
//   E  omit an applicable disclosure            → REQUIRED_DISCLOSURE_MISSING / REQUIREMENT_UNDECIDED; REVIEWED refused
//   H  the supported happy path                 → every server figure of the four statements is in the document with its
//                                                exact amount (hand-computed values checked); REVIEWED → FINAL; bindings
//                                                carry the server's document hash and the dependencies identity; the
//                                                stored document reproduces its declared content hash
//   A  tamper only with a cash-flow figure      → STATEMENT_FIGURE_MISMATCH; REVIEWED refused
//   B  tamper only with an equity figure        → STATEMENT_FIGURE_MISMATCH; an invented equity line → STATEMENT_FIGURE_NOT_COMPOSED
//   D  every unsupported framework / provenance → PUBLICATION_PATH_UNSUPPORTED by name; the trigger refuses a direct insert
//   F  unauthorised and same-person approval    → FORBIDDEN; SIGNOFF_SEPARATE_APPROVERS_REQUIRED
//   K  tenant isolation                         → another company's owner is refused on every RPC and read
//   G  a dependency changes after REVIEWED      → stale; the old approval cannot authorise the changed report; BINDING_STALE
//   C  SCF/SOCIE evidence replaced after REVIEWED → EVIDENCE_SUPERSEDED + REPORTING_DEPENDENCIES_STALE; FINAL refused
//   J  roll-forward opening checks              → a seeded prior-closing discrepancy blocks by name (never absorbed)
//   L  evidence-backed ties                     → an equity movement that no longer ties to the composed statements blocks by name
//   L2 adjustment → every dependent statement   → an approved Close Review adjustment after REVIEWED makes the version stale; the
//                                                 next version carries the recomposed SFP/SCI and the equity statement is refused
//                                                 until its evidence agrees; then it signs
//   ED edition                                  → a period under the third edition (early-application election) is refused by name
//   J2 roll-forward                             → the next period's comparative, as reported, must equal the prior year's issued
//                                                 FINAL; a prior-year adjustment approved after issue is preserved and blocks
//   I  issued history unchanged                 → the FINAL version's document and bindings are byte-identical after everything above
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/publicationControls.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
//   PUBLICATION_CONTROLS_ABSENT=1 applies the chain WITHOUT 20261111100000: the regression run. It MUST fail — its
//   failures are exactly the cases the control exists for (E, A, B, D, J, L). Its output is evidence, not a pass.
import crypto from "node:crypto";
import { applyChain, applyChainBefore, certifier, chainFiles, clientDb, csv, DECISIONS_1_2_0, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, FY2026, makeWorld, migrationText, openDatabase, prepareReporting, reporter, uuid, WORDS_1_2_0 } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { canonicalStringify, sha256Hex } from "../../src/lib/canonicalStatement/serialization.ts";

const FILE = "20261111100000_fs_publication_controls.sql";
const ABSENT = process.env.PUBLICATION_CONTROLS_ABSENT === "1";
const { group, check, refused, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const slug = (s) => sha256Hex(s).slice(0, 10);
let db;

async function main() {
  db = await openDatabase("pubctl_proof");
  group(ABSENT ? "Replay WITHOUT the control (regression run: the cases below must fail)" : "Replay");
  if (ABSENT) {
    await check(`the chain before ${FILE} applies`, async () => (await applyChainBefore(db, FILE)) ?? true);
  } else {
    await check(`${FILE} is in the chain and the whole chain applies`, async () => (!chainFiles().includes(FILE) ? `${FILE} missing` : (await applyChain(db)) ?? true));
    await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");
  }
  await check("static contract: no DELETE or UPDATE without a WHERE clause anywhere in the migration (Supabase API sessions load safeupdate, which refuses them inside SECURITY DEFINER functions too; a direct-connection proof cannot see that)", async () => {
    const code = migrationText(FILE).replace(/--[^\n]*/g, "");
    const bare = [...code.matchAll(/\bDELETE\s+FROM\s+[\w.]+\s*;/gi), ...code.matchAll(/\bUPDATE\s+[\w.]+\s+SET\b(?:(?!\bWHERE\b)[^;])*;/gi)].map((m) => m[0].slice(0, 60));
    return bare.length === 0 ? true : bare;
  });

  const W = await makeWorld(db);
  const { U, A, B } = W;
  await W.rollout(A, true);
  await W.rollout(B, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner), viewer = as(U.viewer), ownerB = as(U.ownerB);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const decide = (id, decision, reason = "Decided from the engagement file") => asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,$4,$5,$6) r", [A, Y, id, decision, reason, uuid()]).then((r) => r.r);
  const record = (id, text) => asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Notes v1',$5) r", [A, Y, id, text, uuid()]).then((r) => r.r);
  const notes = () => asU(U.owner, "SELECT public.fs_notes_status($1,$2) r", [A, Y]).then((r) => r.r);
  const deps = () => asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y]).then((r) => r.r);
  const parse = (type, role = "CURRENT", text = null) => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const body = text ?? (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type];
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: body, fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
    return r.batch;
  };
  const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
  const attempt = (who, rid, newEvidence = []) => prepareReportVersion(who.d, who.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  const readiness = (rid, v) => partner.c.readiness(A, rid, v);
  const stored = (rid, v) => db.one("SELECT report_document, content_hash, evidence_batch_ids, encode(sha256(convert_to(report_document::text,'UTF8')),'hex') AS doc_sha FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=$2", [rid, v]);
  const latest = (rid) => db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE report_id=$1", [rid]);
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code ?? ""}:${String(e.message).split("\n")[0]}`; } };
  /** Saves a document as the next version of a lineage directly (as a defective or tampering client would), with an evaluation. */
  const saveDoc = async (rid, version, doc, evidenceIds, provenance = "TRIAL_BALANCE_DERIVED") => {
    const d = { ...doc, reportIdentity: { ...doc.reportIdentity, reportId: rid, reportVersion: version } };
    const text = canonicalStringify(d);
    await asU(U.preparer, "SELECT * FROM public.fs_save_report_version($1,$2,$3,$4,$5,$6::jsonb,$7,$8::text[])", [rid, version, A, Y, provenance, text, hex(text), evidenceIds]);
    await asU(U.partner, "SELECT * FROM public.fs_save_evaluation($1,$2,$3,$4,'rule-pack','1','engine-1',$5,'[]'::jsonb)", [`ev-${rid}-${version}`, rid, version, A, hex(`e${rid}${version}`)]);
    return version;
  };
  const bump = (doc, factId, delta = 1n) => ({ ...doc, facts: doc.facts.map((f) => (f.factId === factId ? { ...f, value: { ...f.value, minorUnits: { __bigint__: (BigInt(f.value.minorUnits.__bigint__) + delta).toString() } } } : f)) });
  const memberOf = async (uid) => (await db.one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, uid])).id;

  group("Setup through the real functions (pack 1.1.0 items, as before this release)");
  await check("prepared: two certified years, presentation, Close Review, notes, schedule, comparatives approved", async () => { await prepareReporting(db, W, k, { year: Y, pack120: false }); return true; });

  // ── E ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("E. An applicable disclosure of pack 1.2.0 is missing: the report cannot be reviewed");
  const rid1 = `rpt-slice-${uuid()}`;
  let v1;
  await check("the first version saves (evidence + bind) on the current dependencies", async () => {
    const r = await attempt(pre, rid1, allEvidence());
    v1 = r.reportVersion;
    return r.outcome === "saved" ? true : r;
  });
  await check("readiness names the missing going-concern, authorisation, key-management and cash-components disclosures and the undecided events-after / related-party requirements; REVIEWED is refused", async () => {
    const r = await readiness(rid1, v1);
    const want = ["REQUIRED_DISCLOSURE_MISSING:smes.note.going_concern", "REQUIRED_DISCLOSURE_MISSING:smes.note.authorisation", "REQUIRED_DISCLOSURE_MISSING:smes.note.kmp_compensation",
      "REQUIRED_DISCLOSURE_MISSING:smes.note.cash_components", "REQUIRED_DISCLOSURE_MISSING:smes.note.income_tax", "REQUIRED_DISCLOSURE_MISSING:smes.note.revenue",
      "REQUIREMENT_UNDECIDED:smes.note.events_after", "REQUIREMENT_UNDECIDED:smes.note.related_party_control", "REQUIREMENT_UNDECIDED:smes.note.related_party_transactions",
      "DISCLOSURE_CHECKLIST_INCOMPLETE:supporting-notes"];
    const missing = want.filter((b) => !r.blockers.includes(b));
    const ref = await refusal(() => partner.c.setState(A, rid1, v1, "REVIEWED", "Attempted review with disclosures missing"));
    return missing.length === 0 && r.ready === false && /PT409/.test(ref ?? "") ? true : { missing, blockers: r.blockers, ref };
  });
  await check("income tax and revenue are decided by the data (the composed lines carry amounts): a hand decision is not_decidable", async () => {
    const a = await decide("smes.note.income_tax", "not_applicable");
    const b = await decide("smes.note.revenue", "not_applicable");
    const n = await notes();
    const st = (id) => n.requirements.find((r) => r.requirementId === id);
    return a.outcome === "not_decidable" && b.outcome === "not_decidable" && st("smes.note.income_tax")?.status === "missing" && st("smes.note.revenue")?.status === "missing" ? true : { a, b, tax: st("smes.note.income_tax"), rev: st("smes.note.revenue") };
  });
  await check("the 1.2.0 disclosures are recorded with their applicability decisions (requirements version 1.2.0 in the dependencies)", async () => {
    for (const [id, text] of Object.entries(WORDS_1_2_0)) { const r = await record(id, text); if (r.outcome !== "recorded") return { id, r }; }
    for (const id of DECISIONS_1_2_0) {
      const r = await decide(id, "not_applicable", "None in the periods presented; no parent or controlling party");
      if (r.outcome !== "recorded") return { id, r };
    }
    const d = await deps();
    return d.requirementsVersion === "1.2.0" && !d.blockers.some((b) => /smes\.note\./.test(b)) ? true : { version: d.requirementsVersion, blockers: d.blockers };
  });

  // ── H ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("R. Sign-off on the current rules (20261118100000): a period whose trial balance in force predates generation 7 is re-checked before a NEW sign-off");
  if (!ABSENT) {
    const auth = async () => (await db.admin.query("SELECT c.id, c.upload_id, er.engine_generation g FROM public.get_authoritative_certification($1,$2) c JOIN public.engine_runs er ON er.id = c.engine_run_id", [A, Y])).rows[0];
    const preview = (rid, v) => asU(U.partner, "SELECT public.tb_signoff_rules_blocker($1,$2,$3) r", [A, rid, v]).then((r) => r.r);
    let ridR, vR, before;
    await check("FIXTURE (a result accepted before the release): the period's result in force recorded as generation 6 — the preview names TRIAL_BALANCE_RECHECK_REQUIRED:6", async () => {
      before = await auth();
      await db.admin.query("SET session_replication_role = replica");
      try { await db.admin.query("UPDATE public.engine_runs SET engine_generation = 6 WHERE id = (SELECT engine_run_id FROM public.tb_certifications WHERE id=$1)", [before.id]); }
      finally { await db.admin.query("SET session_replication_role = origin"); }
      ridR = `rpt-rules-${uuid()}`;
      const r = await attempt(pre, ridR);
      vR = r.reportVersion;
      const p = await preview(ridR, vR);
      return before?.g === 7 && r.outcome === "saved" && p.outcome === "ok" && p.blocker === "TRIAL_BALANCE_RECHECK_REQUIRED:6" ? true : { before, r: r.outcome, p };
    });
    await check("a NEW Reviewed state is refused on the one sign-off write, before anything is recorded; the certification, its history and earlier publications are untouched", async () => {
      const pubs = async () => Number((await db.admin.query("SELECT count(*) n FROM public.financial_statement_publications WHERE company_id=$1", [A])).rows[0].n);
      const n0 = await pubs();
      const certs0 = Number((await db.admin.query("SELECT count(*) n FROM public.tb_certifications WHERE company_id=$1", [A])).rows[0].n);
      const ref = await refusal(() => partner.c.setState(A, ridR, vR, "REVIEWED", "Attempted review on a trial balance checked under earlier rules"));
      const still = await auth();
      return /TRIAL_BALANCE_RECHECK_REQUIRED:6/.test(ref ?? "") && (await pubs()) === n0 && still.id === before.id
        && Number((await db.admin.query("SELECT count(*) n FROM public.tb_certifications WHERE company_id=$1", [A])).rows[0].n) === certs0 ? true : { ref, still };
    });
    await check("the re-check (the one reprocess path, the generation-7 engine) clears it: a new generation-7 result is in force and the preview has no blocker", async () => {
      const src = (await db.admin.query("SELECT source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [before.upload_id])).rows[0].source_file_hash;
      const acc = (await asU(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [before.upload_id, uuid(), src])).r;
      await k.certify(A, { id: before.upload_id, year: Y });
      // A new authority is a new trial balance for everything bound to it (existing controls, unchanged): its Close Review
      // findings are checked again and the comparatives approved again before the statements can be signed.
      const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y])).r;
      for (const f of (await db.admin.query("SELECT f.id FROM public.close_review_findings f WHERE f.run_id=$1", [run.runId])).rows)
        await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain','Accumulated depreciation is a contra-asset by design','Fixed asset register 2026',$2) r", [f.id, uuid()]);
      await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed to the signed 2025 statements',$3) r", [A, Y, uuid()]);
      const after = await auth();
      const r = await attempt(pre, ridR);
      const p = await preview(ridR, r.reportVersion);
      return acc?.outcome === "accepted" && after.id !== before.id && after.g === 7 && p.outcome === "ok" && p.blocker === null ? true : { acc, after, p };
    });
    await check("the preview is for members only; an outsider learns nothing", async () => {
      const p = await asU(U.ownerB, "SELECT public.tb_signoff_rules_blocker($1,$2,$3) r", [A, ridR, vR]).then((r) => r.r);
      return p.outcome === "not_found" ? true : p;
    });
  }

  group("H. The supported happy path: every figure of the four statements is the server's, REVIEWED → FINAL, reproducible");
  let vFinal, docFinal, depsFinal;
  await check("a new version binds the current dependencies and is ready (no blocker of any kind)", async () => {
    const r = await attempt(pre, rid1);
    vFinal = r.reportVersion;
    const rd = await readiness(rid1, vFinal);
    return r.outcome === "saved" && rd.ready === true && rd.blockers.length === 0 ? true : { r, blockers: rd.blockers };
  });
  await check("the server's evidence figures equal the hand-computed values and every one is in the document with exactly its amount", async () => {
    depsFinal = await deps();
    docFinal = (await stored(rid1, vFinal)).report_document;
    const f = Object.fromEntries(depsFinal.figures.map((x) => [x.factId, x.amountMinor]));
    const want = {
      "fact:line:cf:opening:CURRENT": "800000", "fact:line:cf:net-increase:CURRENT": "450000", "fact:line:cf:closing:CURRENT": "1250000",
      "fact:line:cf:opening:COMPARATIVE_1": "500000", "fact:line:cf:net-increase:COMPARATIVE_1": "300000", "fact:line:cf:closing:COMPARATIVE_1": "800000",
      "fact:line:cf:operating:net:CURRENT": "620000", "fact:line:cf:financing:net:CURRENT": "-170000",
      "fact:line:eq:total-opening:CURRENT": "1660000", "fact:line:eq:total-profit:CURRENT": "510000", "fact:line:eq:total-closing:CURRENT": "2100000",
      "fact:line:eq:total-opening:COMPARATIVE_1": "1420000", "fact:line:eq:total-profit:COMPARATIVE_1": "310000", "fact:line:eq:total-closing:COMPARATIVE_1": "1660000",
      "fact:cashperim:cfexpected:CURRENT": "1250000", "fact:cashperim:cfexpected:COMPARATIVE_1": "800000", "fact:cashperim:net:CURRENT": "1250000",
      [`fact:cashroll:ledger:${slug("1000")}`]: "450000", [`fact:cashroll:tb:${slug("1000")}`]: "450000",
    };
    const wrong = Object.entries(want).filter(([id, v]) => f[id] !== v).map(([id, v]) => `${id}: server ${f[id]} want ${v}`);
    const docFacts = new Map(docFinal.facts.map((x) => [x.factId, x.value.minorUnits.__bigint__]));
    const absent = depsFinal.figures.filter((x) => docFacts.get(x.factId) !== x.amountMinor).map((x) => x.factId);
    const evidenceFigures = depsFinal.figures.filter((x) => /^fact:(line:cf|line:eq|cashperim|cashroll):/.test(x.factId)).length;
    return wrong.length === 0 && absent.length === 0 && evidenceFigures >= 40 && depsFinal.evidenceStatementsSha256?.length === 64 ? true : { wrong, absent: absent.slice(0, 5), evidenceFigures };
  });
  let bindingsFinal, storedFinal;
  await check("REVIEWED (partner, review_close) then FINAL (owner, approve_certification); each binding carries the server's document hash and the dependencies identity including the evidence statements", async () => {
    const rv = await partner.c.setState(A, rid1, vFinal, "REVIEWED", "Reviewed: figures agree to evidence and composition");
    const fin = await owner.c.setState(A, rid1, vFinal, "FINAL", "Approved for issue");
    bindingsFinal = (await db.admin.query("SELECT state, document_sha256, declared_content_hash, dependencies_sha256, dependencies, approver_role FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2 ORDER BY seq", [rid1, vFinal])).rows;
    storedFinal = await stored(rid1, vFinal);
    return rv.state === "REVIEWED" && fin.state === "FINAL" && bindingsFinal.length === 2
      && bindingsFinal.every((b) => b.document_sha256 === storedFinal.doc_sha && b.declared_content_hash === storedFinal.content_hash && b.dependencies_sha256 === depsFinal.dependenciesSha256 && b.dependencies.evidenceStatementsSha256 === depsFinal.evidenceStatementsSha256)
      && bindingsFinal.map((b) => b.approver_role).join(",") === "partner,owner" ? true : { rv: rv.state, fin: fin.state, bindings: bindingsFinal.map((b) => [b.state, b.approver_role]) };
  });
  await check("reproduction: the stored document re-serialises to exactly the content hash it was saved under", async () => hex(canonicalStringify(storedFinal.report_document)) === storedFinal.content_hash ? true : storedFinal.content_hash);

  // Server compilation (20261123100000): prove the residual presentation gap with this ONE control removed,
  // then restore it and replay the identical payloads. The disposable database is the only target of this script.
  group("SC. Complete report authority: correct retained figures cannot authorise a doctored presentation");
  const mutations = [
    ["omitted equity lines", d => { d.statements.find(s => s.type === "STATEMENT_OF_CHANGES_IN_EQUITY").sections[0].lines.pop(); }],
    ["false line heading", d => { d.statements[0].sections[0].lines[0].label = "An invented heading"; }],
    ["missing line binding", d => { d.statements[0].sections[0].lines[0].factBindings = []; }],
    ["false presentation currency", d => { d.presentationCurrency.currency = "USD"; }],
    ["false entity name", d => { d.entity.legalName = "Another company entirely"; }],
  ];
  const definition = (await db.one("SELECT pg_get_functiondef('public.fs_publication_blockers(uuid,text,integer)'::regprocedure) d")).d;
  const splice = /  v_txt := public\.fs_server_compilation_blocker\(p_company_id,p_report_id,p_version\);\s*IF v_txt IS NOT NULL THEN v_out := array_append\(v_out,v_txt\); END IF;\s*/;
  const oldDefinition = definition.replace(splice, "");
  if (oldDefinition === definition) throw Error("Server compilation splice not found; cannot model the preceding controls");
  await db.admin.query(oldDefinition);
  await db.admin.query("ALTER TABLE public.financial_statement_publications DISABLE TRIGGER trg_fsp_server_compilation");
  try {
    for (const [label, mutate] of mutations) await check(`CONTROL REMOVED: ${label}, correct facts and an empty findings list reach FINAL (the residual gap)`, async () => {
      const rid = `rpt-before-${uuid()}`; const d = structuredClone(docFinal); mutate(d);
      await saveDoc(rid, 1, d, storedFinal.evidence_batch_ids);
      const reviewed = await partner.c.setState(A,rid,1,"REVIEWED","Synthetic adversarial control-removed proof");
      const final = await owner.c.setState(A,rid,1,"FINAL","Synthetic adversarial control-removed proof");
      return reviewed.state === "REVIEWED" && final.state === "FINAL";
    });
  } finally {
    await db.admin.query(definition);
    await db.admin.query("ALTER TABLE public.financial_statement_publications ENABLE TRIGGER trg_fsp_server_compilation");
  }
  for (const [label, mutate] of mutations) await check(`CONTROL RESTORED: ${label} is refused before compilation, then refused as SERVER_DOCUMENT_MISMATCH after independent compilation`, async () => {
    const rid = `rpt-after-${uuid()}`; const d = structuredClone(docFinal); mutate(d);
    await saveDoc(rid,1,d,storedFinal.evidence_batch_ids);
    const before = await refusal(() => asU(U.partner,"SELECT public.fs_set_publication_state($1,1,$2,'REVIEWED','Synthetic tamper attempt')",[rid,A]));
    const checked = await pre.d.invoke("compile-financial-report",{companyId:A,reportId:rid,reportVersion:1});
    const rd = await readiness(rid,1);
    const after = await refusal(() => partner.c.setState(A,rid,1,"REVIEWED","Synthetic tamper attempt"));
    return /SERVER_COMPILATION_REQUIRED/.test(before ?? "") && !checked.error && checked.data.matches === false
      && rd.blockers.includes("SERVER_DOCUMENT_MISMATCH") && /SERVER_DOCUMENT_MISMATCH/.test(after ?? "");
  });
  await check("authenticated callers cannot forge a server compilation receipt or mutate one", async () => {
    const forged = await refusal(() => asU(U.preparer,"SELECT public.fs_record_server_compilation($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)",
      [U.preparer,A,rid1,vFinal,storedFinal.doc_sha,depsFinal.dependenciesSha256,JSON.stringify(docFinal),"{\"findings\":[]}"]));
    const changed = await refusal(() => db.asService("UPDATE public.fs_server_compilations SET matches=true WHERE report_id=$1",[rid1]));
    return /42501/.test(forged ?? "") && /42501/.test(changed ?? "");
  });

  await check("a lost compilation response retries the same version and receipt without duplicate history", async () => {
    const before = await db.count("SELECT count(*) n FROM public.fs_server_compilations WHERE report_id=$1",[rid1]);
    const versions = await latest(rid1); let first = true;
    const flaky = { ...pre.d, invoke: async (name,body) => {
      const result = await pre.d.invoke(name,body);
      if (first) { first=false; return { data:null,error:{message:"Synthetic lost response after receipt commit"} }; }
      return result;
    } };
    const input = {companyId:A,periodYear:Y,legalName:"Untrusted name ignored",reportId:rid1,newEvidence:[],idempotencyKey:"lost-compiler-response",evaluatedAt:"2027-02-02T09:00:00Z"};
    const lost = await refusal(() => prepareReportVersion(flaky,signoffClient(flaky),input));
    const retried = await prepareReportVersion(flaky,signoffClient(flaky),input);
    const receipts = await Promise.all(Array.from({length:4},()=>pre.d.invoke("compile-financial-report",{companyId:A,reportId:rid1,reportVersion:vFinal})));
    return /server check could not be confirmed/.test(lost ?? "") && retried.outcome === "saved" && retried.alreadyCurrent
      && (await latest(rid1)) === versions && (await db.count("SELECT count(*) n FROM public.fs_server_compilations WHERE report_id=$1",[rid1])) === before
      && receipts.every(r=>!r.error) && new Set(receipts.map(r=>r.data.compilationId)).size===1;
  });
  await check("another company's owner cannot compile this company's report", async () => {
    const r = await ownerB.d.invoke("compile-financial-report",{companyId:A,reportId:rid1,reportVersion:vFinal});
    return !!r.error && /FORBIDDEN|NOT_FOUND/.test(r.error.message);
  });

  // ── A / B ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("A. Only a cash-flow figure is altered: refused by name");
  for (const [label, factId] of [["closing cash", "fact:line:cf:closing:CURRENT"], ["net cash from operating activities", "fact:line:cf:operating:net:CURRENT"], ["comparative closing cash", "fact:line:cf:closing:COMPARATIVE_1"]]) {
    await check(`${label} +0.01: STATEMENT_FIGURE_MISMATCH on exactly that figure; REVIEWED refused`, async () => {
      const v = await saveDoc(rid1, (await latest(rid1)) + 1, bump(docFinal, factId), storedFinal.evidence_batch_ids);
      const r = await readiness(rid1, v);
      const ref = await refusal(() => partner.c.setState(A, rid1, v, "REVIEWED", "Attempted review of a tampered figure"));
      return r.blockers.includes(`STATEMENT_FIGURE_MISMATCH:1:${factId}`) && /PT409/.test(ref ?? "") ? true : { blockers: r.blockers, ref };
    });
  }
  group("B. Only an equity figure is altered, or an equity line is invented: refused by name");
  for (const [label, factId] of [["total closing equity", "fact:line:eq:total-closing:CURRENT"], ["result recognised in equity", "fact:line:eq:total-profit:CURRENT"], [`retained earnings opening`, `fact:line:eq:${slug("Retained earnings")}:opening:CURRENT`]]) {
    await check(`${label} +0.01: STATEMENT_FIGURE_MISMATCH on exactly that figure; REVIEWED refused`, async () => {
      const v = await saveDoc(rid1, (await latest(rid1)) + 1, bump(docFinal, factId), storedFinal.evidence_batch_ids);
      const r = await readiness(rid1, v);
      const ref = await refusal(() => partner.c.setState(A, rid1, v, "REVIEWED", "Attempted review of a tampered figure"));
      return r.blockers.includes(`STATEMENT_FIGURE_MISMATCH:1:${factId}`) && /PT409/.test(ref ?? "") ? true : { blockers: r.blockers, ref };
    });
  }
  await check("an invented equity line bound on the statement of changes in equity: STATEMENT_FIGURE_NOT_COMPOSED; REVIEWED refused", async () => {
    const extraId = "fact:line:eq:made-up:CURRENT";
    const base = docFinal.facts.find((f) => f.factId === "fact:line:eq:total-closing:CURRENT");
    const doc = { ...docFinal, facts: [...docFinal.facts, { ...base, factId: extraId }],
      statements: docFinal.statements.map((s) => (s.type !== "STATEMENT_OF_CHANGES_IN_EQUITY" ? s : { ...s, sections: [...s.sections, { sectionId: "section:eq:extra", label: "Extra", lines: [{ ...s.sections[0].lines[0], lineId: "line:eq:made-up", factBindings: [{ periodId: "CURRENT", factId: extraId }], castingChildLineIds: [] }] }] })) };
    const v = await saveDoc(rid1, (await latest(rid1)) + 1, doc, storedFinal.evidence_batch_ids);
    const r = await readiness(rid1, v);
    const ref = await refusal(() => partner.c.setState(A, rid1, v, "REVIEWED", "Attempted review with an invented line"));
    return r.blockers.includes(`STATEMENT_FIGURE_NOT_COMPOSED:1:${extraId}`) && /PT409/.test(ref ?? "") ? true : { blockers: r.blockers, ref };
  });

  // ── D ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("D. Every unsupported framework / provenance combination is refused by name — by the blockers and by the trigger");
  const partnerMember = await memberOf(U.partner);
  for (const [kind, prov] of [["IFRS", "TRIAL_BALANCE_DERIVED"], ["IPSAS_ACCRUAL", "TRIAL_BALANCE_DERIVED"], ["IPSAS_CASH", "TRIAL_BALANCE_DERIVED"], ["IFRS_FOR_SMES", "DOCUMENT_REVIEWED"], ["FULL_IFRS_18", "TRIAL_BALANCE_DERIVED"]]) {
    await check(`${kind} / ${prov}: PUBLICATION_PATH_UNSUPPORTED:${kind}:${prov}; REVIEWED refused; a publication inserted behind the canonical path is refused by the trigger`, async () => {
      const rid = `rpt-path-${uuid()}`;
      const doc = { ...docFinal, framework: { ...docFinal.framework, kind }, provenanceOrigin: prov };
      await saveDoc(rid, 1, doc, storedFinal.evidence_batch_ids, prov);
      const r = await readiness(rid, 1);
      const ref = await refusal(() => partner.c.setState(A, rid, 1, "REVIEWED", "Attempted review on an unsupported path"));
      const direct = await refusal(() => db.admin.query("INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,1,$2,'REVIEWED','bypass attempt',$3)", [rid, A, partnerMember]));
      return r.blockers.includes(`PUBLICATION_PATH_UNSUPPORTED:${kind}:${prov}`) && /PT409/.test(ref ?? "") && /PT409:PUBLICATION_PATH_UNSUPPORTED/.test(direct ?? "") ? true : { blockers: r.blockers, ref, direct };
    });
  }
  await check("the edition sealed in the document must be the server's: another pack id is FRAMEWORK_EDITION_MISMATCH", async () => {
    const rid = `rpt-edition-${uuid()}`;
    await saveDoc(rid, 1, { ...docFinal, framework: { ...docFinal.framework, version: "ifrs-for-smes/2025" } }, storedFinal.evidence_batch_ids);
    const r = await readiness(rid, 1);
    return r.blockers.includes("FRAMEWORK_EDITION_MISMATCH:ifrs-for-smes/2025:ifrs-for-smes/2015") ? true : r.blockers;
  });

  // ── F ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("F. Authorised sign-off and separation of duties");
  const ridF = `rpt-sod-${uuid()}`;
  let vF;
  await check("a ready version for the sign-off cases", async () => { const r = await attempt(pre, ridF); vF = r.reportVersion; const rd = await readiness(ridF, vF); return r.outcome === "saved" && rd.ready ? true : { r, b: rd.blockers }; });
  await check("a preparer cannot mark REVIEWED (42501); a viewer cannot (42501)", async () => {
    const p = await refusal(() => pre.c.setState(A, ridF, vF, "REVIEWED", "preparer attempt"));
    const v = await refusal(() => viewer.c.setState(A, ridF, vF, "REVIEWED", "viewer attempt"));
    return /^42501/.test(p ?? "") && /^42501/.test(v ?? "") ? true : { p, v };
  });
  await check("the reviewer's own FINAL is refused (SIGNOFF_SEPARATE_APPROVERS_REQUIRED, 42501); a different authorised approver finalises", async () => {
    await partner.c.setState(A, ridF, vF, "REVIEWED", "Reviewed");
    const same = await refusal(() => partner.c.setState(A, ridF, vF, "FINAL", "Reviewer finalising their own review"));
    const fin = await owner.c.setState(A, ridF, vF, "FINAL", "Approved");
    return /42501:SIGNOFF_SEPARATE_APPROVERS_REQUIRED/.test(same ?? "") && fin.state === "FINAL" ? true : { same, fin: fin.state };
  });

  // ── K ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("K. Tenant isolation — another company's owner, direct RPCs");
  await check("company B's owner is refused readiness, sign-off, dependencies, evidence statements and every read of company A", async () => {
    const rd = await refusal(() => ownerB.c.readiness(A, rid1, vFinal));
    const st = await refusal(() => ownerB.c.setState(A, rid1, vFinal, "REVIEWED", "cross-tenant attempt"));
    const dp = (await asU(U.ownerB, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y])).r;
    const ev = (await asU(U.ownerB, "SELECT public.fs_evidence_statements($1,$2) r", [A, Y])).r;
    const rows = await db.asRole("authenticated", U.ownerB, "SELECT count(*)::int n FROM public.financial_statement_reports WHERE company_id=$1", [A]);
    const binds = await db.asRole("authenticated", U.ownerB, "SELECT count(*)::int n FROM public.fs_publication_bindings WHERE company_id=$1", [A]);
    const ins = await refusal(() => db.asRole("authenticated", U.ownerB, "INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,$2,$3,'REVIEWED','x',$4)", [rid1, vFinal, A, partnerMember]));
    return /^42501/.test(rd ?? "") && /^42501/.test(st ?? "") && dp.state !== "current" && ev.state !== "composed" && rows[0].n === 0 && binds[0].n === 0 && /^42501/.test(ins ?? "")
      ? true : { rd, st, dp: dp.state, ev: ev.state, rows: rows[0].n, binds: binds[0].n, ins };
  });

  // ── G ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("G. A dependency changes after REVIEWED: the approval is stale and cannot authorise the changed report");
  const ridG = `rpt-dep-${uuid()}`;
  let vG;
  await check("REVIEWED, then a disclosure's wording changes: REPORTING_DEPENDENCIES_STALE; FINAL refused; a FINAL inserted behind the canonical path is BINDING_STALE; the REVIEWED binding is untouched", async () => {
    const r = await attempt(pre, ridG); vG = r.reportVersion;
    await partner.c.setState(A, ridG, vG, "REVIEWED", "Reviewed");
    const before = (await db.admin.query("SELECT document_sha256, dependencies_sha256 FROM public.fs_publication_bindings WHERE report_id=$1", [ridG])).rows;
    await record("smes.note.estimates", "Useful lives and residual values, reassessed annually.");
    const rd = await readiness(ridG, vG);
    const fin = await refusal(() => owner.c.setState(A, ridG, vG, "FINAL", "Approving a stale review"));
    const direct = await refusal(() => db.admin.query("INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,$2,$3,'FINAL','bypass attempt',$4)", [ridG, vG, A, partnerMember]));
    const after = (await db.admin.query("SELECT document_sha256, dependencies_sha256 FROM public.fs_publication_bindings WHERE report_id=$1", [ridG])).rows;
    return rd.blockers.includes("REPORTING_DEPENDENCIES_STALE") && /PT409/.test(fin ?? "") && /PT409:BINDING_STALE/.test(direct ?? "") && JSON.stringify(before) === JSON.stringify(after) && before.length === 1 ? true : { b: rd.blockers, fin, direct };
  });

  // ── C ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("C. SOCIE / SCF evidence replaced after REVIEWED");
  const ridC = `rpt-evidence-${uuid()}`;
  let vC;
  await check("REVIEWED; then a new equity-movements batch supersedes the bound one: EVIDENCE_SUPERSEDED + REPORTING_DEPENDENCIES_STALE on the reviewed version; FINAL refused; the trigger refuses a direct FINAL", async () => {
    const r = await attempt(pre, ridC); vC = r.reportVersion;
    await partner.c.setState(A, ridC, vC, "REVIEWED", "Reviewed");
    const bound = (await stored(ridC, vC)).evidence_batch_ids;
    const oldEq = (await db.admin.query("SELECT evidence_batch_id FROM public.financial_evidence_batches WHERE company_id=$1 AND evidence_type='EQUITY_MOVEMENTS' AND period_role='CURRENT' ORDER BY version DESC LIMIT 1", [A])).rows[0].evidence_batch_id;
    // The same figures and line identities, re-described on a balance row (a replacement file): a new version of the series.
    const replaced = parse("EQUITY_MOVEMENTS", "CURRENT", EVIDENCE_FY2026.EQUITY_MOVEMENTS.replace("Share capital,OPENING_BALANCE,10000.00,", "Share capital,OPENING_BALANCE,10000.00,Brought forward"));
    const r2 = await attempt(pre, ridC, [replaced]);
    const rd = await readiness(ridC, vC);
    const fin = await refusal(() => owner.c.setState(A, ridC, vC, "FINAL", "Approving after evidence was replaced"));
    const direct = await refusal(() => db.admin.query("INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,$2,$3,'FINAL','bypass attempt',$4)", [ridC, vC, A, partnerMember]));
    return bound.includes(oldEq) && r2.outcome === "saved" && rd.blockers.includes(`EVIDENCE_SUPERSEDED:${oldEq}`) && rd.blockers.includes("REPORTING_DEPENDENCIES_STALE") && rd.blockers.includes("NOT_LATEST_VERSION")
      && /PT409/.test(fin ?? "") && /PT409:BINDING_STALE/.test(direct ?? "") ? true : { r2: r2.outcome, b: rd.blockers, fin, direct };
  });
  await check("the version saved on the replaced evidence is itself ready (same figures, new identities) and REVIEWED", async () => {
    const v = await latest(ridC);
    const rd = await readiness(ridC, v);
    const rv = await partner.c.setState(A, ridC, v, "REVIEWED", "Reviewed on the replaced evidence");
    return rd.ready === true && rv.state === "REVIEWED" ? true : rd.blockers;
  });

  // ── J ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("J. Roll-forward opening checks: a seeded prior-closing discrepancy blocks by name and is never absorbed");
  await check("the signed prior-year opening cash is restated by 1.00: the comparative closing no longer ties to its perimeter and the current opening no longer equals the prior closing", async () => {
    const rid = `rpt-rollforward-${uuid()}`;
    const prior = parse("PRIOR_PERIOD_STATEMENTS", "COMPARATIVE", EVIDENCE_FY2025_COMPARATIVE.PRIOR_PERIOD_STATEMENTS.replace("5000.00", "4999.00"));
    const r = await attempt(pre, rid, [prior]);
    const v = await latest(rid);
    const rd = await readiness(rid, v);
    const d = await deps();
    const f = Object.fromEntries(d.figures.map((x) => [x.factId, x.amountMinor]));
    const ref = await refusal(() => partner.c.setState(A, rid, v, "REVIEWED", "Attempted review with a prior-closing discrepancy"));
    return r.outcome === "saved" && f["fact:line:cf:opening:COMPARATIVE_1"] === "499900" && f["fact:line:cf:closing:COMPARATIVE_1"] === "799900" && f["fact:line:cf:opening:CURRENT"] === "800000"
      && rd.blockers.includes("CASHFLOW_CLOSING_CASH_TIE:COMPARATIVE_1:-100") && rd.blockers.includes("CASHFLOW_OPENING_NOT_PRIOR_CLOSING:100") && /PT409/.test(ref ?? "")
      ? true : { r: r.outcome, opening: f["fact:line:cf:opening:COMPARATIVE_1"], closing: f["fact:line:cf:closing:COMPARATIVE_1"], b: rd.blockers, ref };
  });

  // ── L ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("L. Evidence-backed ties: an equity movement that no longer agrees with the composed statements blocks by name");
  await check("a dividend of 8.00 instead of 7.00 (closing stated 109.00): the statement casts but total equity no longer equals the statement of financial position (SOCIE_CLOSING_EQUITY_TIE); REVIEWED refused", async () => {
    const rid = `rpt-tie-${uuid()}`;
    const eq = parse("EQUITY_MOVEMENTS", "CURRENT", EVIDENCE_FY2026.EQUITY_MOVEMENTS.replace("-700.00,Final dividend", "-800.00,Final dividend").replace("CLOSING_BALANCE,11000.00", "CLOSING_BALANCE,10900.00"));
    const r = await attempt(pre, rid, [eq]);
    const v = await latest(rid);
    const rd = await readiness(rid, v);
    const ref = await refusal(() => partner.c.setState(A, rid, v, "REVIEWED", "Attempted review with equity not tying"));
    return r.outcome === "saved" && rd.blockers.includes("SOCIE_CLOSING_EQUITY_TIE:CURRENT:-10000") && !rd.blockers.some((b) => b.startsWith("SOCIE_COMPONENT_DOES_NOT_CAST")) && /PT409/.test(ref ?? "") ? true : { r: r.outcome, b: rd.blockers, ref };
  });
  await check("a stated closing balance that does not equal opening + movements: SOCIE_COMPONENT_DOES_NOT_CAST by component and period", async () => {
    const rid = `rpt-cast-${uuid()}`;
    const eq = parse("EQUITY_MOVEMENTS", "CURRENT", EVIDENCE_FY2026.EQUITY_MOVEMENTS.replace("CLOSING_BALANCE,11000.00", "CLOSING_BALANCE,11001.00"));
    const r = await attempt(pre, rid, [eq]);
    const v = await latest(rid);
    const rd = await readiness(rid, v);
    return r.outcome === "saved" && rd.blockers.includes("SOCIE_COMPONENT_DOES_NOT_CAST:Retained earnings:CURRENT:100") ? true : { r: r.outcome, b: rd.blockers };
  });
  await check("a ledger row naming an account the cash review did not establish as cash: CASHFLOW_LEDGER_ACCOUNT_NOT_CASH and the account-by-account rollforward difference", async () => {
    const rid = `rpt-ledger-${uuid()}`;
    const ledger = parse("TRANSACTION_LEDGER", "CURRENT", EVIDENCE_FY2026.TRANSACTION_LEDGER.replace("T7,2026-12-20,1000,", "T7,2026-12-20,1100,"));
    const r = await attempt(pre, rid, [ledger]);
    const v = await latest(rid);
    const rd = await readiness(rid, v);
    return r.outcome === "saved" && rd.blockers.includes("CASHFLOW_LEDGER_ACCOUNT_NOT_CASH:1100") && rd.blockers.includes("CASHFLOW_ACCOUNT_ROLLFORWARD:1000:60000") ? true : { r: r.outcome, b: rd.blockers };
  });

  // ── ED ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("ED. The supported edition: a period under the third edition is refused by name");
  await check("the owner elects early application of the third edition: the composition resolves to ifrs-for-smes/2025, a new version is FRAMEWORK_EDITION_UNSUPPORTED, REVIEWED refused, a direct publication refused by the trigger; withdrawing the election restores the 2015 edition", async () => {
    const rid = `rpt-edition-${uuid()}`;
    const elect = (on) => asU(U.owner, "SELECT public.fs_elect_early_application($1,$2,$3,'NBAA-2026-TEST-CONFIRMATION','Edition refusal case') r", [A, Y, on]).then((r) => r.r);
    const e1 = await elect(true);
    const r = await attempt(pre, rid);
    const v = await latest(rid);
    const d = await deps();
    const rd = await readiness(rid, v);
    const ref = await refusal(() => partner.c.setState(A, rid, v, "REVIEWED", "Attempted review under the third edition"));
    await saveDoc(rid, v + 1, { ...(await stored(rid, v)).report_document }, (await stored(rid, v)).evidence_batch_ids);
    const direct = await refusal(() => db.admin.query("INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,$2,$3,'REVIEWED','bypass attempt',$4)", [rid, v + 1, A, partnerMember]));
    const e2 = await elect(false);
    const d2 = await deps();
    return e1.outcome === "recorded" && r.outcome === "saved" && d.packId === "ifrs-for-smes/2025" && rd.blockers.includes("FRAMEWORK_EDITION_UNSUPPORTED:ifrs-for-smes/2025") && /PT409/.test(ref ?? "")
      && /PT409:(FRAMEWORK_EDITION_UNSUPPORTED|BINDING_STALE)/.test(direct ?? "") && e2.outcome === "recorded" && d2.packId === "ifrs-for-smes/2015" ? true : { e1, r: r.outcome, pack: d.packId, b: rd.blockers, ref, direct, e2, pack2: d2.packId };
  });

  // ── L2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("L2. An approved adjustment after REVIEWED reaches every dependent statement consistently");
  const ridAdj = `rpt-adjust-${uuid()}`;
  let vAdj, adjustmentId;
  // The cases above left the company's latest evidence deliberately wrong (an orphan ledger account, an equity movement
  // that does not tie, a restated prior opening). Identical content replays the old batch instead of superseding it, so a
  // clean world is restored the way a preparer would: the same figures and identities, re-described, as new versions.
  const RESTORED = [
    parse("TRANSACTION_LEDGER", "CURRENT", EVIDENCE_FY2026.TRANSACTION_LEDGER.replace("Receipts from customers,28700.00", "Receipts from customers (final ledger),28700.00")),
    parse("EQUITY_MOVEMENTS", "CURRENT", EVIDENCE_FY2026.EQUITY_MOVEMENTS.replace("Share capital,OPENING_BALANCE,10000.00,", "Share capital,OPENING_BALANCE,10000.00,Brought forward (final)")),
    parse("PRIOR_PERIOD_STATEMENTS", "COMPARATIVE", EVIDENCE_FY2025_COMPARATIVE.PRIOR_PERIOD_STATEMENTS.replace("Cash and cash equivalents at 1 January 2025,", "Cash and cash equivalents at 1 January 2025 (signed),")),
  ];
  await check("the company's evidence is restored to agreeing figures by re-described replacement files: a fresh version is ready", async () => {
    const r = await attempt(pre, ridAdj, RESTORED);
    const rd = await readiness(ridAdj, await latest(ridAdj));
    return r.outcome === "saved" && rd.ready === true ? true : { r: r.outcome, b: rd.blockers };
  });
  await check("REVIEWED; then a balanced adjustment (rent 5.00 to payables) is proposed and approved: the reviewed version is stale (REPORTING_INPUT_STALE, REPORTING_DEPENDENCIES_STALE); FINAL refused", async () => {
    vAdj = await latest(ridAdj);
    await partner.c.setState(A, ridAdj, vAdj, "REVIEWED", "Reviewed before the adjustment");
    const prop = (await asU(U.preparer, "SELECT public.close_review_propose_adjustment($1,$2,'Rent invoice received after the trial balance',NULL,$3::jsonb,'{}'::uuid[],$4,NULL) r",
      [A, Y, JSON.stringify([{ accountKey: "6100", debitMinor: "500", creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: "500" }]), uuid()])).r;
    adjustmentId = prop.adjustmentId;
    const dec = (await asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed to the invoice',NULL,$2) r", [adjustmentId, uuid()])).r;
    const rd = await readiness(ridAdj, vAdj);
    const fin = await refusal(() => owner.c.setState(A, ridAdj, vAdj, "FINAL", "Approving a review that predates the adjustment"));
    return prop.adjustmentId && dec.outcome === "recorded" && rd.blockers.includes("REPORTING_INPUT_STALE") && rd.blockers.includes("REPORTING_DEPENDENCIES_STALE") && /PT409/.test(fin ?? "") ? true : { prop, dec, b: rd.blockers, fin };
  });
  await check("the next version carries the recomposed figures (profit 5,095.00; payables 3,105.00) and is refused until the equity evidence agrees: SOCIE_PROFIT_TIE and SOCIE_CLOSING_EQUITY_TIE of 5.00", async () => {
    const r = await attempt(pre, ridAdj);
    const v = await latest(ridAdj);
    const d = await deps();
    const f = Object.fromEntries(d.figures.map((x) => [x.factId, x.amountMinor]));
    const rd = await readiness(ridAdj, v);
    const doc = (await stored(ridAdj, v)).report_document;
    const docFacts = new Map(doc.facts.map((x) => [x.factId, x.value.minorUnits.__bigint__]));
    return r.outcome === "saved" && f["fact:current:total:profitOrLossMinor"] === "509500" && f["fact:current:current_liabilities:sfp.trade_and_other_payables"] === "310500"
      && docFacts.get("fact:current:total:profitOrLossMinor") === "509500" && docFacts.get("fact:current:current_liabilities:sfp.trade_and_other_payables") === "310500"
      && f["fact:current:account:6100"] === "240500" && rd.blockers.includes("SOCIE_PROFIT_TIE:CURRENT:500") && rd.blockers.includes("SOCIE_CLOSING_EQUITY_TIE:CURRENT:500")
      ? true : { r: r.outcome, profit: f["fact:current:total:profitOrLossMinor"], payables: f["fact:current:current_liabilities:sfp.trade_and_other_payables"], b: rd.blockers };
  });
  await check("re-supplied equity movements (result 5,095.00; closing 10,995.00): the next version ties everywhere, is ready, REVIEWED and FINAL", async () => {
    const eq = parse("EQUITY_MOVEMENTS", "CURRENT", EVIDENCE_FY2026.EQUITY_MOVEMENTS.replace("PROFIT_OR_LOSS,5100.00", "PROFIT_OR_LOSS,5095.00").replace("CLOSING_BALANCE,11000.00", "CLOSING_BALANCE,10995.00"));
    const r = await attempt(pre, ridAdj, [eq]);
    const v = await latest(ridAdj);
    const d = await deps();
    const f = Object.fromEntries(d.figures.map((x) => [x.factId, x.amountMinor]));
    const rd = await readiness(ridAdj, v);
    const rv = await partner.c.setState(A, ridAdj, v, "REVIEWED", "Reviewed on the adjusted figures");
    const fin = await owner.c.setState(A, ridAdj, v, "FINAL", "Approved");
    return r.outcome === "saved" && f["fact:line:eq:total-closing:CURRENT"] === "2099500" && f["fact:line:eq:total-profit:CURRENT"] === "509500" && f["fact:current:total:totalEquityMinor"] === "2099500"
      && rd.ready === true && rv.state === "REVIEWED" && fin.state === "FINAL" ? true : { r: r.outcome, closing: f["fact:line:eq:total-closing:CURRENT"], equity: f["fact:current:total:totalEquityMinor"], b: rd.blockers };
  });

  // ── J2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("J2. Roll-forward: the next period's comparative, as reported, against the prior year's issued FINAL");
  let vIssued;
  await check("a second adjustment (rent 2.00 to payables) is approved AFTER FY2026 was issued: the issued version is unchanged but FY2026's authority has moved", async () => {
    vIssued = await latest(ridAdj);
    const prop = (await asU(U.preparer, "SELECT public.close_review_propose_adjustment($1,$2,'Late rent invoice found after issue',NULL,$3::jsonb,'{}'::uuid[],$4,NULL) r",
      [A, Y, JSON.stringify([{ accountKey: "6100", debitMinor: "200", creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: "200" }]), uuid()])).r;
    const dec = (await asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed',NULL,$2) r", [prop.adjustmentId, uuid()])).r;
    const pub = (await db.admin.query("SELECT state FROM public.financial_statement_publications WHERE report_id=$1 AND report_version=$2 ORDER BY seq", [ridAdj, vIssued])).rows.map((x) => x.state);
    const rd = await readiness(ridAdj, vIssued);
    return dec.outcome === "recorded" && pub.join(",") === "REVIEWED,FINAL" && rd.blockers.includes("REPORTING_INPUT_STALE") ? true : { dec, pub, b: rd.blockers };
  });
  await check("FY2027 certified (the same balances): its comparative is FY2026 as it now stands; the latest issued FY2026 FINAL predates the second adjustment, so the difference is preserved and named for exactly the two lines it moved", async () => {
    const c = await k.upload(A, Y + 1, csv(FY2026)); await k.certify(A, c);
    const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y + 1])).r;
    const open = (await db.admin.query("SELECT f.id FROM public.close_review_findings f WHERE f.run_id=$1", [run.runId])).rows;
    for (const f of open) await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain','Accumulated depreciation is a contra-asset by design','Fixed asset register 2027',$2) r", [f.id, uuid()]);
    const pf = (await asU(U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [A, Y + 1])).r;
    const d = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y + 1])).r;
    const want = ["COMPARATIVE_NOT_AS_ISSUED:fact:comparative:current_liabilities:sfp.trade_and_other_payables:200", "COMPARATIVE_NOT_AS_ISSUED:fact:comparative:sci:sci.operating_expenses_by_function:200"];
    const got = d.blockers.filter((b) => b.startsWith("COMPARATIVE_NOT_AS_ISSUED"));
    return pf.state === "differences" && pf.priorFinal.reportId === ridAdj && pf.priorFinal.reportVersion === vIssued && JSON.stringify(got) === JSON.stringify(want) && d.state === "current"
      ? true : { pf: { state: pf.state, prior: pf.priorFinal, diffs: pf.differences }, got };
  });
  await check("the issued documents are untouched; a period with no issued prior year has nothing to reconcile to (no_prior_final)", async () => {
    const pf = (await asU(U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [A, Y])).r;
    const now = await stored(rid1, vFinal);
    const issued = await stored(ridAdj, vIssued);
    const b = (await db.admin.query("SELECT document_sha256 FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2 AND state='FINAL'", [ridAdj, vIssued])).rows[0];
    return pf.state === "no_prior_final" && now.doc_sha === storedFinal.doc_sha && b?.document_sha256 === issued.doc_sha ? true : { pf: pf.state };
  });

  // ── I ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("I. Issued history unchanged");
  await check("after every later version, replacement and discrepancy above, the FINAL version's document, content hash and both bindings are byte-identical; bindings cannot be altered", async () => {
    const now = await stored(rid1, vFinal);
    const binds = (await db.admin.query("SELECT state, document_sha256, declared_content_hash, dependencies_sha256, dependencies, approver_role FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2 ORDER BY seq", [rid1, vFinal])).rows;
    const pubs = (await db.admin.query("SELECT state FROM public.financial_statement_publications WHERE report_id=$1 AND report_version=$2 ORDER BY seq", [rid1, vFinal])).rows.map((x) => x.state);
    const upd = await refusal(() => db.admin.query("UPDATE public.fs_publication_bindings SET state='REVIEWED' WHERE report_id=$1", [rid1]));
    return now.doc_sha === storedFinal.doc_sha && now.content_hash === storedFinal.content_hash && JSON.stringify(binds) === JSON.stringify(bindingsFinal) && pubs.join(",") === "REVIEWED,FINAL" && /^42501/.test(upd ?? "") ? true : { pubs, upd };
  });
  await check("the FINAL version stays immutable and later versions never reopened it (PT409)", async () => {
    const r = await refusal(() => partner.c.setState(A, rid1, vFinal, "REVIEWED", "reopen attempt"));
    return /PT409/.test(r ?? "") ? true : r;
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish(ABSENT ? "PUBLICATION_CONTROLS (control ABSENT — failures expected)" : "PUBLICATION_CONTROLS", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
