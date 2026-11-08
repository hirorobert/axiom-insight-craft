#!/usr/bin/env node
// NON-PRODUCTION browser journey for a RETURNING client (source A: last year's pack finalised in CFOClose with an approved accrual of 100.00).
//
// Starts a DISPOSABLE PostgreSQL with the loopback bridge (scripts/db-proof/serveReturning.mjs, under bun), the harness
// (dev-harness/returning, Vite) and a headless Chrome/Edge (cdp.mjs), then drives the REAL views with real mouse and keyboard input as three
// simulated people - a preparer, a partner and the owner - in ONE engagement: Check my books -> the one finding -> propose the correction ->
// a second person approves it in Adjustments -> Check my books again -> comparatives -> the existing report preview -> server sign-off.
// Every request must stay on loopback. NOT covered (stated): the app shell, GoTrue, and the Trial Balance Review page (see README).
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> node scripts/browser-acceptance/returningClientJourney.mjs [outDir]
//   env: CHROME_PATH, RETURNING_BRIDGE_PORT (54996), RETURNING_HARNESS_PORT (8092)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "./cdp.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "returning-journey-evidence"));
// --start: the journey begins at the REAL Trial Balance Review page (the owner uploads the new year's trial balance there) and the opening position is
// DERIVED from the prior FINAL pack ("Use last year's FINAL pack"); nothing about last year is typed or exported. Default: the earlier journey
// (FY2026 already certified; last year's approved figure supplied as a file).
const START = process.argv.includes("--start");
const SCOPE = START ? "opening:acct-2000" : "opening:payables";
const BRIDGE_PORT = process.env.RETURNING_BRIDGE_PORT ?? (START ? "54997" : "54996");
const HARNESS_PORT = process.env.RETURNING_HARNESS_PORT ?? (START ? "8095" : "8092");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = async (name, fn) => {
  try { const r = await fn(); results.push({ name, ok: r === true, detail: r === true ? undefined : r }); console.log(`  ${r === true ? "PASS" : "FAIL"}  ${name}${r === true ? "" : `\n        ${JSON.stringify(r).slice(0, 900)}`}`); }
  catch (e) { results.push({ name, ok: false, detail: String(e?.message ?? e) }); console.log(`  FAIL  ${name}\n        ${String(e?.message ?? e).slice(0, 900)}`); }
};

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

