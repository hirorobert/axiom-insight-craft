#!/usr/bin/env node
// NON-PRODUCTION browser journey for the IPSAS accrual preparation page (property, plant and equipment; first chain).
//
// Starts a DISPOSABLE PostgreSQL with the loopback bridge (scripts/db-proof/serveIpsas.mjs under bun; full chain incl.
// 20261207100000; an IPSAS company with its 2025 and 2026 trial balances certified by the REAL engine), the harness
// (dev-harness/ipsas, Vite) and headless Chrome (cdp.mjs), then drives the REAL IpsasPreparation component with mouse and
// keyboard. The identity is SIMULATED by the bridge (x-sim-user); this is not GoTrue and not the hosted site.
//   bring     the preparer maps the PPE accounts, states the policy for part periods, enters last year's printed figure
//   prepare   one asset class with the entity's own estimates, register tie, five entity questions; saved on the server
//   server    TB figures appear from the CERTIFIED rows; the next step and the open matters come from the server's assessment
//   reload    leaving and reopening restores everything from the server (no browser state)
//   confirm   a partner (reviewer) confirms the printed figure and the estimates; the draft policy and note then appear and
//             nothing remains open; official issuance is still stated unavailable
//   keyboard  the area tabs are operable by keyboard alone with a visible focus indicator
//   race      another writer saves meanwhile; the page's save is refused by name, the edit is kept, reloading adopts the server
//   lost      a response is dropped after the server recorded it; the page says it cannot confirm, and the retry reuses the
//             ORIGINAL request identity (one revision, replay acknowledged)
//   access    a viewer and an outsider see a plain refusal and no editor
//   widths    1280 and 375 px: no horizontal overflow, no clipped action, no unlabeled field, on three areas
// Timings in results.json are SCRIPTED durations, not a usability or no-coaching measurement.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> node scripts/browser-acceptance/ipsasJourney.mjs [outDir]
//   env: CHROME_PATH, IPSAS_BRIDGE_PORT (54995), IPSAS_HARNESS_PORT (8096)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "./cdp.mjs";
import { layoutProblems } from "./checks.mjs";
import { grantsChain, grantsHostile } from "./ipsasGrantsSteps.mjs";
import { ppeChain, ppeHostile } from "./ipsasPpeSteps.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "ipsas-journey-evidence"));
const BRIDGE_PORT = process.env.IPSAS_BRIDGE_PORT ?? "54995";
const HARNESS_PORT = process.env.IPSAS_HARNESS_PORT ?? "8096";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const results = [], timings = {};
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "journey.log"), s + "\n"); };
let page = null;
async function check(name, fn) {
  const t0 = Date.now();
  try { const r = await fn(); timings[name] = Date.now() - t0; results.push({ name, ok: r === true, detail: r === true ? undefined : r }); log(`  ${r === true ? "PASS" : "FAIL"}  ${name}${r === true ? "" : `\n        ${JSON.stringify(r).slice(0, 1500)}`}`); if (r !== true) await failure(name); }
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

const bridge = start("bun", ["scripts/db-proof/serveIpsas.mjs"], { IPSAS_BRIDGE_PORT: BRIDGE_PORT, IPSAS_STOP_ON_STDIN_END: "1" }, (o) => { const m = o.match(/READY (\{.*\})/); return m ? JSON.parse(m[1]) : null; });
const vite = start("bunx", ["vite", "--config", "dev-harness/ipsas/vite.config.ts"], { IPSAS_HARNESS_PORT: HARNESS_PORT }, (o) => /ready in/.test(o));
let browser;
try {
  const ready = await bridge.seen;
  await vite.seen;
  const seed = await (await fetch(`${ready.bridge}/seed`, { method: "POST", headers: { "x-sim-user": "owner" }, body: "{}" })).json();
  const rpc = async (as, fn, body) => { const r = await fetch(`${ready.bridge}/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", "x-sim-user": as }, body: JSON.stringify(body) }); return r.json(); };
  const serverContext = (as = "owner") => rpc(as, "ipsas_prep_context", { p_company_id: seed.companyId, p_period_year: seed.periodYear });
  browser = await Browser.launch();
  const url = (as, nav = true) => `http://127.0.0.1:${HARNESS_PORT}/dev-harness/ipsas/index.html?bridge=${encodeURIComponent(ready.bridge)}&as=${as}${nav ? "" : "&nav=off"}`;
  const open = async () => { const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.setViewport(1280, 900); return p; };
  const shot = (p, name) => p.screenshot(path.join(OUT, `${name}.png`));
  const go = async (p, as, text, nav = true) => { await p.goto(url(as, nav)); await p.waitForText(text, { timeout: 45000 }); await sleep(250); };
  const set = (p, id, value) => p.evaluate((i, v) => {
    const el = document.getElementById(i);
    if (!el) return `missing #${i}`;
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, id, value);
  const type = async (p, id, value) => { await p.fill(`#${id}`, value); await sleep(40); };
  const val = (p, id) => p.evaluate((i) => document.getElementById(i)?.value ?? null, id);
  const tab = async (p, name) => { await p.click({ text: name }); await sleep(250); };
  const text = (p) => p.bodyText();
  const nextStep = (p) => p.evaluate(() => document.querySelector('[aria-label="Next step"]')?.innerText ?? "");

  const J = { check, open, go, set, type, val, tab, text, nextStep, shot, rpc, seed, log, serverContext, setPage: (p) => { page = p; },
    accounts: { ppe: ["1500", "1510"], dep: ["6200"], rev: ["4300"], liab: ["2300"], recv: ["1300"] } };
  const { preparer, partner } = await ppeChain(J);
  J.preparer = preparer;
  page = preparer;

  await grantsChain(J);
  page = preparer;

  log("\n== Keyboard");
  await check("the area tabs are operable by keyboard alone, with a visible focus indicator", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await preparer.evaluate(() => document.querySelector('[role="tab"]').focus());
    await preparer.press("Tab"); await sleep(120);
    const focus = await preparer.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); return { name: a.textContent, role: a.getAttribute("role"), outline: cs.outlineStyle, outlineWidth: cs.outlineWidth, shadow: cs.boxShadow }; });
    await preparer.press("Enter"); await sleep(250);
    const selected = await preparer.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent);
    const visible = (focus.outline !== "none" && parseFloat(focus.outlineWidth) > 0) || (focus.shadow && focus.shadow !== "none");
    return focus.role === "tab" && selected === focus.name && visible ? true : { focus, selected };
  });

  await ppeHostile(J);
  page = preparer;

  await grantsHostile(J);
  page = preparer;

  log("\n== Access");
  await check("a viewer and an outsider see a plain refusal and no editor", async () => {
    const out = {};
    for (const who of ["viewer", "outsider"]) {
      const p = await open(); page = p;
      await p.goto(url(who)); await p.waitForText("nothing was saved", { timeout: 45000 }).catch(() => null); await sleep(300);
      out[who] = { refused: (await text(p)).includes("Your role cannot do this for this company"), tabs: await p.evaluate(() => document.querySelectorAll('[role="tab"]').length) };
    }
    return out.viewer.refused && out.viewer.tabs === 0 && out.outsider.refused && out.outsider.tabs === 0 ? true : out;
  });

  log("\n== Widths");
  await check("1280 px and 375 px (the page without the harness sidebar): no horizontal overflow, no clipped action, no unlabeled field, on Bring, Prepare and Review", async () => {
    const narrow = await open(); page = narrow;
    await go(narrow, "preparer", "IPSAS accrual, 2026", false);
    const problems = {};
    for (const area of ["Bring information", "Complete preparation", "Review report"]) {
      await tab(narrow, area);
      for (const [w, h] of [[1280, 900], [375, 812]]) {
        await narrow.setViewport(w, h); await sleep(500);
        const p = await narrow.evaluate(layoutProblems);
        if (p.length) problems[`${area} @${w}`] = p.slice(0, 6);
        await shot(narrow, `07-${area.split(" ")[0].toLowerCase()}-${w}`);
      }
      await narrow.setViewport(1280, 900);
    }
    return Object.keys(problems).length === 0 ? true : problems;
  });
  await check("no uncaught page exceptions on any page of the journey", async () => {
    const all = [preparer, partner].flatMap((p) => p.consoleErrors);
    return all.length === 0 ? true : all.slice(0, 5);
  });
} catch (e) {
  log(`JOURNEY FAILURE: ${e?.stack ?? e}`);
  results.push({ name: "journey", ok: false, detail: String(e?.message ?? e) });
} finally {
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, scriptedTimingsMs: timings, note: "Scripted durations; not a usability, completion-time or no-coaching measurement. Identity is simulated by the loopback bridge.", finishedAt: new Date().toISOString() }, null, 2));
  try { await browser?.close(); } catch { /* */ }
  try { bridge.child.stdin.end(); } catch { /* */ }
  try { vite.child.kill(); } catch { /* */ }
  const failed = results.filter((r) => !r.ok);
  log(`\nchecks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
  log(failed.length || !results.length ? "IPSAS_JOURNEY: FAILED" : "IPSAS_JOURNEY: ALL PASSED");
  setTimeout(() => process.exit(results.length && failed.length === 0 ? 0 : 1), 1500);
}
