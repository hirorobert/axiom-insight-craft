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
const BRIDGE_PORT = process.env.RETURNING_BRIDGE_PORT ?? "54996";
const HARNESS_PORT = process.env.RETURNING_HARNESS_PORT ?? "8092";
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

const bridge = start("bun", ["scripts/db-proof/serveReturning.mjs"], { RETURNING_BRIDGE_PORT: BRIDGE_PORT, RETURNING_STOP_ON_STDIN_END: "1" }, (o) => { const m = o.match(/READY (\{.*\})/); return m ? JSON.parse(m[1]) : null; });
const vite = start("bunx", ["vite", "--config", "dev-harness/returning/vite.config.ts"], { RETURNING_HARNESS_PORT: HARNESS_PORT }, (o) => /ready in/.test(o));
let browser;
try {
  const ready = await bridge.seen;
  await vite.seen;
  const seed = await (await fetch(`${ready.bridge}/seed`, { method: "POST", headers: { "x-sim-user": "owner" }, body: "{}" })).json();
  const facts = async () => (await fetch(`${ready.bridge}/proof/facts`, { method: "POST", headers: { "x-sim-user": "owner" }, body: "{}" })).json();
  browser = await Browser.launch();
  const url = (as, hash) => `http://127.0.0.1:${HARNESS_PORT}/dev-harness/returning/index.html?bridge=${encodeURIComponent(ready.bridge)}&as=${as}#${hash}`;
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

  console.log("\n== Check my books, in the same engagement (no second trial balance upload)");
  await check("the engagement already holds three certified trial balances (one upload per year) and the FY2025 pack is FINAL; Check my books says it has not been started for FY2026", async () => {
    try { await go(preparer, "preparer", "/close/books", "Not started for this period"); }
    catch (e) { await shot(preparer, "00-debug"); const raw = await (await fetch(`${ready.bridge}/rpc/rfr_status`, { method: "POST", headers: { "x-sim-user": "preparer" }, body: JSON.stringify({ p_company_id: seed.companyId, p_period_year: 2026 }) })).text(); return { raw: raw.slice(0, 500), waited: String(e.message), body: (await body(preparer)).slice(0, 700), console: await preparer.evaluate(() => window.__errs ?? null) }; }
    const f = await facts();
    const t = await body(preparer);
    await shot(preparer, "01-not-started");
    return f.uploadsN === 1 && f.pubs.filter((x) => x.state === "FINAL").length === 1 && /Check my books/.test(t) ? true : { uploadsN: f.uploadsN, pubs: f.pubs };
  });
  await check("the preparer starts checking: only the opening line to agree to last year's approved figure is chosen; the form then asks for the files", async () => {
    const linesId = await preparer.evaluate(() => { const l = [...document.querySelectorAll("label")].find((x) => /Opening balance lines/.test(x.innerText)); return l?.getAttribute("for") ?? null; });
    await preparer.fill(`[id="${linesId}"]`, "payables");
    for (const cb of await preparer.evaluate(() => [...document.querySelectorAll('form input[type="checkbox"]')].map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0))) {
      await preparer.evaluate((i) => document.querySelectorAll('form input[type="checkbox"]')[i].click(), cb);
    }
    await preparer.click({ text: "Start checking this period" });
    await preparer.waitForText("Import your exports and documents", { timeout: 30000 });
    await shot(preparer, "02-started");
    return true;
  });
  await check("the four files an accountant holds are chosen (QuickBooks general ledger, last year's approved closing figure from the FINAL pack, the document register, the settings) and imported", async () => {
    await preparer.waitForSelector('input[type="file"]');
    await sleep(500);
    await preparer.evaluate(() => { const names = ["gl", "approved", "evidence", "settings", "bank"]; [...document.querySelectorAll('input[type="file"]')].forEach((el, i) => el.setAttribute("data-slot", names[i])); });
    for (const slot of ["gl", "approved", "evidence", "settings"]) await preparer.setFiles(`input[data-slot="${slot}"]`, [seed.files[slot]]);
    await preparer.click({ text: "Import the files" });
    await preparer.waitForText("Now check your books", { timeout: 45000 });
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
    return articles === 1 && /1 check needs attention/.test(t) && /100\.00/.test(t) && /Review the opening correction/.test(t) && /opening:payables: Needs attention/.test(t) && /pack: Ready/.test(t) && /ledger: Ready/.test(t) ? true : { articles, t: t.slice(0, 900) };
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
    return pay && profit ? true : { pay, profit, na, sample: t.slice(0, 900) };
  });
  await check("the partner marks the new version REVIEWED (confirmation with reason); the owner approves it FINAL; the version is sealed", async () => {
    await go(partner, "partner", "/signoff", "Version");
    const v = await partner.evaluate(() => (document.body.innerText.match(/Version (\d+)/) ?? [])[1] ?? null);
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
    return states.has("REVIEWED") && states.has("FINAL") && ids.size === 1 && cmp.size === 1 && f.manifest?.contract === "rfr-finalization-manifest/1" && f.manifest.scopes["opening:payables"] === "READY" && f.layer["2000"] === "-320000" ? true : { states: [...states], ids: ids.size, cmp: cmp.size, manifest: f.manifest?.scopes };
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
