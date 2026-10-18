// Synthetic harness (dev-harness/trial-balance, the real Prepare page): review → save → replace with two new accounts →
// review → save. Records the review panel (row marks, the save label) and the classification record at 1280/390.
// Usage: node confirm.mjs <checkout> <port> <outDir>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [CHECKOUT, PORT, OUT] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const vite = await import(pathToFileURL(path.join(CHECKOUT, "node_modules/vite/dist/node/index.js")).href);
const server = await vite.createServer({ configFile: path.join(CHECKOUT, "dev-harness/trial-balance/vite.config.ts"), server: { port: Number(PORT), strictPort: true, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const { Browser } = await import(pathToFileURL(path.join(CHECKOUT, "scripts/browser-acceptance/cdp.mjs")).href);
const { layoutProblems } = await import(pathToFileURL(path.join(CHECKOUT, "scripts/browser-acceptance/checks.mjs")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIRST = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n1100,Trade receivables,500.00,\n2000,Trade payables,,600.00\n4000,Sales revenue,,1400.00\n";
const SECOND = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n1100,Trade receivables,500.00,\n1200,Prepaid rent,100.00,\n2000,Trade payables,,600.00\n4000,Sales revenue,,1400.00\n4100,Service income,,100.00\n";
const report = {};
const browser = await Browser.launch();

function panelState() {
  const ws = document.querySelector('[data-testid="account-review-workbench"]') ?? document.querySelector("#account-review")?.closest("section, div");
  const marks = [...document.querySelectorAll('[data-testid^="row-confirmation-"]')].filter((e) => e.offsetParent).map((e) => `${e.dataset.testid.replace("row-confirmation-", "")}: ${e.textContent}`);
  return {
    save: document.querySelector('[data-testid="account-review-save"]')?.textContent?.trim() ?? null,
    status: document.querySelector('[data-testid="account-review-submission"]')?.textContent?.trim() ?? null,
    marks, rows: ws ? [...ws.querySelectorAll("tbody tr")].filter((r) => r.offsetParent).length : null,
  };
}
function recordState() {
  const rec = document.querySelector('[data-testid="classification-record"]');
  if (!rec) return null;
  return { summary: rec.querySelector('[data-testid="classification-record-summary"]')?.textContent, role: rec.querySelector('[data-testid="classification-record-summary"]')?.getAttribute("role"),
    rows: [...rec.querySelectorAll('[data-testid^="record-"]')].filter((e) => e.dataset.basis).map((e) => `${e.dataset.basis} | ${e.innerText.replace(/\s+/g, " ").trim()}`) };
}
const pick = (p, sel, name, csv) => p.evaluate((s, n, c) => { const i = [...document.querySelectorAll(s)].pop(); const dt = new DataTransfer(); dt.items.add(new File([c], n, { type: "text/csv" })); i.files = dt.files; i.dispatchEvent(new Event("change", { bubbles: true })); }, sel, name, csv);
const status = (p, re) => p.waitFor((r) => new RegExp(r, "i").test(document.querySelector('[data-testid="trial-balance-status"]')?.innerText ?? ""), [re], { timeout: 40000, label: re });
async function openList(p) {
  await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^Show the full list$/.test(x.textContent.trim())); b?.click(); });
  await sleep(500);
  await p.evaluate(() => document.querySelector('[data-testid="account-review-save"]')?.scrollIntoView({ block: "end" }));
  await sleep(300);
}
async function snap(p, key, fn) {
  await sleep(400);
  report[key] = { ...(await p.evaluate(fn)), layout: await p.evaluate(layoutProblems) };
  await p.screenshot(path.join(OUT, `${key}.png`));
  console.log(key, JSON.stringify(report[key]).slice(0, 500));
}
try {
  for (const [w, h] of [[1280, 1000], [390, 844]]) {
    const p = await (await browser.newContext()).newPage();
    await p.setViewport(w, h);
    await p.goto(`http://127.0.0.1:${PORT}/dev-harness/trial-balance/index.html`);
    await p.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 90000 });
    await sleep(800);
    await pick(p, 'input[type="file"]', "fy2025-first.csv", FIRST); await sleep(500);
    await p.evaluate(() => document.querySelector('[data-testid="trial-balance-upload-primary"]')?.click());
    await status(p, "NEEDS REVIEW"); await sleep(1500);
    await openList(p);
    await snap(p, `${w}-1-review-first`, panelState);
    await p.evaluate(() => document.querySelector('[data-testid="account-review-save"]').click());
    await status(p, "REVIEWED"); await sleep(2500);
    await p.evaluate(() => document.querySelector('[data-testid="classification-record"]')?.scrollIntoView({ block: "start" }));
    await snap(p, `${w}-2-record-first`, recordState);
    // Replace with a file that adds two accounts: only they need confirming; the rest stand on reviewed mappings.
    await pick(p, 'input[type="file"][accept=".csv,.xlsx,.xls"]', "fy2025-second.csv", SECOND);
    await status(p, "NEEDS REVIEW"); await sleep(1500);
    await openList(p);
    await snap(p, `${w}-3-review-second`, panelState);
    await p.evaluate(() => document.querySelector('[data-testid="account-review-save"]').click());
    await status(p, "REVIEWED"); await sleep(2500);
    await p.evaluate(() => document.querySelector('[data-testid="classification-record"]')?.scrollIntoView({ block: "start" }));
    await snap(p, `${w}-4-record-second`, recordState);
  }
} catch (e) { console.error("FAILED", e?.stack ?? e); report.error = String(e); }
finally {
  fs.writeFileSync(path.join(OUT, "confirm.json"), JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
