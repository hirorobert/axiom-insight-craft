# Kinga Universal Trial Balance Ingestion — Iron Dome Architecture
**Version:** 1.0  
**Date:** 2026-06-26  
**Status:** Phase 3 Design

---

## Problem

The current design assumes every client's accounts have already been manually mapped to Kinga classifications before the engine runs.

This breaks for three reasons:
1. **QuickBooks exports GFS codes** — these are government finance classification codes that mean nothing outside public-sector accounting.
2. **Every ERP produces different column layouts** — Sage exports differ from Tally, Tally differs from a manual Excel trial balance, a scanned PDF has no columns at all.
3. **`is_payroll_account = true` requires manual flagging per account per company** — that's data entry, not software.

"Salaries, Allowances & Wages" was always in the JSONB. The engine was reading the bucket total instead of the name. The number was never wrong. The architecture was reading the wrong field.

---

## What's Fixed Right Now (v2.1 — no migration needed)

The engine now detects payroll and retained earnings accounts **from account names** — no manual flags required.

### SDL Base (Step C1c)
```
TIER 1: is_payroll_account = true in account_mappings (override)
TIER 2: PAYROLL_NAME_PATTERNS matched against account_name from JSONB
         → "Salaries*", "Wages*", "Allowances*", "Mishahara*", "Basic Pay*"...
         → EXCLUDES: "NHIF*", "NSSF*", "WCF*", "SDL*", "PAYE*"
```
Kamanga Medics account 7101 "Salaries, Allowances & Wages" matches Tier 2 automatically.  
Zero configuration. Zero migration needed.

### Retained Earnings Base (Step C1b)
```
TIER 1: is_retained_earnings = true in account_mappings (override)
TIER 2: RETAINED_EARNINGS_NAME_PATTERNS matched against account_name
         → "Retained Earnings*", "Accumulated Profit*", "Profit b/f*", "Faida Iliyobakiwa*"...
```

---

## Phase 3 Architecture — Universal Ingestion

### Layer 1: Format Adapters

One adapter per source format. Each adapter outputs the same normalized structure regardless of input source.

```
INPUT                          ADAPTER                 OUTPUT
──────────────────────────────────────────────────────────────────
QuickBooks CSV/XLSX        →  QuickBooksAdapter    →  RawAccount[]
Sage XLSX export           →  SageAdapter          →  RawAccount[]
Tally XML/CSV              →  TallyAdapter         →  RawAccount[]
Generic Excel (any layout) →  GenericXLSXAdapter   →  RawAccount[]
Digital PDF                →  PDFTableAdapter      →  RawAccount[]
Scanned PDF / image        →  OCRAdapter           →  RawAccount[]
Manual web entry           →  WebFormAdapter       →  RawAccount[]
```

```typescript
interface RawAccount {
  code:    string | null;   // may be absent in manual/paper TBs
  name:    string;          // always required — classification depends on it
  debit:   number;
  credit:  number;
  balance: number;          // debit - credit, or explicit if provided
  source:  string;          // "quickbooks_csv" | "sage_xlsx" | "ocr_pdf" | etc.
}
```

**GenericXLSXAdapter** is the highest priority — covers 80% of real-world uploads:
- Detects which row is the header by scanning for keywords: "account", "debit", "credit", "balance", "dr", "cr"
- Detects column positions automatically — not hardcoded
- Strips subtotals (rows where name is blank or contains "total", "sub-total", "grand")
- Handles merged cells, hidden rows, multiple sheets (picks the one with most account rows)

**OCRAdapter** (Phase 3b):
- Uses Claude vision API to extract table structure from PDF/image
- Prompt: "Extract all rows from this trial balance table. Return JSON array with fields: code, name, debit, credit. Ignore header rows, total rows, and page numbers."
- Output fed into GenericXLSXAdapter logic for normalization

---

### Layer 2: Classification Engine

Three-tier detection. For each RawAccount, in order:

