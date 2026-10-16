// Phase 5 prototype — LAYER 3: accounting meaning (isolated adapter; DETERMINISTIC heuristics, honestly simulated).
//
// This is the INTERPRETATION layer. It PROPOSES meaning (proposal_type = "MACHINE_SUGGESTION"); it never approves one.
// In production the proposal_type/decision_action split already exists (buildReviewDecisions.ts). AI could augment this
// layer, but AI is architecturally DISABLED (ai_provider_settings seeded DISABLED; PROVIDER_DISABLED; data-minimized
// ai-sample/1 shape tokens only). Per the Phase 5 budget rule, NO model is called here — these are deterministic heuristics
// that stand in for what a reviewer-confirmed suggestion engine would produce.
//
// MUSE reference cases are used as SCOPED, UNVERIFIED-UNTIL-RECONCILED knowledge, expressed as UNCERTAINTY, never as global
// rules. No MUSE prefix is hard-coded. Nothing nets balances, invents a journal, or treats a net movement as cash flow.
import { accountKey, normalizeAccountName } from "./layer2_identity.mjs";

const KW = {
  revenue: ["sales", "revenue", "turnover", "fees earned", "grant income", "donation income", "interest income"],
  expense: ["expense", "wages", "salaries", "payroll", "rent", "utilities", "repairs", "depreciation", "amortisation", "cost of", "purchases"],
  asset: ["cash", "bank", "receivable", "debtor", "inventory", "stock", "prepayment", "equipment", "vehicle", "motor", "property", "plant", "machinery", "furniture", "fixture"],
  liability: ["payable", "creditor", "loan", "borrowing", "accrual", "provision", "overdraft", "deferred income", "tax payable", "vat"],
  equity: ["capital", "retained", "reserve", "accumulated surplus", "accumulated fund", "share", "drawings"],
};
// Generic fixed-asset-lifecycle qualifiers (NOT a MUSE-specific vocabulary). Used to RELATE accounts, never to net them.
const FAMILY_QUALIFIERS = [
  { role: "opening", re: /\b(opening|opening balance|brought forward|b\/?f|as at \d)\b/ },
  { role: "addition", re: /\b(addition|additions|acquisition|acquisitions|purchases of)\b/ },
  { role: "transfer", re: /\b(transfer|transfers|reclassification|reclass)\b/ },
  { role: "disposal", re: /\b(disposal|disposals|write[- ]?off)\b/ },
  { role: "depreciation", re: /\b(accumulated depreciation|depreciation charge|depreciation|amortisation)\b/ },
  { role: "cost", re: /\b(cost|gross carrying)\b/ },
];

const CONTRA_ASSET = /\baccumulated (depreciation|amortisation)\b|\bprovision for (depreciation|doubtful)\b/;
function natureOf(name) {
  const n = normalizeAccountName(name);
  // Contra-asset FIRST: "accumulated depreciation" keyword-collides with "depreciation" (expense) but is a balance-sheet
  // contra-asset. We return "asset" so it is not mis-booked to the income statement; its sign is flagged (see uncertainty).
  if (CONTRA_ASSET.test(n)) return "asset";
  for (const [nature, kws] of Object.entries(KW)) if (kws.some((k) => n.includes(normalizeAccountName(k)))) return nature;
  return "unknown";
}

/** Strip a trailing qualifier phrase to get a stem (e.g. "motor vehicles - additions" -> "motor vehicles"). */
function familyOf(name) {
  const n = normalizeAccountName(name);
  for (const q of FAMILY_QUALIFIERS) {
    if (q.re.test(n)) {
      const stem = n.replace(q.re, "").replace(/\b(cost|net|gross|account)\b/g, "").replace(/\s+/g, " ").trim();
      if (stem.length >= 3) return { stem, role: q.role };
    }
  }
  return null;
}

/**
 * Interpret a set of ingested accounts. Returns per-account meaning + proposed relationships + uncertainty.
 * Nothing is merged or netted: a relationship is advisory context only.
 */
export function interpretMeaning(accounts) {
  const byName = new Map();
  accounts.forEach((a) => { const k = normalizeAccountName(a.account_name); byName.set(k, (byName.get(k) || 0) + 1); });

  const meanings = accounts.map((a) => {
    const nature = natureOf(a.account_name);
    const fam = familyOf(a.account_name);
    const reasons = [];
    let level = "low";
    // Year-under-review vs carry-forward is SCOPED MUSE knowledge, surfaced as a proposal, not a verified fact.
    const temporal = nature === "revenue" || nature === "expense"
      ? { proposed: "period_under_review", verified: false, note: "Revenue/expense proposed as the year under review (scoped, unverified until reconciled)." }
      : nature === "unknown"
        ? { proposed: "unknown", verified: false }
        : { proposed: "carried_forward", verified: false, note: "Balance-sheet account proposed as carried forward (scoped, unverified)." };
    if (nature === "unknown") { level = "high"; reasons.push("No deterministic accounting meaning recognised — reviewer must classify."); }
    if (CONTRA_ASSET.test(normalizeAccountName(a.account_name))) { level = "high"; reasons.push("Contra-asset (e.g. accumulated depreciation): credit-normal and reduces the related asset; its sign/presentation is consequential — confirm individually, do not group."); }
    if (nature === "liability" && /payable|creditor|supplier/.test(normalizeAccountName(a.account_name))) {
      level = level === "high" ? "high" : "medium";
      reasons.push("Supplier/payable: the statement debit/credit perspective can differ from the entity's — confirm the sign (scoped MUSE knowledge).");
    }
    if (fam) reasons.push(`Part of a '${fam.stem}' lifecycle (${fam.role}); related to opening/addition/transfer/depreciation accounts — presented, never netted automatically.`);
    return { account_key: accountKey(a), account_name: a.account_name, account_code: a.account_code, nature, temporal, family: fam, uncertainty: { level, reasons }, proposal_type: nature === "unknown" ? "NONE" : "MACHINE_SUGGESTION" };
  });

  // Similar-description / distinct-code pairs: flagged as "confirm not a duplicate", NEVER merged (keys already differ).
  const nameGroups = new Map();
  accounts.forEach((a, i) => { const k = normalizeAccountName(a.account_name); if (!nameGroups.has(k)) nameGroups.set(k, []); nameGroups.get(k).push({ a, i }); });
  for (const [, grp] of nameGroups) {
    const codes = new Set(grp.map((g) => accountKey(g.a)));
    if (grp.length > 1 && codes.size > 1) {
      grp.forEach((g) => {
        const m = meanings[g.i];
        m.uncertainty.level = m.uncertainty.level === "high" ? "high" : "medium";
        m.uncertainty.reasons.push("Different code, similar description to another account — NOT treated as a duplicate; confirm they are distinct (scoped MUSE knowledge).");
      });
    }
  }

  // Relationship families (>=2 members sharing a stem) — advisory context for grouped review.
  const fams = new Map();
  meanings.forEach((m) => { if (m.family) { const s = m.family.stem; if (!fams.has(s)) fams.set(s, []); fams.get(s).push({ key: m.account_key, role: m.family.role }); } });
  const relationships = [...fams.entries()].filter(([, v]) => v.length >= 2)
    .map(([stem, members]) => ({ kind: "asset_lifecycle", stem, members, note: "Opening/addition/transfer/depreciation of the same asset class are related; movements are presented separately and never netted into one figure or a cash flow." }));

  return { meanings, relationships };
}
