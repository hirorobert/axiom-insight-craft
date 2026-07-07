"""
patch_index2.py — extend process-trial-balance with:
  A. rejected_rows tracking (rejected_rows array in summary)
  B. balance_sheet_equation expanded with revenue_total / expenses_total / net_income / closing_equity
  C. Fix duplicate zero guard (applied twice by patch_index.py)

Run from repo root: python patch_index2.py
"""
import sys, pathlib

TARGET = pathlib.Path("supabase/functions/process-trial-balance/index.ts")

if not TARGET.exists():
    sys.exit(f"ERROR: {TARGET} not found. Run from repo root.")

src = TARGET.read_bytes().decode("utf-8").replace("\r\n", "\n")

patches = []

# ── PATCH A: rowsToRawAccounts return type ──────────────────────────────────
A_OLD = "): { accounts: RawAccount[]; errors: ValidationError[] } {"
A_NEW = "): { accounts: RawAccount[]; errors: ValidationError[]; rejectedRows: { account_name: string; account_code: string; reason: string }[] } {"
patches.append(("A: return type signature", A_OLD, A_NEW))

# ── PATCH B: initialize rejectedRows array ──────────────────────────────────
B_OLD = (
    "  const accounts: RawAccount[] = [];\n"
    "  const errors: ValidationError[] = [];\n"
    "  const dataStart = map.header_row + 1;"
)
B_NEW = (
    "  const accounts: RawAccount[] = [];\n"
    "  const errors: ValidationError[] = [];\n"
    "  const rejectedRows: { account_name: string; account_code: string; reason: string }[] = [];\n"
    "  const dataStart = map.header_row + 1;"
)
patches.append(("B: init rejectedRows", B_OLD, B_NEW))

# ── PATCH C: track isSubtotalRow rejection ──────────────────────────────────
C_OLD = "    if (isSubtotalRow(name, rawCode)) continue;"
C_NEW = (
    "    if (isSubtotalRow(name, rawCode)) {\n"
    "      rejectedRows.push({ account_name: name, account_code: rawCode, reason: \"Subtotal/total row — filtered during parsing\" });\n"
    "      continue;\n"
    "    }"
)
patches.append(("C: subtotal row rejection tracking", C_OLD, C_NEW))

# ── PATCH D: fix duplicate zero guard, add rejection tracking ────────────────
# The duplicate was inserted by patch_index.py running twice or idempotent miss.
D_OLD = (
    "    // Skip pure-zero sentinel rows (debit = credit = 0 AND balance = 0).\n"
    "    // Real accounts can have zero balance but always have at least one posting.\n"
    "    // A row with zeros across all three columns is a check/total sentinel row.\n"
    "    if (debit === 0 && credit === 0 && balance === 0) continue;\n"
    "\n"
    "    // Skip pure-zero sentinel rows (debit = credit = 0 AND balance = 0).\n"
    "    // Real accounts can have zero balance but always have at least one posting.\n"
    "    // A row with zeros across all three columns is a check/total sentinel row.\n"
    "    if (debit === 0 && credit === 0 && balance === 0) continue;"
)
D_NEW = (
    "    // Skip pure-zero sentinel rows (debit = credit = 0 AND balance = 0).\n"
    "    // Real accounts can have zero balance but always have at least one posting.\n"
    "    // A row with zeros across all three columns is a check/total sentinel row.\n"
    "    if (debit === 0 && credit === 0 && balance === 0) {\n"
    "      rejectedRows.push({ account_name: name, account_code: rawCode, reason: \"All-zero sentinel row (debit=0, credit=0, balance=0) — filtered during parsing\" });\n"
    "      continue;\n"
    "    }"
)
patches.append(("D: fix duplicate zero guard + track rejection", D_OLD, D_NEW))

# If the duplicate was NOT present, fall back to patching the single guard.
D_SINGLE_OLD = (
    "    // Skip pure-zero sentinel rows (debit = credit = 0 AND balance = 0).\n"
    "    // Real accounts can have zero balance but always have at least one posting.\n"
    "    // A row with zeros across all three columns is a check/total sentinel row.\n"
    "    if (debit === 0 && credit === 0 && balance === 0) continue;"
)
D_SINGLE_NEW = (
    "    // Skip pure-zero sentinel rows (debit = credit = 0 AND balance = 0).\n"
    "    // Real accounts can have zero balance but always have at least one posting.\n"
    "    // A row with zeros across all three columns is a check/total sentinel row.\n"
    "    if (debit === 0 && credit === 0 && balance === 0) {\n"
    "      rejectedRows.push({ account_name: name, account_code: rawCode, reason: \"All-zero sentinel row (debit=0, credit=0, balance=0) — filtered during parsing\" });\n"
    "      continue;\n"
    "    }"
)

