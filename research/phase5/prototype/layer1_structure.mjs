// Phase 5 prototype — LAYER 1: export structure recognition (isolated adapter).
//
// Mirrors the production recognition surface (read-only; not imported):
//   - tbIngestion.ts COLUMN_MATCHERS / ColumnRole: header text -> {account_code, account_name, debit, credit, balance}.
//   - tbIngestion.ts DIMENSION_HEADER: cost centre / branch / fund / … columns captured as dimensions.
//   - auditedAccountsAdapter.ts isAuditedAccountsFormat(): SCI + SFP sheets => an audited-accounts export (not a flat TB).
//   - There is NO vendor/brand export detector in production; recognition is STRUCTURAL only. This mirror is the same.
//
// LAYER DISCIPLINE: recognising columns/structure is NOT approving any accounting treatment. This layer only answers
// "can we read this as a supported trial balance, and what are the columns?" — it never classifies an account.

const COLUMN_MATCHERS = {
  account_code: (s) => s === "code" || s.startsWith("a/c") || (s.startsWith("gl") && s.includes("code")) ||
    (s.startsWith("acc") && s.includes("code")) ||
    (s.startsWith("account") && (s.includes("code") || s.includes("number") || /\bno\.?$/.test(s))),
  account_name: (s) => s === "name" || s === "description" || s === "particulars" || s === "account" ||
    (s.startsWith("account") && (s.includes("name") || s.includes("description") || s.includes("title"))),
  debit: (s) => /\bdebits?\b/.test(s) || /^dr\b\.?/.test(s),
  credit: (s) => /\bcredits?\b/.test(s) || /^cr\b\.?/.test(s),
  balance: (s) => s.startsWith("amount") || s.startsWith("net amount") || /\bbalance\b/.test(s),
};
const DIMENSION_HEADER = /\b(cost ?cent(re|er)s?|department|dept|branch|location|division|fund|project|segment|region|site|programme|program|donor|business unit|profit cent(re|er)s?|sub-?ledger|activity|grant)\b/;
const ROLE_ORDER = ["account_code", "debit", "credit", "account_name", "balance"];
const headerText = (s) => String(s ?? "").toLowerCase().replace(/ /g, " ").replace(/\s+/g, " ").trim();

/**
 * Recognise supported structure from header cells. Returns { kind, columnMap, issues }.
 *   kind: "flat_tb" (code/name + debit/credit or balance) | "unrecognised".
 * Amount shape required: (debit AND credit) OR a single balance column — mirrors validateProfile's rule.
 */
export function recogniseStructure(headers) {
  const norm = headers.map(headerText);
  const map = { account_code: null, account_name: null, debit: null, credit: null, balance: null, dimensions: [] };
  const issues = [];
  for (const role of ROLE_ORDER) {
    const idx = norm.findIndex((h, i) => map[role] == null && !Object.values(map).includes(i) && COLUMN_MATCHERS[role](h));
    if (idx >= 0) map[role] = idx;
  }
  norm.forEach((h, i) => { if (!Object.values(map).flat().includes(i) && DIMENSION_HEADER.test(h)) map.dimensions.push(i); });

  if (map.account_code == null && map.account_name == null) issues.push({ code: "MISSING_COLUMN", field: "account", severity: "blocking" });
  const hasPair = map.debit != null && map.credit != null;
  const hasBalance = map.balance != null;
  if (!hasPair && !hasBalance) issues.push({ code: "MISSING_COLUMN", field: "amount", severity: "blocking" });
  const kind = issues.length === 0 ? "flat_tb" : "unrecognised";
  return { kind, columnMap: map, issues };
}

/** Read recognised rows into synthetic ingested accounts. Amounts are integer minor units (bigint in production). */
export function readAccounts(headers, dataRows) {
  const { kind, columnMap, issues } = recogniseStructure(headers);
  if (kind !== "flat_tb") return { kind, columnMap, issues, accounts: [] };
  const dimHeaders = columnMap.dimensions.map((i) => headerText(headers[i]));
  const accounts = dataRows.map((cells) => {
    const dims = {};
    columnMap.dimensions.forEach((ci, k) => { const v = cells[ci]; if (v != null && String(v).trim() !== "") dims[dimHeaders[k]] = String(v).trim(); });
    const n = (i) => (i == null ? 0 : Math.round(Number(cells[i] || 0)));
    const debitMinor = columnMap.debit != null ? n(columnMap.debit) : Math.max(0, n(columnMap.balance));
    const creditMinor = columnMap.credit != null ? n(columnMap.credit) : Math.max(0, -n(columnMap.balance));
    return {
      account_code: columnMap.account_code != null ? (String(cells[columnMap.account_code] ?? "").trim() || null) : null,
      account_name: columnMap.account_name != null ? String(cells[columnMap.account_name] ?? "").trim() : "",
      dimensions: dims,
      debitMinor,
      creditMinor,
    };
  });
  return { kind, columnMap, issues, accounts };
}
