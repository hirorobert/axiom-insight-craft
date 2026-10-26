#!/usr/bin/env bun
// Real-PostgreSQL proof of the trial-balance classification SUGGESTIONS made by the REAL process-trial-balance handler
// (only the network edges replaced; lib/functionHarness.mjs), on the whole current migration chain with its shipped keyword
// dictionary and NO global mappings. Synthetic data only; the acceptance files are read unchanged from the repository.
//
//   acceptance   both acceptance years (docs/release/acceptance-r1) on a fresh company: every machine suggestion equals the
//                fixture's classification (account_classification.csv), except the bank loan, whose maturity a name cannot
//                give: it is sent to review with NO suggestion (never cash). After a reviewer accepts the suggestions and
//                decides the loan, both years certify and their class totals equal EXPECTED_TOTALS.csv;
//   names        the same names with and without qualifiers ("(acceptance r1)", " - goods"), the existing override cases
//                (repairs and insurance of assets) and ordinary depreciation, sales, bank and interest income;
//   precedence   a reviewed company mapping still decides its account (a reviewed loan mapping is used as reviewed, no
//                review); the review decisions stay append-only history.
//
// Before mode (registered defect reproduction): BEFORE_REF=<commit> loads the handler at that commit and asserts it makes the
// four wrong suggestions recorded in docs/release/classification-r1/RECORD.md — so the proof is known to detect them.
//
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://…(an EMPTY loopback database) bun scripts/db-proof/classificationSuggestions.mjs
import fs from "node:fs";
import path from "node:path";
import { call, functionsAtCommit, loadFunctionTree, mintTestJwt, shim } from "./lib/functionHarness.mjs";
import { applyChain, makeWorld, openDatabase, REPO, reporter, uuid } from "./lib/reportingKit.mjs";

const BEFORE_REF = process.env.BEFORE_REF ?? "";
const { group, check, finish } = reporter();
const FIX = path.join(REPO, "docs/release/acceptance-r1");
const readCsv = (f) => fs.readFileSync(path.join(FIX, f), "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const META = {
  revenue: ["income_statement", "credit"], other_income: ["income_statement", "credit"], cost_of_goods_sold: ["income_statement", "debit"],
  operating_expenses: ["income_statement", "debit"], taxes: ["income_statement", "debit"], current_assets: ["balance_sheet", "debit"],
  non_current_assets: ["balance_sheet", "debit"], current_liabilities: ["balance_sheet", "credit"], non_current_liabilities: ["balance_sheet", "credit"],
  equity: ["balance_sheet", "credit"],
};
let db;

