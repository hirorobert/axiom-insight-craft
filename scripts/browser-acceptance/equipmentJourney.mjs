#!/usr/bin/env node
// NON-PRODUCTION browser journey for the multi-class equipment preparation (Financial Statements › Schedules).
//
// Starts a DISPOSABLE PostgreSQL with the loopback bridge (scripts/db-proof/serveReporting.mjs under bun; full chain,
// 20261206100000 included), the harness (dev-harness/reporting, Vite) and headless Chrome (cdp.mjs), then drives the
// REAL Schedules page with mouse and keyboard as a preparer:
//   load      the recorded one-class schedule (Equipment 16,000 → 14,000) is loaded with its carrying amounts and its
//             recorded depreciation; nothing else is assumed
//   classes   Equipment is split and a second class (Motor vehicles) added; both roll forward through cost and
//             accumulated depreciation; a typo leaves an exact difference that is never balanced
//   tie-out   the 2,000 charge is tied to the expense line it is presented in (bounded by the composed line)
//   questions only the applicable questions are asked; "none" needs who checked; the proposals appear when all are answered
//   record    classes, ten answers (including the zero-entry review) and three reviewed whole notes are recorded in one server transaction; the server's
//             schedule status reads Reconciled with two classes; the notes keep their existing wording
//   race      another preparer records a three-class schedule meanwhile; the page's next save is refused by name, every
//             edit is retained, and re-reading the preparation brings the third class in (never dropped)
//   access    a viewer sees no preparation; widths 1280 and 375 px checked for overflow and unlabeled fields
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> node scripts/browser-acceptance/equipmentJourney.mjs [outDir]
//   env: CHROME_PATH, REPORTING_BRIDGE_PORT (54996), REPORTING_HARNESS_PORT (8095)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "./cdp.mjs";
import { layoutProblems } from "./checks.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "equipment-journey-evidence"));
const BRIDGE_PORT = process.env.REPORTING_BRIDGE_PORT ?? "54996";
const HARNESS_PORT = process.env.REPORTING_HARNESS_PORT ?? "8095";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "journey.log"), s + "\n"); };
let page = null;
async function check(name, fn) {
  try { const r = await fn(); results.push({ name, ok: r === true, detail: r === true ? undefined : r }); log(`  ${r === true ? "PASS" : "FAIL"}  ${name}${r === true ? "" : `\n        ${JSON.stringify(r).slice(0, 1200)}`}`); if (r !== true) await failure(name); }
  catch (e) { results.push({ name, ok: false, detail: String(e?.message ?? e) }); log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`); await failure(name); }
}
async function failure(name) {
  if (!page) return;
  const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  try { await page.screenshot(path.join(OUT, `FAIL-${slug}.png`)); } catch { /* */ }
  try { fs.writeFileSync(path.join(OUT, `FAIL-${slug}.txt`), `${await page.url()}\n\n${await page.bodyText()}`); } catch { /* */ }
}
function start(cmd, args, env, ready) {
  const child = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  let out = "";
  const seen = new Promise((resolve, reject) => {
    const on = (b) => { out += b.toString(); const m = ready(out); if (m) resolve(m); };
    child.stdout.on("data", on); child.stderr.on("data", on);
    child.on("exit", (code) => reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${out.slice(-1500)}`)));
  });
  return { child, seen };
}

