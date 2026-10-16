#!/usr/bin/env node
// Launch-acceptance QA — DRIVER + PRIMITIVE smoke test (SYNTHETIC; NOT a real authenticated journey).
//
// Proves, on THIS host and today (no candidate needed), that:
//   1. the real CDP driver launches Chrome and round-trips goto / evaluate / setViewport / screenshot;
//   2. the pure checks (../checks.mjs) score a REAL extracted DOM — clean page → no signals; broken page → signals;
//   3. cdp.mjs newContext() genuinely ISOLATES localStorage between two identities (the primitive scenario 3 relies on),
//      verified against a real loopback HTTP origin (synthetic page; no production, no customer data).
//
// RUN: node research/launch-qa/harness/driverSmokeTest.mjs   (set CHROME_PATH if Chrome isn't auto-found)
// This is explicitly a MOCKED/SYNTHETIC check. It does not — and must not be read to — establish any of the 9 journeys.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchDriver } from "./cdpDriver.mjs";
import { focusOrderProblems, loadingErrorStateProblems, copyWordingProblems, primaryActionProblems } from "../checks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "artifacts");
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d)}` : ""}`); } };

// A well-formed synthetic page (clean) and, via ?broken=1, a deliberately-broken variant.
const PAGE = (broken) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic QA page</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui}main{max-width:100%;padding:12px}button{min-height:44px}
${broken ? ".wide{width:900px}.hid{position:absolute;left:-9999px}" : ""}</style></head>
<body><main>
<h1>Confirm the company and period, then upload your trial balance.</h1>
${broken ? '<div class="wide">overflow</div>' : ""}
<button id="primary" ${broken ? "" : 'data-primary="1"'}>Upload trial balance</button>
${broken ? '<button data-primary="1">Buy now</button>' : '<a href="#">Learn more</a>'}
<input id="named" ${broken ? "" : 'aria-label="Company name"'} />
<button class="${broken ? "hid" : ""}" ${broken ? "" : 'aria-label="Help"'}>${broken ? "" : "?"}</button>
<div id="status" role="status" aria-busy="true">${broken ? "" : "Processing your trial balance…"}</div>
<div id="err" role="alert">${broken ? "PGRST116: [object Object]" : ""}</div>
<p id="copy">${broken ? "Running SAFISHA; statements certified and ready to file." : "We'll show the detected structure for you to confirm. Nothing is assumed."}</p>
</main></body></html>`;

// Extract observations from the live DOM exactly as a real scenario would (runs IN the page via evaluate).
const EXTRACT = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0 && r.left > -1000; };
  const focusables = [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]")];
  const sequence = focusables.map((el, i) => ({ label: el.getAttribute("aria-label") || el.textContent.trim() || el.id, role: el.tagName.toLowerCase(), visible: vis(el), tabindex: el.hasAttribute("tabindex") ? Number(el.getAttribute("tabindex")) : undefined, interactive: true, domOrder: i }));
  const status = document.getElementById("status");
  const err = document.getElementById("err");
  const errText = err ? err.textContent.trim() : "";
  const viewState = errText ? { phase: "error", errorMessage: errText, nextAction: document.querySelector("#err a") ? "retry" : "" } : { phase: "loading", hasBusyIndicator: !!status, ariaBusy: status?.getAttribute("aria-busy") === "true" };
  const ctas = [...document.querySelectorAll("button,a")].map((el) => ({ label: el.textContent.trim(), primary: el.getAttribute("data-primary") === "1" }));
  const copy = document.getElementById("copy")?.textContent.trim() || "";
  return { sequence, viewState, ctas, copy, layoutWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
};

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(PAGE(req.url.includes("broken=1"))); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  let driver;
  try { driver = await launchDriver({ baseUrl: base, headless: true }); }
  catch (e) { console.log(`  DRIVER-UNAVAILABLE  could not launch Chrome on this host: ${String(e.message).split("\n")[0]}`); console.log("  (The driver is WIRED; execution needs a launchable Chrome. Reported as an environment limitation, not a pass.)"); server.close(); process.exit(3); }

  try {
    // (1) + (2) clean page: driver round-trips; checks find no signals.
    const { page } = await driver.newIdentity();
    await page.setViewport(320, 720);
    await page.goto(`${base}/clean`);
    const clean = await page.evaluate(EXTRACT);
    await page.screenshot(path.join(ART, "synthetic-clean-320.png"));
    check("driver round-trips goto + evaluate (extracted a focusable sequence)", Array.isArray(clean.sequence) && clean.sequence.length >= 3, { n: clean.sequence?.length });
    check("clean synthetic page: no focus signals", focusOrderProblems(clean.sequence).length === 0, focusOrderProblems(clean.sequence));
    check("clean synthetic page: no loading/error signals", loadingErrorStateProblems(clean.viewState).length === 0, clean.viewState);
    check("clean synthetic page: no wording signals", copyWordingProblems(clean.copy).length === 0, copyWordingProblems(clean.copy));
    check("clean synthetic page: exactly one primary CTA", primaryActionProblems(clean.ctas).length === 0, clean.ctas);
    check("no horizontal overflow at 320px (layoutWidth <= innerWidth)", clean.layoutWidth <= clean.innerWidth + 1, { layoutWidth: clean.layoutWidth, innerWidth: clean.innerWidth });

    // (2 negative) broken page: the SAME checks, via the real driver, catch real DOM issues.
    const broken = await page.evaluate((html) => { document.open(); document.write(html); document.close(); return null; }, PAGE(true)) ?? await page.evaluate(EXTRACT);
    const b = await page.evaluate(EXTRACT);
    check("broken synthetic page: focus signal raised (hidden/unlabelled control)", focusOrderProblems(b.sequence).length > 0);
    check("broken synthetic page: error-leakage signal raised ([object Object]/PGRST)", loadingErrorStateProblems(b.viewState).length > 0, b.viewState);
    check("broken synthetic page: wording signals raised (codename + unsupported/premature claim)", copyWordingProblems(b.copy).length >= 2, copyWordingProblems(b.copy));
    check("broken synthetic page: competing-primary-CTA signal raised", primaryActionProblems(b.ctas).length > 0, b.ctas);
    await page.screenshot(path.join(ART, "synthetic-broken.png"));

    // (3) context isolation: identity A writes localStorage; identity B (fresh context) must not see it.
    const A = await driver.newIdentity(); await A.page.goto(`${base}/a`);
    await A.page.evaluate(() => localStorage.setItem("qa-draft", "A-secret"));
    const B = await driver.newIdentity(); await B.page.goto(`${base}/b`);
    const leaked = await B.page.evaluate(() => localStorage.getItem("qa-draft"));
    check("newContext() isolates localStorage between identities (no cross-user leakage of a draft)", leaked === null, { leaked });
  } finally {
    await driver.close(); server.close();
  }

  console.log(`\n${pass}/${pass + fail} SYNTHETIC driver+primitive smoke checks passed.  (MOCKED — not one of the 9 journeys.)`);
  console.log(`Screenshots: research/launch-qa/artifacts/. Real journeys remain PENDING a candidate + isolated preview.`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("SMOKE ERROR:", e.message); process.exit(2); });
