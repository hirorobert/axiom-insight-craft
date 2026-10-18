// Drives dev-harness/journey (synthetic, mocked backend) through the six-issue journey and records route, visible
// actions and screenshots. Works on both the before and after code (selectors fall back).
// Usage: node journey.mjs <checkout> <port> <outDir>
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
const BASE = `http://127.0.0.1:${PORT}/dev-harness/journey/index.html`;
const CSV = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n1100,Trade receivables,500.00,\n2000,Trade payables,,600.00\n4000,Sales revenue,,1400.00\n";
const report = {};
const ONLY = process.env.ONLY ?? "";
const run = (sec) => !ONLY || ONLY.includes(sec);
const log = (k, v) => { report[k] = v; console.log(k, JSON.stringify(v).slice(0, 400)); };

function inv() {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const root = document.getElementById("root");
  if (!root) return { route: location.href, actions: [], live: [], focused: null, leftApp: true };
  const actions = [...root.querySelectorAll("button, a[href], [role=button], [role=combobox]")].filter(vis).filter((e) => !e.closest('[data-testid="harness-bar"]')).map((e) => ({
    label: (e.innerText || e.getAttribute("aria-label") || e.value || "").trim().replace(/\s+/g, " ").slice(0, 70), testid: e.dataset.testid ?? null,
    aria: e.getAttribute("aria-label"), primary: /bg-primary/.test(e.className) && !/outline/.test(e.className), disabled: !!e.disabled,
  }));
  const live = [...document.querySelectorAll("[role=status], [role=alert]")].filter(vis).map((e) => `${e.getAttribute("role")}:${e.innerText.replace(/\s+/g, " ").trim().slice(0, 140)}`);
  return { route: location.hash, actions, live, focused: (document.activeElement?.id || document.activeElement?.dataset?.testid || document.activeElement?.tagName) ?? null };
}
const browser = await Browser.launch();
async function open(scene, w, h) {
  const p = await (await browser.newContext()).newPage();
  await p.setViewport(w, h);
  await p.goto(`${BASE}?scene=${scene}&reset=1#/dashboard`);
  await p.waitForSelector('[data-testid="harness-bar"]', { timeout: 90000 });
  await sleep(1500);
  return p;
}
async function snap(p, key) {
  await sleep(400);
  const i = await p.evaluate(inv);
  i.layout = i.leftApp ? null : await p.evaluate(layoutProblems);
  report[key] = i;
  await p.screenshot(path.join(OUT, `${key}.png`));
  console.log(key, i.route, i.actions.filter((a) => a.primary).map((a) => a.label).join(" | "));
  return i;
}
const click = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
const setVal = (p, sel, v) => p.evaluate((s, val) => {
  const el = document.querySelector(s); if (!el) return false;
  const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  return true;
}, sel, v);
const pickFile = (p, sel, name, csv) => p.evaluate((s, n, c) => { const i = document.querySelector(s); const dt = new DataTransfer(); dt.items.add(new File([c], n, { type: "text/csv" })); i.files = dt.files; i.dispatchEvent(new Event("change", { bubbles: true })); }, sel, name, csv);

