#!/usr/bin/env node
// NON-PRODUCTION browser acceptance for the public landing page's sample review (src/components/landing/IllustrativeReview).
//
// Builds the app with a PLACEHOLDER backend (an unreachable loopback Supabase URL, so no data is read or written and
// plan prices fall back to the no-server state), serves the build with `vite preview` on loopback, and drives a headless
// Chrome/Edge (cdp.mjs) with real keyboard input at 320, 390 and 1280 px:
//   - layout: overflow, clipped actions, unlabelled fields (checks.mjs layoutProblems) with every region opened;
//   - keyboard and focus: tab order, a visible focus indicator at every stop, disclosures, the try toggle;
//   - announcements: polite live regions and the status text changing when a decision is recorded;
//   - behaviour: regression scenarios S0-S6 (only two evidence-supported recorded decisions show the ready state);
//   - the read-only completed example: never records a visitor decision, never shows a visitor decision;
//   - navigation: direct #sample and #completed-example loads, Back/Forward, and unsupported fragments;
//   - no JavaScript: what the page actually renders (it is a client-rendered React app).
// It writes results.json and screenshots to outDir and exits 1 if any check fails.
//
//   node scripts/browser-acceptance/landingSample.mjs [outDir]
//   env: CHROME_PATH, LANDING_PREVIEW_PORT (4318)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Browser } from "./cdp.mjs";
import { layoutProblems } from "./checks.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "landing-sample-evidence"));
const SHOTS = path.join(OUT, "screenshots");
const PORT = Number(process.env.LANDING_PREVIEW_PORT ?? 4318);
const URL0 = `http://127.0.0.1:${PORT}/`;
const PLACEHOLDER_BACKEND = "http://127.0.0.1:59999";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

