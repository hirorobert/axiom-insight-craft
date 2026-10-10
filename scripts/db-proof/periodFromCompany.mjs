#!/usr/bin/env bun
// Real-PostgreSQL proof that a workspace's first period follows the company's recorded year-end and currency
// (20261028100000).
//
//   defect     before: a company with a 30 June year-end and KES gets a 1 Jan – 31 Dec TZS period from the launchpad
//   fixed      after: 1 Jul 2025 – 30 Jun 2026 in KES, basis 'company_year_end'; a 29 February year-end clamps in a non-leap
//              year; the prior period then sets up through open_engagement_with_period with the same dates
//   unchanged  a company without a recorded year-end or currency still gets the legacy calendar-year TZS period; an
//              existing period is reused and never rewritten; the function is the previous definition plus the marked block
//   replay     re-applying is refused by its own preflight; the rest of the chain applies after it
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/periodFromCompany.mjs
import { applyChainBefore, chainFiles, makeWorld, migrationText, openDatabase, reporter } from "./lib/reportingKit.mjs";

const FIX = "20261028100000_period_dates_from_company.sql";
const { group, check, finish } = reporter();
let db;
let crashed = false;

async function main() {
  db = await openDatabase("period_from_company_proof");
  group("Replay up to (not including) the fix");
  await check("the chain before 20261028100000 applies", async () => (await applyChainBefore(db, FIX)) ?? true);
  const { U, A, company } = await makeWorld(db);
  const fyeCo = await company(U.owner, "Mto Holdings");
  const leapCo = await company(U.owner, "Leap Year Co");
  const plainCo = await company(U.owner, "No Year-End Co");
  const beforeCo = await company(U.owner, "Before The Fix Co");
  await db.admin.query("UPDATE public.companies SET fiscal_year_end='2026-06-30', currency='KES', creation_request_id=gen_random_uuid() WHERE id=$1", [beforeCo]);
  await db.admin.query("UPDATE public.companies SET fiscal_year_end='2026-06-30', currency='KES', creation_request_id=gen_random_uuid() WHERE id=$1", [fyeCo]);
  await db.admin.query("UPDATE public.companies SET fiscal_year_end='2024-02-29', currency='USD', creation_request_id=gen_random_uuid() WHERE id=$1", [leapCo]);
  const open = async (c, y) => (await db.asUser(U.owner, "SELECT public.open_engagement_with_scope($1,$2,$3) r", [c, y, ["FINANCIAL_STATEMENTS"]])).r;
  const period = (id) => db.one("SELECT reporting_start::text s, reporting_end::text e, fiscal_year_end::text f, reporting_currency c, dates_basis b FROM public.fiscal_periods WHERE id=$1", [id]);

  group("Before: the defect, reproduced");
  await check("a 30 June / KES company gets a calendar-year TZS period from the launchpad", async () => {
    const p = await period((await open(beforeCo, 2025)).periodId);
    return p.s === "2025-01-01" && p.e === "2025-12-31" && p.c === "TZS" && p.b === "v1_calendar_convention" ? true : p;
  });

  group("Apply");
  await check("20261028100000 applies (preflight passes)", async () => { await db.admin.query(migrationText(FIX)); return true; });

  group("Fixed");
  await check("the same company's next year: 1 Jul 2025 – 30 Jun 2026 in KES, basis company_year_end", async () => {
    const p = await period((await open(fyeCo, 2026)).periodId);
    return p.s === "2025-07-01" && p.e === "2026-06-30" && p.f === "2026-06-30" && p.c === "KES" && p.b === "company_year_end" ? true : p;
  });
  await check("a 29 February year-end clamps in a non-leap year (1 Mar 2024 – 28 Feb 2025)", async () => {
    const p = await period((await open(leapCo, 2025)).periodId);
    return p.s === "2024-03-01" && p.e === "2025-02-28" && p.c === "USD" ? true : p;
  });
  await check("the prior period then sets up with the same dates (open_engagement_with_period), adjacent and linked", async () => {
    const r = (await db.asUser(U.owner, "SELECT public.open_engagement_with_period($1,'2025-07-01','2026-06-30','KES',$2,'composite','2024-07-01','2025-06-30',NULL) r", [fyeCo, ["FINANCIAL_STATEMENTS"]])).r;
    const link = await db.one("SELECT prior_period_id FROM public.fiscal_periods WHERE id=$1", [r.periodId]);
    return r.outcome === "opened" && r.priorPeriodId && link.prior_period_id === r.priorPeriodId ? true : r;
  });

  group("Unchanged");
  await check("a company not created through create_entity keeps the legacy calendar-year TZS period (its table defaults are not a choice)", async () => {
    const p = await period((await open(plainCo, 2026)).periodId);
    return p.s === "2026-01-01" && p.e === "2026-12-31" && p.c === "TZS" && p.b === "v1_calendar_convention" ? true : p;
  });
  await check("the period created before the fix is reused, never rewritten", async () => {
    const r = await open(beforeCo, 2025);
    const p = await period(r.periodId);
    return p.s === "2025-01-01" && p.b === "v1_calendar_convention" ? true : p;
  });
  await check("an unknown currency on the company record falls back to the legacy period (never guessed)", async () => {
    await db.admin.query("UPDATE public.companies SET fiscal_year_end='2026-03-31', currency='XYZ', creation_request_id=gen_random_uuid() WHERE id=$1", [A]);
    const p = await period((await open(A, 2027)).periodId);
    return p.s === "2027-01-01" && p.c === "TZS" ? true : p;
  });

  await check("a company whose legacy calendar period would overlap keeps the legacy convention (no refusal, no crash)", async () => {
    const p = await period((await open(beforeCo, 2026)).periodId);
    return p.s === "2026-01-01" && p.b === "v1_calendar_convention" ? true : p;
  });

  group("Replay");
  await check("re-applying 20261028100000 is refused by its own preflight", async () => {
    try { await db.admin.query(migrationText(FIX)); return "accepted"; } catch (e) { return e.code === "P0001" && /already in force/.test(e.message) ? true : e.message; }
  });
  await check("the rest of the chain applies after it", async () => {
    const chain = chainFiles();
    for (const f of chain.slice(chain.indexOf(FIX) + 1)) await db.admin.query(migrationText(f));
    return true;
  });
}

try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("PERIOD_FROM_COMPANY", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