async function chooseCurrency(p, code, keyPrefix) {
  const kind = await p.evaluate(() => { const el = document.querySelector('[data-testid="confirm-currency"]'); return el ? el.tagName + ":" + (el.getAttribute("role") ?? "") : null; });
  if (kind?.startsWith("SELECT")) {
    // Before: a separate search box filters a closed native select.
    await setVal(p, '[data-testid="confirm-currency-search"]', "zzz"); await sleep(300);
    if (keyPrefix) await snap(p, `${keyPrefix}-currency-nomatch`);
    await setVal(p, '[data-testid="confirm-currency-search"]', "shil"); await sleep(300);
    if (keyPrefix) await snap(p, `${keyPrefix}-currency-typed`);
    await setVal(p, '[data-testid="confirm-currency-search"]', ""); await sleep(100);
    await setVal(p, '[data-testid="confirm-currency"]', code);
  } else {
    await p.evaluate(() => document.querySelector('[data-testid="confirm-currency"]').focus());
    await setVal(p, '[data-testid="confirm-currency"]', "zzz"); await sleep(300);
    if (keyPrefix) await snap(p, `${keyPrefix}-currency-nomatch`);
    await setVal(p, '[data-testid="confirm-currency"]', "shil"); await sleep(300);
    if (keyPrefix) await snap(p, `${keyPrefix}-currency-typed`);
    await setVal(p, '[data-testid="confirm-currency"]', code); await sleep(200);
    await p.press("Enter"); await sleep(200);
  }
  await sleep(200);
}
async function fillCard(p, { entityName, existing, keyPrefix }) {
  if (existing) { await click(p, '[data-testid="confirm-entity-existing"]'); await sleep(200); await setVal(p, '[data-testid="confirm-entity-select"]', existing); await sleep(600); }
  else await setVal(p, '[data-testid="confirm-entity"]', entityName);
  await click(p, '[data-testid="confirm-period-year"]'); await sleep(150);
  await setVal(p, '[data-testid="confirm-period-end"]', "2025-12-31"); await sleep(150);
  const cur = await p.evaluate(() => { const el = document.querySelector('[data-testid="confirm-currency"]'); return el?.dataset.value ?? el?.value ?? ""; });
  if (!existing || !/^[A-Z]{3}$/.test(cur)) await chooseCurrency(p, "TZS", keyPrefix);
}
async function waitResultOrPanel(p) {
  await p.waitFor(() => /trial-balance\/review/.test(location.hash) || !!document.querySelector('[data-testid="first-upload-checked"], [data-testid="first-upload-failure"]'), [], { timeout: 40000, label: "result or panel" });
  await sleep(1500);
}
const settle = (p) => p.waitFor(() => /BLOCKED|NEEDS REVIEW|REVIEWED|FAILED/i.test(document.querySelector('[data-testid="trial-balance-status"]')?.innerText ?? ""), [], { timeout: 40000, label: "settled" }).catch(() => null);

