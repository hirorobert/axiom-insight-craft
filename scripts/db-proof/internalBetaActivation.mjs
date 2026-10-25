#!/usr/bin/env bun
// Real-PostgreSQL proof of the internal beta activation controls (20261203100000) on the WHOLE current chain, over
// statements composed by the database from trial balances certified by the real process-trial-balance engine.
// Synthetic data only; no provider is contacted and no hosted credential is used.
//
//   authority   only an ACTIVE commercial administrator may call any of the five functions; anon and the service role
//               cannot execute them; the internal authority check is not callable;
//   overview    reports the policy revision, the master switch (engaged as installed on the hosted database), the
//               allowlist and enrolled members, without changing anything;
//   open        one transaction: wrong revision → PT409, a company without an enrolled member → PT422, each refused with
//               NOTHING changed; success makes the allowlist exactly the listed companies, switches beta reporting on and
//               releases the master switch LAST (audit order), after which only enrolled members of listed companies read
//               statements;
//   synthetic   the composition hash recorded is the one the database computes for the administrator; an administrator
//               who cannot read the company records nothing;
//   AI          stopping spending needs no revision;
//   close       engages the master switch FIRST, switches beta reporting off, disables the allowlist; reading stops;
//   concurrency open and close racing never deadlock and always leave a coherent state.
//
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://…(an EMPTY loopback database) bun scripts/db-proof/internalBetaActivation.mjs
import { applyChain, certifier, makeWorld, openDatabase, prepareReporting, reporter, uuid } from "./lib/reportingKit.mjs";

const { group, check, refused, finish } = reporter();
let db;
const FNS = ["public.internal_beta_admin_overview()", "public.internal_beta_admin_open_reporting(uuid[],text,bigint)",
  "public.internal_beta_admin_close_reporting(text)", "public.internal_beta_admin_stop_ai(text)",
  "public.internal_beta_admin_record_synthetic_context(uuid,integer,text)"];

