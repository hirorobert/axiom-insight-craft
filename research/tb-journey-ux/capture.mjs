// Scratch capture of the REAL Prepare page in the committed synthetic harness (dev-harness/trial-balance), at a given URL.
// Usage: node capture.mjs <repoRoot> <harnessUrl> <outDir>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [REPO, URL0, OUT] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const { Browser } = await import(pathToFileURL(path.join(REPO, "scripts/browser-acceptance/cdp.mjs")).href);
const { layoutProblems } = await import(pathToFileURL(path.join(REPO, "scripts/browser-acceptance/checks.mjs")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UNBALANCED = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n4000,Sales revenue,,1400.00\n";
const BALANCED = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n1100,Trade receivables,500.00,\n2000,Trade payables,,600.00\n4000,Sales revenue,,1400.00\n";
const NEW_ACCOUNT = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n1100,Trade receivables,500.00,\n1200,Prepaid rent,100.00,\n2000,Trade payables,,700.00\n4000,Sales revenue,,1400.00\n9100,Sundry clearing,,0.00\n";

function inventory() {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const main = document.querySelector("main") ?? document.body;
  const actions = [...main.querySelectorAll("button, a[href], [role=button]")].filter(vis).filter((e) => !e.closest('[data-testid="harness-bar"]')).map((e) => ({
    label: (e.innerText || e.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 70),
    tag: e.tagName.toLowerCase(), testid: e.dataset.testid ?? null, disabled: e.disabled === true || e.getAttribute("aria-disabled") === "true",
    describedBy: e.getAttribute("aria-describedby") ? document.getElementById(e.getAttribute("aria-describedby"))?.innerText?.slice(0, 120) ?? "(missing id)" : null,
    title: e.getAttribute("title"), variantHint: (e.className.match(/bg-primary|variant|outline|ghost|destructive|bg-destructive|text-destructive/g) ?? []).join(" "),
  }));
  const q = (id) => document.querySelector(`[data-testid="${id}"]`)?.innerText?.replace(/\s+/g, " ").trim() ?? null;
  const live = [...document.querySelectorAll('[role=status], [role=alert], [aria-live]')].filter(vis).map((e) => `${e.getAttribute("role") ?? "live"}:${e.innerText.replace(/\s+/g, " ").trim().slice(0, 100)}`);
  const reds = [...main.querySelectorAll("*")].filter(vis).filter((e) => /text-destructive|bg-destructive|text-red-|bg-red-/.test(e.className?.toString?.() ?? "")).map((e) => e.innerText.replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 12);
  return { task: q("trial-balance-current-task"), status: q("trial-balance-status"), primary: q("trial-balance-primary-action"), reason: q("trial-balance-reason"),
    actions, live, reds, text: main.innerText.replace(/\s+/g, " ").slice(0, 1800) };
}

const browser = await Browser.launch();
const report = {};
async function newPage(w, h) {
  const p = await (await browser.newContext()).newPage();
  await p.setViewport(w, h);
  await p.goto(URL0);
  await p.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 60000 });
  await sleep(800);
  return p;
}
const pick = (p, name, csv) => p.evaluate((n, c) => { const i = document.querySelector('input[type="file"]'); const dt = new DataTransfer(); dt.items.add(new File([c], n, { type: "text/csv" })); i.files = dt.files; i.dispatchEvent(new Event("change", { bubbles: true })); }, name, csv);
const settledTo = (p, name) => p.waitFor((n) => { const u = window.__tb.tables.trial_balance_uploads?.[0]; const s = document.querySelector('[data-testid="trial-balance-status"]')?.innerText ?? ""; return u?.file_name === n && !/validating|processing/.test(String(u.status)) && /BLOCKED|NEEDS REVIEW|REVIEWED|FAILED/i.test(s); }, [name], { timeout: 40000, label: "settled" });
async function snap(p, w, key) {
  await sleep(500);
  report[`${w}:${key}`] = { ...(await p.evaluate(inventory)), layout: await p.evaluate(layoutProblems) };
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot(path.join(OUT, `${w}-${key}.png`));
  // full-page-ish: also capture the main column scrolled to the review area if present
  const hasReview = await p.evaluate(() => !!document.querySelector('[data-testid="account-review-workbench"], [data-testid="trial-balance-checks"]'));
  if (hasReview) { await p.evaluate(() => (document.querySelector('[data-testid="account-review-workbench"]') ?? document.querySelector('[data-testid="trial-balance-checks"]')).scrollIntoView({ block: "start" })); await sleep(250); await p.screenshot(path.join(OUT, `${w}-${key}-lower.png`)); }
}

try {
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    let p = await newPage(w, h);
    await snap(p, w, "01-empty");
    await pick(p, "unbalanced.csv", UNBALANCED); await sleep(600);
    await snap(p, w, "02-file-chosen");
    await p.evaluate(() => document.querySelector('[data-testid="trial-balance-upload-primary"]')?.click());
    await sleep(150);
    await snap(p, w, "03-submitting");
    await settledTo(p, "unbalanced.csv");
    await snap(p, w, "04-blocked");
    await pick(p, "new-account.csv", NEW_ACCOUNT); await settledTo(p, "new-account.csv");
    await snap(p, w, "05-needs-review");
    if (w === 1280) {
      const order = [];
      await p.evaluate(() => { document.activeElement?.blur(); document.querySelector('[data-testid="trial-balance-current-task"]')?.setAttribute("tabindex", "-1"); document.querySelector('[data-testid="trial-balance-current-task"]')?.focus(); });
      for (let i = 0; i < 18; i++) { await p.press("Tab"); order.push(await p.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return { el: "body" }; const cs = getComputedStyle(el); const vis = cs.outlineStyle === "auto" || (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow && cs.boxShadow !== "none"); return { el: (el.innerText || el.getAttribute("aria-label") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 50), visible: !!vis }; })); }
      report["keyboard-05"] = order;
    }
    await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Resolve account classifications|Review accounts|Review and confirm/i.test(b.innerText))?.click());
    await sleep(800);
    await snap(p, w, "06-review-open");
    p = await newPage(w, h);
    await pick(p, "balanced.csv", BALANCED); await sleep(500);
    await p.evaluate(() => document.querySelector('[data-testid="trial-balance-upload-primary"]')?.click());
    await settledTo(p, "balanced.csv");
    await snap(p, w, "07-after-balanced");
    // Failure injections on a fresh page
    for (const inj of ["server_error", "drop_after", "in_progress"]) {
      p = await newPage(w, h);
      await p.evaluate((i) => document.querySelector(`[data-testid="inject-${i}"]`).click(), inj);
      await pick(p, `${inj}.csv`, BALANCED); await sleep(500);
      await p.evaluate(() => document.querySelector('[data-testid="trial-balance-upload-primary"]')?.click());
      await sleep(5000);
      await snap(p, w, `08-${inj}`);
    }
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(OUT, "inventory.json"), JSON.stringify(report, null, 2));
console.log("done", Object.keys(report).length);
