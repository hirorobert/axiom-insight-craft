#!/usr/bin/env bun
// Real-PostgreSQL proof of Ask CFOClose Release 0.1 — migration 20261127100000 (assistant controls) and the REAL
// assistant-explain Edge Function (only the network edges replaced; lib/functionHarness.mjs) over statements COMPOSED BY
// THE DATABASE from trial balances certified by the real process-trial-balance engine. Synthetic data only. No provider
// is contacted: a deterministic TEST provider is injected into the real function.
//
//   disabled      as shipped: settings disabled, no terms, prices or budget; the deployed function (no ASSISTANT_PROVIDER)
//                 refuses before anything is read; enabling needs every gate and a reservation covering two calls;
//   enablement    manage_members only, bound to the current terms version, append-only;
//   end to end    answered figures are the composition's own figures rendered by the server; the run records cost and
//                 usage, never the prompt; a replay calls no model; a reused id with another payload is refused;
//   limits        per-workspace lock: concurrent reservations never exceed the monthly cap or the concurrency limit;
//                 concurrent duplicates of one request start one reservation; expired runs keep their reserved cost;
//   isolation     another workspace's member gets nothing (no reservation, no model call); a revoked member receives no
//                 answer, not even a replay; clients cannot read the tables, reserve, complete or configure;
//   records       a run completes once; completed runs are immutable (even to the owner) except the retention purge;
//   reporting     with the assistant disabled the statements stay readable — the assistant is never a prerequisite.
//
// Handled outcomes are HTTP 200 with status and code in the body (the reporting transport passes bodies of successful calls).
//
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://…(an EMPTY loopback database) bun scripts/db-proof/assistantAuthority.mjs
//   (or DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> for an embedded database)
import { call, loadFunctionTree, mintTestJwt, shim } from "./lib/functionHarness.mjs";
import { applyChain, certifier, csv, FY2025, FY2026, makeWorld, migrationText, openDatabase, prepareReporting, reporter, REPO, uuid } from "./lib/reportingKit.mjs";

const FILE = "20261127100000_assistant_controls.sql";
const { group, check, refused, finish } = reporter();
let db;

const SETTINGS = (over = {}) => ({
  enabled: true, provider_id: "test", model: "test-model", prompt_version: "cfoclose-assistant-prompt/1", terms_version: "t1",
  max_input_tokens: 20000, max_output_tokens: 1200, max_request_seconds: 60,
  price_input_micros_per_mtok: 2000000, price_output_micros_per_mtok: 10000000, price_cache_write_micros_per_mtok: 2500000,
  price_cache_read_micros_per_mtok: 100000, price_catalogue_date: "2026-10-24", max_cost_per_request_micros: 124000,
  retention_policy: "zero_data_retention", region: "us", response_retention_days: 30,
  data_handling_approved_at: new Date().toISOString(), evaluation_approved_at: new Date().toISOString(), ...over,
});
const LINE = "sfp.trade_and_other_receivables";

/** A deterministic model: refers to facts only, binds to the digest it was given, records what it saw. */
const seen = [];
globalThis.__testProvider = {
  id: "test",
  async complete(req) {
    seen.push(req.messages[0].content);
    const digest = /"contextDigest": "([0-9a-f]{64})"/.exec(req.messages[0].content)[1];
    const line = /"id": "(line:[^"]+)"/.exec(req.messages[0].content)[1];
    return {
      text: JSON.stringify({ schemaVersion: "cfoclose-assistant-response/1", contextDigest: digest, blocks: [
        { kind: "observation", parts: [{ text: "The balance was " }, { factRef: "line.current" }, { text: " at the end of " }, { factRef: "period.current" },
          { text: ", against " }, { factRef: "line.comparative" }, { text: ": " }, { factRef: "line.change" }, { text: " (" }, { factRef: "line.change_percent" }, { text: ")." }], sourceRefs: [line] },
        { kind: "limitation", parts: [{ text: "The statements establish the movement but not its cause." }], sourceRefs: [] },
      ] }),
      usage: { inputTokens: 3000, outputTokens: 400, cacheWriteTokens: 0, cacheReadTokens: 1500 }, stopReason: "end_turn",
    };
  },
};