async function main() {
  db = await openDatabase("beta_activation_proof");
  group("Replay — the whole chain, the activation controls included");
  await check("the whole chain applies", async () => (await applyChain(db)) ?? true);

  const W = await makeWorld(db);
  const { U, A, B } = W;
  await W.rollout(A, true); await W.rollout(B, true);
  const k = await certifier(db, U);
  await prepareReporting(db, W, k);
  // The hosted state this screen starts from: the world exists before the beta (snapshot enrollment), the master switch is
  // engaged, beta reporting is off. This disposable chain creates its world AFTER the beta migration, so the owner's
  // snapshot enrollment is seeded explicitly (as assistantAuthority.mjs does).
  await db.admin.query("INSERT INTO public.internal_beta_enrollments(company_id,user_id,basis) VALUES($1,$2,'existing_owner')", [A, U.owner]);
  await db.asService("SELECT public.fs_set_kill_switch(true,'engaged as installed on the hosted database','proof')");
  // The owner's normal account is also the commercial administrator (the owner's real situation). A second administrator
  // belongs to no company.
  const OTHER_ADMIN = uuid();
  await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,'admin2@example.test')", [OTHER_ADMIN]);
  await db.admin.query("INSERT INTO public.commercial_admins (user_id, active) VALUES ($1, true), ($2, true)", [U.owner, OTHER_ADMIN]);
  const INACTIVE = U.partner;
  await db.admin.query("INSERT INTO public.commercial_admins (user_id, active) VALUES ($1, false)", [INACTIVE]);

  const overview = (uid = U.owner) => db.asUser(uid, "SELECT public.internal_beta_admin_overview() r").then((r) => r.r);
  const open = (ids, rev, uid = U.owner, reason = "Open internal beta reporting for acceptance") =>
    db.asUser(uid, "SELECT public.internal_beta_admin_open_reporting($1::uuid[],$2,$3) r", [ids, reason, rev]).then((r) => r.r);
  const close = (uid = U.owner) => db.asUser(uid, "SELECT public.internal_beta_admin_close_reporting('Close internal beta reporting now') r").then((r) => r.r);
  const compose = (uid, company = A) => db.asUser(uid, "SELECT public.fs_statement_composition($1,2026) r", [company]).then((r) => r.r);
  const state = async () => ({
    kill: (await db.one("SELECT kill_switch k FROM public.financial_statements_rollout_state")).k,
    policy: await db.one("SELECT reporting_enabled, ai_enabled, revision FROM public.internal_beta_policy"),
    allow: (await db.admin.query("SELECT company_id FROM public.financial_statements_rollout_companies WHERE enabled ORDER BY company_id")).rows.map((r) => r.company_id),
    audit: await db.count("SELECT count(*) n FROM public.financial_statements_rollout_audit"),
    events: await db.count("SELECT count(*) n FROM public.internal_beta_events"),
  });

  group("Authority — active commercial administrators only");
  for (const [who, uid] of [["a workspace owner who is not an administrator", U.ownerB], ["an inactive administrator", INACTIVE]]) {
    await refused(`${who}: overview refused`, "42501", () => overview(uid));
    await refused(`${who}: open refused`, "42501", () => open([A], 1, uid));
    await refused(`${who}: close refused`, "42501", () => close(uid));
    await refused(`${who}: stop AI refused`, "42501", () => db.asUser(uid, "SELECT public.internal_beta_admin_stop_ai('Stop internal beta spending')"));
    await refused(`${who}: synthetic scope refused`, "42501", () => db.asUser(uid, "SELECT public.internal_beta_admin_record_synthetic_context($1,2026,'Synthetic acceptance data')", [A]));
  }
  await check("anon and the service role cannot execute any of them; the internal check is not callable", async () => {
    const rows = [];
    for (const f of FNS) for (const role of ["anon", "service_role"]) rows.push((await db.one("SELECT has_function_privilege($1,$2,'EXECUTE') b", [role, f])).b);
    const internal = (await db.one("SELECT has_function_privilege('authenticated','public._internal_beta_require_admin()','EXECUTE') b")).b;
    return rows.every((b) => b === false) && internal === false ? true : { rows, internal };
  });
  await refused("the service role is refused by privilege", "42501", () => db.asService("SELECT public.internal_beta_admin_close_reporting('Service role must not close')"));

  group("Overview — the state the screen starts from");
  let before;
  await check("revision 1, master switch engaged, beta reporting and AI off, both companies allowlisted, A has one enrolled member", async () => {
    const o = await overview();
    before = await state();
    const a = o.companies.find((c) => c.companyId === A), b = o.companies.find((c) => c.companyId === B);
    return o.policy.revision === 1 && o.masterSwitchEngaged === true && o.reportingOpen === false && o.policy.aiEnabled === false
      && a?.allowlisted === true && a.enrolledMembers === 1 && b?.allowlisted === true && b.enrolledMembers === 0
      && o.policy.remainingMicros === 5000000 - 1341400 ? true : o;
  });
  await check("reading the overview changes nothing", async () => JSON.stringify(await state()) === JSON.stringify(before) ? true : await state());
  await check("while the master switch is engaged, the owner cannot read the statements", async () => (await compose(U.owner)).state === "unavailable" ? true : (await compose(U.owner)).state);

  group("Open — refusals change nothing");
  await refused("a stale revision is refused (VERSION_CONFLICT)", "PT409", () => open([A], 7));
  await refused("a company without an enrolled member is refused", "PT422", () => open([A, B], 1), "COMPANY_HAS_NO_ENROLLED_MEMBER");
  await refused("an empty list is refused", "22023", () => open([], 1));
  await refused("a short reason is refused", "22023", () => open([A], 1, U.owner, "too short"));
  await check("after the refusals nothing changed (switch, policy, allowlist, audit, events)", async () => JSON.stringify(await state()) === JSON.stringify(before) ? true : await state());

  group("Open — one transaction, master switch released last");
  let opened;
  await check("opening A: allowlist exactly [A] (B disabled), beta reporting on, revision 2, master switch released", async () => {
    opened = await open([A], 1);
    const s = await state();
    return opened.outcome === "opened" && opened.revision === 2 && s.kill === false && s.policy.reporting_enabled === true
      && s.policy.revision === "2" && JSON.stringify(s.allow) === JSON.stringify([A]) ? true : { opened, s };
  });
  await check("audit: B disabled, then the master switch released LAST, both labelled with the administrator", async () => {
    const rows = (await db.admin.query("SELECT scope, company_id, new_state, operator_label FROM public.financial_statements_rollout_audit ORDER BY seq DESC LIMIT 2")).rows.reverse();
    return rows[0].scope === "COMPANY" && rows[0].company_id === B && rows[0].new_state === false
      && rows[1].scope === "KILL_SWITCH" && rows[1].new_state === false
      && rows.every((r) => r.operator_label === `commercial-admin:${U.owner}`) ? true : rows;
  });
  await check("an OPEN_REPORTING event names the companies and the administrator", async () => {
    const e = await db.one("SELECT actor_user_id, action, detail FROM public.internal_beta_events ORDER BY seq DESC LIMIT 1");
    return e.action === "OPEN_REPORTING" && e.actor_user_id === U.owner && JSON.stringify(e.detail.companyIds) === JSON.stringify([A]) ? true : e;
  });
  await check("the enrolled owner reads A's statements; an accepted but NOT enrolled member does not", async () => {
    const o = await compose(U.owner), v = await compose(U.viewer);
    return o.state === "composed" && v.state === "unavailable" ? true : { o: o.state, v: v.state };
  });
  await check("B is closed for its own owner (not allowlisted)", async () => (await compose(U.ownerB, B)).state === "unavailable" ? true : "B readable");
  await check("the overview reports reporting open at revision 2", async () => {
    const o = await overview();
    return o.reportingOpen === true && o.masterSwitchEngaged === false && o.policy.revision === 2 ? true : o;
  });

  group("Synthetic scope for the assistant — the database's own hash");
  await check("recorded for A 2026: the hash equals the composition the owner reads; labelled with the administrator", async () => {
    const r = (await db.asUser(U.owner, "SELECT public.internal_beta_admin_record_synthetic_context($1,2026,'Synthetic acceptance data for the assistant') r", [A])).r;
    const own = await compose(U.owner);
    const row = await db.one("SELECT composition_sha256, operator_label FROM public.internal_beta_synthetic_contexts WHERE company_id=$1", [A]);
    return r.outcome === "recorded" && r.compositionSha256 === own.compositionSha256 && row.composition_sha256 === own.compositionSha256
      && row.operator_label === `commercial-admin:${U.owner}` ? true : { r, row };
  });
  await refused("an administrator who cannot read the company records nothing", "PT422",
    () => db.asUser(OTHER_ADMIN, "SELECT public.internal_beta_admin_record_synthetic_context($1,2026,'Synthetic acceptance data attempt')", [A]), "COMPOSITION_NOT_AVAILABLE");
  await check("only one synthetic scope exists", async () => (await db.count("SELECT count(*) n FROM public.internal_beta_synthetic_contexts")) === 1 ? true : "extra rows");

  group("AI spending off needs no revision");
  await check("stop AI: off, revision bumped, event recorded", async () => {
    const r = (await db.asUser(U.owner, "SELECT public.internal_beta_admin_stop_ai('Stop internal beta spending now') r")).r;
    const p = await db.one("SELECT ai_enabled, revision FROM public.internal_beta_policy");
    const e = await db.one("SELECT action FROM public.internal_beta_events ORDER BY seq DESC LIMIT 1");
    return r.outcome === "stopped" && p.ai_enabled === false && p.revision === "3" && e.action === "STOP_AI" ? true : { r, p, e };
  });

  group("Close — master switch engaged first");
  await check("close: master switch engaged, beta reporting off, allowlist empty; audit has the switch BEFORE the company", async () => {
    const auditBefore = await db.count("SELECT max(seq) n FROM public.financial_statements_rollout_audit");
    const r = await close();
    const s = await state();
    const rows = (await db.admin.query("SELECT scope, company_id, new_state FROM public.financial_statements_rollout_audit WHERE seq > $1 ORDER BY seq", [auditBefore])).rows;
    return r.outcome === "closed" && s.kill === true && s.policy.reporting_enabled === false && s.allow.length === 0
      && rows.length === 2 && rows[0].scope === "KILL_SWITCH" && rows[0].new_state === true && rows[1].scope === "COMPANY" && rows[1].company_id === A
      ? true : { r, s, rows };
  });
  await check("after closing nobody reads the statements", async () => (await compose(U.owner)).state === "unavailable" ? true : "still readable");
  await check("closing again is safe and changes no switch (no duplicate audit rows)", async () => {
    const n = await db.count("SELECT count(*) n FROM public.financial_statements_rollout_audit");
    const r = await close();
    return r.outcome === "closed" && (await db.count("SELECT count(*) n FROM public.financial_statements_rollout_audit")) === n ? true : r;
  });
  await check("reopening with the overview's current revision works", async () => {
    const rev = (await overview()).policy.revision;
    const r = await open([A], rev);
    return r.outcome === "opened" && (await compose(U.owner)).state === "composed" ? true : r;
  });

  group("Concurrency — open and close racing");
  await check("20 concurrent opens and closes: no deadlock, every call answers, the final state is coherent", async () => {
    const calls = [];
    for (let i = 0; i < 10; i++) {
      calls.push(overview().then((o) => open([A], o.policy.revision)).then(() => "opened", (e) => (e.code === "PT409" ? "conflict" : `error ${e.code}`)));
      calls.push(close().then(() => "closed", (e) => `error ${e.code}`));
    }
    const out = await Promise.all(calls);
    const s = await state();
    const coherent = (s.kill === true && s.policy.reporting_enabled === false && s.allow.length === 0)
      || (s.kill === false && s.policy.reporting_enabled === true && JSON.stringify(s.allow) === JSON.stringify([A]));
    return out.every((x) => !x.startsWith("error")) && coherent ? true : { out, s };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("BETA_ACTIVATION", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
