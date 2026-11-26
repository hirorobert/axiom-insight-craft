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

/**
 * Read recognised rows into synthetic ingested accounts.
 *
 * EXACT-MONEY: amounts are exact integer minor units carried as **BigInt** — never JS floats. Production stores
 * `bigint`/exact decimal strings and no float ever reaches the DB; this prototype mirrors that so a sign/relationship
 * comparison is exact at any magnitude (not merely correct below 2^53). `toMinorUnits` rejects a non-integer source value
 * rather than silently rounding money — a fractional minor-unit cell is a data defect, not something to guess around.
 */
export function toMinorUnits(v) {
  if (typeof v === "bigint") return v;
  if (v == null || v === "") return 0n;
  const s = String(v).trim();
  if (s === "") return 0n;
  if (!/^-?\d+$/.test(s)) {
    // Fixtures are authored in whole minor units; a non-integer here is an authoring/ingestion defect, surfaced not hidden.
    const num = Number(s);
    if (!Number.isFinite(num) || !Number.isInteger(num)) throw new Error(`NON_INTEGER_MINOR_UNIT: ${JSON.stringify(v)}`);
    return BigInt(num);
  }
  return BigInt(s);
}

export function readAccounts(headers, dataRows) {
  const { kind, columnMap, issues } = recogniseStructure(headers);
  if (kind !== "flat_tb") return { kind, columnMap, issues, accounts: [] };
  const dimHeaders = columnMap.dimensions.map((i) => headerText(headers[i]));
  const accounts = dataRows.map((cells) => {
    const dims = {};
    columnMap.dimensions.forEach((ci, k) => { const v = cells[ci]; if (v != null && String(v).trim() !== "") dims[dimHeaders[k]] = String(v).trim(); });
    const n = (i) => (i == null ? 0n : toMinorUnits(cells[i]));
    const bal = columnMap.balance != null ? n(columnMap.balance) : 0n;
    const debitMinor = columnMap.debit != null ? n(columnMap.debit) : (bal > 0n ? bal : 0n);
    const creditMinor = columnMap.credit != null ? n(columnMap.credit) : (bal < 0n ? -bal : 0n);
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
