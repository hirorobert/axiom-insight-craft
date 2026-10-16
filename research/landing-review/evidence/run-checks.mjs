// Evidence runner for the landing review. Uses the repository's own headless-Chrome driver (scripts/browser-acceptance).
// Usage (repository root): node research/landing-review/evidence/run-checks.mjs [--live-origin https://cfoclose.com] [--no-live]
// Writes research/landing-review/evidence/results.json and screenshots under research/landing-review/evidence/screenshots/.
//
// Mockup checks: reflow at 320 / 390 / 1280, keyboard order with visible focus, regression scenarios (an unresolved or
// unsupported treatment never reaches the illustrated ready state; decisions made by keyboard only), and the no-JavaScript
// static fallback. Exits 1 if any regression scenario fails. Live checks are READ-ONLY: navigation, measurement and screenshots;
// no click, no form, no sign-in.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const HERE = path.join(REPO, "research/landing-review/evidence");
const SHOTS = path.join(HERE, "screenshots");
const MOCKUP = pathToFileURL(path.join(REPO, "research/landing-review/mockup/sample-review-mockup.html")).href;
const args = process.argv.slice(2);
const LIVE = args.includes("--no-live") ? null : (args[args.indexOf("--live-origin") + 1] && args.includes("--live-origin") ? args[args.indexOf("--live-origin") + 1] : "https://cfoclose.com");
const WIDTHS = [[320, 720], [390, 844], [1280, 900]];

const { Browser } = await import(pathToFileURL(path.join(REPO, "scripts/browser-acceptance/cdp.mjs")).href);
const { layoutProblems } = await import(pathToFileURL(path.join(REPO, "scripts/browser-acceptance/checks.mjs")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });
/** A live navigation with one retry for a transient network reset (read-only GET). */
async function gotoLive(page, url) {
  try { await page.goto(url); } catch (e) { await sleep(2000); await page.goto(url); }
}

/** In-page: the smallest computed font size among visible text, excluding screen-reader-only text. */
function smallestText() {
  let min = Infinity, where = null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (el.closest(".sr-only, [hidden], script, style")) continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || cs.display === "none") continue;
    const fs = parseFloat(cs.fontSize);
    if (fs < min) { min = fs; where = n.textContent.trim().slice(0, 40); }
  }
  return { px: min, text: where };
}

