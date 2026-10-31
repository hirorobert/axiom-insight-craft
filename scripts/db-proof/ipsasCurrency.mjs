// Native proof of the IPSAS denomination rules (independent review of #229, finding 4), on the full migration chain in a disposable loopback database.
// Synthetic data only; never a hosted database. Every company here is certified by the REAL processing engine in its own currency.
//
// RULE under test. Every typed amount is a number of minor units of the denomination the SERVER confirms from the certified current period
// (_ipsas_presentation): never an assumption (the page used to hardcode TZS with two decimals, so a JPY balance of 14,000 was shown as 140.00),
// never the browser's locale, never converted. A payload entered in another denomination, or without one, is refused by name; an unknown or unsupported
// denomination is refused by name; a saved draft entered in another denomination is never re-read under this one; a prior period in another currency
// or unit makes the opening figure unknown, not wrong. Supported: exponent 0, 1, 2 or 3.
// DB_PROOF_MODE=external DB_PROOF_CONN=postgres://... | DB_PROOF_MODULES_DIR=<dir>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChain, certifier, csv, FY2025, FY2026, makeWorld, openDatabase, REPO, TB, uuid } from "./lib/reportingKit.mjs";
import { CASES, DENOMINATIONS, PROOF } from "./ipsasCurrency.manifest.mjs";
import { entity47, grantA } from "../../src/lib/ipsasAccrual/grants.fixture.ts";

const results = [], failures = [];
const manifest = fs.readFileSync(new URL("./ipsasCurrency.manifest.mjs", import.meta.url));
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results/ipsasCurrency.present.json");
let db, W, U, completed = false, crashed = false, crashMessage = null, seq = 0;
async function kase(id, fn) {
  if (process.env.CURRENCY_ONLY && !id.startsWith("setup.") && !id.includes(process.env.CURRENCY_ONLY)) return;
  assert(CASES.some((c) => c.id === id), `case ${id} not in manifest`); assert(!results.some((c) => c.id === id), `duplicate ${id}`);
  try { await fn(); results.push({ id, outcome: "pass" }); console.log("PASS", id); }
  catch (e) { results.push({ id, outcome: "fail", detail: `${e.code ?? ""}: ${String(e.message).split("\n")[0]}` }); failures.push(id); console.log("FAIL", id, "-", String(e.message).split("\n")[0].slice(0, 500)); }
}
const one = async (sql, p = []) => (await db.admin.query(sql, p)).rows[0];
const count = async (table, company) => Number((await one(`SELECT count(*) n FROM public.${table} WHERE company_id=$1`, [company])).n);
const asU = (uid, sql, p) => db.asUser(uid, sql, p).then((x) => x.r);

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────
const DEN = { "tzs-2": { code: "TZS", exp: 2 }, "usd-2": { code: "USD", exp: 2 }, "jpy-0": { code: "JPY", exp: 0 }, "kwd-3": { code: "KWD", exp: 3 } };
const fmt = (v, exp) => (v === "" ? "" : Number(v).toFixed(exp));
/** The trial balance of the other proofs, its amounts written with exactly the currency's own number of decimals. */
const rowsFor = (exp) => TB.map((r) => [r[0], r[1], r[2], r[3], r[4], fmt(r[5], exp), fmt(r[6], exp), fmt(r[7], exp), fmt(r[8], exp)]);
const minor = (whole, exp) => (BigInt(whole) * 10n ** BigInt(exp)).toString();
const CLASS_ID = "33333333-3333-4333-8333-333333333333";
const REG = { type: "register", reference: "Fixed asset register FY2026" };
const item = () => ({ label: "E1", costMinor: "2000000", residualMinor: "0", openingAccumulatedMinor: "400000", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "" });
const estimate = () => ({ basis: "cost", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", residualMinor: "0", convention: "daily",
  factors: { usage: "single shift", wear: "annual service", obsolescence: "none expected", legalLimits: "none" }, chargeSource: "calculated", registerChargeMinor: "", registerReference: "",
  items: [item()], calculatedChargeMinor: "", chargeDifference: { amountMinor: "", explanation: "", evidence: "" }, changedSincePrior: "no", changeDescription: "", changeEffectMinor: "",
  rationale: "Ten years of single-shift use expected", evidence: "Maintenance plan MP-2026" });
