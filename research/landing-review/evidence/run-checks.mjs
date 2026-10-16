// Evidence runner for the landing review. Uses the repository's own headless-Chrome driver (scripts/browser-acceptance).
// Usage (repository root): node research/landing-review/evidence/run-checks.mjs [--live-origin https://cfoclose.com] [--no-live]
// Writes research/landing-review/evidence/results.json and screenshots under research/landing-review/evidence/screenshots/.
//
// Mockup checks: reflow at 320 / 390 / 1280, keyboard order with visible focus, tab and status behaviour, decisions by
// keyboard, and the no-JavaScript static fallback. Live checks are READ-ONLY: navigation, measurement and screenshots;
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
    await page.evaluate(() => document.querySelector("tr[data-code='2100']").scrollIntoView({ block: "center" }));
    await sleep(150);
    await page.screenshot(path.join(SHOTS, `mockup-${w}-mapping.png`));
  }

  // ── Mockup: keyboard, focus, tabs, status ───────────────────────────────────────────────────────────────────────
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
    k.arrowRight = await page.evaluate(() => ({ focus: document.activeElement.id, selected: document.querySelector('[aria-selected="true"]').id, panel2: !document.getElementById("panel-2").hidden }));
    await page.press("ArrowRight");
    k.arrowToLocked = await page.evaluate(() => ({ focus: document.activeElement.id, ariaDisabled: document.getElementById("tab-3").getAttribute("aria-disabled"),
      describedBy: document.getElementById(document.getElementById("tab-3").getAttribute("aria-describedby"))?.textContent, panel3Hidden: document.getElementById("panel-3").hidden, panel2Visible: !document.getElementById("panel-2").hidden }));
    await page.press("Enter");
    k.enterOnLocked = await page.evaluate(() => ({ panel3Hidden: document.getElementById("panel-3").hidden }));
    k.status = await page.evaluate(() => { const s = document.getElementById("pending-pill"); return { role: s.getAttribute("role"), live: s.getAttribute("aria-live"), text: s.textContent }; });

    // Decisions by keyboard only: focus each select and press ArrowDown until a category is chosen.
    k.decisions = [];
    for (const id of ["sel-2100", "sel-4900"]) {
      await page.evaluate((s) => document.getElementById(s).focus(), id);
      const focus = await page.evaluate(focusInfo);
      for (let i = 0; i < 3; i++) await page.press("ArrowDown");
      k.decisions.push({ id, focusVisible: focus.visible, value: await page.evaluate((s) => document.getElementById(s).value, id), status: await page.evaluate(() => document.getElementById("pending-pill").textContent) });
    }
    k.afterDecisions = await page.evaluate(() => ({ tab3Disabled: document.getElementById("tab-3").getAttribute("aria-disabled") }));
    await page.evaluate(() => document.getElementById("tab-2").focus());
    await page.press("End");
    k.endOpensReviewed = await page.evaluate(() => ({ focus: document.activeElement.id, selected: document.querySelector('[aria-selected="true"]').id, panel3: !document.getElementById("panel-3").hidden,
      log: [...document.querySelectorAll("#log li")].map((l) => l.innerText.replace(/\s+/g, " ")) }));
    await page.screenshot(path.join(SHOTS, "mockup-1280-reviewed.png"));
    await page.press("Home");
    k.home = await page.evaluate(() => document.querySelector('[aria-selected="true"]').id);
    await page.evaluate(() => document.getElementById("tab-2").click());
    await page.evaluate(() => document.getElementById("reset").focus());
    k.resetFocus = await page.evaluate(focusInfo);
    await page.press("Enter");
    k.afterReset = await page.evaluate(() => ({ status: document.getElementById("pending-pill").textContent, tab3Disabled: document.getElementById("tab-3").getAttribute("aria-disabled"), focus: document.activeElement.id }));
    results.mockup.keyboard = k;
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
        rows: document.querySelectorAll("#rows tr").length,
        label: document.querySelector('[data-testid="sample-label"]').innerText,
        outstanding: document.querySelector('[data-testid="outstanding-note"]').innerText.slice(0, 60),
        selectsDisabled: [...document.querySelectorAll("#rows select")].every((s) => s.disabled),
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
