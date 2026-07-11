/**
 * safisha-ingest · IRON DOME NUCLEAR DESIGN
 *
 * Parses uploaded evidence files (bank statement CSV/XLSX, mobile money CSV,
 * subledger XLSX) into canonical safisha_transactions rows.
 *
 * IRON DOME INVARIANTS:
 *   - Every row gets a SHA-256 hash of its raw bytes (raw_row_hash).
 *     If the same hash appears in the same reconciliation, the row is a duplicate
 *     and is silently deduplicated (not double-counted).
 *   - This function NEVER touches reviewer_action or reconciliation status.
 *   - On completion it calls safisha-match (or signals the UI to trigger it).
 *   - All figures come from the uploaded file — zero hallucination.
 *
 * POST /functions/v1/safisha-ingest
 * Body (multipart or JSON):
 *   {
 *     upload_id:   string   (existing uploads.id — the TB already uploaded)
 *     source_type: 'bank' | 'momo' | 'subledger'
 *     file:        File     (the evidence file)
 *     mapping_override?: object  (optional: override saved column mapping)
 *   }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Canonical row type ─────────────────────────────────────────────────────────

interface CanonicalRow {
  source_id:    "tb" | "bank" | "subledger" | "momo";
  account_code: string;
  account_name: string | null;
  txn_date:     string | null;  // ISO date
  debit:        number | null;
  credit:       number | null;
  currency:     string;
  reference:    string | null;
  raw_row_hash: string;
  raw_row_number: number;
}

// ── SHA-256 ───────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Date parsing ──────────────────────────────────────────────────────────────

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // ISO format already
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,"0")}-${dmy[1].padStart(2,"0")}`;

  // MM/DD/YYYY (US format)
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,"0")}-${mdy[2].padStart(2,"0")}`;

  // Excel serial date (days since 1900-01-00)
  const serial = parseInt(s, 10);
  if (!isNaN(serial) && serial > 40000 && serial < 60000) {
    const d = new Date((serial - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }

  return null;
}

// ── Amount parsing ────────────────────────────────────────────────────────────

function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).replace(/[,\s]/g, "").replace(/[()]/g, s => s === "(" ? "-" : "");
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.abs(n);  // store absolute values; debit/credit columns differentiate sign
}

// ── CSV parser (no external dep) ─────────────────────────────────────────────

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  while (i < text.length) {
    const row: string[] = [];
    while (i < text.length) {
      if (text[i] === '"') {
        let cell = "";
        i++; // skip opening quote
        while (i < text.length) {
          if (text[i] === '"' && text[i+1] === '"') { cell += '"'; i += 2; }
          else if (text[i] === '"') { i++; break; }
          else { cell += text[i++]; }
        }
        row.push(cell);
        if (text[i] === ",") i++;
      } else {
        let cell = "";
        while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          cell += text[i++];
        }
        row.push(cell.trim());
        if (text[i] === ",") i++;
      }
      if (text[i] === "\n" || text[i] === "\r") {
        if (text[i] === "\r" && text[i+1] === "\n") i++;
        i++;
        break;
      }
    }
    if (row.length > 0 && !(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}

// ── Apply column mapping ──────────────────────────────────────────────────────

function applyMapping(
  headers: string[],
  row: string[],
  mapping: Record<string, string>,
  sourceType: CanonicalRow["source_id"]
): Omit<CanonicalRow, "raw_row_hash" | "raw_row_number"> {

  // Build lookup: canonical_field → column index
  const fieldToIndex: Record<string, number> = {};
  for (const [originalHeader, canonicalField] of Object.entries(mapping)) {
    const idx = headers.findIndex(h => h.trim().toLowerCase() === originalHeader.trim().toLowerCase());
    if (idx >= 0) fieldToIndex[canonicalField] = idx;
  }

  const get = (field: string) => row[fieldToIndex[field] ?? -1] ?? undefined;

  // Handle combined debit/credit column (some banks use a single "Amount" col + sign)
  let debit: number | null = null;
  let credit: number | null = null;

  if (fieldToIndex["debit"] !== undefined) {
    debit  = parseAmount(get("debit"));
    credit = parseAmount(get("credit"));
  } else if (fieldToIndex["amount"] !== undefined) {
    const amount = parseAmount(get("amount"));
    const type   = get("type")?.toLowerCase() ?? "";
    if (type.includes("debit") || type.includes("dr") || type === "d") {
      debit = amount;
    } else if (type.includes("credit") || type.includes("cr") || type === "c") {
      credit = amount;
    } else if (amount !== null) {
      // Positive = credit, negative = debit (many bank statement conventions)
      const rawAmt = parseFloat(String(get("amount")).replace(/[,\s]/g, ""));
      if (rawAmt < 0) debit = Math.abs(rawAmt);
      else credit = rawAmt;
    }
  }

  return {
    source_id:    sourceType,
    account_code: get("account_code") ?? "UNKNOWN",
    account_name: get("account_name") ?? null,
    txn_date:     parseDate(get("txn_date")),
    debit,
    credit,
    currency:     get("currency") ?? "TZS",
    reference:    get("reference") ?? null,
  };
}

// ── Load saved column mapping ─────────────────────────────────────────────────

async function loadMapping(
  supabase: ReturnType<typeof createClient>,
  clientId: string,
  sourceType: string
): Promise<Record<string, string> | null> {
  const { data } = await supabase
    .from("safisha_client_mappings")
    .select("column_mapping")
    .eq("client_id", clientId)
    .eq("source_type", sourceType)
    .single();
  return data?.column_mapping ?? null;
}

// ── Task #177: DQC polarity / sign validation ────────────────────────────────
//
// Account types have expected balance directions:
//   Revenue, Other Income       → Credit  (positive credit balance)
//   Cost of Sales, Expenses     → Debit   (positive debit balance)
//   Assets                      → Debit
//   Liabilities, Equity         → Credit
//
// IRON DOME: This is a WARNING, not a hard block.
// A polarity anomaly means the TB row has a sign the account type doesn't expect.
// This is valid in some cases (contra accounts, reversals, refunds) but unusual
// enough to flag for human review. The exception surfaces as exception_type='dqc_polarity'
// in the exception queue — reviewer can confirm or reject.
//
// Account code ranges used (Tanzania IFRS chart — aligns with Hoffman hierarchy):
//   1000–1999: Asset accounts         → expected debit
//   2000–2999: Liability accounts     → expected credit
//   3000–3999: Equity accounts        → expected credit
//   4000–4999: Revenue accounts       → expected credit
//   5000–5999: Cost of Sales          → expected debit
//   6000–6999: Operating Expenses     → expected debit
//   7000–7999: Finance costs/income   → mixed (skip DQC)
//   8000–8999: Tax expense/provision  → expected debit
//   9000–9999: Statistical/memo       → skip DQC

type ExpectedPolarity = "debit" | "credit" | "skip";

function expectedPolarity(accountCode: string): ExpectedPolarity {
  const prefix = parseInt(accountCode.substring(0, 1), 10);
  switch (prefix) {
    case 1: return "debit";   // Assets
    case 2: return "credit";  // Liabilities
    case 3: return "credit";  // Equity
    case 4: return "credit";  // Revenue
    case 5: return "debit";   // Cost of Sales
    case 6: return "debit";   // Operating Expenses
    case 7: return "skip";    // Finance (can be either)
    case 8: return "debit";   // Tax expense
    case 9: return "skip";    // Statistical/memo
    default: return "skip";   // Unknown — skip DQC
  }
}

interface DQCResult {
  warning:    boolean;
  detail?:    string;
}

function dqcPolarityCheck(row: CanonicalRow): DQCResult {
  const code = (row.account_code ?? "").replace(/\D/g, "").substring(0, 4);
  if (!code) return { warning: false };

  const expected = expectedPolarity(code);
  if (expected === "skip") return { warning: false };

  // For bank/momo transactions: debit = money out, credit = money in
  // This is the account balance sign, not the transaction direction.
  // Source_id=bank transactions represent cash movements, not GL balances.
  // Only apply polarity DQC to TB rows (source_id='tb') or subledger rows.
  if (row.source_id === "bank" || row.source_id === "momo") return { warning: false };

  const hasDebit  = row.debit  != null && row.debit  > 0;
  const hasCredit = row.credit != null && row.credit > 0;

  // Both columns populated → ambiguous
  if (hasDebit && hasCredit) return { warning: false };

  const actualSide: "debit" | "credit" | null =
    hasDebit  ? "debit"
    : hasCredit ? "credit"
    : null;

  if (!actualSide) return { warning: false };

  if (actualSide !== expected) {
    const categoryName =
      parseInt(code[0]) === 1 ? "Asset"
      : parseInt(code[0]) === 2 ? "Liability"
      : parseInt(code[0]) === 3 ? "Equity"
      : parseInt(code[0]) === 4 ? "Revenue"
      : parseInt(code[0]) === 5 ? "Cost of Sales"
      : parseInt(code[0]) === 6 ? "Operating Expense"
      : parseInt(code[0]) === 8 ? "Tax Expense"
      : "Unknown";

    const amount = (row.debit ?? row.credit ?? 0).toLocaleString();

    return {
      warning: true,
      detail:  `${categoryName} account ${row.account_code} (${row.account_name ?? "unnamed"}) ` +
               `has a ${actualSide} balance of TZS ${amount}. ` +
               `${categoryName} accounts normally carry a ${expected} balance. ` +
               `Verify the trial balance sign convention or check for a reversal/contra entry.`,
    };
  }

  return { warning: false };
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    // Auth check
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse request
    const formData   = await req.formData();
    const uploadId   = formData.get("upload_id") as string;
    const sourceType = (formData.get("source_type") as string) || "bank";
    const file       = formData.get("file") as File;
    const mappingOverride = formData.get("mapping_override")
      ? JSON.parse(formData.get("mapping_override") as string)
      : null;

    if (!uploadId || !file) {
      return new Response(JSON.stringify({ error: "upload_id and file are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate upload belongs to this user
    const { data: upload, error: uploadErr } = await supabase
      .from("trial_balance_uploads")
      .select("id, company_id")
      .eq("id", uploadId)
      .single();
    if (uploadErr || !upload) {
      return new Response(JSON.stringify({ error: "Upload not found or access denied" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get or create reconciliation record
    let { data: recon } = await supabase
      .from("safisha_reconciliations")
      .select("id, status")
      .eq("tb_upload_id", uploadId)
      .eq("sealed", false)
      .single();

    if (!recon) {
      const { data: newRecon, error: reErr } = await supabase
        .from("safisha_reconciliations")
        .insert({ client_id: user.id, tb_upload_id: uploadId, status: "processing" })
        .select("id, status")
        .single();
      if (reErr) throw new Error("Failed to create reconciliation: " + reErr.message);
      recon = newRecon;

      // Set upload safisha_status to processing
      await supabase.from("trial_balance_uploads").update({ safisha_status: "processing" }).eq("id", uploadId);
    }

    const reconId = recon!.id;

    // Load column mapping
    const detectedSourceType = `${sourceType}_${file.name.endsWith(".csv") ? "csv" : "excel"}`;
    const savedMapping = mappingOverride ?? await loadMapping(supabase, user.id, detectedSourceType);

    // Parse file content
    const fileContent = await file.text();
    const isCSV = file.name.endsWith(".csv") || file.type === "text/csv";

    let rawRows: string[][];
    if (isCSV) {
      rawRows = parseCSV(fileContent);
    } else {
      // For XLSX: client must have used xlsx.js to convert to CSV before calling ingest
      // Or the formData includes pre-parsed JSON rows
      const jsonRows = formData.get("parsed_rows");
      if (!jsonRows) {
        return new Response(JSON.stringify({
          error: "XLSX_NEEDS_CLIENT_PARSE",
          message: "Upload XLSX files converted to CSV, or include parsed_rows JSON. "
                   + "Use the FieldMappingModal which handles XLSX → CSV conversion client-side.",
          needs_mapping: !savedMapping,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      rawRows = JSON.parse(jsonRows as string);
    }

    if (rawRows.length < 2) {
      return new Response(JSON.stringify({ error: "File appears empty or has only a header row" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const headers = rawRows[0];
    const dataRows = rawRows.slice(1);

    // If no mapping saved, return headers so UI can show FieldMappingModal
    if (!savedMapping) {
      return new Response(JSON.stringify({
        needs_mapping:    true,
        detected_headers: headers,
        reconciliation_id: reconId,
        source_type:      detectedSourceType,
        message:          "No column mapping found for this client + source type. "
                          + "Return with column_mapping to complete ingestion.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Parse rows → canonical + hash
    const canonicalRows: CanonicalRow[] = [];
    const seenHashes = new Set<string>();

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      if (row.every(cell => !cell.trim())) continue; // skip blank rows

      const rawString  = JSON.stringify(row);
      const hash       = await sha256(rawString);

      // Deduplicate by hash within this reconciliation
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      const canonical = applyMapping(headers, row, savedMapping, sourceType as CanonicalRow["source_id"]);
      canonicalRows.push({ ...canonical, raw_row_hash: hash, raw_row_number: i + 2 }); // +2 for 1-indexed + header
    }

    if (canonicalRows.length === 0) {
      return new Response(JSON.stringify({ error: "No valid rows parsed from file" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check for existing hashes in this reconciliation (cross-upload dedup)
    const newHashes = canonicalRows.map(r => r.raw_row_hash);
    const { data: existingTxns } = await supabase
      .from("safisha_transactions")
      .select("raw_row_hash")
      .eq("reconciliation_id", reconId)
      .in("raw_row_hash", newHashes);

    const existingHashSet = new Set((existingTxns ?? []).map((t: any) => t.raw_row_hash));
    const newRows = canonicalRows.filter(r => !existingHashSet.has(r.raw_row_hash));

    if (newRows.length === 0) {
      return new Response(JSON.stringify({
        success:       true,
        inserted:      0,
        deduplicated:  canonicalRows.length,
        message:       "All rows already ingested (duplicate file upload detected)",
        reconciliation_id: reconId,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Task #177: Run DQC polarity check on each row before insert
    let dqcWarningCount = 0;
    const rowsWithDQC = newRows.map(r => {
      const dqc = dqcPolarityCheck(r);
      if (dqc.warning) dqcWarningCount++;
      return { ...r, dqc_polarity_warning: dqc.warning, dqc_sign_detail: dqc.detail ?? null };
    });

    // Insert in batches of 500
    const BATCH = 500;
    let inserted = 0;
    for (let b = 0; b < rowsWithDQC.length; b += BATCH) {
      const batch = rowsWithDQC.slice(b, b + BATCH).map(r => ({
        reconciliation_id:    reconId,
        source_id:            r.source_id,
        account_code:         r.account_code,
        account_name:         r.account_name,
        txn_date:             r.txn_date,
        debit:                r.debit,
        credit:               r.credit,
        currency:             r.currency,
        reference:            r.reference,
        raw_row_hash:         r.raw_row_hash,
        raw_row_number:       r.raw_row_number,
        dqc_polarity_warning: r.dqc_polarity_warning,
        dqc_sign_detail:      r.dqc_sign_detail,
      }));
      const { error: insErr } = await supabase.from("safisha_transactions").insert(batch);
      if (insErr) throw new Error("Insert failed: " + insErr.message);
      inserted += batch.length;
    }

    // Append to evidence_files JSONB array via raw SQL (cannot use rpc helper as a value)
    await supabase.rpc("safisha_append_evidence_file", {
      p_recon_id:   reconId,
      p_source_type: sourceType,
      p_filename:   file.name,
      p_rows:       inserted,
    }).then(() => {}); // fire-and-forget; non-critical tracking

    return new Response(JSON.stringify({
      success:              true,
      inserted,
      deduplicated:         canonicalRows.length - newRows.length,
      reconciliation_id:    reconId,
      dqc_polarity_warnings: dqcWarningCount,
      dqc_note:             dqcWarningCount > 0
        ? `${dqcWarningCount} rows have unexpected debit/credit polarity for their account type. `
          + "These appear in the exception queue as dqc_polarity items for reviewer sign-off."
        : null,
      next_step:            "Call safisha-match to run the matching engine",
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("safisha-ingest error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
