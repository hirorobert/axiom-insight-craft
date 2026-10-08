#!/usr/bin/env node
// NON-PRODUCTION browser journey for the reporting workbench (Financial Statements; Sign-off & Exports).
//
// Starts a DISPOSABLE PostgreSQL with the loopback bridge (scripts/db-proof/serveReporting.mjs, under bun), the harness
// (dev-harness/reporting, Vite) and a headless Chrome/Edge (cdp.mjs), then drives the REAL pages with real mouse and
// keyboard input as three simulated people — a preparer, a reviewer (partner) and the owner — through statements,
// lineage, notes, schedules, comparatives approval, evidence intake, saving a version, REVIEWED, FINAL and export. It
// records screenshots and prints the draft and the sealed pack to PDF. Every request must stay on loopback.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> node scripts/browser-acceptance/reportingJourney.mjs [outDir]
//   env: CHROME_PATH, REPORTING_BRIDGE_PORT (54997), REPORTING_HARNESS_PORT (8094)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "./cdp.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "reporting-journey-evidence"));
const BRIDGE_PORT = process.env.REPORTING_BRIDGE_PORT ?? "54997";
const HARNESS_PORT = process.env.REPORTING_HARNESS_PORT ?? "8094";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = async (name, fn) => {
  try { const r = await fn(); results.push({ name, ok: r === true, detail: r === true ? undefined : r }); console.log(`  ${r === true ? "PASS" : "FAIL"}  ${name}${r === true ? "" : `\n        ${JSON.stringify(r).slice(0, 800)}`}`); }
  catch (e) { results.push({ name, ok: false, detail: String(e?.message ?? e) }); console.log(`  FAIL  ${name}\n        ${String(e?.message ?? e).slice(0, 800)}`); }
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

const bridge = start("bun", ["scripts/db-proof/serveReporting.mjs"], { REPORTING_BRIDGE_PORT: BRIDGE_PORT, REPORTING_STOP_ON_STDIN_END: "1" }, (o) => { const m = o.match(/READY (\{.*\})/); return m ? JSON.parse(m[1]) : null; });
const vite = start("bunx", ["vite", "--config", "dev-harness/reporting/vite.config.ts"], { REPORTING_HARNESS_PORT: HARNESS_PORT }, (o) => /ready in/.test(o));
let browser;
try {
  const ready = await bridge.seen;
  await vite.seen;
  const seed = await (await fetch(`${ready.bridge}/seed`, { method: "POST", headers: { "x-sim-user": "owner" }, body: "{}" })).json();
  browser = await Browser.launch();
  const url = (as, hash) => `http://127.0.0.1:${HARNESS_PORT}/dev-harness/reporting/index.html?bridge=${encodeURIComponent(ready.bridge)}&as=${as}#${hash}`;
  const open = async (as) => { const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.setViewport(1280, 900); return p; };
  const shot = (p, name) => p.screenshot(path.join(OUT, `${name}.png`));
  const go = async (p, as, hash, text) => { await p.goto(url(as, hash)); if (text) await p.waitForText(text, { timeout: 45000 }); await sleep(300); };
  const nextAction = (p) => p.evaluate(() => { const el = document.querySelector('[data-testid="next-action"]'); return el ? { text: el.innerText.replace(/\s+/g, " ").trim(), tone: el.getAttribute("data-tone") } : null; });
  const confirmDialog = async (p, reason) => {
    await p.waitForSelector('[role="dialog"] textarea');
    await p.fill('[role="dialog"] textarea', reason);
    const ack = await p.evaluate(() => !!document.querySelector('[role="dialog"] input[type="checkbox"]'));
    if (ack) await p.click('[role="dialog"] input[type="checkbox"]');
    await p.click({ selector: '[role="dialog"] button.bg-primary' });
  };

  const preparer = await open("preparer"), partner = await open("partner"), owner = await open("owner");

  console.log("\n== Statements: the server's figures, lineage by keyboard");
  await check("the statements show the composed figures (total assets 33,000.00; profit 5,100.00) and the next action names the comparatives as a reviewer's step", async () => {
    await go(preparer, "preparer", "/statements", "Statement of Financial Position");
    const t = await preparer.bodyText();
    const na = await nextAction(preparer);
    await shot(preparer, "01-statements");
    return /Total assets\s+33,000\.00\s+28,800\.00/.test(t) && /Profit or loss for the period\s+5,100\.00\s+3,100\.00/.test(t)
      && /Total comprehensive income for the period\s+5,100\.00\s+3,100\.00/.test(t) && na?.tone === "blocked" && /Comparatives: Not yet approved/.test(na.text) ? true : { na, sample: t.slice(0, 400) };
  });
  await check("keyboard: arrow keys move through the rows, Enter opens the lineage panel (accounts, certification, assignment), Escape closes it and returns focus", async () => {
    await preparer.click('tr[data-row="SFP:1"]');
    await preparer.press("ArrowDown"); await preparer.press("ArrowUp");
    const focused = await preparer.evaluate(() => document.activeElement?.getAttribute("data-row") ?? null);
    await preparer.press("Enter");
    await preparer.waitForSelector('[data-testid="lineage-panel"]');
    const panel = await preparer.evaluate(() => document.querySelector('[data-testid="lineage-panel"]').innerText);
    await shot(preparer, "02-lineage-panel");
    await preparer.press("Escape");
    await sleep(300);
    const closed = await preparer.evaluate(() => !document.querySelector('[data-testid="lineage-panel"]'));
    return focused && /1500 Equipment at cost/.test(panel) && /1510 Accumulated depreciation/.test(panel) && /certification/.test(panel) && /assignment #/.test(panel) && closed ? true : { focused, panel: panel.slice(0, 300), closed };
  });

  console.log("\n== Notes and schedules");
  await check("notes: every requirement with the server's status; recording wording through the form is accepted by the server", async () => {
    await go(preparer, "preparer", "/statements/notes", "requirement");
    await preparer.click('[data-requirement="smes.note.judgements"]');
    await preparer.fill('[data-testid="wording-body"]', "No judgements beyond the estimates note.");
    await preparer.fill('[data-testid="wording-source"]', "Engagement file N-2");
    await preparer.click({ text: "Record wording" });
    await preparer.waitForText("Recorded.");
    await shot(preparer, "03-notes");
    const t = await preparer.bodyText();
    // The only open blocking requirements are the evidence-built statements (cash flows, changes in equity), whose
    // evidence is supplied with a version on the Sign-off page.
    const open = Number((t.match(/(\d+) blocking requirements? open/) ?? [])[1]);
    const missing = (t.match(/Evidence missing/g) ?? []).length;
    return open === 2 && missing === 2 ? true : { open, missing, t: t.slice(0, 500) };
  });
  await check("schedules: the property, plant and equipment schedule is reconciled to the statements by the server", async () => {
    await go(preparer, "preparer", "/statements/schedules", "Property, plant and equipment");
    const s = await preparer.evaluate(() => document.querySelector('[data-testid="schedule-status-ppe"]')?.innerText);
    await shot(preparer, "04-schedules");
    return /Reconciled/.test(s ?? "") ? true : s;
  });

  console.log("\n== Comparatives: approved by a reviewer, with a reason");
  await check("a preparer cannot approve (no control; the next action says it is a reviewer's)", async () => {
    await go(preparer, "preparer", "/statements/comparatives", "Not yet approved");
    return (await preparer.evaluate(() => !document.querySelector('[data-testid="approve-comparatives"]'))) && /A reviewer approves the comparatives/.test(await preparer.bodyText()) ? true : "approve control visible to a preparer";
  });
  await check("the reviewer approves through the confirmation (reason required); the server's state becomes Approved", async () => {
    await go(partner, "partner", "/statements/comparatives", "Not yet approved");
    await partner.click('[data-testid="approve-comparatives"]');
    await confirmDialog(partner, "Agreed to the signed 2025 statements");
    await partner.waitFor(() => document.querySelector('[data-testid="comparative-state"]')?.getAttribute("data-state") === "approved", [], { label: "approved" });
    await shot(partner, "05-comparatives-approved");
    return true;
  });

  console.log("\n== Sign-off: evidence and a version, through the one atomic save");
  await check("the next action now asks for the cash-flow and equity evidence", async () => {
    await go(preparer, "preparer", "/signoff", "Evidence for the cash-flow");
    const na = await nextAction(preparer);
    return /evidence/i.test(na?.text ?? "") && na.tone === "todo" ? true : na;
  });
  await check("six evidence files are picked and parsed in the browser; one save stores them with version 1 and re-saves version 2 on the changed dependencies; version 2 has no blocker", async () => {
    for (const [slot, file] of Object.entries(seed.files)) await preparer.setFiles(`input[data-slot="${slot}"]`, [file]);
    await preparer.waitFor(() => document.querySelectorAll('[data-parsed="ok"]').length === 6, [], { label: "six parsed files" });
    await shot(preparer, "06-evidence-picked");
    await preparer.click('[data-testid="save-version"]');
    await preparer.waitForText("version 2 is saved", { timeout: 60000 });
    await preparer.waitFor(() => document.querySelector('[data-testid="readiness"]')?.getAttribute("data-ready") === "true", [], { label: "version 2 ready", timeout: 30000 });
    await shot(preparer, "07-version-saved-ready");
    return true;
  });
  await check("a preparer cannot sign: no sign-off control, the page says who does", async () => {
    const t = await preparer.bodyText();
    return (await preparer.evaluate(() => !document.querySelector('[data-testid^="sign-"]'))) && /A reviewer marks the version reviewed/.test(t) ? true : t.slice(-400);
  });
  await check("the reviewer marks version 2 REVIEWED (confirmation with reason)", async () => {
    await go(partner, "partner", "/signoff", "Version 2");
    await partner.click('[data-testid="sign-reviewed"]');
    await confirmDialog(partner, "Reviewed against the evidence and the composed statements");
    await partner.waitForText("Version 2 is reviewed.");
    return true;
  });
  await check("the owner approves version 2 as FINAL; the version is sealed", async () => {
    await go(owner, "owner", "/signoff?v=2", "Version 2");
    await owner.click('[data-testid="sign-final"]');
    await confirmDialog(owner, "Approved for issue");
    await owner.waitForText("final and sealed");
    // The container re-reads every server state after the write; the next action then reads "done".
    await owner.waitFor(() => document.querySelector('[data-testid="next-action"]')?.getAttribute("data-tone") === "done", [], { label: "next action done" });
    await shot(owner, "08-final");
    const na = await nextAction(owner);
    return na?.tone === "done" && /Version 2 is signed off/.test(na.text) ? true : na;
  });

  console.log("\n== Exports: the sealed pack and the draft, from the stored versions");
  const printPack = async (p, file) => {
    const html = await p.evaluate(() => document.querySelector('[data-testid="pack-preview"]').srcdoc);
    const ctx = await browser.newContext(); const q = await ctx.newPage();
    await q.goto("about:blank");
    await q.evaluate((h) => { document.open(); document.write(h); document.close(); return true; }, html);
    await sleep(300);
    const { data } = await q.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(data, "base64"));
    return html;
  };
  let finalHtml = "";
  await check("the FINAL pack carries the seal with the recorded approver, the server binding's hashes and the composed figures; printed to PDF", async () => {
    await go(owner, "owner", "/signoff/exports?v=2", "final and sealed");
    await owner.waitForSelector('[data-testid="pack-preview"]');
    await shot(owner, "09-exports-final");
    finalHtml = await printPack(owner, "pack-final-v2.pdf");
    // The seal names the approver from the server's record: the owner has no display name on record, so the role and
    // the stable membership reference are shown — never an invented name.
    return /FINAL — signed off by owner [0-9a-f]{8} \(no name on record\) on \d{4}-\d{2}-\d{2}/.test(finalHtml) && /reporting dependencies SHA-256 [0-9a-f]{64}/.test(finalHtml)
      && /33,000\.00/.test(finalHtml) && /12,500\.00/.test(finalHtml) && /Total comprehensive income for the period/.test(finalHtml) ? true : finalHtml.slice(0, 400);
  });
  await check("the draft (version 1) renders through the same pack with the DRAFT watermark; printed to PDF", async () => {
    await go(owner, "owner", "/signoff/exports?v=1", "draft (not signed off)");
    await owner.waitForSelector('[data-testid="pack-preview"]');
    const draft = await printPack(owner, "pack-draft-v1.pdf");
    return /DRAFT — not signed off/.test(draft) && /content:"DRAFT"/.test(draft) && !/FINAL — signed off/.test(draft) ? true : draft.slice(0, 300);
  });
  await check("context is preserved: navigating from Exports v2 to Statements keeps v=2 on the link", async () => {
    await go(owner, "owner", "/signoff/exports?v=2", "final and sealed");
    await owner.click({ text: "Financial Statements" });
    await sleep(500);
    const href = await owner.url();
    return /#\/statements\?v=2$/.test(href) ? true : href;
  });

  console.log("\n== Recovery and refusal states");
  await check("a later change: the signed version stays FINAL but the next action asks for a new version and names the stale dependency", async () => {
    await go(preparer, "preparer", "/statements/notes", "requirement");
    await preparer.click('[data-requirement="smes.note.estimates"]');
    await preparer.fill('[data-testid="wording-body"]', "Useful lives and residual values are reviewed annually.");
    await preparer.fill('[data-testid="wording-source"]', "Engagement file N-3");
    await preparer.click({ text: "Record wording" });
    await preparer.waitForText("Recorded.");
    await go(preparer, "preparer", "/signoff?v=2", "Version 2");
    const t = await preparer.bodyText();
    const na = await nextAction(preparer);
    await shot(preparer, "10-stale-after-change");
    return /Save a new report version/.test(na?.text ?? "") && /changed after this version was saved/.test(t) && /final and sealed/.test(t) ? true : { na, t: t.slice(0, 600) };
  });
  await check("a viewer sees the statements but has no write control anywhere on the sign-off page", async () => {
    const viewer = await open("viewer");
    await go(viewer, "viewer", "/signoff", "Report versions");
    const t = await viewer.bodyText();
    return (await viewer.evaluate(() => !document.querySelector('[data-testid="save-version"], [data-testid^="sign-"], input[type="file"]'))) && /A preparer saves report versions/.test(t) ? true : t.slice(0, 400);
  });
  await check("another workspace's owner is refused by the server; the page shows the error with a retry, not data", async () => {
    const outsider = await open("outsider");
    await go(outsider, "outsider", "/statements", null);
    await outsider.waitFor(() => /could not be read|not enabled/.test(document.body.innerText), [], { label: "refusal" });
    const t = await outsider.bodyText();
    await shot(outsider, "11-outsider-refused");
    return !/33,000\.00/.test(t) && (/Try again/.test(t) || /not enabled/.test(t)) ? true : t.slice(0, 300);
  });
  await check("every data request of every page stayed on loopback (the app stylesheet's web font is the only other host)", async () => {
    const all = [preparer, partner, owner].flatMap((p) => p.requests).filter((u) => /^https?:|^wss?:/.test(u));
    const off = all.filter((u) => !/^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u) && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u));
    return off.length === 0 && all.length > 0 ? true : off.slice(0, 5);
  });
} catch (e) {
  results.push({ name: "infrastructure", ok: false, detail: String(e?.stack ?? e) });
  console.error(`INFRASTRUCTURE FAILURE: ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  try { bridge.child.stdin.end(); } catch { /* */ }
  try { vite.child.kill(); } catch { /* */ }
  if (process.platform === "win32") { try { spawn("taskkill", ["/pid", String(vite.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* */ } }
}
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nchecks: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
console.log(failed.length === 0 && results.length > 0 ? "REPORTING_JOURNEY: ALL PASSED" : "REPORTING_JOURNEY: FAILED");
await sleep(500);
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
