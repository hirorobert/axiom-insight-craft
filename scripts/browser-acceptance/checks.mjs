// Pure checks for the staging browser-acceptance suite (unit-tested in src/lib/workspace/browserAcceptance.test.ts).

import { PRODUCTION_PROJECT_REF } from "../ci/stagingGuard.mjs";

/** Every observed request URL, classified. Any production reference, or any other Supabase project, is a failure. */
export function classifyRequests(urls, stagingRef) {
  const production = urls.filter((u) => typeof u === "string" && u.includes(PRODUCTION_PROJECT_REF));
  const otherSupabase = urls.filter((u) => {
    const m = typeof u === "string" && u.match(/^(?:https?|wss?):\/\/([a-z0-9]+)\.supabase\.(?:co|in)\b/i);
    return !!m && m[1] !== stagingRef;
  });
  const staging = urls.filter((u) => typeof u === "string" && u.includes(`${stagingRef}.supabase.co`));
  return { production, otherSupabase, staging };
}

/**
 * Runs INSIDE the page (serialized by Page.evaluate, so it must stay self-contained). Returns human-readable problems:
 *   - horizontal page overflow;
 *   - a visible button/link cut off by the viewport (elements inside an intentionally horizontally-scrollable
 *     container, such as the stage tab rail, are exempt);
 *   - a visible form field without an accessible name (a <label>, aria-label or aria-labelledby).
 */
export function layoutProblems() {
  const problems = [];
  const vw = window.innerWidth;
  const overflow = document.documentElement.scrollWidth - vw;
  if (overflow > 1) problems.push(`page overflows horizontally by ${overflow}px`);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll("button, a[href], [role=button]")) {
    if (!visible(el) || inScroller(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1) problems.push(`action clipped: "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"`);
  }
  for (const el of document.querySelectorAll("input, select, textarea, [role=combobox]")) {
    if (el.type === "hidden" || el.type === "file" || !visible(el)) continue;
    const named = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.getAttribute("aria-label")
      || el.getAttribute("aria-labelledby") || el.closest("label");
    if (!named) problems.push(`field without a label: ${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}`);
  }
  return problems;
}