```
TIER 1: Cache hit
  account_mappings has this company + account_code/name before?
  → Use stored classification instantly. No LLM call, no patterns.

TIER 2: Pattern library (deterministic, zero latency)
  600+ regex patterns organized by classification bucket:

  operating_expenses / PAYROLL (SDL base):
    INCLUDE: /salary/i, /wage/i, /allowance/i, /mishahara/i, /basic pay/i...
    EXCLUDE: /nhif/i, /nssf/i, /wcf/i, /sdl/i, /paye/i...

  equity / RETAINED_EARNINGS (WHT base):
    INCLUDE: /retained earning/i, /accumulated profit/i, /profit b\/f/i...

  current_liabilities / STATUTORY_PAYABLE (Module C):
    SDL, NSSF, NHIF, WCF, PAYE, VAT, TRA, Service Levy, Corporate Tax...

  current_assets / CASH:
    /bank/i, /cash/i, /petty cash/i...

  → Confidence ≥ 0.95: auto-accept, save to account_mappings, continue
  → Confidence 0.70–0.94: auto-accept but flag for review

TIER 3: LLM classification (Claude Haiku, ~50ms, ~$0.001/account)
  For ambiguous names only (confidence < 0.70 from Tier 2)
  
  Prompt structure:
    "You are classifying accounts for Tanzania tax compliance (TRA).
     Company industry: {industry}
     Peer accounts in same upload: {10 other account names}
     Account to classify: '{name}' — balance TZS {balance:,}
     
     Return JSON: {
       classification: 'operating_expenses'|'revenue'|'equity'|...,
       is_payroll_account: boolean,
       is_retained_earnings: boolean,
       is_cash_account: boolean,
       confidence: 0.0-1.0,
       reasoning: string (one sentence)
     }"
  
  confidence ≥ 0.85: auto-accept, save with is_auto_classified=true
  confidence < 0.85: → human review queue

TIER 4: Human review queue
  Preparer sees: account name, balance, suggested classification, confidence
  Preparer confirms or corrects
  Correction saved with is_auto_classified=false (human-verified)
  Correction improves Tier 2 patterns for future uploads (feedback loop)
```

---

### Layer 3: Process Trial Balance (existing)

No changes. Receives ClassifiedAccount[] instead of RawAccount[].  
Builds `processing_result.statements` exactly as today.

---

### Layer 4: Findings Engine (current — Module B+C v2.1)

No changes needed beyond what's already implemented.  
Name-based detection already handles format-agnostic input.

---

## Account Mappings Schema (current + additions)

```sql
-- Existing columns used by engine today
account_code          TEXT
account_name          TEXT           -- THE KEY FIELD for auto-detection
classification        TEXT           -- 'operating_expenses', 'equity', etc.
line_item             TEXT
is_retained_earnings  BOOLEAN
is_cash_account       BOOLEAN
is_payroll_account    BOOLEAN        -- added migration 20260626200000

-- Phase 3 additions
is_auto_classified    BOOLEAN DEFAULT true   -- false = human-verified
classification_confidence FLOAT              -- 0.0–1.0
classification_source TEXT                   -- 'pattern'|'llm'|'human'
classification_tier   INTEGER                -- 1|2|3|4
```

---

## Format Compatibility Matrix

| Input Source | Phase | Column detection | Code required? | Swahili names? |
|---|---|---|---|---|
| QuickBooks CSV | 1 (now) | Auto | No | Yes |
| Sage XLSX | 2 | Auto | No | Yes |
| Tally | 2 | Auto | No | Yes |
| Manual Excel | 2 | Auto | No | Yes |
| Digital PDF | 3a | PDF table parser | No | Yes |
| Scanned paper | 3b | OCR (Claude vision) | No | Yes |
| Web form entry | 3 | N/A | No | Yes |
| GFS codes only | 3 | Tier 3 LLM | Yes | N/A |

**GFS codes with no descriptive name:** The only genuinely hard case. If account_name = "7101" with no description, the engine cannot pattern-match. Options: (1) Tier 3 LLM with code + GFS lookup table, (2) require account name column in upload validation, (3) preparer provides name at upload time. Phase 3c.

---

## What This Means for Kinga UX

### Current (Phase 2)
1. Preparer uploads XLSX
2. Preparer manually maps each account in Kinga UI
3. Engine runs

### Phase 3 (Universal)
1. Preparer uploads anything — XLSX, CSV, PDF, scanned image
2. Engine auto-classifies all accounts (Tier 1–3)
3. Preparer reviews only the low-confidence accounts (typically 0–3 out of 20)
4. Engine runs

### Phase 4 (Zero-touch)
1. Accounting software API pushes trial balance directly (QuickBooks Online API, Sage Business Cloud API)
2. Classification runs automatically
3. Engine runs
4. Preparer reviews findings only — never sees the raw accounts

---

## Open Decisions

| ID | Decision | Default |
|---|---|---|
| OD-13 | Module C dedup for null rule_id findings | Add partial unique index on (company_id, category, period_start, period_end) WHERE statutory_rule_id IS NULL |
| OD-14 | OCR provider — Claude vision vs Tesseract vs AWS Textract | Claude vision (already integrated, handles Swahili) |
| OD-15 | LLM classification cost cap — max accounts per upload to send to Haiku | 50 accounts max; above that, require human review |
| OD-16 | GFS code lookup table — build internal or license PSASB mapping | Build internal, starting from PSASB Chart of Accounts v2021 |

---

## Migration Checklist (Phase 3)

- [ ] `20260627_classification_engine.sql` — add is_auto_classified, classification_confidence, classification_source, classification_tier to account_mappings
- [ ] `parse-trial-balance` edge function — replace current XLSX parser with GenericXLSXAdapter  
- [ ] `classify-accounts` edge function — new, implements Tiers 1–4
- [ ] `process-trial-balance` — receives pre-classified accounts, no internal classification logic
- [ ] OD-13 — dedup partial index for Module C findings
- [ ] Phase 3b — OCR adapter + Claude vision integration
