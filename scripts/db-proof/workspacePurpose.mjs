#!/usr/bin/env bun
// Real-PostgreSQL proof of explicit workspace purpose metadata (20261027100000).
//
//   record     only the company's owner records a purpose (client / test / training) with a reason; replay-safe; another
//              member, another company's owner and an invalid request are refused, nothing recorded
//   read       members with workspace access read it; another company's owner reads nothing; anon reads nothing
//   history    append-only: update, delete and truncate are refused, also for the owner; a change is a new event
//   untouched  companies, engagements and uploads are byte-identical before and after (purpose gates nothing)
//   replay     re-applying is refused by its own preflight; the rest of the chain applies after it
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/workspacePurpose.mjs
import { applyChainBefore, certifier, chainFiles, csv, FY2026, makeWorld, migrationText, openDatabase, reporter } from "./lib/reportingKit.mjs";

const FIX = "20261027100000_workspace_purpose.sql";
const { group, check, finish } = reporter();
let db;
let crashed = false;

async function main() {
  db = await openDatabase("workspace_purpose_proof");
  group("Replay up to (not including) workspace purpose");
  await check("the chain before 20261027100000 applies", async () => (await applyChainBefore(db, FIX)) ?? true);
  const { U, A, B } = await makeWorld(db);
  const k = await certifier(db, U);
  await k.upload(A, 2026, csv(FY2026));
  const snapshot = async () => JSON.stringify((await db.admin.query(`SELECT
    (SELECT md5(string_agg(to_jsonb(c)::text, '' ORDER BY c.id)) FROM public.companies c) AS companies,
    (SELECT md5(coalesce(string_agg(to_jsonb(e)::text, '' ORDER BY e.id), '')) FROM public.engagements e) AS engagements,
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY t.id), '')) FROM public.trial_balance_uploads t) AS uploads`)).rows[0]);
  const before = await snapshot();
  const set = (uid, company, purpose, reason) => db.asUser(uid, "SELECT public.set_workspace_purpose($1,$2,$3) r", [company, purpose, reason]).then((x) => x.r);
  const events = () => db.count("SELECT count(*) n FROM public.workspace_purpose_events");

  group("Apply");
  await check("20261027100000 applies (preflight and postcondition pass)", async () => { await db.admin.query(migrationText(FIX)); return true; });

  group("Record");
  await check("the owner records 'test' with a reason", async () => (await set(U.owner, A, "test", "Acceptance demonstration workspace")).outcome === "recorded");
  await check("recording the purpose already in force changes nothing (unchanged, no new event)", async () => (await set(U.owner, A, "test", "Again")).outcome === "unchanged" && (await events()) === 1);
  await check("another member (not the owner) is refused; nothing recorded", async () => (await set(U.preparer, A, "client", "Not mine to decide")).outcome === "forbidden" && (await events()) === 1);
  await check("another company's owner is refused; nothing recorded", async () => (await set(U.ownerB, A, "client", "Cross-tenant attempt")).outcome === "forbidden" && (await events()) === 1);
  await check("an unknown purpose or a missing reason is refused", async () => (await set(U.owner, A, "demo", "Unknown")).outcome === "invalid_request" && (await set(U.owner, A, "client", " ")).outcome === "invalid_request" && (await events()) === 1);
  await check("a change is a new event; the latest is in force and the history is kept", async () => {
    const r = await set(U.owner, A, "client", "Engagement became live client work");
    const rows = (await db.admin.query("SELECT purpose FROM public.workspace_purpose_events WHERE company_id=$1 ORDER BY seq", [A])).rows.map((x) => x.purpose);
    return r.outcome === "recorded" && JSON.stringify(rows) === JSON.stringify(["test", "client"]);
  });

  group("Read");
  await check("a member with workspace access reads the company's purpose", async () => (await db.asUser(U.preparer, "SELECT count(*)::int n FROM public.workspace_purpose_events WHERE company_id=$1", [A])).n === 2);
  await check("another company's owner reads nothing", async () => (await db.asUser(U.ownerB, "SELECT count(*)::int n FROM public.workspace_purpose_events WHERE company_id=$1", [A])).n === 0 && B !== A);
  await check("anon reads nothing (no grant)", async () => {
    try { await db.asRole("anon", null, "SELECT 1 FROM public.workspace_purpose_events"); return "anon read"; } catch (e) { return e.code === "42501" ? true : e.code; }
  });

  group("History");
  for (const [what, sql] of [["update", "UPDATE public.workspace_purpose_events SET purpose='test'"], ["delete", "DELETE FROM public.workspace_purpose_events"]]) {
    await check(`${what} by the owner is refused (42501)`, async () => { try { await db.asUser(U.owner, sql); return "accepted"; } catch (e) { return e.code === "42501" ? true : e.code; } });
  }
  await check("update, delete and truncate are refused even for the table owner role (append-only trigger)", async () => {
    let refused = 0;
    for (const sql of ["UPDATE public.workspace_purpose_events SET purpose='test'", "DELETE FROM public.workspace_purpose_events", "TRUNCATE public.workspace_purpose_events"]) {
      try { await db.admin.query(sql); } catch (e) { if (/WORKSPACE_PURPOSE_APPEND_ONLY/.test(e.message)) refused++; }
    }
    return refused === 3 && (await events()) === 2 ? true : refused;
  });

  group("Untouched");
  await check("companies, engagements and uploads are byte-identical (purpose gates nothing)", async () => (await snapshot()) === before);

  group("Replay");
  await check("re-applying 20261027100000 is refused by its own preflight", async () => {
    try { await db.admin.query(migrationText(FIX)); return "accepted"; } catch (e) { return e.code === "P0001" && /already exists/.test(e.message) ? true : e.message; }
  });
  await check("the rest of the chain applies after it", async () => {
    const chain = chainFiles();
    for (const f of chain.slice(chain.indexOf(FIX) + 1)) await db.admin.query(migrationText(f));
    return true;
  });
}

try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("WORKSPACE_PURPOSE", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
