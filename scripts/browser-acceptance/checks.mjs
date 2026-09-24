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
  // The LAYOUT width, never innerWidth: under mobile emulation innerWidth grows to fit overflowing content (a
  // 320px page 141px too wide reported innerWidth 461), which silently hid exactly the overflow this checks for.
  const vw = document.documentElement.clientWidth;
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

/**
 * Runs INSIDE the page. The workspace header at any width: the financial period is fully visible and inside the
 * viewport, nothing in the header overlaps (identity, period, refresh, account menu), and the refresh control is a
 * focusable button with a usable touch target. Returns problems; an absent header is a problem too.
 */
export function headerProblems() {
  const problems = [];
  const q = (s) => document.querySelector(s);
  const period = q('[data-testid="workspace-period"]');
  const refresh = q('[data-testid="workspace-refresh"]');
  const header = q("header");
  if (!header || !period || !refresh) return [`header parts missing (period=${!!period} refresh=${!!refresh})`];
  // The account menu button carries the signed-in email as its title.
  const menu = [...header.querySelectorAll("button")].find((b) => b !== refresh && (b.getAttribute("title") ?? "").includes("@"));
  const box = (el) => el.getBoundingClientRect();
  const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const p = box(period), r = box(refresh);
  if (p.width < 2 || p.height < 2) problems.push("financial period is not visible");
  if (p.left < -0.5 || p.right > document.documentElement.clientWidth + 0.5) problems.push("financial period is cut off by the viewport");
  if (period.scrollWidth > period.clientWidth + 1) problems.push("financial period text is truncated");
  if (overlap(p, r)) problems.push("financial period overlaps the refresh control");
  if (menu && overlap(p, box(menu))) problems.push("financial period overlaps the account menu");
  const identity = q('[data-testid="workspace-identity"]');
  if (identity && overlap(box(identity), r)) problems.push("workspace identity overlaps the refresh control");
  if (r.width < 32 || r.height < 32) problems.push(`refresh touch target too small (${Math.round(r.width)}x${Math.round(r.height)})`);
  if (refresh.tabIndex < 0 || refresh.disabled) problems.push("refresh is not keyboard reachable");
  if (!refresh.getAttribute("aria-label")) problems.push("refresh has no accessible name");
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!top || !(top === refresh || refresh.contains(top))) problems.push("refresh is covered at its centre");
  return problems;
}
