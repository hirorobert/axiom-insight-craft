#!/usr/bin/env bun
// Real-PostgreSQL proof of the first-period review PAGE's server side: the delta 20261223100000 over 20261217100000 (defect S2-A03; the
// part of PR #269 beyond PR #256). It is the "UI" group of PR #269's proof, made to run on the integrated chain: the same calls, in the
// page's order, through src/lib/comparatives/firstPeriodReview.ts over the real client transport (clientDb: PostgREST's argument
// binding, a STABLE read in a READ ONLY transaction), each state read through the page's own mapping (reviewView).
//
//   The governed review itself (the exception is a verified decision by a different approver; legacy declarations are claims; staleness;
//   races with sign-off) is proven by scripts/db-proof/firstPeriodGovernedReview.mjs against 20261217100000. This proof adds only what the
//   delta adds: the read model (entity, the server's dates, current evidence, per-subject claim/decision/cited revisions, the binding) and
//   the approver's binding guard (p_expected_binding -> changed_since_viewed).
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/firstPeriodReviewPage.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
//   FIRST_PERIOD_PAGE_ABSENT=1 applies the chain WITHOUT the delta and runs the page cases: the regression run. It MUST fail (the old
//   status has no entity/period/evidence/binding and the old decide function takes no binding). Its output is evidence, not a pass.
import { applyChainBefore, certifier, chainFiles, clientDb, csv, FY2026, makeWorld, migrationText, openDatabase, prepareReporting, reporter, uuid } from "./lib/reportingKit.mjs";
import { blockersOf, sha, withMissingComparativeDates } from "./lib/firstPeriodKit.mjs";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { firstPeriodClient, firstPeriodFacts, reviewView } from "../../src/lib/comparatives/firstPeriodReview.ts";
import { FIRST_PERIOD_NEXT_ACTIONS } from "../../src/lib/comparatives/firstPeriodNextActions.ts";

const FILE = "20261223100000_first_period_review_page_read_model.sql";
const BASE = "20261217100000_first_period_governed_review.sql";
const ABSENT = process.env.FIRST_PERIOD_PAGE_ABSENT === "1";
const { group, check, refused, finish } = reporter();
const MINE = /^(COMPARATIVE_|FIRST_PERIOD_|OPENING_SUPPORT_)/;
const ours = (b) => b.filter((x) => MINE.test(x));
const Y = 2026;
let db;