const cls = () => ({ classId: CLASS_ID, label: "Equipment", accounts: "1500, 1510", measurementModel: "cost",
  opening: { grossMinor: "2000000", accumulatedDepreciationMinor: "400000", accumulatedImpairmentMinor: "0", carryingMinor: "1600000" },
  closing: { grossMinor: "2000000", accumulatedDepreciationMinor: "600000", accumulatedImpairmentMinor: "0", carryingMinor: "1400000" },
  movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "200000", accumulatedImpairmentMinor: "0", source: REG, note: "" }], disposals: [], estimate: estimate() });
const none = () => ({ status: "none_with_basis", text: "Checked the asset register and board minutes", evidence: "Register FY2026 and minutes", checkedBy: "", flags: { applies: false } });
const wp = (A, presentation) => ({ contract: "cfoclose-ipsas-ppe-workpaper/1", companyId: A, periodYear: 2026, ...(presentation === undefined ? {} : { presentation }), period: { start: "2026-01-01", end: "2026-12-31" }, convention: "daily", classes: [cls()],
  entityAnswers: { heritage_assets: none(), infrastructure_assets: none(), impairment_indicators: none(), held_for_sale: none(), commitments_restrictions: none() }, depreciationDifference: null,
  tbSelection: { ppeAccountKeys: ["1500", "1510"], depreciationExpenseKeys: ["6200"] } });
const prior = (A, currency, scale) => ({ contract: "cfoclose-ipsas-prior-figures/1", companyId: A, periodYear: 2026, currency, scale,
  lines: [{ lineId: "ppe", label: "Property, plant and equipment (carrying amount)", amountMinor: null, locator: "" }], items: [] });
const grantsPayload = (A, presentation) => ({ contract: "cfoclose-ipsas-grants/1", companyId: A, periodYear: 2026, ...(presentation === undefined ? {} : { presentation }), entityAnswers: entity47(), tbSelection: { revenueKeys: [], liabilityKeys: [], receivableKeys: [] }, grants: [grantA()] });
const SAVE = "SELECT public.ipsas_save_preparation($1,2026,$2,$3::jsonb,$4,$5) r";
const SAVE_G = "SELECT public.ipsas_save_grants($1,2026,$2::jsonb,$3,$4) r";
const CONFIRM = "SELECT public.ipsas_confirm($1,2026,'ppe_class_estimate',$2,$3,$4) r";
const CTX = "SELECT public.ipsas_prep_context($1,2026) r", CTX_G = "SELECT public.ipsas_grants_context($1,2026) r";

async function newAccount() {
  const uid = uuid();
  await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [uid, `curowner-${uid}@example.test`]);
  const prod = (await db.one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  const bc = (await db.one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
  await db.admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  return uid;
}
/** A company whose 2026 (and 2025) trial balances are really processed and certified in `code` with `exp` decimals. */
async function company({ code, exp, priorCode = code, priorExp = exp, certify = true }) {
  const owner = await newAccount();
  const A = await W.company(owner, `Currency case ${++seq} ${code}`, "ipsas_accrual");
  for (const k of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], k]);
  await W.rollout(A, true);
  if (certify) {
    const k = await certifier(db, { ...U, owner });
    for (const [y, col, c, e] of [[2025, FY2025, priorCode, priorExp], [2026, FY2026, code, exp]]) {
      const rows = rowsFor(e); const u = await k.upload(A, y, csv(col, rows), { currency: c });
      if (y === 2025) await k.review(A, u, rows); await k.certify(A, u);
    }
  }
  return { A, owner };
}
const facts = async (c) => { await db.admin.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [U.preparer]); return (await one(`SELECT public._ipsas_tb_facts($1,2026,'{"ppeAccountKeys":["1500","1510"],"depreciationExpenseKeys":["6200"]}') r`, [c.A])).r; };
const cache = {};
const co = async (d) => (cache[d] ??= await company({ code: DEN[d].code, exp: DEN[d].exp }));
const other = (d) => (DEN[d].code === "TZS" ? { currency: "JPY", exponent: 0 } : { currency: "TZS", exponent: 2 });

