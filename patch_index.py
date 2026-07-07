"""
patch_index.py — apply sentinel-row filter patches to process-trial-balance/index.ts
Run from the repo root: python patch_index.py
"""
import sys, pathlib

TARGET = pathlib.Path("supabase/functions/process-trial-balance/index.ts")

if not TARGET.exists():
    sys.exit(f"ERROR: {TARGET} not found. Run from repo root.")

src = TARGET.read_bytes().decode("utf-8").replace("\r\n", "\n")

# ── PATCH 1: expand SUBTOTAL_ROW_PATTERNS ─────────────────────────────────
OLD1 = (
    "/** Accounts that represent total/subtotal rows — stripped during parsing */\n"
    "const SUBTOTAL_ROW_PATTERNS = [\n"
    "  /^total/i, /^sub[- ]?total/i, /^grand[- ]?total/i, /^sum/i,\n"
    "  /total$/i, /^net\\s+(assets|liabilities|equity|income|profit)/i,\n"
    "];"
)
NEW1 = (
    "/** Accounts that represent total/subtotal rows — stripped during parsing */\n"
    "const SUBTOTAL_ROW_PATTERNS = [\n"
    "  /^total/i, /^sub[- ]?total/i, /^grand[- ]?total/i, /^sum/i,\n"
    "  /total$/i, /^net\\s+(assets|liabilities|equity|income|profit)/i,\n"
    "  // Sentinel / integrity-check rows common in Tanzanian TB exports\n"
    "  /^balance\\s*check/i, /^check\\s*figure/i, /^proof\\s*of\\s*(balance|total)/i,\n"
    "  /must\\s*be\\s*zero/i, /^difference/i, /^variance/i,\n"
    "];"
)

# ── PATCH 2: zero-debit-zero-credit guard before accounts.push() ──────────
OLD2 = (
    "    accounts.push({ account_code: code, account_name: name || code, "
    "debit, credit, balance, source_row_number: i });"
)
NEW2 = (
    "    // Skip pure-zero sentinel rows (debit = credit = 0 AND balance = 0).\n"
    "    // Real accounts can have zero balance but always have at least one posting.\n"
    "    // A row with zeros across all three columns is a check/total sentinel row.\n"
    "    if (debit === 0 && credit === 0 && balance === 0) continue;\n\n"
    "    accounts.push({ account_code: code, account_name: name || code, "
    "debit, credit, balance, source_row_number: i });"
)

ok = True

if OLD1 not in src:
    if NEW1 in src:
        print("PATCH 1: already applied — skipping")
    else:
        print("ERROR: PATCH 1 old-string not found and new-string not present either")
        ok = False
else:
    src = src.replace(OLD1, NEW1, 1)
    print("PATCH 1: applied")

if OLD2 not in src:
    if "debit === 0 && credit === 0 && balance === 0" in src:
        print("PATCH 2: already applied — skipping")
    else:
        print("ERROR: PATCH 2 old-string not found and guard not present either")
        ok = False
else:
    src = src.replace(OLD2, NEW2, 1)
    print("PATCH 2: applied")

if not ok:
    sys.exit("Patches failed — file not written. Check output above.")

# Write with LF endings
TARGET.write_bytes(src.encode("utf-8"))

lines = src.count("\n")
size  = len(src.encode("utf-8"))
print(f"\nFile written: {size} bytes, ~{lines} lines")
print("Tail (last 8 lines):")
for l in src.splitlines()[-8:]:
    print(" ", l)

print("\nNext steps:")
print("  git add supabase/functions/process-trial-balance/index.ts")
print('  git commit -m "fix(parser): filter sentinel rows — SUBTOTAL_ROW_PATTERNS + zero guard')
print()
print("  PART 5 reconstruction defect: BALANCE CHECK (must be zero) in Kamanga Medics v4")
print("  survived to needs_review because SUBTOTAL_ROW_PATTERNS had no sentinel patterns.")
print()
print("  Fix 1: expand SUBTOTAL_ROW_PATTERNS with 6 patterns covering Tanzanian TB sentinels.")
print("  Fix 2: zero-debit-zero-credit guard in rowsToRawAccounts — belt-and-suspenders.")
print()
print("  Reconstructed-from-memory file. Source: session memory of approved code (b880173).")
print('  "')
print("  git push origin main")
print("  supabase functions deploy process-trial-balance --project-ref bvyivmmfjejbmqoydezk")