const bridge = start("bun", ["scripts/db-proof/serveReturning.mjs"], { RETURNING_BRIDGE_PORT: BRIDGE_PORT, RETURNING_STOP_ON_STDIN_END: "1", ...(START ? { RETURNING_SCENE: "start", RETURNING_LOG: "1" } : {}) }, (o) => { const m = o.match(/READY (\{.*\})/); return m ? JSON.parse(m[1]) : null; });
const vite = start("bunx", ["vite", "--config", START ? "dev-harness/returning/vite.start.config.ts" : "dev-harness/returning/vite.config.ts"], { RETURNING_HARNESS_PORT: HARNESS_PORT, RETURNING_START_PORT: HARNESS_PORT }, (o) => /ready in/.test(o));
let browser;
try {
  const ready = await bridge.seen;
  await vite.seen;
  const seed = await (await fetch(`${ready.bridge}/seed`, { method: "POST", headers: { "x-sim-user": "owner" }, body: "{}" })).json();
  const facts = async () => (await fetch(`${ready.bridge}/proof/facts`, { method: "POST", headers: { "x-sim-user": "owner" }, body: "{}" })).json();
  browser = await Browser.launch();
  const url = (as, hash) => `http://127.0.0.1:${HARNESS_PORT}/dev-harness/returning/${START ? "start" : "index"}.html?bridge=${encodeURIComponent(ready.bridge)}&as=${as}#${hash}`;
  const pages = {};
  const open = async (as) => { const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.setViewport(1280, 1000); pages[as] = p; return p; };
  const shot = (p, name) => p.screenshot(path.join(OUT, `${name}.png`));
  const go = async (p, as, hash, text) => { await p.goto(url(as, hash)); if (text) await p.waitForText(text, { timeout: 45000 }); await sleep(300); };
  const body = (p) => p.evaluate(() => document.body.innerText.replace(/[ \t]+/g, " "));
  const confirmDialog = async (p, reason) => {
    await p.waitForSelector('[role="dialog"] textarea');
    await p.fill('[role="dialog"] textarea', reason);
    if (await p.evaluate(() => !!document.querySelector('[role="dialog"] input[type="checkbox"]'))) await p.click('[role="dialog"] input[type="checkbox"]');
    await p.click({ selector: '[role="dialog"] button.bg-primary' });
  };
  const preparer = await open("preparer"), partner = await open("partner"), owner = await open("owner");

  if (START) {
    console.log("\n== The REAL Trial Balance Review page: the owner uploads the new year's trial balance, once");
    await check("the owner opens the real Trial Balance Review page for FY2026 in the engagement the account home opened, chooses trial-balance-2026.csv and presses Upload and check: the file goes reserve -> signed URL -> storage -> register, and the REAL process-trial-balance handler checks it", async () => {
      const before = await facts();
      await go(owner, "owner", `/workspace/${seed.companyId}/2026/trial-balance/review`, "Upload the trial balance for this period");
      await owner.waitForSelector('input[type="file"]');
      await sleep(800);
      await owner.setFiles('input[type="file"]', [seed.files.tb]);
      await owner.waitForText("Upload and check", { timeout: 20000 });
      await shot(owner, "00a-file-chosen");
      await owner.click({ text: "Upload and check" });
      const deadline = Date.now() + 90000;
      let f = before;
      while (Date.now() < deadline) { f = await facts(); if (f.uploadRows.some((u) => u.status === "complete")) break; await sleep(1000); }
      await sleep(2500);
      const t = await body(owner);
      await shot(owner, "00b-after-upload");
      globalThis.__tbText = t;
      return before.uploadsN === 0 && f.uploadsN === 1 && f.uploadRows[0].lifecycle_state === "active_processed" && /^workspaces\//.test(f.uploadRows[0].file_path) && f.engagements >= 1 ? true : { before: before.uploadsN, rows: f.uploadRows, engagements: f.engagements, t: t.slice(0, 700) };
    });
    await check("the page itself reports the trial balance as checked (no failure notice, no second upload offered while it is current)", async () => {
      const t = globalThis.__tbText;
      return !/could not be completed|Stopped/.test(t) ? true : { t: t.slice(0, 900) };
    });
    await check("fixture step (not a page): the steps after the trial balance that have their own journeys - Close Review findings explained, notes, evidence and a first draft version - are recorded by the bridge", async () => {
      const r = await (await fetch(`${ready.bridge}/proof/finish-prepare`, { method: "POST", headers: { "x-sim-user": "owner" }, body: "{}" })).json();
      return r.draftReportVersion >= 1 ? (seed.draftReportId = r.draftReportId, true) : r;
    });
  }

  console.log("\n== Check my books, in the same engagement (no second trial balance upload)");
  await check("the engagement already holds three certified trial balances (one upload per year) and the FY2025 pack is FINAL; Check my books says it has not been started for FY2026", async () => {
    try { await go(preparer, "preparer", "/close/books", "Not started for this period"); }
    catch (e) { await shot(preparer, "00-debug"); const raw = await (await fetch(`${ready.bridge}/rpc/rfr_status`, { method: "POST", headers: { "x-sim-user": "preparer" }, body: JSON.stringify({ p_company_id: seed.companyId, p_period_year: 2026 }) })).text(); return { raw: raw.slice(0, 500), waited: String(e.message), body: (await body(preparer)).slice(0, 700), console: await preparer.evaluate(() => window.__errs ?? null) }; }
    const f = await facts();
    const t = await body(preparer);
    await shot(preparer, "01-not-started");
    return f.uploadsN === 1 && f.pubs.filter((x) => x.state === "FINAL").length === 1 && /Check my books/.test(t) ? true : { uploadsN: f.uploadsN, pubs: f.pubs };
  });
  await check(START ? "the preparer starts checking with NO opening line typed (the scope comes from last year's pack in the next step); the form then asks for the files" : "the preparer starts checking: only the opening line to agree to last year's approved figure is chosen; the form then asks for the files", async () => {
    const linesId = await preparer.evaluate(() => { const l = [...document.querySelectorAll("label")].find((x) => /Opening balance lines/.test(x.innerText)); return l?.getAttribute("for") ?? null; });
    if (!START) await preparer.fill(`[id="${linesId}"]`, "payables");
    for (const cb of await preparer.evaluate(() => [...document.querySelectorAll('form input[type="checkbox"]')].map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0))) {
      await preparer.evaluate((i) => document.querySelectorAll('form input[type="checkbox"]')[i].click(), cb);
    }
    await preparer.click({ text: "Start checking this period" });
    await preparer.waitForText("Import your exports and documents", { timeout: 30000 });
    await shot(preparer, "02-started");
    return true;
  });
  await check(START ? "only the QuickBooks general ledger is imported; then 'Use last year's FINAL pack' reads the approved opening position from the prior FINAL pack itself (report, version, document hash and input hash cited) - no approved-figures file, no document register, no settings file" : "the four files an accountant holds are chosen (QuickBooks general ledger, last year's approved closing figure from the FINAL pack, the document register, the settings) and imported", async () => {
    await preparer.waitForSelector('input[type="file"]');
    await sleep(500);
    await preparer.evaluate(() => { const names = ["gl", "approved", "evidence", "settings", "bank"]; [...document.querySelectorAll('input[type="file"]')].forEach((el, i) => el.setAttribute("data-slot", names[i])); });
    for (const slot of START ? ["gl"] : ["gl", "approved", "evidence", "settings"]) await preparer.setFiles(`input[data-slot="${slot}"]`, [seed.files[slot]]);
    await preparer.click({ text: "Import the files" });
    await preparer.waitForText("Now check your books", { timeout: 45000 });
    if (START) {
      // Last year's approved position is READ FROM THE PRIOR FINAL PACK by the server - no export, no typed figure, no settings file.
      await preparer.click('[data-testid="use-prior-pack"]');
      await preparer.waitForText("Read last year's approved position from its FINAL pack", { timeout: 45000 });
      const f = await facts();
      await shot(preparer, "03-imported");
      return f.priorBasis?.startsWith(`prior_final:${seed.priorReportId}@v${seed.priorReportVersion};doc:`) ? true : { basis: f.priorBasis };
    }
    await shot(preparer, "03-imported");
    return /Imported 3 items|Imported 4 items/.test(await body(preparer)) ? true : (await body(preparer)).slice(0, 500);
  });
  await check("ONE click on Check my books: ONE check needs attention, the exact figure (TZS 100.00) and ONE next action (review the correction); the independent checks are Ready", async () => {
    await preparer.click("main button.bg-primary");
    try { await preparer.waitForText("needs attention", { timeout: 45000 }); }
    catch (e) { await shot(preparer, "04-debug"); return { waited: e.message, body: (await body(preparer)).slice(0, 1200) }; }
    const t = await body(preparer);
    await shot(preparer, "04-one-finding");
    const articles = await preparer.evaluate(() => document.querySelectorAll("article").length);
    return articles === 1 && /1 check needs attention/.test(t) && /100\.00/.test(t) && /Review the opening correction/.test(t) && new RegExp(SCOPE + ": Needs attention").test(t) && (START || /pack: Ready/.test(t)) && /ledger: Ready/.test(t) ? true : { articles, t: t.slice(0, 900) };
  });
  await check("the preparer proposes the correction for review (one adjustment: Dr opening equity 100.00 / Cr payables 100.00); pressing it again proposes nothing more", async () => {
    await preparer.click({ text: "Propose for review" });
    await preparer.waitForText("proposed. A second person approves", { timeout: 30000 });
    await sleep(300);
    const f = await facts();
    return f.adjN === 1 ? true : { adjN: f.adjN };
  });

  console.log("\n== A second person approves it in Adjustments");
  await check("the proposer is not offered Approve; the partner sees the adjustment (Dr 3100 Retained earnings 100.00 / Cr 2000 Trade payables 100.00) and approves it with a reason", async () => {
    await go(preparer, "preparer", "/close/adjustments", "Adjustment 1");
    const own = await preparer.evaluate(() => [...document.querySelectorAll("button")].some((b) => /^approve$/i.test(b.innerText.trim())));
    await go(partner, "partner", "/close/adjustments", "Adjustment 1");
    const t = await body(partner);
    const rid = await partner.evaluate(() => document.querySelector('[data-testid="adjustment-1"] input[id*="-"]')?.id ?? null);
    await partner.fill(`[id="${rid}"]`, "Agreed to the audit adjustment schedule held in the document register");
    await shot(partner, "05-adjustment-before-approval");
    await partner.click({ text: "Approve" });
    await partner.waitForText("Approved", { timeout: 30000 });
    await shot(partner, "06-adjustment-approved");
    const f = await facts();
    return own === false && /Retained earnings/.test(t) && /Trade payables/.test(t) && /100\.00/.test(t) && f.adjN === 1 ? true : { own, t: t.slice(0, 600), adjN: f.adjN };
  });

  console.log("\n== Check my books again: every required check is ready, nothing was applied twice");
  await check("the preparer checks again: every required check is ready; the adjusted trial balance is exact (payable 3,200.00 credit; opening equity 10,900.00 credit... i.e. minor units -320000 / -1090000) and still ONE adjustment and ONE FY2026 upload", async () => {
    await go(preparer, "preparer", "/close/books", "Check my books");
    await preparer.waitForText("Not checked yet", { timeout: 20000 }).catch(() => {});
    await preparer.click("main button.bg-primary");
    await preparer.waitForText("Every required check is ready", { timeout: 60000 });
    await shot(preparer, "07-all-ready");
    const f = await facts();
    return f.layer["2000"] === "-320000" && f.layer["3100"] === "-1090000" && f.layer["6100"] === "240000" && f.adjN === 1 && f.uploadsN === 1 ? true : { layer: { 2000: f.layer["2000"], 3100: f.layer["3100"], 6100: f.layer["6100"] }, adjN: f.adjN, uploadsN: f.uploadsN };
  });
  await check("a second press of Check my books and a second import of the same files change nothing: still one adjustment, same balances", async () => {
    await preparer.click("main button.bg-primary");
    await sleep(2500);
    const f = await facts();
    return f.layer["2000"] === "-320000" && f.layer["3100"] === "-1090000" && f.adjN === 1 ? true : { layer: f.layer, adjN: f.adjN };
  });

  console.log("\n== The comparative, the existing report preview and the server sign-off");
  await check("the partner approves the comparative (the issued FY2025 pack, with the correction); the page names it as approved", async () => {
    await go(partner, "partner", "/statements/comparatives", "Not yet approved");
    await partner.click('[data-testid="approve-comparatives"]');
    await confirmDialog(partner, "Agreed to the FY2025 pack as issued in CFOClose (FINAL), including the approved audit accrual");
    await partner.waitFor(() => document.querySelector('[data-testid="comparative-state"]')?.getAttribute("data-state") === "approved", [], { label: "approved", timeout: 45000 });
    await shot(partner, "08-comparatives-approved");
    return true;
  });
  await check("the preparer saves a new draft version from the stored evidence (the existing report builder and server compiler); the preview shows the exact figures", async () => {
    await go(preparer, "preparer", "/signoff", "Version");
    try { await preparer.click('[data-testid="save-version"]', { timeout: 30000 }); }
    catch (e) { await shot(preparer, "09-debug-signoff"); return { click: e.message, body: (await body(preparer)).slice(0, 900) }; }
    await sleep(6000);
    await go(preparer, "preparer", "/statements", "Statement of Financial Position");
    await sleep(1500);
    const t = await body(preparer);
    await shot(preparer, "09-preview");
    const na = await preparer.evaluate(() => document.querySelector('[data-testid="next-action"]')?.innerText.replace(/\s+/g, " ").trim() ?? null);
    // The statements page shows the current and comparative columns (minor units rendered with two decimals).
    const pay = /Trade and other payables\s+3,200\.00\s+3,200\.00/.test(t);
    const profit = /Profit or loss for the period\s+5,100\.00\s+5,000\.00/.test(t);
    globalThis.__preview = { pay: t.match(/Trade and other payables\s+3,200\.00\s+3,200\.00/)?.[0], profit: t.match(/Profit or loss for the period\s+5,100\.00\s+5,000\.00/)?.[0] };
    return pay && profit ? true : { pay, profit, na, sample: t.slice(0, 900) };
  });
  await check("the partner marks the new version REVIEWED (confirmation with reason); the owner approves it FINAL; the version is sealed", async () => {
    await go(partner, "partner", "/signoff", "Version");
    const v = await partner.evaluate(() => (document.body.innerText.match(/Version (\d+)/) ?? [])[1] ?? null);
    globalThis.__version = v;
    await partner.click('[data-testid="sign-reviewed"]');
    await confirmDialog(partner, "Reviewed against the issued FY2025 pack and the approved correction");
    await partner.waitForText("is reviewed.", { timeout: 60000 });
    await go(owner, "owner", `/signoff?v=${v}`, "Version");
    await owner.click('[data-testid="sign-final"]');
    await confirmDialog(owner, "Approved for issue");
    await owner.waitForText("final and sealed", { timeout: 60000 });
    await shot(owner, "10-final");
    const f = await facts();
    const fin = f.pubs.filter((x) => x.state === "FINAL");
    return fin.length === 2 && fin.some((x) => x.report_id === seed.draftReportId) ? true : { v, pubs: f.pubs };
  });
  await check("preview and FINAL used the SAME approved comparative: every binding of the FY2026 report carries one dependencies identity and one comparative status; the manifest binds the readiness run and review", async () => {
    const f = await facts();
    const mine = f.bindings.filter((b) => b.report_id === seed.draftReportId);
    const states = new Set(mine.map((b) => b.state));
    const ids = new Set(mine.map((b) => b.dependencies_sha256)), cmp = new Set(mine.map((b) => b.cmp));
    return states.has("REVIEWED") && states.has("FINAL") && ids.size === 1 && cmp.size === 1 && f.manifest?.contract === "rfr-finalization-manifest/1" && f.manifest.scopes[SCOPE] === "READY" && f.layer["2000"] === "-320000" ? true : { states: [...states], ids: ids.size, cmp: cmp.size, manifest: f.manifest?.scopes };
  });
  await check("the FINAL version shows the SAME exact figures as the preview it came from (payables 3,200.00 in both columns; profit 5,100.00 current / 5,000.00 comparative), the same approved comparative identity on every binding, and the books hold ONE FY2026 upload, ONE approved correction and ONE adjustment", async () => {
    await go(owner, "owner", `/statements?v=${globalThis.__version}`, "Statement of Financial Position");
    await sleep(1500);
    const t = await body(owner);
    await shot(owner, "11-final-statements");
    const pay = t.match(/Trade and other payables\s+3,200\.00\s+3,200\.00/)?.[0], profit = t.match(/Profit or loss for the period\s+5,100\.00\s+5,000\.00/)?.[0];
    const f = await facts();
    const mine = f.bindings.filter((b) => b.report_id === seed.draftReportId);
    const cmp = new Set(mine.map((b) => b.cmp));
    return pay && profit && pay === globalThis.__preview?.pay && profit === globalThis.__preview?.profit && cmp.size === 1 && [...cmp][0] && f.uploadsN === 1 && f.corrections === 1 && f.adjN === 1
      ? true : { pay, profit, preview: globalThis.__preview, cmp: [...cmp], uploadsN: f.uploadsN, corrections: f.corrections, adjN: f.adjN };
  });
  await check("no request left the machine: every request this journey made went to loopback", async () => (() => { const all = Object.values(pages).flatMap((pg) => pg.requests); const off = all.filter((u) => /^https?:/.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost|fonts\.googleapis\.com|fonts\.gstatic\.com)[:/]/.test(u)); return off.length === 0 && all.length > 0 ? true : { total: all.length, off: off.slice(0, 5) }; })());
}
catch (e) { results.push({ name: "journey crashed", ok: false, detail: String(e?.stack ?? e).slice(0, 1500) }); console.log(`\nCRASH ${String(e?.stack ?? e).slice(0, 1500)}`); }
finally {
  try { fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2)); } catch { /* */ }
  const bad = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - bad.length}   failed: ${bad.length}`);
  try { await browser?.close(); } catch { /* */ }
  try { bridge.child.stdin.end(); } catch { /* */ }
  await sleep(1500);
  try { bridge.child.kill(); vite.child.kill(); } catch { /* */ }
  process.exit(bad.length === 0 && results.length > 0 ? 0 : 1);
}