try {
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const W = String(w);
    // ── A. First upload → result → refresh → Back ───────────────────────────────────────────────────────────────
    if (run("A")) { let p;
    p = await open("first", w, h);
    await snap(p, `${W}-A1-home-first`);
    await pickFile(p, '[data-testid="first-upload-input"]', "fy2025-trial-balance.csv", CSV);
    await p.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 20000 });
    await fillCard(p, { entityName: "Synthetic Trading Co", keyPrefix: w === 1280 ? `${W}-A2` : null });
    await snap(p, `${W}-A3-card-filled`);
    await click(p, '[data-testid="first-upload-start"]');
    await waitResultOrPanel(p);
    await snap(p, `${W}-A4-after-check`);
    if (await p.evaluate(() => !!document.querySelector('[data-testid="first-upload-open-result"]'))) {
      await click(p, '[data-testid="first-upload-open-result"]');
      await sleep(2500);
    }
    await settle(p);
    const resultRoute = await p.evaluate(() => location.hash);
    await snap(p, `${W}-A5-result`);
    await p.evaluate(() => location.reload());
    await sleep(3000); await settle(p);
    log(`${W}-A6-refresh`, { before: resultRoute, after: await p.evaluate(() => location.hash), file: await p.evaluate(() => document.querySelector('[data-testid="trial-balance-current-task"]')?.closest("main, div")?.innerText.match(/fy2025[^\s]*\.csv/)?.[0] ?? null) });
    await snap(p, `${W}-A6-after-refresh`);
    await p.evaluate(() => history.back());
    await sleep(2500);
    await snap(p, `${W}-A7-after-back`);

    }
    // ── B. Saved-draft return ────────────────────────────────────────────────────────────────────────────────────
    if (run("B")) { let p;
    p = await open("draft", w, h);
    await snap(p, `${W}-B1-home-draft`);
    const resumeSel = (await p.evaluate(() => !!document.querySelector('[data-testid="first-upload-continue-draft"]'))) ? '[data-testid="first-upload-continue-draft"]' : '[data-testid="first-upload-resume"]';
    await click(p, resumeSel); await sleep(800);
    await snap(p, `${W}-B2-draft-continued`);

    }
    // ── C. Existing engagement: row actions, purpose, replacement from the home ─────────────────────────────────
    if (run("C")) { let p;
    p = await open("existing", w, h);
    await p.waitForSelector('[data-testid^="engagement-row-"]', { timeout: 30000 });
    await snap(p, `${W}-C1-home-existing`);
    const purposeSel = (await p.evaluate(() => !!document.querySelector('[data-testid^="company-options-"]'))) ? '[data-testid^="company-options-"]' : '[data-testid^="set-purpose-"]';
    await click(p, purposeSel); await sleep(500);
    await snap(p, `${W}-C2-purpose`);
    await click(p, '[data-testid="resume-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]'); await sleep(2500);
    await snap(p, `${W}-C3-row-action-destination`);
    await p.evaluate(() => history.back()); await sleep(2000);
    await p.waitForSelector('[data-testid="first-upload-input"]', { timeout: 20000 });
    await pickFile(p, '[data-testid="first-upload-input"]', "fy2025-replacement.csv", CSV.replace("1500.00", "1700.00").replace("500.00,", "300.00,"));
    await p.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 20000 });
    await fillCard(p, { existing: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    await click(p, '[data-testid="first-upload-start"]');
    await p.waitForSelector('[data-testid="first-upload-failure"]', { timeout: 20000 });
    await snap(p, `${W}-C4-replace-offered`);
    await click(p, '[data-testid="first-upload-replace"]');
    await p.waitFor(() => /trial-balance\/review/.test(location.hash) || !!document.querySelector('[data-testid="first-upload-checked"]'), [], { timeout: 40000, label: "replacement result" });
    await sleep(1500);
    if (await p.evaluate(() => !!document.querySelector('[data-testid="first-upload-open-result"]'))) { await click(p, '[data-testid="first-upload-open-result"]'); await sleep(2500); }
    await settle(p);
    await snap(p, `${W}-C5-replacement-result`);
    // Card actions on the result: review (primary) and file options (secondary)
    const fo = await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^File options/.test(x.innerText.trim())); if (b) { b.click(); return true; } return false; });
    await sleep(600);
    await snap(p, `${W}-C6-file-options`);
    if (fo) {
      await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Upload history/.test(x.innerText.trim()) && !x.closest('[data-testid="upload-history"]'))?.click());
      await sleep(600);
      await snap(p, `${W}-C7-history-focus`);
    }
    await p.evaluate(() => document.querySelector('[data-testid="trial-balance-primary-action"]')?.click());
    await sleep(900);
    await snap(p, `${W}-C8-review-focus`);

    }
    // ── D. Refusal and a failed check from the home ─────────────────────────────────────────────────────────────
    if (run("D")) { let p;
    p = await open("first", w, h);
    await click(p, '[data-testid="refuse-period"]');
    await pickFile(p, '[data-testid="first-upload-input"]', "fy2025-trial-balance.csv", CSV);
    await p.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 20000 });
    await fillCard(p, { entityName: "Synthetic Trading Co" });
    await click(p, '[data-testid="first-upload-start"]');
    await p.waitForSelector('[data-testid="first-upload-failure"]', { timeout: 20000 });
    await snap(p, `${W}-D1-refused`);
    for (const [inj, key] of [["server_error", "D2-check-failed"], ["in_progress", "D3-check-running"]]) {
      p = await open("first", w, h);
      await pickFile(p, '[data-testid="first-upload-input"]', "fy2025-trial-balance.csv", CSV);
      await p.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 20000 });
      await fillCard(p, { entityName: "Synthetic Trading Co" });
      await click(p, `[data-testid="inject-${inj}"]`);
      await click(p, '[data-testid="first-upload-start"]');
      await sleep(5000);
      await snap(p, `${W}-${key}`);
      if (await p.evaluate(() => !!document.querySelector('[data-testid="first-upload-open-result"]'))) { await click(p, '[data-testid="first-upload-open-result"]'); await sleep(1500); await snap(p, `${W}-${key}-result`); }
    }

    }
    // ── E. Keyboard on the home (1280 only) ──────────────────────────────────────────────────────────────────────
    if (run("E")) { let p;
    if (w === 1280) {
      p = await open("existing", w, h);
      await p.waitForSelector('[data-testid^="engagement-row-"]', { timeout: 30000 });
      const order = [];
      await p.evaluate(() => document.activeElement?.blur());
      for (let i = 0; i < 14; i++) { await p.press("Tab"); order.push(await p.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return "body"; if (el.closest('[data-testid="harness-bar"]')) return "(harness)"; const cs = getComputedStyle(el); const ring = cs.outlineStyle !== "none" || (cs.boxShadow && cs.boxShadow !== "none"); return `${(el.getAttribute("aria-label") || el.innerText || el.tagName).trim().replace(/\s+/g, " ").slice(0, 60)}${ring ? "" : " [no visible focus]"}`; })); }
      log("keyboard-home", order);
    }
    }
  }
} catch (e) {
  console.error("FAILED", e?.stack ?? e);
  report.error = String(e?.stack ?? e);
} finally {
  fs.writeFileSync(path.join(OUT, "journey.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
}