const bridge = start("bun", ["scripts/db-proof/serveReporting.mjs"], { REPORTING_BRIDGE_PORT: BRIDGE_PORT, REPORTING_STOP_ON_STDIN_END: "1" }, (o) => { const m = o.match(/READY (\{.*\})/); return m ? JSON.parse(m[1]) : null; });
const vite = start("bunx", ["vite", "--config", "dev-harness/reporting/vite.config.ts"], { REPORTING_HARNESS_PORT: HARNESS_PORT }, (o) => /ready in/.test(o));
let browser;
try {
  const ready = await bridge.seen;
  await vite.seen;
  const seed = await (await fetch(`${ready.bridge}/seed`, { method: "POST", headers: { "x-sim-user": "owner" }, body: "{}" })).json();
  const rpc = async (as, fn, body) => { const r = await fetch(`${ready.bridge}/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", "x-sim-user": as }, body: JSON.stringify(body) }); return r.json(); };
  const initial = await rpc("preparer", "fs_record_schedule", { p_company_id: seed.companyId, p_period_year: seed.periodYear, p_schedule_id: "ppe", p_source_ref: "SYNTHETIC recorded zero-effect entries for review", p_request_id: crypto.randomUUID(),
    p_rows: [{classLabel:"Equipment",openingMinor:"1600000",closingMinor:"1400000",movements:[{kind:"additions",amountMinor:"0"},{kind:"disposals",amountMinor:"0"},{kind:"depreciation",amountMinor:"-200000"}]}] });
  if (!["recorded", "unchanged"].includes(initial.outcome)) throw new Error(`Synthetic zero-entry setup refused: ${JSON.stringify(initial)}`);
  browser = await Browser.launch();
  const url = (as, hash, nav = true) => `http://127.0.0.1:${HARNESS_PORT}/dev-harness/reporting/index.html?bridge=${encodeURIComponent(ready.bridge)}&as=${as}${nav ? "" : "&nav=off"}#${hash}`;
  const open = async (as) => { const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.setViewport(1280, 900); return p; };
  const shot = (p, name) => p.screenshot(path.join(OUT, `${name}.png`));
  const go = async (p, as, hash, text, nav = true) => { await p.goto(url(as, hash, nav)); if (text) await p.waitForText(text, { timeout: 45000 }); await sleep(300); };
  /** Sets a React-controlled field found by its aria-label (input, select, textarea, checkbox), the way input events deliver it. */
  const setField = (p, label, value) => p.evaluate((lab, val) => {
    const el = document.querySelector(`[aria-label="${lab.replace(/"/g, '\\"')}"]`);
    if (!el) return `missing ${lab}`;
    if (el.type === "checkbox") { if (el.checked !== !!val) el.click(); return true; }
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, label, value);
  const setByLabel = (p, label, value) => p.evaluate((lab, val) => {
    const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(lab));
    const el = l && (l.control ?? l.querySelector("input,select,textarea"));
    if (!el) return `missing label ${lab}`;
    if (el.type === "checkbox") { if (el.checked !== !!val) el.click(); return true; }
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, label, value);
  const fieldValue = (p, label) => p.evaluate((lab) => document.querySelector(`[aria-label="${lab}"]`)?.value ?? null, label);
  const testid = (p, id) => p.evaluate((x) => document.querySelector(`[data-testid="${x}"]`)?.innerText ?? null, id);
  const fillClass = async (p, L, opening, closing, depreciation) => {
    const values = [
      [`${L}: accounts`, "1500 Equipment at cost, 1510 Accumulated depreciation"],
      [`${L}: opening total cost before depreciation (gross carrying amount)`, opening[0]], [`${L}: opening depreciation charged in total (accumulated)`, opening[1]], [`${L}: opening impairment recognised in total (accumulated)`, "0"], [`${L}: opening carrying amount (net)`, opening[2]],
      [`${L}: closing total cost before depreciation (gross carrying amount)`, closing[0]], [`${L}: closing depreciation charged in total (accumulated)`, closing[1]], [`${L}: closing impairment recognised in total (accumulated)`, "0"], [`${L}: closing carrying amount (net)`, closing[2]],
    ];
    for (const [k, v] of values) { const r = await setField(p, k, v); if (r !== true) return r; }
    if ((await fieldValue(p, `${L}: Depreciation for the year Accumulated depreciation`)) === null) { const r = await setField(p, `${L}: add a change`, "depreciation"); if (r !== true) return r; await sleep(100); }
    const more = [
      [`${L}: Depreciation for the year Accumulated depreciation`, depreciation], [`${L}: Depreciation for the year record type`, "register"], [`${L}: Depreciation for the year reference`, "Synthetic register depreciation report 2026"],
      [`${L}: measurement basis`, "cost"], [`${L}: depreciation method`, "straight-line"], [`${L}: useful life in years`, "10"], [`${L}: residual value`, "0"], [`${L}: part-year convention`, "full-period"],
      [`${L}: charge source`, "register"], [`${L}: register reference`, "Synthetic register depreciation report 2026"], [`${L}: register charge`, depreciation], [`${L}: changed since prior`, "no"],
      [`${L}: rationale`, "Expected ten years of two-shift use"], [`${L}: estimate evidence`, "Capital budget and maintenance plan"],
    ];
    for (const [k, v] of more) { const r = await setField(p, k, v); if (r !== true) return r; await sleep(30); }
    return true;
  };
  const answer = async (p, prefix, id, status, textValue) => {
    let r = await setField(p, `${prefix}${id} status`, status); if (r !== true) return r; await sleep(50);
    if (status === "answered") { r = await setField(p, `${prefix}${id} answer`, textValue); if (r !== true) return r; }
    else { r = await setField(p, `${prefix}${id} checked by`, "Synthetic preparer, 2027-01-15"); if (r !== true) return r; }
    return setField(p, `${prefix}${id} evidence`, "Engagement file E-2026");
  };

  const preparer = await open("preparer");
  page = preparer;
  log("\n== Load the recorded class");
  await check("the Schedules page offers the guided preparation; the recorded one-class schedule is loaded with its carrying amounts and recorded depreciation, and nothing else is assumed", async () => {
    await go(preparer, "preparer", "/statements/schedules", "Prepare equipment from supporting records");
    await preparer.click({ text: "Start guided equipment preparation" });
    await preparer.waitForText("1. Read the prior report");
    await preparer.waitForSelector('[aria-label="Equipment: opening carrying amount (net)"]', { timeout: 20000 });
    const opening = await fieldValue(preparer, "Equipment: opening carrying amount (net)"), dep = await fieldValue(preparer, "Equipment: Depreciation for the year Accumulated depreciation"), gross = await fieldValue(preparer, "Equipment: opening total cost before depreciation (gross carrying amount)");
    const life = await fieldValue(preparer, "Equipment: useful life in years");
    await shot(preparer, "01-loaded-class");
    return opening === "16000.00" && dep === "2000.00" && gross === "" && life === null ? true : { opening, dep, gross, life };
  });
  await check("recorded zero-effect entries remain until an explicit evidenced review; the recorded nonzero depreciation is kept", async () => {
    const before = await preparer.evaluate(() => document.querySelectorAll('[data-recorded-zero]').length);
    if (before !== 2) return {before};
    const checked = await setField(preparer, "Equipment: zero-effect reviewer", "Synthetic browser-test preparer");
    const evidence = await setField(preparer, "Equipment: zero-effect evidence", "SYNTHETIC purchase and disposal log: no such events");
    if (checked !== true || evidence !== true) return {checked,evidence};
    await preparer.click({text:"I checked: none of these events occurred — remove these zero-effect entries"});
    await preparer.waitForText("Zero-effect entry review retained");
    return (await preparer.evaluate(() => document.querySelectorAll('[data-recorded-zero]').length)) === 0
      && (await fieldValue(preparer, "Equipment: Depreciation for the year Accumulated depreciation")) === "2000.00";
  });
  log("\n== Prior report, two classes, destinations");
  await check("the prior figure is confirmed from a referenced record; Equipment is split and Motor vehicles added; both classes roll forward and agree to the statement line; a typo leaves an exact difference that is never balanced", async () => {
    for (const [k, v] of [["Available prior-year source", "reference"], ["Prior figure source reference", "Reviewed opening register page A1"], ["Prior reporting date", "2025-12-31"], ["Equipment net amount as printed", "16,000.00"], ["Currency printed", "TZS"], ["Units printed", "0"]]) { const r = await setByLabel(preparer, k, v); if (r !== true) return r; }
    await preparer.click('[data-testid="confirm-prior-figure"]');
    await preparer.click({ text: "Add a class" });
    await preparer.waitFor(() => document.querySelectorAll('[aria-label="Class name"]').length === 2, [], { label: "second class" });
    await preparer.evaluate(() => { const el = document.querySelectorAll('[aria-label="Class name"]')[1]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "Motor vehicles"); el.dispatchEvent(new Event("input", { bubbles: true })); });
    let r = await fillClass(preparer, "Equipment", ["12,500.00", "2,500.00", "10,000.00"], ["12,500.00", "3,750.00", "8,750.00"], "1,250.00"); if (r !== true) return r;
    r = await fillClass(preparer, "Motor vehicles", ["7,500.00", "1,500.00", "6,000.00"], ["7,500.00", "2,250.00", "5,250.00"], "750.00"); if (r !== true) return r;
    await preparer.click('[data-testid="confirm-movement-coverage"]');
    await preparer.click({ text: "Add a destination" });
    await preparer.waitForSelector('[aria-label="Destination 1 target"]');
    for (const [k, v] of [["Destination 1 target", "sci.operating_expenses_by_function"], ["Destination 1 amount", "2,000.00"], ["Destination 1 evidence", "Expense ledger 6200 Depreciation"]]) { r = await setField(preparer, k, v); if (r !== true) return r; }
    await sleep(300);
    const statement = await testid(preparer, "statement-status"), tie = await testid(preparer, "tieout-status"), bridgeS = await testid(preparer, "bridge-status");
    const body = await preparer.bodyText();
    // A typo: 1,000 instead of 1,250 leaves a 250.00 difference in accumulated depreciation; nothing is inferred.
    await setField(preparer, "Equipment: Depreciation for the year Accumulated depreciation", "1,000.00"); await sleep(300);
    const typo = await preparer.bodyText();
    await shot(preparer, "02-difference-never-balanced");
    await setField(preparer, "Equipment: Depreciation for the year Accumulated depreciation", "1,250.00"); await sleep(300);
    // Any change to a class withdraws the coverage confirmation; the preparer confirms it again after the correction.
    const coverageWithdrawn = !(await preparer.evaluate(() => document.querySelector('[data-testid="confirm-movement-coverage"]').checked));
    await preparer.click('[data-testid="confirm-movement-coverage"]');
    const commitDisabledDuringTypo = /difference TZS 250.00/.test(typo) && coverageWithdrawn;
    return /agree to the server statement line/.test(statement) && /account for the whole charge/.test(tie) && /arithmetic agrees/.test(bridgeS) && /Roll-forward of Motor vehicles: cost, accumulated depreciation/.test(body) && commitDisabledDuringTypo ? true : { statement, tie, bridgeS, typo: typo.slice(0, 300) };
  });
  log("\n== Only the applicable questions; proposals when answered");
  await check("the mandatory questions are asked, conditional ones are not; 'none' needs who checked; once every applicable question is answered the three proposals appear with every class", async () => {
    const asked = await preparer.evaluate(() => [...document.querySelectorAll("[data-question]")].map((q) => q.getAttribute("data-question")));
    if (asked.includes("addition_cost") || asked.includes("lease") || !asked.includes("impairment")) return { asked };
    let r = await setField(preparer, "restrictions_security status", "none_with_basis"); if (r !== true) return r;
    await sleep(100);
    const needsBasis = /'None' needs who checked|still need/.test(await testid(preparer, "questions-summary"));
    for (const [id, status, t] of [["restrictions_security", "none_with_basis"], ["commitments", "none_with_basis"], ["impairment", "answered", "No damage, obsolescence, idle items or early disposal plans; checklist signed"], ["events_after", "none_with_basis"], ["framework_history", "answered", "Prepared under the IFRS for SMEs since FY2020"]]) { r = await answer(preparer, "", id, status, t); if (r !== true) return r; }
    for (const L of ["Equipment", "Motor vehicles"]) { r = await answer(preparer, `${L}: `, "recognition", "answered", "All items owned; invoices and registration documents on file"); if (r !== true) return r; r = await answer(preparer, `${L}: `, "components", "answered", "No major parts with different lives"); if (r !== true) return r; }
    await preparer.waitForText("Every applicable question is answered");
    const policy = await preparer.evaluate(() => document.querySelector('[data-testid="proposal-smes.note.policies"]')?.value ?? "");
    await shot(preparer, "03-proposals");
    return needsBasis && /Equipment is measured at cost/.test(policy) && /Motor vehicles is measured at cost/.test(policy) ? true : { needsBasis, policy: policy.slice(0, 200) };
  });
  log("\n== Record everything in one transaction");
  let recordedScheduleId = null;
  await check("the three whole notes are prepared keeping the existing wording, reviewed, and recorded with every class and the answers in one server call; the server reconciles the two-class schedule", async () => {
    await preparer.click('[data-testid="prepare-notes"]');
    await preparer.waitForSelector('[aria-label="Proposed Accounting policies (equipment section)"]');
    const policyNote = await preparer.evaluate(() => document.querySelector('[aria-label="Proposed Accounting policies (equipment section)"]').value);
    await preparer.click('[data-testid="notes-reviewed"]');
    await preparer.click('[data-testid="commit-all"]');
    await preparer.waitForText("Recorded: workpaper", { timeout: 30000 });
    await shot(preparer, "04-recorded");
    const ctx = await rpc("preparer", "fs_equipment_context_v2", { p_company_id: seed.companyId, p_period_year: seed.periodYear });
    recordedScheduleId = ctx.schedule?.id ?? null;
    const status = await rpc("preparer", "fs_notes_status", { p_company_id: seed.companyId, p_period_year: seed.periodYear });
    const ppe = status.requirements?.find((x) => x.requirementId === "smes.schedule.ppe");
    await go(preparer, "preparer", "/statements/schedules", "Property, plant and equipment");
    const shown = await preparer.evaluate(() => document.querySelector('[data-testid="schedule-status-ppe"]')?.innerText);
    return policyNote.startsWith("Historical cost.") && ctx.schedule?.rows?.length === 2 && ctx.schedule.rows.map((x) => x.classLabel).join("|") === "Equipment|Motor vehicles" && ctx.answers?.length === 10 && ctx.answers.some(a => a.questionId === "zero_effect_row_review" && a.answer.checkedBy === "Synthetic browser-test preparer")
      && ctx.notes["smes.note.policies"].body.startsWith("Historical cost.") && ctx.notes["smes.note.estimates"].body.startsWith("Useful lives.") && ppe?.status === "reconciled" && /Reconciled/.test(shown ?? "")
      ? true : { rows: ctx.schedule?.rows?.length, answers: ctx.answers?.length, ppe: ppe?.status, shown };
  });
  log("\n== A concurrent change is refused by name; edits are retained; the new class is never dropped");
  await check("another preparer records a three-class schedule meanwhile; this page's next save is refused (stale schedule), every edit is retained, and re-reading brings the third class into the preparation", async () => {
    // The harness is a hash router: leave and return so the page mounts afresh, as a person reopening it would.
    await go(preparer, "preparer", "/statements", "Statement of Financial Position");
    await go(preparer, "preparer", "/statements/schedules", "Prepare equipment from supporting records");
    await preparer.click({ text: "Start guided equipment preparation" });
    await preparer.waitForText("1. Read the prior report");
    await preparer.click({ text: "Read the recorded preparation" });
    await preparer.waitForText("The recorded schedule has 2 classes", { timeout: 20000 });
    await preparer.click({ text: "Load the recorded classes into this preparation" });
    await preparer.waitForText("2 recorded classes loaded");
    for (const [k, v] of [["Available prior-year source", "reference"], ["Prior figure source reference", "Reviewed opening register page A1"], ["Prior reporting date", "2025-12-31"], ["Equipment net amount as printed", "16,000.00"], ["Currency printed", "TZS"], ["Units printed", "0"]]) { const r = await setByLabel(preparer, k, v); if (r !== true) return r; }
    await preparer.click('[data-testid="confirm-prior-figure"]');
    let r = await fillClass(preparer, "Equipment", ["12,500.00", "2,500.00", "10,000.00"], ["12,500.00", "3,750.00", "8,750.00"], "1,250.00"); if (r !== true) return r;
    r = await fillClass(preparer, "Motor vehicles", ["7,500.00", "1,500.00", "6,000.00"], ["7,500.00", "2,250.00", "5,250.00"], "750.00"); if (r !== true) return r;
    await preparer.click('[data-testid="confirm-movement-coverage"]');
    await preparer.click({ text: "Add a destination" });
    await preparer.waitForSelector('[aria-label="Destination 1 target"]');
    for (const [k, v] of [["Destination 1 target", "sci.operating_expenses_by_function"], ["Destination 1 amount", "2,000.00"], ["Destination 1 evidence", "Expense ledger 6200 Depreciation"]]) { r = await setField(preparer, k, v); if (r !== true) return r; }
    // Meanwhile the owner (also a preparer) records three classes through the schedule authority: 9,000 + 4,000 + 1,000 → 8,000 + 3,500 + 2,500 = 14,000.
    const other = await rpc("owner", "fs_record_schedule", { p_company_id: seed.companyId, p_period_year: seed.periodYear, p_schedule_id: "ppe", p_source_ref: "Synthetic register, three classes", p_request_id: crypto.randomUUID(),
      p_rows: [{ classLabel: "Equipment", openingMinor: "900000", closingMinor: "800000", movements: [{ kind: "depreciation", amountMinor: "-100000" }] }, { classLabel: "Motor vehicles", openingMinor: "400000", closingMinor: "350000", movements: [{ kind: "depreciation", amountMinor: "-50000" }] }, { classLabel: "Computers", openingMinor: "300000", closingMinor: "250000", movements: [{ kind: "depreciation", amountMinor: "-50000" }] }] });
    if (other.outcome !== "recorded") return { other };
    await preparer.click('[data-testid="commit-classes"]');
    await preparer.waitForText("The equipment schedule changed while you were preparing", { timeout: 30000 });
    const kept = await fieldValue(preparer, "Motor vehicles: closing carrying amount (net)");
    await shot(preparer, "05-stale-refused-edits-kept");
    await preparer.click({ text: "Read the recorded preparation" });
    await preparer.waitForText("The recorded schedule has 3 classes", { timeout: 20000 });
    await preparer.click({ text: "Load the recorded classes into this preparation" });
    await preparer.waitForText("1 recorded class loaded");
    const names = await preparer.evaluate(() => [...document.querySelectorAll('[aria-label="Class name"]')].map((e) => e.value));
    const stillKept = await fieldValue(preparer, "Motor vehicles: closing carrying amount (net)");
    await shot(preparer, "06-third-class-loaded");
    return kept === "5,250.00" && stillKept === "5,250.00" && names.join("|") === "Equipment|Motor vehicles|Computers" && recordedScheduleId !== null ? true : { kept, stillKept, names };
  });
  log("\n== Access and widths");
  await check("a viewer sees no equipment preparation and reads no preparation context", async () => {
    const viewer = await open("viewer");
    await go(viewer, "viewer", "/statements/schedules", "Property, plant and equipment");
    const offered = await viewer.evaluate(() => document.body.innerText.includes("Start guided equipment preparation"));
    const ctx = await rpc("viewer", "fs_equipment_context_v2", { p_company_id: seed.companyId, p_period_year: seed.periodYear });
    return !offered && ctx.outcome === "forbidden" ? true : { offered, ctx: ctx.outcome };
  });
  await check("the preparation at 1280 px and 375 px (the page without the harness's fixed sidebar, as the product lays it out): no horizontal overflow, no cut-off control, no unlabeled field", async () => {
    // The harness's 15rem sidebar is not the product's layout; the width check opens the page without it.
    const narrow = await open("preparer");
    await go(narrow, "preparer", "/statements/schedules", "Prepare equipment from supporting records", false);
    await narrow.click({ text: "Start guided equipment preparation" });
    await narrow.waitForText("1. Read the prior report");
    await narrow.click({ text: "Read the recorded preparation" });
    await narrow.waitForText("recorded class", { timeout: 20000 });
    await narrow.click({ text: "Load the recorded classes into this preparation" });
    await narrow.waitForText("loaded with their carrying amounts");
    await narrow.click({ text: "Add a destination" });
    await narrow.waitForSelector('[aria-label="Destination 1 target"]');
    page = narrow;
    const problems = {};
    for (const [w, h] of [[1280, 900], [375, 812]]) {
      await narrow.setViewport(w, h); await sleep(600);
      const p = await narrow.evaluate(layoutProblems);
      if (p.length) {
        const culprits = await narrow.evaluate(() => { const vw = document.documentElement.clientWidth; return [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > vw + 1).filter((el) => ![...el.children].some((c) => c.getBoundingClientRect().right > vw + 1)).slice(0, 8).map((el) => `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ").slice(0, 3).join(".") : ""} ${Math.round(el.getBoundingClientRect().right - vw)}px: ${(el.getAttribute("aria-label") || el.innerText || "").slice(0, 40)}`); });
        problems[w] = { problems: p.slice(0, 6), culprits };
      }
      await shot(narrow, `07-width-${w}`);
    }
    await narrow.setViewport(1280, 900);
    return Object.keys(problems).length === 0 ? true : problems;
  });
} catch (e) {
  log(`JOURNEY FAILURE: ${e?.stack ?? e}`);
  results.push({ name: "journey", ok: false, detail: String(e?.message ?? e) });
} finally {
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, finishedAt: new Date().toISOString() }, null, 2));
  try { await browser?.close(); } catch { /* */ }
  try { bridge.child.stdin.end(); } catch { /* */ }
  try { vite.child.kill(); } catch { /* */ }
  setTimeout(() => process.exit(results.length && results.every((r) => r.ok) ? 0 : 1), 1500);
}
const failed = results.filter((r) => !r.ok);
log(`\nchecks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
log(failed.length ? "EQUIPMENT_JOURNEY: FAILED" : "EQUIPMENT_JOURNEY: ALL PASSED");