# ── PATCH E: return rejectedRows ─────────────────────────────────────────────
E_OLD = "  return { accounts, errors };"
E_NEW = "  return { accounts, errors, rejectedRows };"
patches.append(("E: return rejectedRows", E_OLD, E_NEW))

# ── PATCH F: destructure rejectedRows at call site ───────────────────────────
F_OLD = "    const { accounts: rawAccounts } = rowsToRawAccounts(rawRows, colMap);"
F_NEW = "    const { accounts: rawAccounts, rejectedRows } = rowsToRawAccounts(rawRows, colMap);"
patches.append(("F: destructure rejectedRows at call site", F_OLD, F_NEW))

# ── PATCH G: expand balance_sheet_equation payload ───────────────────────────
G_OLD = "      balance_sheet_equation: { passed: bsPassed, assets: totals.assets, liabilities: totals.liabilities, equity: totals.equity, difference: bsDifference },"
G_NEW = "      balance_sheet_equation: { passed: bsPassed, assets: totals.assets, liabilities: totals.liabilities, equity: totals.equity, revenue_total: totals.revenue, expenses_total: totals.expenses, net_income: netIncome, closing_equity: closingEquity, difference: bsDifference },"
patches.append(("G: expand balance_sheet_equation payload", G_OLD, G_NEW))

# ── PATCH H: needs_review summary — add rejected_rows ───────────────────────
H_OLD = (
    "        summary: {\n"
    "          total_accounts:   rawAccounts.length,\n"
    "          processed_at:     new Date().toISOString(),\n"
    "          parser_version:   \"v2.2\",\n"
    "          columns_detected: detectedCols,\n"
    "          auto_classified:  autoClassifiedCount,\n"
    "        },"
)
H_NEW = (
    "        summary: {\n"
    "          total_accounts:   rawAccounts.length,\n"
    "          processed_at:     new Date().toISOString(),\n"
    "          parser_version:   \"v2.2\",\n"
    "          columns_detected: detectedCols,\n"
    "          auto_classified:  autoClassifiedCount,\n"
    "          rejected_rows:    rejectedRows,\n"
    "        },"
)
patches.append(("H: needs_review summary — add rejected_rows", H_OLD, H_NEW))

# ── PATCH I: processingResult.summary — add rejected_rows ────────────────────
I_OLD = (
    "      summary: {\n"
    "        total_accounts:    rawAccounts.length,\n"
    "        processed_at:      new Date().toISOString(),\n"
    "        parser_version:    \"v2.0\",\n"
    "        columns_detected:  detectedCols,\n"
    "        auto_classified:   autoClassifiedCount,\n"
    "      },"
)
I_NEW = (
    "      summary: {\n"
    "        total_accounts:    rawAccounts.length,\n"
    "        processed_at:      new Date().toISOString(),\n"
    "        parser_version:    \"v2.0\",\n"
    "        columns_detected:  detectedCols,\n"
    "        auto_classified:   autoClassifiedCount,\n"
    "        rejected_rows:     rejectedRows,\n"
    "      },"
)
patches.append(("I: processingResult.summary — add rejected_rows", I_OLD, I_NEW))

# ── Apply all patches ─────────────────────────────────────────────────────────
ok = True
for label, old, new in patches:
    if old not in src:
        # For patch D: try the single-guard fallback
        if label.startswith("D:"):
            if D_SINGLE_OLD in src:
                # Guard was not duplicated — patch the single occurrence
                if D_SINGLE_NEW in src:
                    print(f"D (single guard): already applied — skipping")
                else:
                    src = src.replace(D_SINGLE_OLD, D_SINGLE_NEW, 1)
                    print(f"D (single guard): applied (no duplicate found)")
            elif "rejectedRows.push" in src and "All-zero sentinel" in src:
                print(f"D: already applied — skipping")
            else:
                print(f"ERROR: PATCH {label} — old-string not found")
                ok = False
        elif new in src:
            print(f"PATCH {label}: already applied — skipping")
        else:
            print(f"ERROR: PATCH {label} — old-string not found and new-string not present")
            ok = False
    else:
        count = src.count(old)
        if count > 1:
            print(f"WARNING: PATCH {label} — old-string appears {count}x; replacing first only")
        src = src.replace(old, new, 1)
        print(f"PATCH {label}: applied")

if not ok:
    sys.exit("\nOne or more patches failed — file NOT written. Review errors above.")

# Write with LF endings
TARGET.write_bytes(src.encode("utf-8"))

lines = src.count("\n")
size  = len(src.encode("utf-8"))
print(f"\nFile written: {size} bytes, ~{lines} lines")
print("\nTail (last 10 lines):")
for l in src.splitlines()[-10:]:
    print(" ", l)

print("""
Next: Rule 11 checks before commit
  1. deno check supabase/functions/process-trial-balance/index.ts
  2. Verify tail ends at `});` (shown above)
  3. Share deno output here — STOP before commit until confirmed.
""")