async function main() {
  db = await openDatabase(ABSENT ? "firstpage_absent" : "firstpage_proof");
  group(ABSENT ? "Replay WITHOUT the delta (regression run: the page cases must fail)" : "Replay (the chain before the delta)");
  await check(`the chain before ${FILE} applies`, async () => (await applyChainBefore(db, FILE)) ?? true);
  await check(`${BASE} is applied before ${FILE} in the current chain, and the standalone port is not in the chain`, async () => {
    const c = chainFiles();
    return c.indexOf(BASE) >= 0 && c.indexOf(BASE) < c.indexOf(FILE) && !c.some((f) => /first_period_governed_review_standalone/.test(f)) ? true : c.slice(-6);
  });

  const W = await makeWorld(db);
  const { U } = W;
  // This proof creates a few workspaces under one owner: lift the plan's entity capacity (a commercial rule, not under test).
  await db.admin.query("SET session_replication_role = replica");
  await db.admin.query("UPDATE public.commercial_licences SET plan_id = (SELECT p.id FROM public.commercial_plans p JOIN public.commercial_products pr ON pr.id = p.product_id WHERE pr.code='CFOCLOSE' AND p.code='FIRM'), additional_seats = 50 WHERE billing_customer_id = (SELECT id FROM public.billing_customers WHERE owner_user_id = $1)", [U.owner]);
  await db.admin.query("SET session_replication_role = origin");
  await W.rollout(W.A, true);
  const k = await certifier(db, U);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const pre = (() => { const d = withMissingComparativeDates(clientDb(db, U.preparer)); return { d, c: signoffClient(d) }; })();
  const attempt = (company, rid, name) => prepareReportVersion(pre.d, pre.c, { companyId: company, periodYear: Y, legalName: name, reportId: rid, newEvidence: [], idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  const members = async (company) => { for (const m of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [company, U[m], m]); };
  /** A workspace whose ONLY trial balance is FY2026 (no earlier CFOClose books), with its exact reporting dates. */
  const entity = async (name, { start = `${Y}-01-01`, end = `${Y}-12-31`, prepared = true } = {}) => {
    const co = await W.company(U.owner, name); await members(co); await W.rollout(co, true);
    const up = await k.upload(co, Y, csv(FY2026), { start, end }); await k.review(co, up); await k.certify(co, up);
    if (prepared) await prepareReporting(db, { U, A: co }, k, { year: Y, uploads: false, comparativesApproved: false });
    return co;
  };
  const light = async (co, name) => { const rid = `rpt-fp-${uuid()}`; const r = await attempt(co, rid, name); if (r.outcome !== "saved") throw new Error(`no version: ${JSON.stringify(r).slice(0, 300)}`); return { rid, v: r.reportVersion }; };
  const bl = (co, rep) => blockersOf(db, U.partner, co, rep.rid, rep.v);
  const comparatives = async (co) => (await asU(U.owner, "SELECT public.fs_comparatives_status($1,$2) r", [co, Y])).r.comparative;

  // ── The delta applies, once, and changes nothing but the three functions ─────────────────────────────────────────────
  group("MIG. The delta applies on the chain (it needs 20261217100000) and replaces exactly the decide function and the status read model");
  const rowsBefore = async () => Number((await db.admin.query("SELECT (SELECT count(*) FROM public.fs_first_period_claims)+(SELECT count(*) FROM public.fs_first_period_decisions)+(SELECT count(*) FROM public.fs_first_period_evidence)+(SELECT count(*) FROM public.fs_first_period_declarations) n")).rows[0].n);
  if (!ABSENT) {
    const n0 = await rowsBefore();
    await check(`${FILE} applies`, async () => { try { await db.admin.query(migrationText(FILE)); return true; } catch (e) { return `${e.code}: ${e.message}`; } });
    await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");
    await check("no first-period row was created or changed by the delta", async () => (await rowsBefore()) === n0 ? true : "rows changed");
    await check("one decide function remains (seven arguments), the view helper is not client-callable, anon reaches nothing, authenticated reads and decides", async () => {
      const q = await db.one(`SELECT
        (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='fs_decide_first_period')::int n,
        has_function_privilege('authenticated','public._fs_fp_review_view(uuid,integer,uuid,uuid,uuid)','EXECUTE') v,
        has_function_privilege('anon','public.fs_decide_first_period(uuid,integer,text,boolean,text,uuid,text)','EXECUTE') a1,
        has_function_privilege('anon','public.fs_first_period_status(uuid,integer)','EXECUTE') a2,
        has_function_privilege('authenticated','public.fs_decide_first_period(uuid,integer,text,boolean,text,uuid,text)','EXECUTE') d,
        has_function_privilege('authenticated','public.fs_first_period_status(uuid,integer)','EXECUTE') s`);
      return q.n === 1 && !q.v && !q.a1 && !q.a2 && q.d && q.s ? true : q;
    });
    await check("fs_publication_blockers is NOT touched by the delta: every splice is still in the live function", async () => {
      const d = (await db.one("SELECT pg_get_functiondef('public.fs_publication_blockers(uuid,text,integer)'::regprocedure) d")).d;
      return ["fs_server_compilation_blocker", "_rfr_blockers", "_fs_document_structure_blockers", "DOCUMENT_FACT_NOT_COMPOSED", "ACCOUNT_CAPACITY_EXCEEDED", "REVIEW_COMMENT_UNRESOLVED", "_fs_first_period_pending", "_fs_opening_pending"].every((m) => d.includes(m)) ? true : "a splice is missing";
    });
  }

  // ── UI ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("UI. The Comparatives page's calls, in its order, through the browser client over the real client transport");
  const UIC = await entity("Uiflow Limited", { start: "2026-02-03", end: `${Y}-12-31` });
  const repUI = await light(UIC, "Uiflow Limited");
  const L2 = await entity("Newly Formed Limited", { prepared: false });
  const fpc = (uid) => firstPeriodClient(clientDb(db, uid));
  const BOTH = { canPrepare: true, canApprove: true }, VIEW = { canPrepare: false, canApprove: false };
  const decisionsUI = () => db.count("SELECT count(*) n FROM public.fs_first_period_decisions WHERE company_id=$1", [UIC]);
  let shownAtApproval = null;
  await check("ui.prepare-through-client: the person preparing (a partner, who also holds the approval capability) reads the review (not started), records the certificate, reads again, and submits facts built from the SERVER's reporting dates with the evidence chosen from the server's list; the page then shows awaiting approval with no approve control for them", async () => {
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
  await check("ui.same-person-cannot-approve: if the person who recorded the facts calls the decision anyway (with the binding shown), the server refuses it (separate_approver_required); a preparer without the approval capability is refused (forbidden); nothing is recorded", async () => {
    const s = await fpc(U.partner).status(UIC, Y);
    const d = await fpc(U.partner).decide(UIC, Y, "first_period", true, "Approving my own facts", uuid(), s.firstPeriod.binding);
    const p = await fpc(U.preparer).decide(UIC, Y, "first_period", true, "A preparer approving", uuid(), s.firstPeriod.binding);
    const n = await decisionsUI();
    return d.outcome === "separate_approver_required" && p.outcome === "forbidden" && n === 0 ? true : { d, p, n };
  });
  await check("ui.second-person-approves: a second person (the owner) is offered the review, reads exactly what is bound (company name, the server's dates, the one cited current revision, the rule version) and decides with the binding shown: recorded; COMPARATIVE_PERIOD_MISSING clears; the page shows approved and the comparatives a first-period exception", async () => {
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
  await check("ui.new-evidence-stales: new evidence recorded through the page (a certified copy of the certificate) makes the approval stale: the page shows 'approval out of date' with the server's ONE named reason and its next action; COMPARATIVE_PERIOD_MISSING returns with FIRST_PERIOD_DECISION_STALE", async () => {
    const e = await fpc(U.preparer).recordEvidence(UIC, Y, { kind: "certificate_of_registration", reference: "Certified copy of certificate CN-2026-0301", issuedOn: "2026-03-01", assertedDate: "2026-02-03",
      documentSha256: sha("synthetic certified copy CN-2026-0301"), note: null, retract: false }, uuid());
    const s = await fpc(U.owner).status(UIC, Y); const v = reviewView(s.firstPeriod, "first_period", BOTH);
    const b = await bl(UIC, repUI);
    return e.outcome === "recorded" && v.kind === "stale" && v.primary === "review" && v.nextAction === FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_DECISION_STALE && JSON.stringify(v.codes) === JSON.stringify(["FIRST_PERIOD_DECISION_STALE"])
      && b.includes("COMPARATIVE_PERIOD_MISSING") && b.includes("FIRST_PERIOD_DECISION_STALE") ? true : { e, v, b: ours(b) };
  });
  await check("ui.decision-on-old-binding-refused: a decision sent with the binding the approver was shown BEFORE the new evidence is refused (changed_since_viewed): nothing is recorded and the exception stays off", async () => {
    const before = await decisionsUI();
    const d = await fpc(U.owner).decide(UIC, Y, "first_period", true, "Approving what I was shown earlier", uuid(), shownAtApproval);
    const after = await decisionsUI(); const b = await bl(UIC, repUI);
    return d.outcome === "changed_since_viewed" && before === after && b.includes("COMPARATIVE_PERIOD_MISSING") ? true : { d, before, after, b: ours(b) };
  });
  await check("ui.re-review-restores: the approver reads the review again (the new revision is now in the evidence set) and decides on what is shown now: recorded; approved again; COMPARATIVE_PERIOD_MISSING clears; both decisions are kept", async () => {
    const c = fpc(U.owner);
    const s = await c.status(UIC, Y);
    const d = await c.decide(UIC, Y, "first_period", true, "Certified copy agrees to the original certificate; review refreshed.", uuid(), s.firstPeriod.binding);
    const after = await c.status(UIC, Y); const b = await bl(UIC, repUI);
    return s.firstPeriod.binding !== shownAtApproval && d.outcome === "recorded" && reviewView(after.firstPeriod, "first_period", BOTH).kind === "approved" && !b.includes("COMPARATIVE_PERIOD_MISSING")
      && (await decisionsUI()) === 2 ? true : { d, b: ours(b), n: await decisionsUI() };
  });
  await check("ui.no-binding-is-still-accepted: a decision call WITHOUT a binding (the guard is optional) is not refused for that reason: the old call shape keeps working", async () => {
    const s = await fpc(U.owner).status(UIC, Y);
    const d = await asU(U.owner, "SELECT public.fs_decide_first_period($1,$2,'first_period',true,'Re-confirming without a binding',$3) r", [UIC, Y, uuid()]).then((r) => r.r, (e) => ({ error: `${e.code}:${String(e.message).split("\n")[0]}` }));
    return s.state === "evaluated" && d && d.outcome !== "changed_since_viewed" && !d.error ? true : { d };
  });
  await check("ui.legacy-and-viewer: through the same client, a legacy declaration reads as an unverified claim that needs a governed review (never approved); a viewer reads the review and is offered no action", async () => {
    await asU(U.owner, "SELECT public.fs_declare_first_period($1,$2,true,'First reporting period in CFOClose','certificate_of_incorporation','Certificate of incorporation no. 9902','2026-01-12'::date) r", [L2, Y]);
    const s = await fpc(U.owner).status(L2, Y); const v = reviewView(s.firstPeriod, "first_period", BOTH);
    const sv = await fpc(U.viewer).status(UIC, Y); const vv = reviewView(sv.state === "evaluated" ? sv.firstPeriod : null, "first_period", VIEW);
    return v.kind === "legacy_claim" && s.legacyDeclaration?.satisfiesRequirement === false && vv.kind === "approved" && vv.primary === null ? true : { v, legacy: s.legacyDeclaration, vv, sv: sv.state };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish(ABSENT ? "FIRST PERIOD PAGE (delta absent - the page cases must fail)" : "FIRST PERIOD REVIEW PAGE", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
