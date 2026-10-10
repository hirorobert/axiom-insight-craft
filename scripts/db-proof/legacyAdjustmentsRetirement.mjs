#!/usr/bin/env bun
// Real-PostgreSQL proof that the legacy browser-write adjusting-journal pathway is closed (20261026100000), with history
// preserved and the server path intact.
//
//   before     the defect, reproduced: a signed-in member writes an entry and its lines from the client role and marks it
//              approved from the client role
//   retired    after the migration the client role cannot insert, update, delete or truncate either table (42501); no
//              client write policy remains
//   history    every earlier row is unchanged, byte for byte, and still readable by the company's members only
//   server     service_role (server functions) still writes, so engine-generated entries keep working
//   replay     re-applying is refused by its own preflight; the rest of the chain applies after it
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/legacyAdjustmentsRetirement.mjs
import { applyChainBefore, certifier, chainFiles, csv, FY2026, makeWorld, migrationText, openDatabase, reporter } from "./lib/reportingKit.mjs";

const FIX = "20261026100000_retire_browser_adjusting_journal_writes.sql";
const { group, check, finish } = reporter();
let db;
let crashed = false;

const refused = async (fn) => {
  try { await fn(); } catch (e) { if (e.code === "42501") return true; throw new Error(`expected 42501, got ${e.code}: ${e.message}`); }
  throw new Error("the write was accepted");
};

async function main() {
  db = await openDatabase("legacy_adjustments_proof");
  group("Replay up to (not including) the retirement");
  await check("the chain before 20261026100000 applies", async () => (await applyChainBefore(db, FIX)) ?? true);
  const { U, A, B } = await makeWorld(db);
  const k = await certifier(db, U);
  const up = await k.upload(A, 2026, csv(FY2026));
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const entry = (n) => [A, up.id, 2026, n, "Accrue rent", "accrual", U.owner];
  const INSERT = "INSERT INTO public.adjusting_journal_entries (company_id, upload_id, period_year, aje_number, description, aje_type, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id";
  const LINE = "INSERT INTO public.aje_lines (aje_id, line_number, account_code, account_name, classification, debit_tzs, credit_tzs) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id";
  const snapshot = async () => (await db.admin.query(
    "SELECT to_jsonb(a) || jsonb_build_object('lines', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_number) FROM public.aje_lines l WHERE l.aje_id=a.id)) s FROM public.adjusting_journal_entries a ORDER BY a.aje_number")).rows.map((r) => JSON.stringify(r.s));

  let earlier;
  group("Before: the defect, reproduced");
  await check("a member writes an entry and its lines from the browser role", async () => {
    earlier = (await asU(U.owner, INSERT, entry("AJE-M001"))).id;
    await asU(U.owner, LINE, [earlier, 1, "6000", "Rent", "operating_expenses", 100, 0]);
    await asU(U.owner, LINE, [earlier, 2, "2000", "Accruals", "current_liabilities", 0, 100]);
    return true;
  });
  await check("and a second member marks it approved from the browser role, outside the Close Review decision", async () => {
    const r = await asU(U.partner, "UPDATE public.adjusting_journal_entries SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING status", [earlier, U.partner]);
    return r?.status === "approved";
  });
  const before = await snapshot();

  group("Retired");
  await check("20261026100000 applies (preflight and postcondition pass)", async () => { await db.admin.query(migrationText(FIX)); return true; });
  await check("insert from the browser role is refused", () => refused(() => asU(U.owner, INSERT, entry("AJE-M002"))));
  await check("update (approval) from the browser role is refused", () => refused(() => asU(U.owner, "UPDATE public.adjusting_journal_entries SET status='reversed' WHERE id=$1", [earlier])));
  await check("delete from the browser role is refused", () => refused(() => asU(U.owner, "DELETE FROM public.adjusting_journal_entries WHERE id=$1", [earlier])));
  await check("line insert from the browser role is refused", () => refused(() => asU(U.owner, LINE, [earlier, 3, "6000", "Rent", "operating_expenses", 1, 0])));
  await check("line update and delete from the browser role are refused", async () => {
    await refused(() => asU(U.owner, "UPDATE public.aje_lines SET debit_tzs=0 WHERE aje_id=$1", [earlier]));
    return refused(() => asU(U.owner, "DELETE FROM public.aje_lines WHERE aje_id=$1", [earlier]));
  });
  await check("anon holds no write either; no client write policy remains", async () => {
    const r = await db.one(`SELECT
      bool_or(has_table_privilege(r, t, p)) AS any_write,
      (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('adjusting_journal_entries','aje_lines') AND cmd <> 'SELECT') AS write_policies
      FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['public.adjusting_journal_entries','public.aje_lines']) t, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p`);
    return r.any_write === false && Number(r.write_policies) === 0;
  });

  group("History preserved");
  await check("every earlier row and line is unchanged, byte for byte", async () => JSON.stringify(await snapshot()) === JSON.stringify(before));
  await check("members of the company still read the earlier entry and its lines", async () => {
    const r = await asU(U.preparer, "SELECT count(*)::int n, (SELECT count(*)::int FROM public.aje_lines WHERE aje_id=$1) l FROM public.adjusting_journal_entries WHERE id=$1", [earlier]);
    return r.n === 1 && r.l === 2;
  });
  await check("another company's owner reads nothing", async () => {
    const r = await asU(U.ownerB, "SELECT count(*)::int n FROM public.adjusting_journal_entries WHERE company_id=$1", [A]);
    return r.n === 0 && B !== A;
  });

  group("Server path intact");
  await check("service_role still writes an entry and its lines (engine-generated entries)", async () => {
    const id = (await db.asService(INSERT, entry("AJE-E001"))).id;
    await db.asService(LINE, [id, 1, "7000", "Tax expense", "taxes", 5, 0]);
    return (await db.count("SELECT count(*) n FROM public.aje_lines WHERE aje_id=$1", [id])) === 1;
  });

  group("Replay");
  await check("re-applying 20261026100000 is refused by its own preflight; nothing changes", async () => {
    const before2 = await snapshot();
    try { await db.admin.query(migrationText(FIX)); return "re-application was accepted"; }
    catch (e) { return e.code === "P0001" && /already retired/.test(e.message) && JSON.stringify(await snapshot()) === JSON.stringify(before2) ? true : `${e.code}: ${e.message}`; }
  });
  await check("the rest of the chain applies after it", async () => {
    const chain = chainFiles();
    for (const f of chain.slice(chain.indexOf(FIX) + 1)) await db.admin.query(migrationText(f));
    return true;
  });
}

try { await main(); } catch (e) { crashed = true; console.error(`
INFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("LEGACY_ADJUSTMENTS_RETIREMENT", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
