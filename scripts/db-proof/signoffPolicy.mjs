#!/usr/bin/env bun
// Real-PostgreSQL proof of the statement sign-off policy (20261024100000) and the classification of the three shared
// reporting catalogues.
//
//   catalogues   fs_presentation_lines, fs_pack_requirements, fs_schedule_definitions: no tenant column, readable by
//                signed-in users only, no client write, RLS on — intentional shared, read-only framework definitions
//   preserved    a version sealed BEFORE the migration by one owner (REVIEWED and FINAL, as hosted version 6) keeps its
//                bindings byte for byte and its pack renders exactly as before (no approvals inferred)
//   release      applied through the exact hosted artifacts: preflight, self-checking wrapper, postcondition
//   default      separate approvers: the owner who reviewed cannot approve as final (refused, nothing recorded); a
//                different approver can; both approvers are recorded and disclosed in the pack
//   policy       set only by a member who manages members, with a reason; solo_owner needs the exact confirmation;
//                replay-safe; append-only; readable by members only
//   solo owner   under the recorded policy the owner records both; the binding records it and the pack discloses the
//                same person, the policy and its reason; a non-owner reviewer still cannot approve their own review
//   revert       separate approvers again: the owner's own final approval is refused again
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/signoffPolicy.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyChainBefore, assignmentPairs, ASSIGN, certifier, clientDb, COMPREHENSIVE_INCOME_DECISIONS, csv, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026,
  FY2025, FY2026, makeWorld, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient, SOLO_OWNER_CONFIRMATION } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { packSignOffFor } from "../../src/lib/reporting/packSignOff.ts";
import { buildReportPack } from "../../src/lib/exports/reportPack.ts";
import { readStoredReport } from "../../src/lib/financialGeneration/composedReport.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIX = "20261024100000_fs_signoff_approval_policy.sql";
const WRAPPER = fs.readFileSync(path.join(REPO, "release/wrappers", FIX.replace(/\.sql$/, ".wrapper.sql")), "utf8");
const PREFLIGHT = fs.readFileSync(path.join(REPO, "docs/release/reporting-r5/preflight.sql"), "utf8");
const POSTCONDITION = fs.readFileSync(path.join(REPO, "docs/release/reporting-r5/postcondition.sql"), "utf8");
const CATALOGUES = ["fs_presentation_lines", "fs_pack_requirements", "fs_schedule_definitions"];
const { group, check, finish } = reporter();
let db;

