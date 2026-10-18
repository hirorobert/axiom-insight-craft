// Scratch: start the committed trial-balance harness for a given checkout on a port, reach "Needs review", expand the
// technical processing ledger, read it and screenshot it. Usage: node ledger.mjs <checkout> <port> <outPng> <repoForDriver>
import path from "node:path";
import { pathToFileURL } from "node:url";
const [CHECKOUT, PORT, OUT, DRIVER_REPO] = process.argv.slice(2);
const vite = await import(pathToFileURL(path.join(CHECKOUT, "node_modules/vite/dist/node/index.js")).href);
const server = await vite.createServer({ configFile: path.join(CHECKOUT, "dev-harness/trial-balance/vite.config.ts"), server: { port: Number(PORT), strictPort: true, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const { Browser } = await import(pathToFileURL(path.join(DRIVER_REPO, "scripts/browser-acceptance/cdp.mjs")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await Browser.launch();
try {
  const p = await (await browser.newContext()).newPage();
  await p.setViewport(1280, 1400);
  await p.goto(`http://127.0.0.1:${PORT}/dev-harness/trial-balance/index.html`);
  await p.waitForSelector('input[type="file"]', { timeout: 90000 });
  await sleep(800);
  const csv = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n1100,Trade receivables,500.00,\n1200,Prepaid rent,100.00,\n2000,Trade payables,,700.00\n4000,Sales revenue,,1400.00\n";
  await p.evaluate((c) => { const i = document.querySelector('input[type="file"]'); const dt = new DataTransfer(); dt.items.add(new File([c], "nr.csv", { type: "text/csv" })); i.files = dt.files; i.dispatchEvent(new Event("change", { bubbles: true })); }, csv);
  await sleep(600);
  await p.evaluate(() => document.querySelector('[data-testid="trial-balance-upload-primary"]')?.click());
  await p.waitFor(() => /NEEDS REVIEW/i.test(document.querySelector('[data-testid="trial-balance-status"]')?.innerText ?? ""), [], { timeout: 40000, label: "needs review" });
  await sleep(1500);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Technical processing details/.test(b.innerText.trim()))?.click());
  await sleep(1500);
  const info = await p.evaluate(() => {
    const sec = document.querySelector('[data-testid="certification-ledger"] section');
    if (!sec) return { found: false };
    sec.scrollIntoView({ block: "start" });
    return { found: true, header: sec.innerText.split("\n").slice(0, 2).join(" | "), spinners: sec.querySelectorAll(".animate-spin").length,
      rows: [...sec.querySelectorAll("li")].map((li) => li.innerText.replace(/\s+/g, " ").trim()) };
  });
  await sleep(300);
  await p.screenshot(OUT);
  console.log(JSON.stringify(info, null, 1));
} finally {
  await browser.close();
  await server.close();
}