try {
  db = await openDatabase("ipsas_currency");
  await kase("setup.chain-and-world", async () => {
    const err = await applyChain(db); assert.equal(err, null, String(err));
    W = await makeWorld(db); U = W.U;
  });
  if (failures.length) throw new Error("setup failed");

  for (const d of DENOMINATIONS) {
    const { code, exp } = DEN[d];
    await kase(`${d}.server-states-the-denomination`, async () => {
      const c = await co(d);
      const ctx = await asU(U.preparer, CTX, [c.A]); assert.equal(ctx.outcome, "available");
      assert.deepEqual(ctx.assessment.presentation, { state: "known", currency: code, exponent: exp }, "the prep assessment must state the certified period's currency and exponent");
      assert.deepEqual((await asU(U.preparer, CTX_G, [c.A])).live.presentation, { state: "known", currency: code, exponent: exp }, "the grants live state must state the same");
    });
    await kase(`${d}.figures-are-exact-minor-units`, async () => {
      const c = await co(d), f = await facts(c);
      // the trial balance holds equipment at cost 20,000 and accumulated depreciation 6,000 (4,000 a year earlier) and depreciation expense 2,000, in whole units of the currency
      assert.equal(f.ppeCarryingClosingMinor, minor(14000, exp)); assert.equal(f.ppeCarryingOpeningMinor, minor(16000, exp)); assert.equal(f.depreciationExpenseMinor, minor(2000, exp));
      assert.equal(f.comparative, "compatible");
    });
    await kase(`${d}.matching-payload-saved-and-reopened`, async () => {
      const c = await co(d), pres = { currency: code, exponent: exp };
      const saved = await asU(U.preparer, SAVE, [c.A, "ppe_workpaper", JSON.stringify(wp(c.A, pres)), null, uuid()]);
      assert.equal(saved.outcome, "recorded", JSON.stringify(saved).slice(0, 200)); c.wpRev = saved.revisionId;
      const ctx = await asU(U.preparer, CTX, [c.A]);
      assert.deepEqual(ctx.workpaper.payload.presentation, pres, "the saved draft reopens in the denomination it was entered in");
      assert.deepEqual(ctx.assessment.presentation, { state: "known", ...pres });
      assert.equal(ctx.assessment.tb.ppeCarryingClosingMinor, minor(14000, exp));
    });
    await kase(`${d}.other-denomination-refused-nothing-written`, async () => {
      const c = await co(d), before = await count("ipsas_prep_revisions", c.A), o = other(d);
      for (const [label, payload] of [["another currency and unit", wp(c.A, o)], ["the right currency, another exponent", wp(c.A, { currency: code, exponent: exp === 2 ? 0 : 2 })], ["no denomination at all", wp(c.A)]]) {
        const r = await asU(U.preparer, SAVE, [c.A, "ppe_workpaper", JSON.stringify(payload), c.wpRev, uuid()]);
        assert.deepEqual(r, { outcome: "denomination_mismatch" }, `${label}: ${JSON.stringify(r).slice(0, 160)}`);
      }
      assert.equal(await count("ipsas_prep_revisions", c.A), before, "a refusal writes nothing");
    });
    await kase(`${d}.prior-figures-currency-and-scale-checked`, async () => {
      const c = await co(d);
      const bad1 = await asU(U.preparer, SAVE, [c.A, "prior_figures", JSON.stringify(prior(c.A, other(d).currency, other(d).exponent)), null, uuid()]);
      const bad2 = await asU(U.preparer, SAVE, [c.A, "prior_figures", JSON.stringify(prior(c.A, code, exp === 2 ? 0 : 2)), null, uuid()]);
      assert.deepEqual([bad1, bad2], [{ outcome: "denomination_mismatch" }, { outcome: "denomination_mismatch" }]);
      const good = await asU(U.preparer, SAVE, [c.A, "prior_figures", JSON.stringify(prior(c.A, code, exp)), null, uuid()]);
      assert.equal(good.outcome, "recorded", JSON.stringify(good).slice(0, 160));
    });
  }

  await kase("unsupported.exponent-four-refused-by-name", async () => {
    // Layer 1, upstream: the processing engine itself refuses a currency whose exponent it cannot check exactly, so such a source never becomes a
    // certified current source; the page sees no confirmed denomination and the save is refused by name.
    await db.admin.query("INSERT INTO public.currency_registry (code, exponent, name) VALUES ('XTS', 4, 'proof-only four-decimal unit')");
    const c = await company({ code: "XTS", exp: 4, certify: false });
    const k = await certifier(db, { ...U, owner: c.owner }), rows = rowsFor(4), u = await k.upload(c.A, 2026, csv(FY2026, rows), { currency: "XTS" });
    await assert.rejects(() => k.certify(c.A, u), /CURRENCY_UNSUPPORTED/, "the engine must refuse to certify an exponent-four source");
    assert.deepEqual((await asU(U.preparer, CTX, [c.A])).assessment.presentation, { state: "unknown" });
    assert.deepEqual(await asU(U.preparer, SAVE, [c.A, "ppe_workpaper", JSON.stringify(wp(c.A, { currency: "XTS", exponent: 4 })), null, uuid()]), { outcome: "denomination_unavailable" });
    assert.equal(await count("ipsas_prep_revisions", c.A), 0);
    // Layer 2, at this server's own boundary: whatever authority supplies, only exponent 0-3 with an ISO-shaped code is 'known'.
    const pres = async (input) => (await one("SELECT public._ipsas_presentation($1::jsonb) r", [JSON.stringify(input)])).r;
    const cur = (currency, exponent) => ({ state: "current", current: { currency, exponent } });
    for (const exponent of [0, 1, 2, 3]) assert.deepEqual(await pres(cur("JPY", exponent)), { state: "known", currency: "JPY", exponent });
    for (const [currency, exponent] of [["XTS", 4], ["XTS", 5], ["JPY", -1], ["jpy", 0], ["JP", 0], ["JPYY", 2], [null, 2], ["JPY", null], ["JPY", "2.5"]]) {
      assert.equal((await pres(cur(currency, exponent))).state, "unsupported", `${currency}/${exponent} must be refused as unsupported`);
    }
    for (const input of [null, {}, { state: "no_authority" }, { state: "legacy_certification" }]) assert.deepEqual(await pres(input), { state: "unknown" });
  });
  await kase("unknown.no-certified-source-refused-by-name", async () => {
    const c = await company({ code: "TZS", exp: 2, certify: false });
    const ctx = await asU(U.preparer, CTX, [c.A]);
    assert.deepEqual(ctx.assessment.presentation, { state: "unknown" }, "no certified source: the denomination is unknown, never a default");
    assert.deepEqual(await asU(U.preparer, SAVE, [c.A, "ppe_workpaper", JSON.stringify(wp(c.A, { currency: "TZS", exponent: 2 })), null, uuid()]), { outcome: "denomination_unavailable" });
    assert.equal(await count("ipsas_prep_revisions", c.A), 0);
  });
  await kase("prior-period.different-currency-makes-the-opening-unknown", async () => {
    const c = await company({ code: "USD", exp: 2, priorCode: "JPY", priorExp: 0 });
    const f = await facts(c);
    assert.equal(f.comparative, "incompatible", "a prior period in another currency or unit is not used");
    assert.equal(f.ppeCarryingOpeningMinor, null, "the opening carrying amount is unknown, not a figure in the wrong unit");
    assert.equal(f.ppeCarryingClosingMinor, minor(14000, 2), "the current period is unaffected");
  });
  await kase("saved-draft.entered-in-another-denomination-is-never-reread", async () => {
    const c = await company({ code: "TZS", exp: 2 }), cert = (await one("SELECT id FROM public.get_authoritative_certification($1,2026)", [c.A])).id;
    const payload = wp(c.A, { currency: "JPY", exponent: 0 });                           // a draft entered in yen, as if the period's units later changed
    const revId = uuid(), sha = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await db.admin.query(`INSERT INTO public.ipsas_prep_revisions (id, company_id, period_year, kind, payload, payload_sha256, certification_id, receipt, actor_user_id, request_id, request_fingerprint)
      VALUES ($1,$2,2026,'ppe_workpaper',$3::jsonb,$4,$5,'{}'::jsonb,$6,$7,$4)`, [revId, c.A, JSON.stringify(payload), sha, cert, U.preparer, uuid()]);
    const before = await count("ipsas_prep_revisions", c.A);
    const save = await asU(U.preparer, SAVE, [c.A, "ppe_workpaper", JSON.stringify(wp(c.A, { currency: "TZS", exponent: 2 })), revId, uuid()]);
    assert.deepEqual(save, { outcome: "denomination_mismatch" }, "a save built on a draft in another denomination is refused, however it is labelled");
    assert.equal(await count("ipsas_prep_revisions", c.A), before);
    c.legacy = revId;
  });
  await kase("grants.same-rules-and-live-presentation", async () => {
    const c = await co("jpy-0"), pres = { currency: "JPY", exponent: 0 };
    assert.deepEqual((await asU(U.preparer, SAVE_G, [c.A, JSON.stringify(grantsPayload(c.A, { currency: "TZS", exponent: 2 })), null, uuid()])), { outcome: "denomination_mismatch" });
    assert.deepEqual((await asU(U.preparer, SAVE_G, [c.A, JSON.stringify(grantsPayload(c.A)), null, uuid()])), { outcome: "denomination_mismatch" });
    const ok = await asU(U.preparer, SAVE_G, [c.A, JSON.stringify(grantsPayload(c.A, pres)), null, uuid()]);
    assert.equal(ok.outcome, "recorded"); c.grantRev = ok.revisionId;
    assert.deepEqual(ok.live.presentation, { state: "known", ...pres });
    assert.deepEqual((await asU(U.preparer, CTX_G, [c.A])).register.payload.presentation, pres);
  });
  await kase("confirmations.refuse-a-mismatched-denomination", async () => {
    const jp = await co("jpy-0");
    const ok = await asU(U.partner, CONFIRM, [jp.A, CLASS_ID, jp.wpRev, uuid()]);
    assert.equal(ok.outcome, "confirmed", JSON.stringify(ok).slice(0, 160));
    const c = await company({ code: "TZS", exp: 2 }), cert = (await one("SELECT id FROM public.get_authoritative_certification($1,2026)", [c.A])).id;
    const payload = wp(c.A, { currency: "JPY", exponent: 0 }), revId = uuid(), sha = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await db.admin.query(`INSERT INTO public.ipsas_prep_revisions (id, company_id, period_year, kind, payload, payload_sha256, certification_id, receipt, actor_user_id, request_id, request_fingerprint)
      VALUES ($1,$2,2026,'ppe_workpaper',$3::jsonb,$4,$5,'{}'::jsonb,$6,$7,$4)`, [revId, c.A, JSON.stringify(payload), sha, cert, U.preparer, uuid()]);
    const before = await count("ipsas_confirmations", c.A);
    assert.deepEqual(await asU(U.partner, CONFIRM, [c.A, CLASS_ID, revId, uuid()]), { outcome: "denomination_mismatch" });
    assert.equal(await count("ipsas_confirmations", c.A), before, "nothing is confirmed in a denomination the server would read differently");
  });
  await kase("persisted.nothing-written-by-a-refusal", async () => {
    for (const d of DENOMINATIONS) { const c = await co(d); const n = await count("ipsas_prep_revisions", c.A); assert.equal(n, 2, `${d}: exactly the accepted workpaper and the accepted prior figures were written, none of the refused ones`); }
  });
  completed = failures.length === 0;
} catch (e) { crashed = true; crashMessage = `${e.code ?? ""}: ${e.stack ?? e.message}`; console.error(crashMessage); process.exitCode = 1; }
finally {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2) + "\n");
  console.log(`IPSAS_CURRENCY: ${results.filter((r) => r.outcome === "pass").length}/${CASES.length} passed${failures.length ? `; FAILED: ${failures.join(", ")}` : ""}`);
  if (failures.length) process.exitCode = 1;
  await db?.close(); process.exit(process.exitCode ?? 0);
}