async function main() {
  db = await openDatabase("assistant_proof");
  group("Replay — the whole chain, the assistant controls included");
  await check(`the whole chain applies, ${FILE} included`, async () => (await applyChain(db)) ?? true);
  await refused("applying it again is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");

  const W = await makeWorld(db);
  const { U, A, B } = W;
  await W.rollout(A, true); await W.rollout(B, true);
  const k = await certifier(db, U);
  await prepareReporting(db, W, k);
  const ADMIN = uuid();
  await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,'admin@example.test')", [ADMIN]);
  await db.admin.query("INSERT INTO public.commercial_admins (user_id, active) VALUES ($1, true)", [ADMIN]);
  // Workspace B has statements too (its own owner), so isolation is tested against real, composed data.
  { const kk = await certifier(db, { ...U, owner: U.ownerB }); const p = await kk.upload(B, 2025, csv(FY2025)); await kk.review(B, p); await kk.certify(B, p); const c = await kk.upload(B, 2026, csv(FY2026)); await kk.certify(B, c); }

  const deployed = (await loadFunctionTree(REPO, "assistant-explain")).handler;
  let patchedApplied = false;
  const tested = (await loadFunctionTree(REPO, "assistant-explain", { patch: (p, t) => {
    if (p !== "assistant-explain/index.ts") return t;
    const out = t.replace("provider: configuredProvider(),", "provider: globalThis.__testProvider,");
    patchedApplied = out !== t; return out;
  } })).handler;
  const ask = (h, uid, body) => call(h, db.pool, uid ? mintTestJwt(uid) : null, body);
  const req = (o = {}) => ({ action: "explain_movement", companyId: A, periodYear: 2026, lineId: LINE, requestId: uuid(), ...o });
  const configure = (uid, s) => db.asUser(uid, "SELECT public.ai_assistant_configure($1::jsonb) r", [JSON.stringify(s)]).then((r) => r.r);
  const enable = (uid, company, terms, on = true) => db.asUser(uid, "SELECT public.ai_assistant_set_enablement($1,$2,$3) r", [company, terms, on]).then((r) => r.r);
  const budget = (company, cap, quota, conc) => db.asUser(ADMIN, "SELECT public.ai_assistant_set_budget($1,$2,$3,$4) r", [company, cap, quota, conc]);
  const runs = () => db.count("SELECT count(*) n FROM public.ai_assistant_runs");
  const compose = (uid, company = A) => db.asUser(uid, "SELECT public.fs_statement_composition($1,2026) r", [company]).then((r) => r.r);

  group("Disabled as shipped");
  await check("as migrated: disabled, no provider, terms, prices or budget", async () => {
    const s = await db.one("SELECT * FROM public.ai_assistant_settings");
    return s.enabled === false && s.provider_id === null && s.terms_version === null && s.price_input_micros_per_mtok === null
      && (await db.count("SELECT count(*) n FROM public.ai_assistant_budgets")) === 0 ? true : s;
  });
  await check("the deployed function (no ASSISTANT_PROVIDER in the environment) refuses PROVIDER_DISABLED, reserving nothing", async () => {
    const r = await ask(deployed, U.owner, req());
    return r.http === 200 && r.body.code === "PROVIDER_DISABLED" && (await runs()) === 0 ? true : r;
  });
  await check("the test provider was injected into the real function (patch applied)", async () => patchedApplied);
  await check("with a provider but the settings disabled: refused PROVIDER_DISABLED by the database, nothing recorded", async () => {
    const r = await ask(tested, U.owner, req());
    return r.http === 200 && r.body.code === "PROVIDER_DISABLED" && (await runs()) === 0 && seen.length === 0 ? true : r;
  });
  await refused("enabling without the approvals is refused", "23514", () => configure(ADMIN, SETTINGS({ evaluation_approved_at: null })));
  await refused("a reservation that would not cover the request and its correction is refused", "23514", () => configure(ADMIN, SETTINGS({ max_cost_per_request_micros: 50000 })));
  await refused("only a commercial admin configures", "42501", () => configure(U.owner, SETTINGS()));
  await refused("only a commercial admin sets a budget", "42501", () => db.asUser(U.owner, "SELECT public.ai_assistant_set_budget($1,1,1,1)", [A]));
  await check("a commercial admin enables it with every gate recorded", async () => (await configure(ADMIN, SETTINGS())).enabled === true ? true : "not enabled");

  group("Workspace enablement — manage_members, current terms, append-only");
  await check("not enabled yet: ASSISTANT_NOT_ENABLED; nothing recorded; no model call", async () => {
    const r = await ask(tested, U.owner, req());
    return r.body.code === "ASSISTANT_NOT_ENABLED" && (await runs()) === 0 && seen.length === 0 ? true : r;
  });
  await check("a preparer or viewer cannot enable; stale terms are refused; the owner enables the current terms", async () => {
    const p = await enable(U.preparer, A, "t1"), v = await enable(U.viewer, A, "t1"), s = await enable(U.owner, A, "t0"), o = await enable(U.owner, A, "t1");
    return p.outcome === "forbidden" && v.outcome === "forbidden" && s.outcome === "stale_terms" && o.outcome === "recorded" ? true : { p, v, s, o };
  });
  await refused("enablement records are append-only (even for the database owner)", "42501", () => db.admin.query("DELETE FROM public.ai_assistant_enablements"));
  await check("no budget: AI_BUDGET_EXCEEDED, nothing recorded", async () => {
    const r = await ask(tested, U.owner, req());
    return r.body.code === "AI_BUDGET_EXCEEDED" && (await runs()) === 0 ? true : r;
  });
  await budget(A, 2_000_000, 50, 2);

  group("End to end — the database's figures, rendered by the server");
  let first;
  await check("answered: every figure equals the composition's own (minor units), rendered from the fact records", async () => {
    const comp = await compose(U.owner);
    const line = comp.lines.find((l) => l.lineId === LINE);
    first = req();
    const r = await ask(tested, U.owner, first);
    if (r.http !== 200) return r;
    const text = r.body.answer.blocks[0].parts.map((p) => p.text).join("");
    // Trade receivables: 4,300.00 (2026) vs 3,000.00 (2025) → +1,300.00, +43.3%.
    return line.current.amountMinor === "430000" && line.comparative.amountMinor === "300000"
      && text === "The balance was TZS 4,300.00 at the end of 2026, against TZS 3,000.00: an increase of TZS 1,300.00 (+43.3%)." ? true : { text, line };
  });
  await check("the run records model, prompt and terms versions, usage and cost — and no prompt text", async () => {
    const r = await db.one("SELECT * FROM public.ai_assistant_runs WHERE request_id=$1", [first.requestId]);
    return r.state === "succeeded" && r.actual_cost_micros === "10150" && r.model === "test-model" && r.terms_version === "t1"
      && r.usage.inputTokens === 3000 && !JSON.stringify(r).includes("Request (application data") && r.source_refs.includes(`line:${LINE}`) ? true : r;
  });
  await check("the model saw this workspace's line facts, and no other workspace's identifiers", async () => {
    const s = seen.at(-1);
    return s.includes('"value": "TZS 4,300.00"') && s.includes(A) === false && !s.includes(B) ? true : s.slice(0, 400);
  });
  await check("a replay of the same request returns the recorded answer with no model call", async () => {
    const before = seen.length;
    const r = await ask(tested, U.owner, first);
    return r.http === 200 && r.body.replay === true && seen.length === before ? true : r;
  });
  await check("the same request id with another payload is refused (REQUEST_ID_REUSED)", async () => {
    const r = await ask(tested, U.owner, { ...first, lineId: "sfp.inventories" });
    return r.body.status === "refused" && r.body.code === "REQUEST_ID_REUSED" ? true : r;
  });
  await check("a draft is labelled as an unreviewed draft", async () => {
    const before = globalThis.__testProvider.complete;
    globalThis.__testProvider.complete = async (q) => {
      const digest = /"contextDigest": "([0-9a-f]{64})"/.exec(q.messages[0].content)[1];
      return { text: JSON.stringify({ schemaVersion: "cfoclose-assistant-response/1", contextDigest: digest, blocks: [
        { kind: "draft", parts: [{ text: "Trade and other receivables were " }, { factRef: "line.current" }, { text: " at year end." }], sourceRefs: [`line:${LINE}`] }] }),
        usage: { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0 }, stopReason: "end_turn" };
    };
    try {
      const r = await ask(tested, U.owner, req({ action: "draft_commentary", refinement: "shorter" }));
      return r.http === 200 && r.body.answer.label === "Draft — not reviewed" && r.body.answer.draftText === "Trade and other receivables were TZS 4,300.00 at year end." ? true : r;
    } finally { globalThis.__testProvider.complete = before; }
  });

  group("Isolation and revocation");
  await check("another workspace's owner asking about A: the database composes nothing for them; no reservation, no model call", async () => {
    const n = await runs(), s = seen.length;
    const r = await ask(tested, U.ownerB, req());
    return r.body.status === "unavailable" && (await runs()) === n && seen.length === s ? true : r;
  });
  await check("a forged reservation for workspace A by B's owner (service path) is FORBIDDEN", async () => {
    const r = (await db.asService("SELECT public.ai_assistant_reserve($1,$2,2026,$3,'explain_movement',$4,$5,$5,$5) r", [U.ownerB, A, LINE, uuid(), "a".repeat(64)])).r;
    return r.code === "FORBIDDEN" ? true : r;
  });
  let prepReq;
  await check("a member is answered; once revoked, even a replay of their own answer is refused", async () => {
    prepReq = req();
    const a = await ask(tested, U.preparer, prepReq);
    await db.admin.query("UPDATE public.firm_members SET accepted_at = NULL WHERE company_id=$1 AND user_id=$2", [A, U.preparer]);
    const b = await ask(tested, U.preparer, prepReq);
    const direct = (await db.asService("SELECT public.ai_assistant_reserve($1,$2,2026,$3,'explain_movement',$4,$5,$5,$5) r", [U.preparer, A, LINE, prepReq.requestId, "a".repeat(64)])).r;
    return a.http === 200 && b.body.answer === undefined && b.body.status !== "answered" && direct.code === "FORBIDDEN" ? true : { a: a.http, b: b.body, direct };
  });
  await refused("clients cannot read the runs", "42501", () => db.asUser(U.owner, "SELECT * FROM public.ai_assistant_runs"));
  await refused("clients cannot read the settings", "42501", () => db.asUser(U.owner, "SELECT * FROM public.ai_assistant_settings"));
  await refused("clients cannot reserve", "42501", () => db.asUser(U.owner, "SELECT public.ai_assistant_reserve($1,$2,2026,$3,'explain_movement',$4,$5,$5,$5)", [U.owner, A, LINE, uuid(), "a".repeat(64)]));
  await refused("clients cannot complete", "42501", () => db.asUser(U.owner, "SELECT public.ai_assistant_complete($1,'succeeded',0,NULL,1,1,'{}'::jsonb,NULL,NULL,NULL)", [uuid()]));
  await refused("anon cannot see the status", "42501", () => db.asRole("anon", null, "SELECT public.ai_assistant_status($1)", [A]));
  await check("the status tells a member what the panel may show; an outsider gets 'unavailable'", async () => {
    const o = (await db.asUser(U.owner, "SELECT public.ai_assistant_status($1) r", [A])).r;
    const x = (await db.asUser(U.ownerB, "SELECT public.ai_assistant_status($1) r", [A])).r;
    return o.state === "available" && o.canManage === true && x.state === "unavailable" ? true : { o, x };
  });

  group("Limits under concurrency");
  const reserveAs = (uid, request = uuid(), payload = "a".repeat(64)) =>
    db.asService("SELECT public.ai_assistant_reserve($1,$2,2026,$3,'explain_movement',$4,$5,$6,$6) r", [uid, A, LINE, request, payload, "c".repeat(64)]).then((r) => r.r);
  const settle = () => db.admin.query("SET session_replication_role = replica; UPDATE public.ai_assistant_runs SET state='failed', completed_at=now(), actual_cost_micros=0 WHERE state='reserved'; SET session_replication_role = origin;");
  await check("12 concurrent duplicates of ONE request: one reservation, the rest replay it", async () => {
    await settle();
    const request = uuid();
    const out = await Promise.all(Array.from({ length: 12 }, () => reserveAs(U.owner, request)));
    const reserved = out.filter((r) => r.outcome === "reserved").length, replays = out.filter((r) => r.outcome === "replay").length;
    return reserved === 1 && replays === 11 && (await db.count("SELECT count(*) n FROM public.ai_assistant_runs WHERE request_id=$1", [request])) === 1 ? true : out;
  });
  await check("per-user: a second request while one is running is USER_BUSY; workspace concurrency 2 is never exceeded", async () => {
    await settle();
    const extra = [uuid(), uuid(), uuid()];
    for (const [i, id] of extra.entries()) {
      await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `m${i}@example.test`]);
      await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'viewer',now())", [A, id]);
    }
    const users = [U.owner, U.partner, U.viewer, ...extra];
    const out = await Promise.all(users.map((u) => reserveAs(u)));
    const busy = await reserveAs(out.findIndex((r) => r.outcome === "reserved") >= 0 ? users[out.findIndex((r) => r.outcome === "reserved")] : U.owner);
    const live = await db.count("SELECT count(*) n FROM public.ai_assistant_runs WHERE state='reserved'");
    return live === 2 && out.filter((r) => r.code === "CONCURRENCY_LIMIT").length === users.length - 2 && busy.code === "USER_BUSY" ? true : { live, out, busy };
  });
  await check("monthly cap: 20 concurrent reservations never exceed it (pessimistic reserved cost under one lock)", async () => {
    await settle();
    const spent = Number((await db.one("SELECT COALESCE(sum(COALESCE(actual_cost_micros,reserved_cost_micros)),0) s FROM public.ai_assistant_runs WHERE company_id=$1", [A])).s);
    const cap = spent + 3 * 124000 + 1000;
    await budget(A, cap, 1000, 10);
    const ids = [];
    for (let i = 0; i < 20; i++) { const id = uuid(); ids.push(id); await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `c${i}@example.test`]);
      await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'viewer',now())", [A, id]); }
    const out = await Promise.all(ids.map((u) => reserveAs(u)));
    const total = Number((await db.one("SELECT COALESCE(sum(COALESCE(actual_cost_micros,reserved_cost_micros)),0) s FROM public.ai_assistant_runs WHERE company_id=$1", [A])).s);
    return out.filter((r) => r.outcome === "reserved").length === 3 && out.filter((r) => r.code === "AI_BUDGET_EXCEEDED").length === 17 && total <= cap ? true : { total, cap, out: out.map((r) => r.code ?? r.outcome) };
  });
  await check("an unconfirmed run past twice the time bound is EXPIRED and keeps its reserved cost (never assumed free)", async () => {
    await settle();
    await budget(A, 100_000_000, 1000, 10);
    const r = await reserveAs(U.owner);
    await db.admin.query("SET session_replication_role = replica");
    await db.admin.query("UPDATE public.ai_assistant_runs SET created_at = now() - interval '10 minutes' WHERE id=$1", [r.runId]);
    await db.admin.query("SET session_replication_role = origin");
    await reserveAs(U.partner);
    const x = await db.one("SELECT state, failure_code, actual_cost_micros, reserved_cost_micros FROM public.ai_assistant_runs WHERE id=$1", [r.runId]);
    const late = (await db.asService("SELECT public.ai_assistant_complete($1,'succeeded',1,NULL,1,1,'{}'::jsonb,NULL,NULL,NULL) r", [r.runId])).r;
    return x.state === "expired" && x.failure_code === "EXPIRED_UNCONFIRMED" && x.actual_cost_micros === null && late.outcome === "already_completed" ? true : { x, late };
  });
  await check("a daily quota is enforced per user", async () => {
    await settle();
    await budget(A, 100_000_000, 0, 10);
    const r = await reserveAs(U.partner);
    await budget(A, 100_000_000, 1000, 10);
    return r.code === "QUOTA_EXCEEDED" ? true : r;
  });

  group("Records");
  await refused("a completed run cannot be changed, even by the database owner", "42501", () => db.admin.query("UPDATE public.ai_assistant_runs SET actual_cost_micros = 0 WHERE state='succeeded'"));
  await refused("runs cannot be deleted", "42501", () => db.admin.query("DELETE FROM public.ai_assistant_runs"));
  await check("retention: the purge removes stored answers only, past the retention period; the accounting record stays", async () => {
    await configure(ADMIN, SETTINGS({ response_retention_days: 0 }));
    const before = await db.count("SELECT count(*) n FROM public.ai_assistant_runs WHERE response IS NOT NULL");
    const p = (await db.asService("SELECT public.ai_assistant_purge_responses() r")).r;
    const after = await db.one("SELECT count(*) FILTER (WHERE response IS NOT NULL) a, count(*) FILTER (WHERE state='succeeded' AND actual_cost_micros IS NOT NULL) s FROM public.ai_assistant_runs");
    const replay = await ask(tested, U.owner, first);
    return before > 0 && p.count === before && Number(after.a) === 0 && Number(after.s) >= 2 && replay.body.code === "ANSWER_EXPIRED" ? true : { before, p, after, replay: replay.body };
  });

  group("Reporting does not depend on the assistant");
  await check("emergency switch: {enabled:false} turns it off; requests are refused; the statements stay readable", async () => {
    await configure(ADMIN, { enabled: false });
    const r = await ask(tested, U.owner, req());
    const comp = await compose(U.owner);
    return r.body.code === "PROVIDER_DISABLED" && comp.state === "composed" ? true : { r: r.body, state: comp.state };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("ASSISTANT", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
shim.pool = null;
await db?.close();
process.exit(ok ? 0 : 1);