const git = (...a) => { try { return execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim(); } catch { return null; } };
const results = {
  source: { commit: git("rev-parse", "HEAD"), uncommittedChanges: git("status", "--porcelain", "--", "src", "index.html", "public", "scripts/browser-acceptance") || "" },
  command: `node scripts/browser-acceptance/landingSample.mjs ${path.relative(REPO, OUT) || "."}`,
  environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, browser: null, backend: `placeholder (${PLACEHOLDER_BACKEND}, unreachable)`, url: URL0 },
  checks: [],
};
const check = (group, name, ok, detail) => {
  results.checks.push({ group, name, ok: !!ok, detail: ok ? undefined : detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${group}] ${name}${ok ? "" : `\n        ${JSON.stringify(detail).slice(0, 600)}`}`);
};

// ── in-page helpers (serialised into the page) ───────────────────────────────────────────────────────────────────
function smallestText(rootSel) {
  let min = Infinity, where = null;
  const root = document.querySelector(rootSel) ?? document.body;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (el.closest(".sr-only, [hidden], script, style")) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || cs.display === "none") continue;
    const f = parseFloat(cs.fontSize);
    if (f < min) { min = f; where = n.textContent.trim().slice(0, 40); }
  }
  return { px: min, text: where };
}
function focusInfo() {
  const el = document.activeElement;
  if (!el || el === document.body) return { el: "body", endOfDocument: true };
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle === "auto" || (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2);
  const ring = cs.boxShadow && cs.boxShadow !== "none";
  return { el: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.dataset.testid ? `[${el.dataset.testid}]` : ""), label: (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40), visible: !!(outline || ring) };
}
const sampleState = () => ({
  lead: document.querySelector('[data-testid="lead-status"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
  status: document.querySelector('[data-testid="pending-status"]')?.textContent ?? null,
  readyShown: !document.querySelector('[data-testid="ready-state"]')?.hidden,
  equation: document.querySelector('[data-testid="equation-state"]')?.textContent ?? null,
  logEntries: document.querySelectorAll('[data-testid="decision-log"] li').length,
  outcomes: ["2100", "4800"].map((c) => document.querySelector(`[data-testid="outcome-${c}"]`)?.textContent ?? null),
});
const viewState = () => {
  const s = document.getElementById("sample"), c = document.getElementById("completed-example");
  const inView = (el) => { if (!el || el.hidden) return false; const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  return { hash: location.hash, sampleShown: !!s && !s.hidden, completedShown: !!c && !c.hidden, sampleInView: inView(s), completedInView: inView(c),
    focus: document.activeElement?.id || null, h1: document.querySelector("h1")?.textContent ?? null,
    lead: document.querySelector('[data-testid="lead-status"]')?.textContent.replace(/\s+/g, " ").trim() ?? null };
};
const completedState = () => {
  const c = document.getElementById("completed-example");
  return { controls: c.querySelectorAll("input, select, textarea, button").length,
    rows: [...c.querySelectorAll('[data-testid="supplied-decisions"] tbody tr')].map((r) => r.innerText.replace(/\s+/g, " ").trim()),
    limitations: c.querySelectorAll('[data-testid="limitations"] li').length, namesVisitor: /Sample reviewer|\(you\)/.test(c.innerText) };
};

// ── build and serve ──────────────────────────────────────────────────────────────────────────────────────────────
process.env.VITE_SUPABASE_URL = PLACEHOLDER_BACKEND;
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = "local-placeholder";
process.env.VITE_SUPABASE_PROJECT_ID = "local";
const vite = await import(pathToFileURL(path.join(REPO, "node_modules/vite/dist/node/index.js")).href);
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "landing-sample-dist-"));
const emptyEnv = fs.mkdtempSync(path.join(os.tmpdir(), "landing-sample-env-"));
await vite.build({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), envDir: emptyEnv, logLevel: "error", build: { outDir: dist, emptyOutDir: true } });
const preview = await vite.preview({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), envDir: emptyEnv, logLevel: "error", build: { outDir: dist }, preview: { port: PORT, strictPort: true, host: "127.0.0.1" } });

const browser = await Browser.launch();
try { results.environment.browser = (await browser.send("Browser.getVersion")).product; } catch { /* optional */ }
const ready = async (p) => { await p.waitForText("From trial balance to review-ready accounts.", { timeout: 30000 }); await sleep(500); };
const open = async (url = URL0, w = 1280, h = 900) => { const p = await (await browser.newContext()).newPage(); await p.setViewport(w, h); await p.goto(url); await ready(p); return p; };
const OPTION = { "2100": ["Current Liabilities", "Non-Current Liabilities", "Equity"], "4800": ["Current Liabilities", "Other Income", "Revenue"] };
async function choose(p, code, value, record = true) {
  await p.evaluate((c) => document.querySelector(`input[name="decision-${c}"]`).focus(), code);
  await p.press(" ");
  for (let i = 0; i < OPTION[code].indexOf(value); i++) await p.press("ArrowDown");
  if (record) { await p.evaluate((c) => document.querySelector(`[data-testid="record-${c}"]`).focus(), code); await p.press("Enter"); }
  await sleep(80);
}
async function openTry(p) { await p.evaluate(() => document.querySelector('[data-testid="try-toggle"]').focus()); await p.press("Enter"); await sleep(120); }
const INITIAL_LEAD = "Balanced · 2 accounts need your review.";

try {
  // ── Layout at 320 / 390 / 1280, with screenshots ───────────────────────────────────────────────────────────────
  for (const [w, h] of [[320, 720], [390, 844], [1280, 900]]) {
    const p = await open(URL0, w, h);
    const hero = await p.evaluate(() => ({ img: !!document.querySelector('section[aria-labelledby="hero-title"] img'),
      actions: [...document.querySelectorAll('section[aria-labelledby="hero-title"] a')].map((a) => `${a.innerText.trim()} -> ${a.getAttribute("href")}`) }));
    check(`layout ${w}`, "hero: sample review first, plans second, no screenshot", !hero.img && hero.actions[0] === "See a sample review -> #sample" && hero.actions[1] === "View plans -> /plans", hero);
    const nav = await p.evaluate(() => [...document.querySelectorAll("header a, header button")].map((a) => (a.innerText || a.getAttribute("aria-label") || "").trim()).filter(Boolean));
    check(`layout ${w}`, "production navigation kept (incl. Sign in)", ["Product", "Plans", "Questions", "Expert help", "Sign in", "View plans"].every((n) => nav.includes(n)) || (w < 768 && nav.includes("Open menu")), nav);
    check(`layout ${w}`, "no layout problems on load", (await p.evaluate(layoutProblems)).length === 0, await p.evaluate(layoutProblems));
    await p.screenshot(path.join(SHOTS, `${w}-hero.png`));
    await p.evaluate(() => document.getElementById("sample").scrollIntoView({ block: "start" })); await sleep(200);
    const small = await p.evaluate(smallestText, "#sample");
    check(`layout ${w}`, "sample text is at least 12 px", small.px >= 12, small);
    await p.screenshot(path.join(SHOTS, `${w}-sample.png`));
    await p.evaluate(() => document.querySelectorAll("#sample details").forEach((d) => { d.open = true; })); await sleep(150);
    check(`layout ${w}`, "no layout problems with disclosures open", (await p.evaluate(layoutProblems)).length === 0, await p.evaluate(layoutProblems));
    await p.evaluate(() => document.querySelector('[data-testid="checks-disclosure"]').scrollIntoView({ block: "start" })); await sleep(150);
    await p.screenshot(path.join(SHOTS, `${w}-details.png`));
    await p.evaluate(() => document.querySelectorAll("#sample details").forEach((d) => { d.open = false; }));
    await openTry(p);
    check(`layout ${w}`, "no layout problems with the try region open", (await p.evaluate(layoutProblems)).length === 0, await p.evaluate(layoutProblems));
    await p.evaluate(() => document.querySelector('[data-testid="held-2100"]').scrollIntoView({ block: "start" })); await sleep(150);
    await p.screenshot(path.join(SHOTS, `${w}-try.png`));
    await p.evaluate(() => { location.hash = "#completed-example"; }); await sleep(300);
    await p.evaluate(() => document.activeElement?.blur());
    check(`layout ${w}`, "no layout problems in the completed example", (await p.evaluate(layoutProblems)).length === 0, await p.evaluate(layoutProblems));
    const csmall = await p.evaluate(smallestText, "#completed-example");
    check(`layout ${w}`, "completed-example text is at least 12 px", csmall.px >= 12, csmall);
    await p.evaluate(() => window.scrollTo(0, document.getElementById("completed-example").getBoundingClientRect().top + scrollY - 60)); await sleep(150);
    await p.screenshot(path.join(SHOTS, `${w}-completed.png`));
    check(`layout ${w}`, "no console errors", p.consoleErrors.length === 0, p.consoleErrors);
  }

  // ── Keyboard, focus, disclosures, announcements ────────────────────────────────────────────────────────────────
  {
    const p = await open();
    const order = [];
    for (let i = 0; i < 16; i++) { await p.press("Tab"); order.push(await p.evaluate(focusInfo)); }
    results.tabOrder = order;
    check("keyboard", "every tab stop shows a visible focus indicator", order.filter((f) => !f.endOfDocument).every((f) => f.visible), order.filter((f) => !f.visible));
    const ids = order.map((f) => f.el);
    const at = (s) => ids.findIndex((e) => e.includes(s));
    check("keyboard", "order: header, then See a sample review, View plans, View completed example, Try, Checks, All accounts",
      at("hero-sample") > 0 && at("hero-sample") < at("hero-view-plans") && at("hero-view-plans") < at("view-completed") && at("view-completed") < at("try-toggle"), ids);
    await p.evaluate(() => document.querySelector('[data-testid="checks-disclosure"] summary').focus());
    await p.press("Enter"); await sleep(80);
    check("keyboard", "Enter opens a disclosure; its summary shows focus", await p.evaluate(() => document.querySelector('[data-testid="checks-disclosure"]').open) && (await p.evaluate(focusInfo)).visible, null);
    await openTry(p);
    const t = await p.evaluate(() => ({ expanded: document.querySelector('[data-testid="try-toggle"]').getAttribute("aria-expanded"), controls: document.querySelector('[data-testid="try-toggle"]').getAttribute("aria-controls"), shown: !document.getElementById("try-region").hidden, focus: document.activeElement.id }));
    check("keyboard", "try toggle: aria-expanded true, aria-controls set, focus moves to the region heading", t.expanded === "true" && t.controls === "try-region" && t.shown && t.focus === "try-title", t);
    await p.evaluate(() => document.querySelector('input[name="decision-2100"]').focus());
    check("keyboard", "radio focus is visible", (await p.evaluate(focusInfo)).visible, null);
    const live = await p.evaluate(() => ({ lead: document.querySelector('[data-testid="lead-status"]').getAttribute("aria-live"), status: document.querySelector('[data-testid="pending-status"]').getAttribute("role"), outcome: document.querySelector('[data-testid="outcome-2100"]').getAttribute("aria-live") }));
    check("announcements", "lead and outcomes are polite live regions; the status is role=status", live.lead === "polite" && live.status === "status" && live.outcome === "polite", live);
    const before = (await p.evaluate(sampleState)).status;
    await choose(p, "2100", "Current Liabilities");
    const after = await p.evaluate(sampleState);
    check("announcements", "recording a decision changes the announced status and outcome", before !== after.status && after.outcomes[0].startsWith("Recorded: Current Liabilities"), { before, after: after.status, outcome: after.outcomes[0] });
    const labels = await p.evaluate(() => ["2100", "4800"].map((c) => document.querySelector(`[data-testid="held-${c}"] fieldset [data-testid="guided-label-${c}"]`)?.textContent ?? null));
    check("labels", "guided-example label inside both sets of choices", labels.every((l) => l === "Guided example—not automated evidence checking."), labels);
  }

  // ── Behaviour: regression scenarios (keyboard only) ────────────────────────────────────────────────────────────
  {
    const scen = (name, s, want) => check("scenario", name, Object.entries(want).every(([k, v]) => s[k] === v), { want, got: s });
    let p = await open(); await openTry(p);
    scen("S0 nothing decided: no ready state, equation pending", await p.evaluate(sampleState), { readyShown: false, equation: "Pending", lead: INITIAL_LEAD });
    await choose(p, "2100", "Current Liabilities");
    scen("S1 one supported recorded, one unresolved", await p.evaluate(sampleState), { readyShown: false, equation: "Pending" });
    p = await open(); await openTry(p);
    await choose(p, "2100", "Current Liabilities", false); await choose(p, "4800", "Current Liabilities", false);
    scen("S1b both selected but not recorded", await p.evaluate(sampleState), { readyShown: false, equation: "Pending", logEntries: 0 });
    p = await open(); await openTry(p);
    await choose(p, "2100", "Equity"); await choose(p, "4800", "Other Income");
    scen("S2 both recorded, both unsupported", await p.evaluate(sampleState), { readyShown: false, equation: "Holds" });
    p = await open(); await openTry(p);
    await choose(p, "2100", "Current Liabilities"); await choose(p, "4800", "Revenue");
    scen("S3 one supported, one unsupported", await p.evaluate(sampleState), { readyShown: false, equation: "Holds" });
    p = await open(); await openTry(p);
    await choose(p, "2100", "Non-Current Liabilities"); await choose(p, "2100", "Current Liabilities"); await choose(p, "4800", "Current Liabilities");
    scen("S4 both supported: ready state shown, 3 ordered entries", await p.evaluate(sampleState), { readyShown: true, equation: "Holds", logEntries: 3 });
    await p.evaluate(() => document.querySelector('[data-testid="ready-state"]').scrollIntoView({ block: "center" })); await sleep(120);
    await p.screenshot(path.join(SHOTS, "1280-ready.png"));
    await choose(p, "4800", "Revenue");
    scen("S5 reverted to unsupported after the ready state", await p.evaluate(sampleState), { readyShown: false });
    await p.evaluate(() => document.querySelector('[data-testid="reset"]').focus()); await p.press("Enter"); await sleep(100);
    scen("S6 reset clears status, equation and log", await p.evaluate(sampleState), { readyShown: false, equation: "Pending", logEntries: 0, lead: INITIAL_LEAD });
    check("scenario", "S6 reset clears the radios", await p.evaluate(() => !document.querySelector('input[name^="decision-"]:checked')), null);
  }

  // ── Completed example: read-only and isolated ──────────────────────────────────────────────────────────────────
  {
    let p = await open();
    await p.evaluate(() => document.querySelector('[data-testid="view-completed"]').focus()); await p.press("Enter"); await sleep(400);
    const v = await p.evaluate(viewState), c = await p.evaluate(completedState);
    check("completed", "C1 opens by keyboard, replaces the sample, focus on its heading", v.hash === "#completed-example" && v.completedShown && !v.sampleShown && v.focus === "completed-title", v);
    check("completed", "C1 no recording control inside", c.controls === 0, c.controls);
    check("completed", "C1 two supplied decisions, each with the invented reviewer and time", c.rows.length === 2 && c.rows.every((r) => r.includes("Example reviewer (invented) · 14 Oct 2026")), c.rows);
    check("completed", "C1 four limitations; the visitor is never named", c.limitations === 4 && !c.namesVisitor, c);
    await p.evaluate(() => history.back()); await sleep(400);
    await openTry(p);
    const s = await p.evaluate(sampleState);
    check("completed", "C2 viewing it recorded nothing for the visitor", s.logEntries === 0 && !s.readyShown && s.equation === "Pending" && s.lead === INITIAL_LEAD, s);
    p = await open(); await openTry(p);
    await choose(p, "2100", "Equity");
    await p.evaluate(() => { location.hash = "#completed-example"; }); await sleep(300);
    const c3 = await p.evaluate(completedState);
    check("completed", "C3 a visitor's decision never appears in the supplied example", c3.rows.every((r) => !r.includes("Equity")) && c3.rows[0].includes("Current Liabilities") && !c3.namesVisitor, c3.rows);
    await p.evaluate(() => { location.hash = "#sample"; }); await sleep(300);
    const s3 = await p.evaluate(sampleState);
    check("completed", "C3 the visitor's decision survives the round trip", s3.logEntries === 1 && s3.outcomes[0].startsWith("Recorded: Equity"), s3);
  }

  // ── Navigation: direct fragments, Back/Forward, unsupported fragments ──────────────────────────────────────────
  {
    let p = await open(`${URL0}#sample`);
    let v = await p.evaluate(viewState);
    check("navigation", "N1 direct /#sample: the sample shows, in view, the completed example hidden", v.sampleShown && !v.completedShown && v.sampleInView && v.lead === INITIAL_LEAD, v);
    p = await open(`${URL0}#completed-example`); await sleep(300);
    v = await p.evaluate(viewState);
    check("navigation", "N2 direct /#completed-example: the completed example shows, in view, with focus on its heading; the sample hidden", v.completedShown && !v.sampleShown && v.completedInView && v.focus === "completed-title", v);
    await p.screenshot(path.join(SHOTS, "1280-direct-completed.png"));

    p = await open();
    await p.evaluate(() => document.querySelector('[data-testid="view-completed"]').focus()); await p.press("Enter"); await sleep(300);
    const steps = [await p.evaluate(viewState)];
    await p.evaluate(() => history.back()); await sleep(300); steps.push(await p.evaluate(viewState));
    await p.evaluate(() => history.forward()); await sleep(300); steps.push(await p.evaluate(viewState));
    await p.evaluate(() => document.querySelector('[data-testid="back-to-sample"]').focus()); await p.press("Enter"); await sleep(300); steps.push(await p.evaluate(viewState));
    await p.evaluate(() => history.back()); await sleep(300); steps.push(await p.evaluate(viewState));
    const shown = steps.map((s) => (s.completedShown && !s.sampleShown ? "completed" : s.sampleShown && !s.completedShown ? "sample" : "INVALID"));
    results.backForward = steps.map((s, i) => ({ step: ["View completed example", "Back", "Forward", "Back to the sample (link)", "Back"][i], hash: s.hash, shown: shown[i], focus: s.focus }));
    check("navigation", "N3 View completed → Back → Forward → 'Back to the sample' → Back shows completed, sample, completed, sample, completed",
      JSON.stringify(shown) === JSON.stringify(["completed", "sample", "completed", "sample", "completed"]), results.backForward);
    check("navigation", "N3 every step shows exactly one view (never both, never neither)", !shown.includes("INVALID"), results.backForward);

    p = await open(`${URL0}#completed-example`); await sleep(300);
    await p.evaluate(() => { location.hash = "#plans"; }); await sleep(400);
    const plans = await p.evaluate(() => { const r = document.getElementById("plans").getBoundingClientRect(); return { hash: location.hash, sampleShown: !document.getElementById("sample").hidden, completedShown: !document.getElementById("completed-example").hidden, plansTop: Math.round(r.top), viewport: innerHeight }; });
    check("navigation", "N5 from the completed example, #plans returns to the sample view and lands on the plans (not the sample)",
      plans.sampleShown && !plans.completedShown && plans.plansTop >= -5 && plans.plansTop < plans.viewport / 2, plans);

    for (const frag of ["#does-not-exist", "#completed-examplex", "#try-region", "#completed-title"]) {
      p = await open(`${URL0}${frag}`); await sleep(200);
      v = await p.evaluate(viewState);
      check("navigation", `N4 unsupported ${frag}: the sample shows with its status line; nothing blank or misleading`,
        v.sampleShown && !v.completedShown && v.lead === INITIAL_LEAD && v.h1 === "From trial balance to review-ready accounts.", v);
    }
  }

  // ── No JavaScript (recorded, not asserted as a fallback) ───────────────────────────────────────────────────────
  {
    const p = await (await browser.newContext()).newPage();
    await p.send("Emulation.setScriptExecutionDisabled", { value: true });
    await p.setViewport(390, 844);
    await p.goto(URL0); await sleep(800);
    results.noJavaScript = await p.evaluate(() => ({ title: document.title, rootChildren: document.getElementById("root")?.children.length ?? null, bodyTextChars: document.body.innerText.trim().length, noscript: !!document.querySelector("noscript") }));
    results.noJavaScript.note = "The landing page is a client-rendered React app: without JavaScript it renders no visible content. Search engines receive the head metadata and the static JSON-LD in index.html.";
    await p.screenshot(path.join(SHOTS, "390-nojs.png"));
  }
} finally {
  await browser.close();
  await new Promise((r) => preview.httpServer.close(r));
}

results.summary = { passed: results.checks.filter((c) => c.ok).length, failed: results.checks.filter((c) => !c.ok).length };
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`\nchecks: ${results.checks.length}   passed: ${results.summary.passed}   failed: ${results.summary.failed}`);
process.exit(results.summary.failed ? 1 : 0);
