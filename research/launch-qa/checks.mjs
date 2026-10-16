// Launch-acceptance QA — PURE checks (no DOM, no network). These add the coverage the existing suites do NOT have:
// keyboard/focus order, loading/error-state legibility, and a preview/production guard for the live harness. They are
// deterministic functions a live-DOM harness (or a unit test) feeds observations into; they never claim a UI scenario
// passed by themselves. Existing coverage is referenced, not duplicated (see ACCEPTANCE-PLAN.md).
//
// SCREENING AIDS, NOT VERDICTS: every "problem" these return is a SIGNAL that a human must confirm in context — never an
// automatic customer-facing defect. A displayed number, or a word like "exception" in otherwise-fine copy, must NOT be
// treated as a defect on its own; that is why the generic 5xx/"exception" auto-flags were removed and the remaining error
// patterns are limited to unambiguous internal leakage (`[object Object]`, `PGRST…`, `SQLSTATE`, `TypeError`, "stack trace").
// A real defect is recorded only after manual confirmation on the live candidate (see REPORT.md).

const PRODUCTION_PROJECT_REF = "bvyivmmfjejbmqoydezk"; // mirrors scripts/ci/stagingGuard.mjs; QA must never touch production

/**
 * Guard a target URL for the live harness: QA runs ONLY against a non-production preview/loopback. Returns a problem string
 * or null. Never performs I/O. (Mirrors the repository's staging-guard intent; does not import or modify it.)
 */
export function productionTargetProblem(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "no target URL (set LAUNCH_QA_BASE_URL to a non-production preview)";
  let u;
  try { u = new URL(rawUrl); } catch { return `target URL is not a valid URL: ${rawUrl}`; }
  if (rawUrl.includes(PRODUCTION_PROJECT_REF)) return "REFUSED: target references the production project ref";
  if (!/^https?:$/.test(u.protocol)) return `REFUSED: unsupported protocol ${u.protocol}`;
  return null; // a preview/loopback/staging host is acceptable; the caller still asserts it is an authorised preview
}

/**
 * Keyboard / focus-order problems for ONE ordered sequence of focusable things, as observed in the live DOM.
 * Each item: { label?: string, role?: string, visible: boolean, tabindex?: number, interactive: boolean, domOrder: number }.
 * Flags the well-known a11y defects the existing suites don't cover.
 */
export function focusOrderProblems(sequence) {
  const problems = [];
  if (!Array.isArray(sequence) || sequence.length === 0) return ["no focusable sequence captured"];
  sequence.forEach((el, i) => {
    const where = el.label || el.role || `item ${i}`;
    if (typeof el.tabindex === "number" && el.tabindex > 0) problems.push(`positive tabindex (${el.tabindex}) on "${where}" — breaks natural order`);
    if (el.visible === false && el.interactive) problems.push(`focusable but not visible: "${where}" (focus trap / hidden control)`);
    if (el.interactive && (!el.label || String(el.label).trim() === "")) problems.push(`interactive control with no accessible label: "${where}"`);
  });
  // Focus order must follow DOM order (proxy for reading/visual order): the captured tab sequence's domOrder is monotonic.
  for (let i = 1; i < sequence.length; i++) {
    if (typeof sequence[i].domOrder === "number" && typeof sequence[i - 1].domOrder === "number" && sequence[i].domOrder < sequence[i - 1].domOrder) {
      problems.push(`focus order does not follow DOM order at "${sequence[i].label || i}" (jumps backwards)`);
    }
  }
  return problems;
}

/**
 * Loading / error-state legibility for ONE observed view state.
 * state: { phase: "loading"|"error"|"ready", hasBusyIndicator?: boolean, ariaBusy?: boolean, errorMessage?: string,
 *          errorIsActionable?: boolean, nextAction?: string }.
 * A loading view must SHOW it is busy; an error must be a legible, actionable message with one next step — never a blank
 * screen, a raw provider error, or a dead end.
 */
export function loadingErrorStateProblems(state) {
  const problems = [];
  if (!state || !state.phase) return ["no view state captured"];
  if (state.phase === "loading") {
    if (!state.hasBusyIndicator && !state.ariaBusy) problems.push("loading state shows no busy indicator (spinner/skeleton) or aria-busy");
  }
  if (state.phase === "error") {
    const msg = (state.errorMessage || "").trim();
    if (msg === "") problems.push("error state has no message");
    // Unambiguous internal leakage only (manual confirmation still required). Generic tokens like a bare number or the word
    // "exception" are intentionally NOT auto-flagged — they produce false positives and are not defects on their own.
    if (/\[object Object\]|PGRST\d+|SQLSTATE|TypeError|stack trace/i.test(msg)) problems.push(`SIGNAL (confirm manually): error message may expose a raw/internal error: "${msg.slice(0, 80)}"`);
    if (state.errorIsActionable === false || !(state.nextAction && String(state.nextAction).trim() !== "")) problems.push("SIGNAL (confirm manually): error state offers no actionable next step");
  }
  return problems;
}

/**
 * Customer-wording problems for ONE user-facing string (scenario 9 / the "no premature Phase-6 claims" part of 7).
 * Complements the existing src/content/publicClaimRegistry.test.ts + accountReviewBrand.test.ts — it does not replace them;
 * it is the launch-QA lens applied to candidate copy captured from the live app.
 * Flags internal engine codenames and unsupported certification/compliance claims surfaced to the user.
 */
const CODENAMES = /\b(SAFISHA|HESABU|KINGA|MAONO|SAFF)\b/;
const UNSUPPORTED_CLAIMS = /\b(certified|certification|guarantee[ds]?|guaranteed|fully compliant|compliance guaranteed|audited by us|TRA[- ]approved|government[- ]approved|legally approved)\b/i;
const PREMATURE_FEATURE = /\b(financial statements? (generated|ready|complete)|filing (submitted|complete)|XBRL (generated|filed)|statements? certified)\b/i;
export function copyWordingProblems(text, { context = "copy" } = {}) {
  const problems = [];
  if (typeof text !== "string" || text.trim() === "") return problems;
  if (CODENAMES.test(text)) problems.push(`[${context}] exposes an internal engine codename: "${text.match(CODENAMES)[0]}"`);
  if (UNSUPPORTED_CLAIMS.test(text)) problems.push(`[${context}] unsupported certification/compliance claim: "${text.match(UNSUPPORTED_CLAIMS)[0]}"`);
  if (PREMATURE_FEATURE.test(text)) problems.push(`[${context}] claims a not-yet-available (Phase 6) feature works: "${text.match(PREMATURE_FEATURE)[0]}"`);
  return problems;
}

/**
 * One-clear-next-action check for a screen's set of PRIMARY calls-to-action. ctas: array of { label, primary: boolean }.
 * A customer screen should present exactly one dominant next action (mirrors the WorkspaceOverview single-CTA invariant).
 */
export function primaryActionProblems(ctas) {
  const primaries = (ctas || []).filter((c) => c && c.primary);
  if (primaries.length === 0) return ["screen has no primary next action"];
  if (primaries.length > 1) return [`screen has ${primaries.length} competing primary actions: ${primaries.map((c) => c.label).join(", ")}`];
  return [];
}