/** In-page: describe the focused element and whether it shows a visible focus indicator. */
function focusInfo() {
  const el = document.activeElement;
  if (!el || el === document.body) return { el: "body", endOfDocument: true };
  const cs = getComputedStyle(el);
  // "auto" is the browser's own focus ring (drawn by Chrome regardless of the reported width): visible, but not the
  // site's designed indicator. Recorded separately so the two are never conflated.
  const browserDefault = cs.outlineStyle === "auto";
  const outline = browserDefault || (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2);
  const ring = /rgb|#/.test(cs.boxShadow) && cs.boxShadow !== "none";
  const r = el.getBoundingClientRect();
  const label = (el.getAttribute("aria-label") || el.innerText || el.id || el.tagName).trim().replace(/\s+/g, " ").slice(0, 48);
  return { el: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.getAttribute("role") ? "[role=" + el.getAttribute("role") + "]" : ""}`, label,
    visible: outline || ring, browserDefaultRing: browserDefault && !ring, outline: `${cs.outlineStyle} ${cs.outlineWidth}`, boxShadow: cs.boxShadow === "none" ? null : cs.boxShadow.slice(0, 60),
    inViewport: r.bottom > 0 && r.top < innerHeight, height: Math.round(r.height) };
}

const results = { runAt: new Date().toISOString(), baseline: "origin/main 00a2653b5736e89447334e1147aa25f5308b0393", mockup: {}, live: null };
const browser = await Browser.launch();
try {
  // ── Mockup: reflow ──────────────────────────────────────────────────────────────────────────────────────────────
  results.mockup.reflow = {};
  for (const [w, h] of WIDTHS) {
    const page = await (await browser.newContext()).newPage();
    await page.setViewport(w, h);
    await page.goto(MOCKUP);
    await page.waitForSelector("#sample-title");
    const m = await page.evaluate(() => ({ cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }));
    results.mockup.reflow[w] = { layoutProblems: await page.evaluate(layoutProblems), smallestText: await page.evaluate(smallestText), ...m,
      consoleErrors: page.consoleErrors, networkRequests: page.requests.filter((u) => !u.startsWith("file:") && !u.startsWith("data:")) };
    await page.screenshot(path.join(SHOTS, `mockup-${w}-top.png`));
    await page.evaluate(() => document.getElementById("sample").scrollIntoView({ block: "start" }));
    await sleep(150);
    await page.screenshot(path.join(SHOTS, `mockup-${w}-sample.png`));
    await page.evaluate(() => document.querySelector('[role="tab"]#tab-2').click());
    await page.evaluate(() => document.getElementById("held-2100").scrollIntoView({ block: "start" }));
    await sleep(150);
    await page.screenshot(path.join(SHOTS, `mockup-${w}-mapping.png`));
  }

  // ── Mockup: keyboard order and visible focus ────────────────────────────────────────────────────────────────────
  {
    const page = await (await browser.newContext()).newPage();
    await page.setViewport(1280, 900);
    await page.goto(MOCKUP);
    await page.waitForSelector("#sample-title");
    const order = [];
    for (let i = 0; i < 12; i++) { await page.press("Tab"); order.push(await page.evaluate(focusInfo)); }
    const k = { tabOrder: order, everyFocusVisible: order.filter((f) => !f.endOfDocument).every((f) => f.visible) };
    await page.evaluate(() => document.getElementById("tab-1").focus());
    await page.press("ArrowRight");
    k.arrowRight = await page.evaluate(() => ({ focus: document.activeElement.id, selected: document.querySelector('[aria-selected="true"]').id }));
    await page.press("ArrowRight");
    k.arrowToLocked = await page.evaluate(() => ({ focus: document.activeElement.id, ariaDisabled: document.getElementById("tab-3").getAttribute("aria-disabled"),
      describedBy: document.getElementById(document.getElementById("tab-3").getAttribute("aria-describedby"))?.textContent, panel3Hidden: document.getElementById("panel-3").hidden }));
    k.status = await page.evaluate(() => { const s = document.getElementById("pending-pill"); return { role: s.getAttribute("role"), live: s.getAttribute("aria-live") }; });
    await page.evaluate(() => document.querySelector('input[name="d-2100"]').focus());
    k.radioFocus = await page.evaluate(focusInfo);
    results.mockup.keyboard = k;
  }

  // ── Mockup: regression scenarios (decisions made by keyboard only) ──────────────────────────────────────────────
  // An unresolved or unsupported treatment must never produce the illustrated ready state.
  {
    const state = () => ({
      ready: window.__sample.ready(),
      tab3Locked: document.getElementById("tab-3").getAttribute("aria-disabled") === "true",
      readyShown: !document.querySelector('[data-testid="ready-state"]').hidden,
      panel3Open: !document.getElementById("panel-3").hidden,
      equation: document.getElementById("equation-state").textContent,
      equationDetail: document.getElementById("equation-detail").textContent,
      status: document.getElementById("pending-pill").textContent,
      outcomes: [document.getElementById("out-2100").textContent, document.getElementById("out-4900").textContent],
      logEntries: document.querySelectorAll("#log li").length,
    });
    // Keyboard only: focus the group's first radio, Space checks it, ArrowDown moves the selection, then Enter on "Record decision".
    const OPTION = { "2100": ["Current Liabilities", "Non-Current Liabilities", "Equity"], "4900": ["Current Liabilities", "Other Income", "Revenue"] };
    async function choose(page, code, value, record = true) {
      const idx = OPTION[code].indexOf(value);
      await page.evaluate((c) => document.querySelector(`input[name="d-${c}"]`).focus(), code);
      await page.press(" ");
      for (let i = 0; i < idx; i++) await page.press("ArrowDown");
      const selected = await page.evaluate((c) => document.querySelector(`input[name="d-${c}"]:checked`)?.value ?? null, code);
      if (record) { await page.evaluate((c) => document.querySelector(`[data-record="${c}"]`).focus(), code); await page.press("Enter"); }
      return selected;
    }
    async function tryOpenReviewed(page) {
      await page.evaluate(() => document.getElementById("tab-2").focus());
      await page.press("End");
      return page.evaluate(() => !document.getElementById("panel-3").hidden);
    }
    const fresh = async () => { const p = await (await browser.newContext()).newPage(); await p.setViewport(1280, 900); await p.goto(MOCKUP); await p.waitForSelector("#sample-title"); await p.evaluate(() => document.getElementById("tab-2").click()); return p; };
    const scenarios = [];
    const expect = (name, s, opened, want) => {
      const failures = [];
      for (const [key, val] of Object.entries(want)) {
        const got = key === "opened" ? opened : s[key];
        if (got !== val) failures.push(`${key}: expected ${val}, got ${got}`);
      }
      scenarios.push({ name, pass: failures.length === 0, failures, state: s, endKeyOpenedReviewed: opened });
    };

    let p = await fresh();
    expect("S0 initial: both held, nothing decided", await p.evaluate(state), await tryOpenReviewed(p),
      { ready: false, tab3Locked: true, readyShown: false, opened: false, equation: "Pending" });

    p = await fresh();
    await choose(p, "2100", "Current Liabilities");
    expect("S1 one supported decision, one unresolved", await p.evaluate(state), await tryOpenReviewed(p),
      { ready: false, tab3Locked: true, readyShown: false, opened: false, equation: "Pending" });

    p = await fresh();
    await choose(p, "2100", "Equity"); await choose(p, "4900", "Other Income");
    expect("S2 both decided, both unsupported by the evidence", await p.evaluate(state), await tryOpenReviewed(p),
      { ready: false, tab3Locked: true, readyShown: false, opened: false, equation: "Holds" });
    await p.evaluate(() => document.getElementById("held-2100").scrollIntoView({ block: "start" }));
    await sleep(150);
    await p.screenshot(path.join(SHOTS, "mockup-1280-unsupported.png"));

    p = await fresh();
    await choose(p, "2100", "Current Liabilities", false); await choose(p, "4900", "Current Liabilities", false);
    expect("S1b both supported treatments selected but not recorded", await p.evaluate(state), await tryOpenReviewed(p),
      { ready: false, tab3Locked: true, readyShown: false, opened: false, equation: "Pending", logEntries: 1 });

    p = await fresh();
    await choose(p, "2100", "Current Liabilities"); await choose(p, "4900", "Revenue");
    expect("S3 one supported, one unsupported", await p.evaluate(state), await tryOpenReviewed(p),
      { ready: false, tab3Locked: true, readyShown: false, opened: false, equation: "Holds" });

    p = await fresh();
    const picked = [await choose(p, "2100", "Non-Current Liabilities"), await choose(p, "2100", "Current Liabilities"), await choose(p, "4900", "Current Liabilities")];
    const before = await p.evaluate(state);
    const opened4 = await tryOpenReviewed(p);
    expect("S4 both supported (after one earlier unsupported choice)", await p.evaluate(state), opened4,
      { ready: true, tab3Locked: false, readyShown: true, opened: true, equation: "Holds" });
    Object.assign(scenarios[scenarios.length - 1], { keyboardPicked: picked, stateBeforeOpening: before });
    await p.screenshot(path.join(SHOTS, "mockup-1280-reviewed.png"));

    // The choices live in step 2: return there (as a person must) before changing one.
    await p.evaluate(() => document.getElementById("tab-2").focus());
    await p.press("Home"); await p.press("ArrowRight");
    await choose(p, "4900", "Revenue");
    expect("S5 a supported decision changed to unsupported after reaching the reviewed state", await p.evaluate(state), await tryOpenReviewed(p),
      { ready: false, tab3Locked: true, readyShown: false, panel3Open: false, opened: false });

    await p.evaluate(() => document.getElementById("reset").focus());
    await p.press("Enter");
    expect("S6 reset returns to two held accounts", await p.evaluate(state), await tryOpenReviewed(p),
      { ready: false, tab3Locked: true, readyShown: false, opened: false, equation: "Pending", logEntries: 1 });

    results.mockup.regression = { allPass: scenarios.every((s) => s.pass), scenarios };
  }

  // ── Mockup: no-JavaScript fallback ──────────────────────────────────────────────────────────────────────────────
  for (const w of [320, 1280]) {
    const page = await (await browser.newContext()).newPage();
    await page.send("Emulation.setScriptExecutionDisabled", { value: true });
    await page.setViewport(w, w === 320 ? 720 : 900);
    await page.goto(MOCKUP);
    await sleep(400);
    results.mockup[`noJs${w}`] = {
      ...(await page.evaluate(() => ({
        jsClass: document.documentElement.classList.contains("js"),
        panelsVisible: ["panel-1", "panel-2", "panel-3"].map((id) => { const el = document.getElementById(id); return !el.hidden && el.getBoundingClientRect().height > 0; }),
        tablistHidden: getComputedStyle(document.querySelector('[role="tablist"]')).display === "none",
        mappedRows: document.querySelectorAll("#rows tr").length,
        heldCards: document.querySelectorAll(".held-card").length,
        radiosDisabled: [...document.querySelectorAll('.held-card input[type="radio"]')].every((r) => r.disabled),
        equation: document.getElementById("equation-state").textContent,
        readyShown: document.querySelector('[data-testid="ready-state"]').getBoundingClientRect().height > 0,
        label: document.querySelector('[data-testid="sample-label"]').innerText,
        reviewerNotesSeparate: !!document.querySelector('aside[data-testid="reviewer-notes"]') && !document.querySelector("main").innerText.includes("Reviewer notes"),
        totals: [...document.querySelectorAll(".totals dd")].map((d) => d.textContent),
      }))),
      layoutProblems: await page.evaluate(layoutProblems),
    };
    await page.screenshot(path.join(SHOTS, `mockup-nojs-${w}.png`));
  }

  // ── Live page: read-only measurements ───────────────────────────────────────────────────────────────────────────
  if (LIVE) {
    results.live = { origin: LIVE, reflow: {}, head: {}, keyboard: null };
    for (const [w, h] of WIDTHS) {
      const page = await (await browser.newContext()).newPage();
      await page.setViewport(w, h);
      await gotoLive(page, LIVE + "/");
      await page.waitForSelector("#hero-title", { timeout: 45000 });
      await sleep(2000);
      results.live.reflow[w] = {
        layoutProblems: await page.evaluate(layoutProblems),
        smallestText: await page.evaluate(smallestText),
        ...(await page.evaluate(() => {
          const img = document.querySelector('[data-testid="hero-screenshot"] img');
          const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), height: Math.round(b.height), text: e.innerText.trim().replace(/\s+/g, " "), href: e.getAttribute("href") }; };
          return { commitShaMarker: document.querySelector("[data-commit-sha]")?.getAttribute("data-commit-sha") ?? null,
            heroPrimary: r('[data-testid="hero-explore-plans"]'), heroSecondary: r('[data-testid="hero-view-plans"]'),
            heroImage: img && { renderedWidth: Math.round(img.getBoundingClientRect().width), naturalWidth: img.naturalWidth, scale: +(img.getBoundingClientRect().width / img.naturalWidth).toFixed(3) },
            planRows: [...document.querySelectorAll('[role="row"][data-mode]')].map((x) => `${x.dataset.mode} | ${x.querySelector('[data-testid^="plan-price-"]')?.innerText.replace(/\s+/g, " ") ?? ""}`) };
        })),
      };
      await page.screenshot(path.join(SHOTS, `live-${w}-hero.png`));
    }
    for (const route of ["/", "/plans", "/this-path-does-not-exist-404-probe"]) {
      const page = await (await browser.newContext()).newPage();
      await page.setViewport(1280, 900);
      await gotoLive(page, LIVE + route);
      await sleep(5000);
      results.live.head[route] = await page.evaluate(() => ({
        title: document.title,
        canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
        robots: document.querySelector('meta[name="robots"]')?.content ?? null,
        description: document.querySelector('meta[name="description"]')?.content ?? null,
        h1: [...document.querySelectorAll("h1")].map((h) => h.innerText.trim()),
      }));
    }
    {
      const page = await (await browser.newContext()).newPage();
      await page.setViewport(1280, 900);
      await gotoLive(page, LIVE + "/");
      await page.waitForSelector("#hero-title", { timeout: 45000 });
      await sleep(1500);
      const order = [];
      for (let i = 0; i < 12; i++) { await page.press("Tab"); order.push(await page.evaluate(focusInfo)); }
      results.live.keyboard = { tabOrder: order, everyFocusVisible: order.filter((f) => !f.endOfDocument).every((f) => f.visible), browserDefaultRingCount: order.filter((f) => f.browserDefaultRing).length };
    }
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
if (!results.mockup.regression?.allPass) { console.error("regression scenarios failed"); process.exit(1); }
