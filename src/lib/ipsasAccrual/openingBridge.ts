/**
 * IPSAS accrual opening bridge (charter R4, G3, L6; proposed spec §9). Pure, exact-integer, advisory: the server
 * (ipsas_save_preparation) recomputes the same identities before anything is stored.
 *
 * Four layers stay apart (spec §9): the figure PRINTED in the prior report, the confirmed interpretation of it, the
 * authorised bridge items, and the current opening. This module compares the first with the last through the third.
 * It never produces a balancing amount: an unexplained residual is returned as a blocker, not absorbed into a debtor,
 * suspense item or "other" line. An unconfirmed or missing figure is not zero.
 *
 * Amounts are signed minor units in the line's natural balance (assets positive). difference = opening − published.
 */
export const OPENING_BRIDGE_CONTRACT = "cfoclose-ipsas-opening-bridge/1";

export const BRIDGE_KINDS = ["reclassification", "prior-period-error", "policy-transition", "scope-change", "posted-journal"] as const;
export type BridgeKind = (typeof BRIDGE_KINDS)[number];

export type PublishedClosing = { lineId: string; label: string; amountMinor: string | null; locator: string; confirmed: boolean };
export type OpeningFact = { lineId: string; label: string; amountMinor: string | null; source: "prior-tb-closing" | "current-tb-opening" | "register" | ""; reference: string };
export type BridgeItem = { id: string; groupId: string; lineId: string; kind: BridgeKind | ""; amountMinor: string; evidenceRef: string; authorityReference: string };

export type BridgeLineStatus = "agrees" | "bridged" | "unexplained" | "published-unconfirmed" | "published-missing" | "opening-missing";
export type BridgeLine = {
  lineId: string;
  label: string;
  publishedMinor: string | null;
  openingMinor: string | null;
  differenceMinor: string | null;
  bridgedMinor: string;
  /** difference − bridged; null while a side is unknown. Never absorbed. */
  residualMinor: string | null;
  status: BridgeLineStatus;
};
export type BridgeBlocker = { code: string; lineId: string | null; message: string };
export type BridgeResult = {
  state: "agrees" | "bridged" | "blocked";
  lines: BridgeLine[];
  itemProblems: string[];
  blockers: BridgeBlocker[];
};

const EXACT = /^(0|-?[1-9][0-9]{0,30})$/;
const exact = (v: string | null | undefined): bigint | null => (typeof v === "string" && EXACT.test(v) ? BigInt(v) : null);
const text = (v: string | null | undefined) => typeof v === "string" && v.trim().length >= 3;

