// Launch-acceptance QA — REAL browser driver adapter, wired on the repository's EXISTING dependency-free CDP tool
// (scripts/browser-acceptance/cdp.mjs). No new dependency, no edit to that shared file — it is imported read-only. Chrome is
// located by its own findChrome() (set CHROME_PATH to override).
//
// It exposes an isolated context per synthetic test identity (cdp.mjs newContext() = own cookies/localStorage/cache — the
// primitive scenario 3's no-leakage flow needs) and the observation primitives the scenarios feed into ../checks.mjs.
// The per-scenario journey steps (`scenarios[1..9]`) are intentionally NOT implemented here: they require the real app from a
// candidate + isolated preview (see ENVIRONMENT-REQUIREMENTS.md). Until then the harness reports them PENDING — never passed.
import { Browser, findChrome } from "../../../scripts/browser-acceptance/cdp.mjs";
import { productionTargetProblem } from "../checks.mjs";

export { findChrome };

/** Launch a real headless Chrome and return a driver. Refuses a production target. Caller must close(). */
export async function launchDriver({ baseUrl = "", headless = true } = {}) {
  if (baseUrl) { const g = productionTargetProblem(baseUrl); if (g) throw new Error(g); } // never drive production
  const browser = await Browser.launch({ headless });
  const contexts = [];
  return {
    baseUrl,
    browser,
    /** A fresh isolated identity (own cookies/localStorage) — one per synthetic user. */
    async newIdentity() { const ctx = await browser.newContext(); contexts.push(ctx); const page = await ctx.newPage(); return { ctx, page }; },
    // Journeys are wired when a candidate + preview exist; empty today so the harness honestly reports PENDING.
    scenarios: {},
    async close() { try { await browser.close(); } catch { /* already gone */ } },
  };
}
