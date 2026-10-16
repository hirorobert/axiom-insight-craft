// Evidence runner for the landing review. Uses the repository's own headless-Chrome driver (scripts/browser-acceptance).
// Usage (repository root): node research/landing-review/evidence/run-checks.mjs [--live-origin https://cfoclose.com] [--no-live]
// Writes research/landing-review/evidence/results.json and screenshots under research/landing-review/evidence/screenshots/.
//
// Mockup checks: reflow at 320 / 390 / 1280, keyboard order with visible focus, regression scenarios (an unresolved or
// unsupported treatment never reaches the illustrated ready state; decisions made by keyboard only), and the no-JavaScript
// static fallback, plus the read-only completed-example route. Exits 1 if any regression or route check fails. Live checks are READ-ONLY: navigation, measurement and screenshots;
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
  // ── Mockup: reflow, and customer-view screenshots (reviewer notes stay collapsed) ──────────────────────────────
  results.mockup.reflow = {};
  for (const [w, h] of WIDTHS) {
    const page = await (await browser.newContext()).newPage();
    await page.setViewport(w, h);
    await page.goto(MOCKUP);
    await page.waitForSelector("#sample-title");
    const m = await page.evaluate(() => ({ cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
      reviewerNotesOpen: document.querySelector('[data-testid="reviewer-notes"]').open }));
    results.mockup.reflow[w] = { layoutProblems: await page.evaluate(layoutProblems), smallestText: await page.evaluate(smallestText), ...m,
      consoleErrors: page.consoleErrors, networkRequests: page.requests.filter((u) => !u.startsWith("file:") && !u.startsWith("data:")) };
    if (w === 320) continue; // 320 is a reflow check; customer screenshots are taken at 390 and desktop width
    await page.screenshot(path.join(SHOTS, `mockup-${w}-top.png`));
    await page.evaluate(() => document.getElementById("sample").scrollIntoView({ block: "start" }));
    await sleep(150);
    await page.screenshot(path.join(SHOTS, `mockup-${w}-sample.png`));
    await page.evaluate(() => document.getElementById("try-toggle").click());
    await page.evaluate(() => document.getElementById("held-2100").scrollIntoView({ block: "start" }));
    await sleep(150);
    results.mockup.reflow[w].tryOpen = { layoutProblems: await page.evaluate(layoutProblems) };
    await page.screenshot(path.join(SHOTS, `mockup-${w}-try.png`));
    await page.evaluate(() => { location.hash = "#completed-example"; });
    await sleep(250);
    await page.evaluate(() => window.scrollTo(0, document.getElementById("completed-example").offsetTop));
    await sleep(150);
    results.mockup.reflow[w].completed = { layoutProblems: await page.evaluate(layoutProblems) };
    await page.evaluate(() => document.activeElement?.blur()); // customer view as a pointer user sees it (keyboard focus is checked separately)
    await page.screenshot(path.join(SHOTS, `mockup-${w}-completed.png`));
  }

  // ── Mockup: keyboard order and visible focus ────────────────────────────────────────────────────────────────────
  {
    const page = await (await browser.newContext()).newPage();
    await page.setViewport(1280, 900);
    await page.goto(MOCKUP);
    await page.waitForSelector("#sample-title");
    const order = [];
    for (let i = 0; i < 14; i++) { await page.press("Tab"); order.push(await page.evaluate(focusInfo)); }
    const k = { tabOrder: order, everyFocusVisible: order.filter((f) => !f.endOfDocument).every((f) => f.visible) };
    // Disclosures open with the keyboard and expose state.
    await page.evaluate(() => document.querySelector('[data-testid="checks-disclosure"] summary').focus());
    await page.press("Enter");
    k.checksDisclosureOpensByKeyboard = await page.evaluate(() => document.querySelector('[data-testid="checks-disclosure"]').open);
    await page.evaluate(() => document.getElementById("try-toggle").focus());
    await page.press("Enter");
    k.tryToggle = await page.evaluate(() => ({ expanded: document.getElementById("try-toggle").getAttribute("aria-expanded"), regionShown: !document.getElementById("try-region").hidden, focus: document.activeElement.id }));
    await page.evaluate(() => document.querySelector('input[name="d-2100"]').focus());
    k.radioFocus = await page.evaluate(focusInfo);
    k.guidedLabelsAdjacent = await page.evaluate(() => ["2100", "4900"].map((c) => {
      const fs = document.querySelector(`#held-${c} fieldset`), label = document.querySelector(`[data-testid="guided-label-${c}"]`);
      return !!label && fs.contains(label) && label.textContent === "Guided example—not automated evidence checking." && label.getBoundingClientRect().height > 0;
    }));
    k.status = await page.evaluate(() => { const s = document.getElementById("pending-pill"); return { role: s.getAttribute("role"), live: s.getAttribute("aria-live") }; });
    results.mockup.keyboard = k;
  }

  // ── Mockup: regression scenarios (decisions made by keyboard only) ──────────────────────────────────────────────
  // An unresolved, unrecorded or unsupported treatment must never produce the illustrated ready state.
  const state = () => ({
    ready: window.__sample.ready(),
    readyShown: !document.querySelector('[data-testid="ready-state"]').hidden,
    equation: document.getElementById("equation-state").textContent,
    lead: document.getElementById("lead-status").textContent.replace(/\s+/g, " ").trim(),
    status: document.getElementById("pending-pill").textContent,
    outcomes: [document.getElementById("out-2100").textContent, document.getElementById("out-4900").textContent],
    visitorDecisions: window.__sample.decisionCount(),
    logEntries: document.querySelectorAll("#log li").length,
  });
  const OPTION = { "2100": ["Current Liabilities", "Non-Current Liabilities", "Equity"], "4900": ["Current Liabilities", "Other Income", "Revenue"] };
  // Keyboard only: focus the group's first radio, Space checks it, ArrowDown moves the selection, then Enter on "Record decision".
  async function choose(page, code, value, record = true) {
    const idx = OPTION[code].indexOf(value);
    await page.evaluate((c) => document.querySelector(`input[name="d-${c}"]`).focus(), code);
    await page.press(" ");
    for (let i = 0; i < idx; i++) await page.press("ArrowDown");
    const selected = await page.evaluate((c) => document.querySelector(`input[name="d-${c}"]:checked`)?.value ?? null, code);
    if (record) { await page.evaluate((c) => document.querySelector(`[data-record="${c}"]`).focus(), code); await page.press("Enter"); }
    return selected;
  }
  const fresh = async () => {
    const p = await (await browser.newContext()).newPage(); await p.setViewport(1280, 900); await p.goto(MOCKUP); await p.waitForSelector("#sample-title");
    await p.evaluate(() => document.getElementById("try-toggle").focus()); await p.press("Enter"); return p;
  };
  const scenarios = [];
  const expect = (name, s, want, extra = {}) => {
    const failures = [];
    for (const [key, val] of Object.entries(want)) if (s[key] !== val) failures.push(`${key}: expected ${JSON.stringify(val)}, got ${JSON.stringify(s[key])}`);
    scenarios.push({ name, pass: failures.length === 0, failures, state: s, ...extra });
  };
  {
    let p = await fresh();
    expect("S0 initial: both held, nothing decided", await p.evaluate(state),
      { ready: false, readyShown: false, equation: "Pending", lead: "Balanced · 2 accounts need your review." });

    p = await fresh();
    await choose(p, "2100", "Current Liabilities");
    expect("S1 one supported decision, one unresolved", await p.evaluate(state), { ready: false, readyShown: false, equation: "Pending" });

    p = await fresh();
    await choose(p, "2100", "Current Liabilities", false); await choose(p, "4900", "Current Liabilities", false);
    expect("S1b both supported treatments selected but not recorded", await p.evaluate(state), { ready: false, readyShown: false, equation: "Pending", logEntries: 0 });

    p = await fresh();
    await choose(p, "2100", "Equity"); await choose(p, "4900", "Other Income");
    expect("S2 both recorded, both unsupported", await p.evaluate(state), { ready: false, readyShown: false, equation: "Holds" });

    p = await fresh();
    await choose(p, "2100", "Current Liabilities"); await choose(p, "4900", "Revenue");
    expect("S3 one supported, one unsupported", await p.evaluate(state), { ready: false, readyShown: false, equation: "Holds" });

    p = await fresh();
    const picked = [await choose(p, "2100", "Non-Current Liabilities"), await choose(p, "2100", "Current Liabilities"), await choose(p, "4900", "Current Liabilities")];
    expect("S4 both supported (after one earlier unsupported decision)", await p.evaluate(state), { ready: true, readyShown: true, equation: "Holds", logEntries: 3 }, { keyboardPicked: picked });
    await choose(p, "4900", "Revenue");
    expect("S5 a supported decision changed to unsupported after the ready state", await p.evaluate(state), { ready: false, readyShown: false });
    await p.evaluate(() => document.getElementById("reset").focus()); await p.press("Enter");
    expect("S6 reset returns to two held accounts", await p.evaluate(state), { ready: false, readyShown: false, equation: "Pending", logEntries: 0, visitorDecisions: 0 });
  }

  // ── Mockup: completed-example route (read-only; viewing never records a visitor decision) ───────────────────────
  {
    const completedState = () => {
      const c = document.getElementById("completed-example");
      return {
        hash: location.hash,
        completedShown: !c.hidden, sampleShown: !document.getElementById("sample").hidden,
        focusOnHeading: document.activeElement?.id === "completed-title",
        controlsInside: c.querySelectorAll("input, select, textarea, button, [data-record]").length,
        suppliedRows: [...c.querySelectorAll('[data-testid="supplied-decisions"] tbody tr')].map((r) => r.innerText.replace(/\s+/g, " ").trim()),
        limitations: c.querySelectorAll('[data-testid="limitations"] li').length,
        mentionsVisitor: /\(you\)|Sample reviewer/.test(c.innerText),
        label: c.querySelector(".tag")?.innerText ?? null,
      };
    };
    const routeChecks = [];
    const check = (name, ok, detail) => routeChecks.push({ name, pass: !!ok, detail });

    // C1: open by keyboard from the sample; read-only; supplied decisions with who and when; limitations stated.
    let p = await (await browser.newContext()).newPage(); await p.setViewport(1280, 900); await p.goto(MOCKUP); await p.waitForSelector("#sample-title");
    await p.evaluate(() => document.getElementById("view-completed").focus()); await p.press("Enter"); await sleep(250);
    const c1 = await p.evaluate(completedState);
    check("C1 route opens read-only view by keyboard", c1.hash === "#completed-example" && c1.completedShown && !c1.sampleShown && c1.focusOnHeading, c1);
    check("C1 no recording controls inside the completed view", c1.controlsInside === 0, c1.controlsInside);
    check("C1 two supplied decisions, each with who and when", c1.suppliedRows.length === 2 && c1.suppliedRows.every((r) => /Example reviewer \(invented\) · 14 Oct 2026/.test(r)), c1.suppliedRows);
    check("C1 remaining limitations and invented-data label", c1.limitations >= 3 && c1.label === "Illustrative example — invented data", { limitations: c1.limitations, label: c1.label });
    check("C1 the completed view never names the visitor", !c1.mentionsVisitor, c1.mentionsVisitor);

    // C2: returning leaves the visitor's sample untouched (viewing recorded nothing).
    await p.evaluate(() => history.back()); await sleep(300);
    const c2 = await p.evaluate(state);
    const c2shown = await p.evaluate(() => ({ sampleShown: !document.getElementById("sample").hidden, completedShown: !document.getElementById("completed-example").hidden }));
    check("C2 back returns to the sample", c2shown.sampleShown && !c2shown.completedShown, c2shown);
    check("C2 viewing recorded no visitor decision", c2.visitorDecisions === 0 && c2.logEntries === 0 && !c2.ready && c2.equation === "Pending" && c2.lead === "Balanced · 2 accounts need your review.", c2);

    // C3: a visitor's own (unsupported) decision never appears in the supplied example, and survives the round trip.
    p = await fresh();
    await choose(p, "2100", "Equity");
    await p.evaluate(() => { location.hash = "#completed-example"; }); await sleep(250);
    const c3 = await p.evaluate(completedState);
    check("C3 supplied decisions unaffected by the visitor's decision", c3.suppliedRows.every((r) => !/Equity/.test(r)) && /Director current account.*Current Liabilities/.test(c3.suppliedRows[0]) && !c3.mentionsVisitor, c3.suppliedRows);
    await p.evaluate(() => { location.hash = "#sample"; }); await sleep(250);
    const c3b = await p.evaluate(state);
    check("C3 the visitor's own decision is still theirs after returning", c3b.visitorDecisions === 1 && c3b.logEntries === 1 && !c3b.ready, c3b);

    results.mockup.completedRoute = { allPass: routeChecks.every((c) => c.pass), checks: routeChecks };
  }
  results.mockup.regression = { allPass: scenarios.every((s) => s.pass), scenarios };

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
        lead: document.getElementById("lead-status").textContent.replace(/\s+/g, " ").trim(),
        disclosuresPresent: document.querySelectorAll("details.more").length,
        tryRegionShown: document.getElementById("try-region").getBoundingClientRect().height > 0,
        radiosDisabled: [...document.querySelectorAll('.held-card input[type="radio"]')].every((r) => r.disabled),
        guidedLabels: document.querySelectorAll(".guided").length,
        completedShown: document.getElementById("completed-example").getBoundingClientRect().height > 0,
        readyShown: document.querySelector('[data-testid="ready-state"]').getBoundingClientRect().height > 0,
        equation: document.getElementById("equation-state").textContent,
        label: document.querySelector('[data-testid="sample-label"]').innerText,
        reviewerNotesCollapsed: !document.querySelector('[data-testid="reviewer-notes"]').open,
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
if (!results.mockup.regression?.allPass || !results.mockup.completedRoute?.allPass) { console.error("regression or completed-route checks failed"); process.exit(1); }