async function main() {
  db = await openDatabase(BEFORE_REF ? "classification_before" : "classification_proof");
  group("Replay — the whole chain");
  await check("the whole chain applies (shipped keyword dictionary; no global mappings)", async () => {
    const e = await applyChain(db); if (e) return e;
    return (await db.count("SELECT count(*) n FROM public.account_mappings WHERE company_id IS NULL")) === 0 ? true : "global mappings present";
  });
  const W = await makeWorld(db);
  const { U } = W;
  // The FIRM account (capacity 25): this proof opens several companies.
  const OWNER = U.ownerB;
  const ptb = (await loadFunctionTree(REPO, "process-trial-balance",
    BEFORE_REF ? { functionsDir: functionsAtCommit(REPO, BEFORE_REF, "process-trial-balance") } : {})).handler;

  let periods = 0;
  const upload = async (company, year, text) => {
    const end = `${year}-12-31`;
    const pid = (await db.one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$2) RETURNING id",
      [company, end, `FY${year}-${++periods}`, OWNER, `${year}-01-01`])).id;
    const filePath = `${OWNER}/${uuid()}.csv`;
    const id = (await db.one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,$2,'processing',$3,$4,$5,$6) RETURNING id`, [filePath, text.length, company, year, pid, OWNER])).id;
    shim.storage.set(`trial-balance-files/${filePath}`, new TextEncoder().encode(text));
    const r = await call(ptb, db.pool, mintTestJwt(OWNER), { uploadId: id, clientRequestId: uuid() });
    return { id, year, http: r.http };
  };
  const reviewList = async (id) => (await db.one("SELECT validation_report v FROM public.trial_balance_uploads WHERE id=$1", [id])).v?.mapping_completeness?.review_accounts ?? [];
  const reprocess = async (id) => {
    const op = uuid();
    const hash = (await db.one("SELECT source_file_hash h FROM public.trial_balance_uploads WHERE id=$1", [id])).h;
    const q = (await db.asUser(OWNER, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [id, op, hash])).r;
    if (q.outcome !== "accepted") return q;
    return (await call(ptb, db.pool, mintTestJwt(OWNER), { uploadId: id, clientRequestId: op })).body;
  };
  const decide = (company, uploadId, rows) => db.asUser(OWNER, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb) r", [company, uploadId, uuid(), JSON.stringify(rows.map((r) => ({
    account_code: r.code, account_name: r.name, proposal_type: r.suggested ? "MACHINE_SUGGESTION" : "NONE", suggested_classification: r.suggested ?? undefined,
    decision_action: r.suggested && r.suggested === r.cls ? "USER_ACCEPTED_SUGGESTION" : "USER_MANUAL_CLASSIFICATION",
    statement: META[r.cls][0], classification: r.cls, normal_balance: META[r.cls][1], is_cash_account: r.cash === true })))]).then((x) => x.r);

  const fixture = new Map(readCsv("account_classification.csv").map(([code, name, cls, , , cash]) => [code, { name, cls, cash: cash === "yes" }]));
  const tbText = (f) => fs.readFileSync(path.join(FIX, f), "utf8");

  if (BEFORE_REF) {
    group(`Before (${BEFORE_REF.slice(0, 8)}) — the registered wrong suggestions reproduce`);
    const A = await W.company(OWNER, "Before company");
    const u = await upload(A, 2025, tbText("trial_balance_FY2025_current.csv"));
    const got = Object.fromEntries((await reviewList(u.id)).map((a) => [a.account_code, a.suggested_classification ?? null]));
    for (const [code, wrong] of [["95000", "revenue"], ["91510", "operating_expenses"], ["92500", "current_assets"], ["94100", "revenue"]]) {
      await check(`${code} ${fixture.get(code).name}: suggested ${wrong} (expected ${fixture.get(code).cls})`, async () => got[code] === wrong ? true : got[code]);
    }
    return;
  }

  group("Acceptance files — every suggestion, both years, fresh company");
  const A = await W.company(OWNER, "Acceptance r1 synthetic");
  const years = [[2024, "trial_balance_FY2024_prior.csv"], [2025, "trial_balance_FY2025_current.csv"]];
  const uploads = {};
  for (const [year, file] of years) {
    uploads[year] = await upload(A, year, tbText(file));
    const list = await reviewList(uploads[year].id);
    await check(`FY${year}: all ${fixture.size} accounts go to review (nothing is accepted without a reviewer)`, async () =>
      list.length === fixture.size && [...fixture.keys()].every((c) => list.some((a) => a.account_code === c)) ? true : list.map((a) => a.account_code));
    for (const [code, f] of fixture) {
      const a = list.find((x) => x.account_code === code);
      if (code === "92500") {
        await check(`FY${year} ${code} ${f.name}: no suggestion (maturity cannot be read from a name), never cash`, async () =>
          a && !a.suggested_classification && /loan|borrowing/i.test(a.reason ?? "") ? true : a);
      } else {
        await check(`FY${year} ${code} ${f.name}: suggested ${f.cls}`, async () => a?.suggested_classification === f.cls ? true : a?.suggested_classification);
      }
    }
  }

  group("Reviewer accepts the suggestions and decides the loan; both years certify with the expected totals");
  const decisions = [...fixture].map(([code, f]) => ({ code, name: f.name, cls: f.cls, cash: f.cash, suggested: code === "92500" ? null : f.cls }));
  await check("one review batch records 18 decisions (17 accepted suggestions, 1 manual)", async () => {
    const r = await decide(A, uploads[2025].id, decisions);
    const n = await db.one(`SELECT count(*) FILTER (WHERE decision_action='USER_ACCEPTED_SUGGESTION') acc, count(*) FILTER (WHERE decision_action='USER_MANUAL_CLASSIFICATION') man
      FROM public.account_review_decisions WHERE company_id=$1`, [A]);
    return r.decisions_logged === 18 && Number(n.acc) === 17 && Number(n.man) === 1 ? true : { r, n };
  });
  const expected = Object.fromEntries(readCsv("EXPECTED_TOTALS.csv").map(([, line, cur, prior]) => [line, { 2025: cur, 2024: prior }]));
  const minor = (s) => String(Math.round(Number(s) * 100));
  for (const [year] of years) {
    await check(`FY${year}: re-check certifies; total assets, liabilities, equity and profit equal EXPECTED_TOTALS.csv`, async () => {
      const body = await reprocess(uploads[year].id);
      const cert = await db.one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, year]);
      const amounts = (await db.one("SELECT processing_result->'amounts'->'classes' c FROM public.trial_balance_uploads WHERE id=$1", [uploads[year].id])).c;
      if (!cert || !amounts) return { body: JSON.stringify(body).slice(0, 300) };
      const profit = BigInt(amounts.income_minor) - BigInt(amounts.expenses_minor);
      const ok = amounts.assets_minor === minor(expected["Total assets"][year]) && amounts.liabilities_minor === minor(expected["Total liabilities"][year])
        && String(BigInt(amounts.equity_minor) + profit) === minor(expected["Total equity"][year]) && String(profit) === minor(expected["Profit for the period"][year]);
      return ok ? true : { amounts, expected: Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, v[year]])) };
    });
  }
  await check("FY2025 certified snapshot: 95000 cost of sales, 91510 a non-current asset (class side −6,000.00: it still reduces assets), 92500 non-current liability", async () => {
    const cert = await db.one("SELECT id FROM public.get_authoritative_certification($1,2025)", [A]);
    const rows = Object.fromEntries((await db.admin.query("SELECT account_code, classification, class_side_minor FROM public._cr_certified_accounts($1)", [cert.id])).rows.map((r) => [r.account_code, r]));
    return rows["95000"].classification === "cost_of_goods_sold" && rows["91510"].classification === "non_current_assets" && rows["91510"].class_side_minor === "-600000"
      && rows["92500"].classification === "non_current_liabilities" ? true : rows;
  });

  group("Names with and without qualifiers — and the existing expense-over-asset cases");
  const B = await W.company(OWNER, "Name variants");
  const NAMES = [
    ["10", "Cost of sales", "cost_of_goods_sold"], ["11", "Cost of sales (acceptance r1)", "cost_of_goods_sold"], ["12", "Cost of sales - goods", "cost_of_goods_sold"],
    ["20", "Accumulated depreciation", "non_current_assets"], ["21", "Accumulated depreciation (acceptance r1)", "non_current_assets"],
    ["22", "Accumulated depreciation - equipment", "non_current_assets"],
    ["30", "Depreciation", "operating_expenses"], ["31", "Depreciation (acceptance r1)", "operating_expenses"], ["32", "Depreciation charge - vehicles", "operating_expenses"],
    ["40", "Sales", "revenue"], ["41", "Sales (acceptance r1)", "revenue"], ["42", "Sales - retail", "revenue"],
    ["50", "Interest income", "other_income"], ["51", "Interest income (acceptance r1)", "other_income"], ["52", "Interest income - deposits", "other_income"],
    ["60", "Bank", "current_assets"], ["61", "Bank (acceptance r1)", "current_assets"],
    ["70", "Bank loan", null], ["71", "Bank loan (acceptance r1)", null], ["72", "Loan from director", null],
    ["73", "Long term loan", "non_current_liabilities"], ["74", "Loan interest", "operating_expenses"], ["75", "Bank charges", "operating_expenses"],
    ["80", "Repair & Maintenance - Motor Vehicles", "operating_expenses"], ["81", "Motor Vehicle Insurance", "operating_expenses"], ["82", "Equipment Repairs", "operating_expenses"],
  ];
  const lines = NAMES.map(([code, name]) => `${code},${name},100.00,`);
  const text = ["Account code,Account name,Debit,Credit", ...lines, `99,Share capital,,${(NAMES.length * 100).toFixed(2)}`].join("\n") + "\n";
  const ub = await upload(B, 2025, text);
  const got = Object.fromEntries((await reviewList(ub.id)).map((a) => [a.account_code, a]));
  for (const [code, name, cls] of NAMES) {
    await check(cls ? `"${name}" → ${cls}` : `"${name}" → review with no suggestion (not cash)`, async () =>
      cls ? (got[code]?.suggested_classification === cls ? true : got[code]?.suggested_classification ?? got[code])
          : (got[code] && !got[code].suggested_classification ? true : got[code]));
  }

  group("Reviewed mappings keep precedence; decisions stay history");
  await check("a reviewed loan mapping (non-current liability) is used as reviewed: no review, certified on it", async () => {
    const C = await W.company(OWNER, "Reviewed loan");
    const t = "Account code,Account name,Debit,Credit\n10,Bank,500.00,\n20,Bank loan,,500.00\n";
    const u = await upload(C, 2025, t);
    await decide(C, u.id, [{ code: "10", name: "Bank", cls: "current_assets", cash: true, suggested: "current_assets" }, { code: "20", name: "Bank loan", cls: "non_current_liabilities", suggested: null }]);
    await reprocess(u.id);
    const left = await reviewList(u.id);
    const cert = await db.one("SELECT id FROM public.get_authoritative_certification($1,2025)", [C]);
    const row = cert && (await db.one("SELECT classification FROM public._cr_certified_accounts($1) WHERE account_code='20'", [cert.id]));
    return left.length === 0 && row?.classification === "non_current_liabilities" ? true : { left, row };
  });
  await check("a reviewed mapping that DISAGREES with the rules is still used as reviewed (rules never overwrite a decision)", async () => {
    const D = await W.company(OWNER, "Reviewed disagreement");
    const t = "Account code,Account name,Debit,Credit\n10,Bank,700.00,\n30,Cost of sales,,700.00\n";
    const u = await upload(D, 2025, t);
    await decide(D, u.id, [{ code: "10", name: "Bank", cls: "current_assets", cash: true, suggested: "current_assets" }, { code: "30", name: "Cost of sales", cls: "revenue", suggested: "cost_of_goods_sold" }]);
    await reprocess(u.id);
    const m = await db.one("SELECT classification, confidence_source FROM public.account_mappings WHERE company_id=$1 AND account_code='30'", [D]);
    const cert = await db.one("SELECT id FROM public.get_authoritative_certification($1,2025)", [D]);
    const row = cert && (await db.one("SELECT classification FROM public._cr_certified_accounts($1) WHERE account_code='30'", [cert.id]));
    return m.classification === "revenue" && m.confidence_source === "user_approved" && row?.classification === "revenue" ? true : { m, row };
  });
  await refusedDelete();
}

async function refusedDelete() {
  await check("review decisions cannot be changed or deleted (append-only history)", async () => {
    try { await db.admin.query("DELETE FROM public.account_review_decisions"); return "delete was allowed"; }
    catch (e) { return /append-only/i.test(String(e.message)) ? true : String(e.message); }
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish(BEFORE_REF ? "CLASSIFICATION_BEFORE" : "CLASSIFICATION", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
shim.pool = null;
await db?.close();
process.exit(ok ? 0 : 1);
