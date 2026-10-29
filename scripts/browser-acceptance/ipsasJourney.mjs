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

  log("== Preparer builds the chain");
  const preparer = await open();
  page = preparer;
  await check("the page opens for a signed-in preparer: five areas, one next step, draft label, nothing invented", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    const tabs = await preparer.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent));
    const t = await text(preparer);
    await shot(preparer, "01-opened");
    return JSON.stringify(tabs) === JSON.stringify(["Bring information", "Complete preparation", "Review report", "Approve", "Issue & history"])
      && (await nextStep(preparer)).includes("bring in the trial balance") && t.includes("Draft preparation only") && t.includes("unknown") ? true : { tabs, next: await nextStep(preparer) };
  });
  await check("bring: mapping the PPE accounts, the policy and last year's printed figure are entered by typing; the preparer cannot confirm", async () => {
    await type(preparer, "tb-ppe", "1500, 1510"); await type(preparer, "tb-dep", "6200");
    if ((await set(preparer, "conv", "daily")) !== true) return "no convention select";
    await type(preparer, "prior-amt", "16,000.00"); await type(preparer, "prior-loc", "Statement of financial position, p. 12");
    await preparer.click({ text: "Save prior figure" });
    await preparer.waitForText("This is the server's recorded version", { timeout: 20000 });
    const disabled = await preparer.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Confirm against the printed page"))?.disabled);
    return disabled === true && (await text(preparer)).includes("Confirmation needs a reviewer") ? true : { disabled };
  });
  await check("prepare: one asset class with the entity's own estimates, the register tie and five answered questions saves on the server", async () => {
    await tab(preparer, "Complete preparation");
    await preparer.click({ text: "Add an asset class" });
    await preparer.waitForSelector("#c0-label");
    const steps = [["c0-label", "Equipment"], ["c0-acc", "1500, 1510"], ["c0-openingg", "20,000.00"], ["c0-openingd", "4,000.00"], ["c0-closingg", "20,000.00"], ["c0-closingd", "6,000.00"],
      ["c0-dep", "2,000.00"], ["c0-src", "Fixed asset register FY2026"], ["c0-i0l", "E1"], ["c0-i0c", "20,000.00"], ["c0-i0r", "0.00"], ["c0-i0o", "4,000.00"], ["c0-i0y", "10"],
      ["c0-rat", "Ten years of single-shift use expected"], ["c0-ev", "Maintenance plan MP-2026"]];
    for (const [id, v] of steps) await type(preparer, id, v);
    for (const [id, v] of [["c0-model", "cost"], ["c0-cs", "calculated"]]) if ((await set(preparer, id, v)) !== true) return `no ${id}`;
    for (const q of ["heritage_assets", "infrastructure_assets", "impairment_indicators", "held_for_sale", "commitments_restrictions"]) {
      if ((await set(preparer, `q-${q}`, "no")) !== true) return `no q-${q}`;
      await type(preparer, `q-${q}-t`, "Checked the asset register and the board minutes"); await type(preparer, `q-${q}-e`, "Register FY2026 and minutes");
    }
    await shot(preparer, "02-filled");
    await preparer.click({ text: "Save preparation" });
    await preparer.waitForText("This is the server's recorded version", { timeout: 20000 });
    const ctx = await serverContext();
    return ctx.workpaper?.id && ctx.assessment.ppe && ctx.assessment.ppe.classes[0].chargeCalculatedMinor === "200000" ? true : ctx.assessment;
  });
  await check("server: trial-balance figures come from the CERTIFIED rows, and the next step is the first open matter from the server's assessment", async () => {
    await tab(preparer, "Bring information"); await sleep(300);
    const t = await text(preparer), next = await nextStep(preparer);
    return t.includes("closing 14,000.00, opening 16,000.00") && t.includes("depreciation expense 2,000.00") && /Next:/.test(next) && next.includes("prior report figure") ? true : { next, tb: t.match(/Property, plant and equipment per[^\n]*/)?.[0] };
  });
  await check("review: before management confirms, no policy wording exists for the class and the open matters name what, why, which evidence and who", async () => {
    await tab(preparer, "Review report");
    const t = await text(preparer);
    await shot(preparer, "03-review-before");
    return t.includes("INCOMPLETE DRAFT") && t.includes("await management's confirmation") && !/straight-line over 10 years/.test(t) && t.includes("Estimate unconfirmed")
      && t.includes("Evidence:") && t.includes("Who: management") && t.includes("Carrying amount") ? true : t.slice(0, 1500);
  });
  await check("reload: leaving and reopening restores the saved preparation from the server alone", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    const t = await text(preparer);
    await tab(preparer, "Complete preparation");
    const label = await val(preparer, "c0-label"), life = await val(preparer, "c0-i0y");
    return t.includes("Everything shown is the server's saved version") && label === "Equipment" && life === "10" ? true : { label, life };
  });

  log("\n== Reviewer confirms; the chain completes");
  const partner = await open();
  page = partner;
  await check("a partner (reviewer) confirms the printed figure and the estimates; the draft policy and note then appear and nothing remains open", async () => {
    await go(partner, "partner", "IPSAS accrual, 2026");
    await partner.click({ text: "Confirm against the printed page" });
    await partner.waitForText("Confirmed against the printed page", { timeout: 20000 });
    await tab(partner, "Complete preparation");
    await partner.click({ text: "Confirm these estimates" });
    await partner.waitForText("Estimates confirmed", { timeout: 20000 });
    await sleep(300);
    const next = await nextStep(partner);
    await tab(partner, "Review report");
    const t = await text(partner);
    await shot(partner, "04-review-after");
    return next.includes("no open matters") && t.includes("straight-line over 10 years") && t.includes("No open matters in this slice") && t.includes("Server state: ready-for-review")
      && t.includes("Prepared from confirmed facts") && /Total[\s\S]{0,40}16,000\.00[\s\S]{0,20}14,000\.00/.test(t.replace(/\n/g, " ")) ? true : { next, hasPolicy: t.includes("straight-line over 10 years") };
  });
  await check("issue & history: official issuance is stated unavailable, with reasons, even though this slice has no open matter", async () => {
    await tab(partner, "Issue & history");
    const t = await text(partner);
    return t.includes("Official issuance is unavailable") && t.includes("No IPSAS report has been issued") && t.includes("no accounting author or reviewer") ? true : t.slice(0, 800);
  });
  page = preparer;
  await check("the preparer, reloading, sees the confirmed state with no coaching: the same next step as the server holds", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    return (await nextStep(preparer)).includes("no open matters") ? true : await nextStep(preparer);
  });

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

  log("\n== Concurrency and lost responses");
  await check("race: another writer saves meanwhile; the page's save is refused by name, the edit is kept, and reloading adopts the server's version", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await tab(preparer, "Complete preparation");
    await type(preparer, "c0-label", "Equipment (mine)");
    const ctx = await serverContext();
    const theirs = JSON.parse(JSON.stringify(ctx.workpaper.payload)); theirs.classes[0].label = "Equipment (theirs)";
    const saved = await rpc("owner", "ipsas_save_preparation", { p_company_id: seed.companyId, p_period_year: seed.periodYear, p_kind: "ppe_workpaper", p_payload: theirs, p_expected_id: ctx.workpaper.id, p_request_id: crypto.randomUUID() });
    if (saved.outcome !== "recorded") return saved;
    await preparer.click({ text: "Save preparation" });
    await preparer.waitForText("Someone saved a newer version", { timeout: 20000 });
    const kept = await val(preparer, "c0-label");
    await shot(preparer, "05-stale");
    await preparer.click({ text: "Discard edits and reload the saved version" });
    await sleep(600);
    const adopted = await val(preparer, "c0-label");
    return kept === "Equipment (mine)" && adopted === "Equipment (theirs)" ? true : { kept, adopted };
  });
  await check("lost: a response dropped after the server recorded it is reported as unconfirmed, and the retry reuses the ORIGINAL request identity (one revision, replay acknowledged)", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await tab(preparer, "Complete preparation");
    await preparer.evaluate(() => {
      const real = window.fetch.bind(window); window.__sent = []; let dropped = false;
      window.fetch = async (u, o) => {
        if (String(u).includes("/rpc/ipsas_save_preparation")) {
          window.__sent.push(JSON.parse(o.body).p_request_id);
          const r = await real(u, o);
          if (!dropped) { dropped = true; await r.text(); throw new TypeError("Failed to fetch"); } // the server recorded it; the answer never arrives
          return r;
        }
        return real(u, o);
      };
    });
    const before = (await serverContext()).workpaper.id;
    await type(preparer, "c0-rat", "Ten years of single-shift use expected; reviewed after the race");
    await preparer.click({ text: "Save preparation" });
    await preparer.waitForText("We could not confirm whether this was saved", { timeout: 20000 });
    const midText = await text(preparer);
    const recorded = (await serverContext()).workpaper.id;
    await preparer.click({ text: "Send the same request again" });
    await preparer.waitForText("had already been recorded", { timeout: 20000 });
    const sent = await preparer.evaluate(() => window.__sent);
    const after = (await serverContext()).workpaper.id;
    await shot(preparer, "06-lost-retry");
    return midText.includes("Nothing is assumed either way") && sent.length === 2 && sent[0] === sent[1] && recorded !== before && after === recorded ? true : { sent, before, recorded, after };
  });

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
