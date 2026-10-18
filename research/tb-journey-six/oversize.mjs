// Synthetic harness run: replace the current TB with a 12,000,039-byte file; record the refusal, upload count and focus.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [CHECKOUT, PORT, OUT] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const vite = await import(pathToFileURL(path.join(CHECKOUT, "node_modules/vite/dist/node/index.js")).href);
const server = await vite.createServer({ configFile: path.join(CHECKOUT, "dev-harness/journey/vite.config.ts"), server: { port: Number(PORT), strictPort: true, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const { Browser } = await import(pathToFileURL(path.join(CHECKOUT, "scripts/browser-acceptance/cdp.mjs")).href);
const { layoutProblems } = await import(pathToFileURL(path.join(CHECKOUT, "scripts/browser-acceptance/checks.mjs")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await Browser.launch();
const report = {};
try {
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const p = await (await browser.newContext()).newPage();
    await p.setViewport(w, h);
    await p.goto(`http://127.0.0.1:${PORT}/dev-harness/journey/index.html?scene=existing&reset=1#/dashboard`);
    await p.waitForSelector('[data-testid="resume-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]', { timeout: 90000 });
    await sleep(800);
    await p.evaluate(() => document.querySelector('[data-testid="resume-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]').click());
    await p.waitForSelector('[data-testid="trial-balance-file-options"]', { timeout: 30000 });
    await sleep(1500);
    const before = await p.evaluate(() => ({ uploads: window.__tb.tables.trial_balance_uploads.length, calls: window.__journey.calls.length }));
    await p.evaluate(() => {
      const input = [...document.querySelectorAll('input[type="file"]')].find((i) => i.accept === ".csv,.xlsx,.xls");
      const big = new File([new Uint8Array(12_000_039)], "fy2027-demo.csv", { type: "text/csv" });
      const dt = new DataTransfer(); dt.items.add(big); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await sleep(1200);
    const r = await p.evaluate(() => {
      const a = document.querySelector('[data-testid="trial-balance-replace-refusal"]');
      a?.scrollIntoView({ block: "center" });
      return { refusal: a?.textContent ?? null, role: a?.getAttribute("role") ?? null, optionsOpen: document.querySelector('[data-testid="trial-balance-file-options"]').getAttribute("aria-expanded"),
        uploads: window.__tb.tables.trial_balance_uploads.length, calls: window.__journey.calls.length, toasts: document.querySelectorAll("[data-sonner-toast]").length };
    });
    report[`${w}-refused`] = { before, ...r, layout: await p.evaluate(layoutProblems) };
    await sleep(300);
    await p.screenshot(path.join(OUT, `${w}-oversize-refused.png`));
    await sleep(6000); // still there after a toast would have gone
    report[`${w}-after-6s`] = await p.evaluate(() => !!document.querySelector('[data-testid="trial-balance-replace-refusal"]'));
    await p.evaluate(() => document.querySelector('[data-testid="trial-balance-replace-refusal-dismiss"]').click());
    await sleep(300);
    report[`${w}-dismissed`] = await p.evaluate(() => !document.querySelector('[data-testid="trial-balance-replace-refusal"]'));
  }
} finally {
  fs.writeFileSync(path.join(OUT, "oversize.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
  await server.close();
}