async function main() {
  db = await openDatabase("signoff_policy_proof");
  group("Replay up to (not including) the policy");
  await check("the chain before 20261024100000 applies", async () => (await applyChainBefore(db, FIX)) ?? true);
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  let pre, partner, owner, viewer;
  const reload = () => { const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; }; pre = as(U.preparer); partner = as(U.partner); owner = as(U.owner); viewer = as(U.viewer); };
  reload();
  const rid = `fsr-${Y}-${A}`;
  const save = (newEvidence) => prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: `sp-${uuid()}`, evaluatedAt: new Date().toISOString() });
  const parse = (type, role) => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2,
      text: (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type], fileName: `${type}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected`);
    return r.batch;
  };
  let wording = 0;
  const newVersion = async () => {
    await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.estimates',$3,'Notes',$4)", [A, Y, `Useful lives (revision ${++wording}).`, uuid()]);
    const s = await save([]);
    if (s.outcome !== "saved") throw new Error(`not saved: ${s.reason}`);
    return s.reportVersion;
  };
  const sign = async (who, v, state) => { try { await who.c.setState(A, rid, v, state, `${state} by proof`); return "ok"; } catch (e) { return String(e.message); } };
  const packFor = async (v, state) => {
    const stored = await owner.c.report(rid, v);
    const bindings = (await owner.c.bindings(rid)).filter((b) => b.reportVersion === v);
    const fin = bindings.find((b) => b.state === state);
    const ev = fin?.signoffPolicy === "solo_owner" && fin.signoffPolicyEventId ? await owner.c.signoffPolicyEvent(fin.signoffPolicyEventId) : null;
    return buildReportPack({ document: readStoredReport(stored.document), entityName: "Synthetic SME Limited", editionTitle: "IFRS for SMEs (2015 edition)", adjustments: [],
      signOff: packSignOffFor(state, bindings, ev ? { reason: ev.reason, setAt: ev.setAt } : null) }).html;
  };

  group("Shared catalogues (the three USING (true) read policies of the reporting release)");
  for (const t of CATALOGUES) {
    await check(`${t}: no tenant or person column; RLS on; only SELECT for authenticated, nothing for anon; one permissive read policy`, async () => {
      const cols = (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [t])).rows.map((r) => r.column_name);
      const grants = (await db.admin.query("SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name=$1 AND grantee IN ('anon','authenticated') ORDER BY 1,2", [t])).rows.map((r) => `${r.grantee}:${r.privilege_type}`);
      const pol = (await db.admin.query("SELECT policyname, cmd, roles::text, qual FROM pg_policies WHERE schemaname='public' AND tablename=$1", [t])).rows;
      const rls = (await db.one("SELECT relrowsecurity r FROM pg_class WHERE oid = $1::regclass", [`public.${t}`])).r;
      const tenant = cols.filter((c) => /company|user|member|actor|owner|email|created_by/.test(c));
      return rls && tenant.length === 0 && JSON.stringify(grants) === '["authenticated:SELECT"]' && pol.length === 1 && pol[0].cmd === "SELECT" && pol[0].qual === "true" && pol[0].roles === "{authenticated}"
        ? true : { cols, grants, pol, rls, tenant };
    });
    await check(`${t}: signed-in users read the shared definitions; INSERT, UPDATE and DELETE are refused; anon is refused`, async () => {
      const n = (await db.asRole("authenticated", U.ownerB, `SELECT count(*)::int n FROM public.${t}`))[0].n;
      const out = [];
      for (const sql of [`INSERT INTO public.${t} DEFAULT VALUES`, `UPDATE public.${t} SET pack_family = pack_family`, `DELETE FROM public.${t}`, `SELECT 1 FROM public.${t} LIMIT 1`]) {
        const role = sql.startsWith("SELECT") ? "anon" : "authenticated";
        try { await db.asRole(role, role === "anon" ? null : U.ownerB, sql); out.push("allowed"); } catch (e) { out.push(e.code); }
      }
      return n > 0 && out.every((c) => c === "42501") ? true : { n, out };
    });
  }

  group("A version sealed before the policy, by one owner (as hosted version 6)");
  let sealed, sealedBindings, sealedPack;
  await check("two certified years, presentation, notes, schedule, comparatives, Close Review; version 2 REVIEWED and FINAL by the owner", async () => {
    const p = await k.upload(A, Y - 1, csv(FY2025)); await k.review(A, p); await k.certify(A, p);
    const c = await k.upload(A, Y, csv(FY2026)); await k.certify(A, c);
    await asU(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Presentation',$3)", [A, JSON.stringify(assignmentPairs(ASSIGN)), uuid()]);
    await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,'smes.note.share_capital','applicable','Share capital',$3)", [A, Y, uuid()]);
    for (const id of COMPREHENSIVE_INCOME_DECISIONS) await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,'not_applicable','None',$4)", [A, Y, id, uuid()]);
    for (const [id, t] of Object.entries({ "smes.note.compliance": "Synthetic.", "smes.note.identification": "Synthetic SME Limited.", "smes.note.policies": "Historical cost.",
      "smes.note.judgements": "None.", "smes.note.estimates": "Useful lives.", "smes.note.subclassifications": "Third parties.", "smes.note.share_capital": "10,000 shares." }))
      await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Notes v1',$5)", [A, Y, id, t, uuid()]);
    await asU(U.preparer, "SELECT public.fs_record_schedule($1,$2,'ppe',$3::jsonb,'Register',$4)", [A, Y, JSON.stringify([{ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }]), uuid()]);
    await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed',$3) r", [A, Y, uuid()]);
    const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y])).r;
    for (const f of (await db.admin.query("SELECT id FROM public.close_review_findings WHERE run_id=$1", [run.runId])).rows)
      await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain','Contra-asset by design','Register',$2) r", [f.id, uuid()]);
    const s = await save([...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t, "CURRENT")), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))]);
    sealed = s.reportVersion;
    const r1 = await sign(owner, sealed, "REVIEWED"), r2 = await sign(owner, sealed, "FINAL");
    sealedBindings = JSON.stringify((await db.admin.query("SELECT publication_id, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings WHERE report_id=$1 ORDER BY approved_at", [rid])).rows);
    sealedPack = await packFor(sealed, "FINAL");
    return r1 === "ok" && r2 === "ok" ? true : { r1, r2 };
  });

  group("The release, as hosted: preflight, self-checking wrapper, postcondition");
  await check("the postcondition refuses before the wrapper; the preflight passes", async () => {
    try { await db.admin.query(POSTCONDITION); return "postcondition passed early"; } catch (e) { if (!/POSTCONDITION/.test(e.message)) return e.message; }
    await db.admin.query(PREFLIGHT); return true;
  });
  await check("the wrapper applies; the postcondition passes; the preflight and a re-application are refused", async () => {
    await db.admin.query(WRAPPER);
    reload();
    await db.admin.query(POSTCONDITION);
    const out = [];
    for (const sql of [PREFLIGHT, WRAPPER]) { try { await db.admin.query(sql); out.push("ran"); } catch (e) { out.push(/PREFLIGHT/.test(e.message) ? "refused" : e.message); } }
    return out.every((x) => x === "refused") ? true : out;
  });
  await check("the sealed version's bindings are unchanged (the new columns NULL) and its pack renders byte for byte as before", async () => {
    const now = JSON.stringify((await db.admin.query("SELECT publication_id, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings WHERE report_id=$1 ORDER BY approved_at", [rid])).rows);
    const cols = (await db.admin.query("SELECT signoff_policy, signoff_policy_event_id, same_approver FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2", [rid, sealed])).rows;
    const pack = await packFor(sealed, "FINAL");
    return now === sealedBindings && cols.every((c) => c.signoff_policy === null && c.signoff_policy_event_id === null && c.same_approver === null) && pack === sealedPack && !/Statement sign-off/.test(pack)
      ? true : { same: now === sealedBindings, cols, packSame: pack === sealedPack };
  });

  group("Default: separate approvers");
  let v;
  await check("the policy in force is separate_approvers (no event recorded)", async () => {
    const s = await viewer.c.signoffPolicy(A);
    return s.state === "current" && s.policy === "separate_approvers" && s.recorded === false ? true : s;
  });
  await check("the owner who reviewed cannot approve as final: refused by name, nothing recorded", async () => {
    v = await newVersion();
    const r = await sign(owner, v, "REVIEWED");
    const f = await sign(owner, v, "FINAL");
    const pub = (await owner.c.publications(rid)).filter((p) => p.reportVersion === v).map((p) => p.state);
    return r === "ok" && /SIGNOFF_SEPARATE_APPROVERS_REQUIRED/.test(f) && JSON.stringify(pub) === '["REVIEWED"]' ? true : { r, f, pub };
  });
  await check("separate people: the partner reviews, the owner approves; both bindings record the policy; the pack names both", async () => {
    v = await newVersion();
    const r = await sign(partner, v, "REVIEWED"), f = await sign(owner, v, "FINAL");
    const b = (await db.admin.query("SELECT state, signoff_policy, signoff_policy_event_id, same_approver FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2 ORDER BY approved_at", [rid, v])).rows;
    const pack = await packFor(v, "FINAL");
    return r === "ok" && f === "ok" && b.length === 2 && b.every((x) => x.signoff_policy === "separate_approvers" && x.signoff_policy_event_id === null) && b[1].same_approver === false
      && /Statement sign-off: reviewed by .+ on .+; approved as final by .+ on .+ \(separate approvers\)\./.test(pack) && /FINAL — reviewed by .+; signed off by /.test(pack) ? true : { r, f, b, pack: pack.slice(0, 300) };
  });

  group("Setting the policy");
  await check("only a member who manages members may set it (a preparer and the partner are refused)", async () => {
    const out = [];
    for (const who of [pre, partner]) out.push((await who.c.setSignoffPolicy(A, "solo_owner", "The firm has one owner", SOLO_OWNER_CONFIRMATION, uuid())).outcome);
    const n = await db.count("SELECT count(*) n FROM public.fs_signoff_policy_events WHERE company_id=$1", [A]);
    return out.every((o) => o === "forbidden") && n === 0 ? true : { out, n };
  });
  await check("solo_owner without the exact confirmation, or with a short reason, is refused; nothing recorded", async () => {
    const a = (await owner.c.setSignoffPolicy(A, "solo_owner", "The firm has one owner", null, uuid())).outcome;
    const b = (await owner.c.setSignoffPolicy(A, "solo_owner", "The firm has one owner", SOLO_OWNER_CONFIRMATION.replace("every", "each"), uuid())).outcome;
    const c = (await owner.c.setSignoffPolicy(A, "solo_owner", "short", SOLO_OWNER_CONFIRMATION, uuid())).outcome;
    const n = await db.count("SELECT count(*) n FROM public.fs_signoff_policy_events WHERE company_id=$1", [A]);
    return a === "confirmation_required" && b === "confirmation_required" && c === "invalid_request" && n === 0 ? true : { a, b, c, n };
  });
  let req;
  await check("recorded with a reason and the confirmation; a retry of the same request records nothing new; the events are append-only", async () => {
    req = uuid();
    const a = await owner.c.setSignoffPolicy(A, "solo_owner", "The firm has one owner and no second approver", SOLO_OWNER_CONFIRMATION, req);
    const b = await owner.c.setSignoffPolicy(A, "solo_owner", "The firm has one owner and no second approver", SOLO_OWNER_CONFIRMATION, req);
    const n = await db.count("SELECT count(*) n FROM public.fs_signoff_policy_events WHERE company_id=$1", [A]);
    let upd = "allowed"; try { await db.admin.query("UPDATE public.fs_signoff_policy_events SET reason='changed reason here' WHERE company_id=$1", [A]); } catch (e) { upd = /append-only/.test(e.message) ? "refused" : e.message; }
    return a.outcome === "recorded" && b.outcome === "recorded" && b.replay === true && n === 1 && upd === "refused" ? true : { a, b, n, upd };
  });
  await check("readable by the company's members only (another workspace's owner reads nothing and is refused the policy)", async () => {
    const mine = await viewer.c.signoffPolicy(A);
    const other = clientDb(db, U.ownerB);
    const sel = await other.select("fs_signoff_policy_events", { company_id: A });
    const pol = await signoffClient(other).signoffPolicy(A);
    return mine.policy === "solo_owner" && mine.recorded === true && sel.data?.length === 0 && pol.state === "unavailable" ? true : { mine, sel: sel.data?.length, pol };
  });

  group("Solo owner: recorded, enforced and disclosed");
  await check("the owner records both; the binding records solo_owner, its event and same_approver; the pack discloses the same person, the policy and its reason", async () => {
    v = await newVersion();
    const r = await sign(owner, v, "REVIEWED"), f = await sign(owner, v, "FINAL");
    const b = (await db.admin.query("SELECT state, signoff_policy, signoff_policy_event_id, same_approver FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2 ORDER BY approved_at", [rid, v])).rows;
    const pack = await packFor(v, "FINAL");
    return r === "ok" && f === "ok" && b[1]?.signoff_policy === "solo_owner" && b[1].same_approver === true && b[1].signoff_policy_event_id
      && /reviewed and approved as final by the same person, .+ under the company's recorded solo-owner sign-off policy set on .+: The firm has one owner and no second approver\./.test(pack)
      && /\(the same person, under the recorded solo-owner policy\)/.test(pack) ? true : { r, f, b, pack: pack.slice(0, 400) };
  });
  await check("under solo_owner a non-owner still cannot approve their own review", async () => {
    const can = (await db.one("SELECT public.workspace_capability_allowed($1,$2,'approve_certification') a", [A, U.partner])).a;
    v = await newVersion();
    const r = await sign(partner, v, "REVIEWED"), f = await sign(partner, v, "FINAL");
    return r === "ok" && (can ? /SIGNOFF_SEPARATE_APPROVERS_REQUIRED/.test(f) : f !== "ok") ? true : { can, r, f };
  });

  group("Back to separate approvers");
  await check("recorded with a reason (no confirmation needed); the owner's own final approval is refused again", async () => {
    const s = await owner.c.setSignoffPolicy(A, "separate_approvers", "A second partner has joined the firm", null, uuid());
    v = await newVersion();
    const r = await sign(owner, v, "REVIEWED"), f = await sign(owner, v, "FINAL");
    return s.outcome === "recorded" && r === "ok" && /SIGNOFF_SEPARATE_APPROVERS_REQUIRED/.test(f) ? true : { s, r, f };
  });
  await check("every earlier sealed pack is unchanged by the later policy changes", async () => {
    return (await packFor(sealed, "FINAL")) === sealedPack ? true : "the pre-policy sealed pack changed";
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("SIGNOFF_POLICY", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