export function computeOpeningBridge(published: readonly PublishedClosing[], openings: readonly OpeningFact[], items: readonly BridgeItem[]): BridgeResult {
  const itemProblems: string[] = [];
  const blockers: BridgeBlocker[] = [];
  const pub = new Map<string, PublishedClosing>();
  const open = new Map<string, OpeningFact>();
  for (const p of published) { if (pub.has(p.lineId)) itemProblems.push(`Published line ${p.lineId} appears twice.`); pub.set(p.lineId, p); }
  for (const o of openings) { if (open.has(o.lineId)) itemProblems.push(`Opening line ${o.lineId} appears twice.`); open.set(o.lineId, o); }

  const ids = new Set<string>();
  const byLine = new Map<string, bigint>();
  const groups = new Map<string, { lines: Set<string>; total: bigint }>();
  for (const it of items) {
    if (!text(it.id) || ids.has(it.id)) { itemProblems.push(`Bridge item ${it.id || "(unnamed)"} needs a unique identity.`); continue; }
    ids.add(it.id);
    const amount = exact(it.amountMinor);
    if (amount === null || amount === 0n) { itemProblems.push(`Bridge item ${it.id} needs an exact non-zero amount.`); continue; }
    if (!(BRIDGE_KINDS as readonly string[]).includes(it.kind)) { itemProblems.push(`Bridge item ${it.id} needs a kind (${BRIDGE_KINDS.join(", ")}).`); continue; }
    if (!text(it.evidenceRef)) itemProblems.push(`Bridge item ${it.id} needs the evidence that supports it (journal, restatement note, scope document).`);
    if (!text(it.authorityReference)) itemProblems.push(`Bridge item ${it.id} needs its authority (who approved the entry or restatement, and where it is recorded).`);
    if (!pub.has(it.lineId) && !open.has(it.lineId)) { itemProblems.push(`Bridge item ${it.id} names a line (${it.lineId}) that is in neither the prior report nor the opening.`); continue; }
    byLine.set(it.lineId, (byLine.get(it.lineId) ?? 0n) + amount);
    if (it.kind === "reclassification") {
      if (!text(it.groupId)) { itemProblems.push(`Reclassification ${it.id} needs a group so its two sides can be matched.`); continue; }
      const g = groups.get(it.groupId) ?? { lines: new Set<string>(), total: 0n };
      g.lines.add(it.lineId); g.total += amount; groups.set(it.groupId, g);
    }
  }
  // A reclassification moves an amount between lines: it must net to zero across lines of its group.
  for (const [groupId, g] of groups) {
    if (g.total !== 0n) itemProblems.push(`Reclassification group ${groupId} does not net to zero (${g.total}); a reclassification cannot create or remove an amount.`);
    if (g.lines.size < 2) itemProblems.push(`Reclassification group ${groupId} touches only one line; it needs both sides.`);
  }

  const lineIds = [...new Set([...pub.keys(), ...open.keys()])].sort();
  const lines: BridgeLine[] = lineIds.map((lineId) => {
    const p = pub.get(lineId), o = open.get(lineId);
    const label = (p?.label || o?.label || lineId).trim();
    const published = p?.confirmed ? exact(p.amountMinor) : null;
    const opening = o ? exact(o.amountMinor) : null;
    const bridged = byLine.get(lineId) ?? 0n;
    let status: BridgeLineStatus;
    let difference: bigint | null = null, residual: bigint | null = null;
    if (!p || exact(p.amountMinor) === null) { status = "published-missing"; blockers.push({ code: "PUBLISHED_FIGURE_MISSING", lineId, message: `The prior report figure for "${label}" is not recorded. Capture it from the prior report (page-linked), or confirm it as nil there; it is never assumed to be zero.` }); }
    else if (!p.confirmed) { status = "published-unconfirmed"; blockers.push({ code: "PUBLISHED_FIGURE_UNCONFIRMED", lineId, message: `Confirm the prior report figure for "${label}" against its page before it is compared with the opening.` }); }
    else if (!o || opening === null) { status = "opening-missing"; blockers.push({ code: "OPENING_FIGURE_MISSING", lineId, message: `No opening figure is recorded for "${label}". An absent opening is not zero; supply it from the prior trial balance, the current opening or a register.` }); }
    else {
      difference = opening - published!;
      residual = difference - bridged;
      if (residual === 0n) status = difference === 0n ? "agrees" : "bridged";
      else { status = "unexplained"; blockers.push({ code: "OPENING_RESIDUAL_UNEXPLAINED", lineId, message: `"${label}" opens ${residual > 0n ? "above" : "below"} the prior report by ${residual < 0n ? -residual : residual} (minor units) with no evidenced bridge item. Add the journal, restatement or error correction that explains it, or correct the opening source. No balancing entry is created.` }); }
    }
    return { lineId, label, publishedMinor: published === null ? null : published.toString(), openingMinor: opening === null ? null : opening.toString(), differenceMinor: difference === null ? null : difference.toString(), bridgedMinor: bridged.toString(), residualMinor: residual === null ? null : residual.toString(), status };
  });
  const state: BridgeResult["state"] = blockers.length || itemProblems.length ? "blocked" : lines.length && lines.every((l) => l.status === "agrees") ? "agrees" : lines.length ? "bridged" : "blocked";
  if (!lines.length) blockers.push({ code: "NO_OPENING_LINES", lineId: null, message: "No prior report figures or opening balances have been recorded." });
  return { state, lines, itemProblems, blockers };
}
