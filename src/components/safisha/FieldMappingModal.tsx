/**
 * FieldMappingModal.tsx · SAFISHA Stage 2
 *
 * One-time per-client column mapping UI. Appears when safisha-ingest responds
 * with { needs_mapping: true, detected_headers: [...] }.
 *
 * Flow:
 *   1. User uploads bank/momo/subledger file → ingest returns detected_headers
 *   2. This modal appears; user maps each detected column to a canonical field
 *   3. On Save, mapping is persisted to safisha_client_mappings
 *   4. Re-calls safisha-ingest with mapping_override → completes ingestion
 *
 * On subsequent uploads of the same source_type, the saved mapping is used
 * automatically — this modal never appears again for that client + source_type.
 *
 * IRON DOME: This modal writes ONLY to safisha_client_mappings.
 * It never touches reviewer_action, reconciliation status, or uploads.safisha_status.
 */

import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button }   from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge }    from "@/components/ui/badge";
import { AlertCircle, CheckCircle2 } from "lucide-react";

// ── Canonical fields the user must map to ─────────────────────────────────────

export interface CanonicalField {
  key:         string;
  label:       string;
  required:    boolean;
  description: string;
}

export const CANONICAL_FIELDS: CanonicalField[] = [
  { key: "account_code", label: "Account Code",  required: true,  description: "GL account number or ledger code" },
  { key: "account_name", label: "Account Name",  required: false, description: "Account description (optional)" },
  { key: "txn_date",     label: "Transaction Date", required: true, description: "Date of the transaction" },
  { key: "debit",        label: "Debit Amount",  required: false, description: "Debit column (or use Amount + Type)" },
  { key: "credit",       label: "Credit Amount", required: false, description: "Credit column (or use Amount + Type)" },
  { key: "amount",       label: "Amount (single column)", required: false, description: "If debit/credit are combined in one column" },
  { key: "type",         label: "Dr/Cr Flag",    required: false, description: "Column that indicates Debit or Credit (e.g. 'DR'/'CR')" },
  { key: "currency",     label: "Currency",      required: false, description: "Currency code (defaults to TZS if not mapped)" },
  { key: "reference",    label: "Reference",     required: false, description: "Transaction reference, narration, or description" },
];

const SKIP_VALUE = "__skip__";

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  open:            boolean;
  detectedHeaders: string[];
  sourceType:      string;
  reconciliationId: string;
  /** Called after mapping is saved AND ingest completes successfully */
  onComplete: (reconId: string, rowsInserted: number) => void;
  onCancel:   () => void;
  /** The original file to re-ingest after mapping is saved */
  fileToIngest: File;
  uploadId:     string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FieldMappingModal({
  open,
  detectedHeaders,
  sourceType,
  reconciliationId,
  onComplete,
  onCancel,
  fileToIngest,
  uploadId,
}: Props) {
  // mapping: { detectedHeader → canonicalField }
  // Pre-populate with auto-detected matches (case-insensitive fuzzy)
  const [mapping, setMapping]   = useState<Record<string, string>>(() =>
    autoDetect(detectedHeaders)
  );
  const [saving,  setSaving]    = useState(false);
  const [error,   setError]     = useState<string | null>(null);

  const handleFieldChange = (header: string, canonicalKey: string) => {
    setMapping(prev => {
      const next = { ...prev };
      if (canonicalKey === SKIP_VALUE) {
        delete next[header];
      } else {
        // Clear any other header that was mapped to the same canonical field
        Object.keys(next).forEach(h => {
          if (next[h] === canonicalKey && h !== header) delete next[h];
        });
        next[header] = canonicalKey;
      }
      return next;
    });
  };

  // Validation: require account_code + txn_date + (debit OR credit OR amount)
  const missingRequired = validateMapping(mapping);

  const handleSaveAndIngest = async () => {
    if (missingRequired.length > 0) return;
    setSaving(true);
    setError(null);

    try {
      // 1. Persist mapping
      const { error: dbErr } = await supabase
        .from("safisha_client_mappings")
        .upsert({
          client_id:      (await supabase.auth.getUser()).data.user!.id,
          source_type:    sourceType,
          column_mapping: mapping,
          sample_headers: detectedHeaders,
          updated_at:     new Date().toISOString(),
        }, { onConflict: "client_id,source_type" });

      if (dbErr) throw new Error("Failed to save mapping: " + dbErr.message);

      // 2. Re-call safisha-ingest with the saved mapping
      const form = new FormData();
      form.append("upload_id",       uploadId);
      form.append("source_type",     sourceType.replace(/_csv$|_excel$/, ""));
      form.append("file",            fileToIngest);
      form.append("mapping_override", JSON.stringify(mapping));

      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/safisha-ingest`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${session!.access_token}` },
          body: form,
        }
      );

      const result = await res.json();
      if (!res.ok || result.error) {
        throw new Error(result.error ?? result.message ?? "Ingest failed");
      }

      onComplete(result.reconciliation_id, result.inserted);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={open => !open && onCancel()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Map Columns — {labelSourceType(sourceType)}</DialogTitle>
          <DialogDescription>
            Tell Safisha which column in your file corresponds to each field.
            This is a one-time setup — next time you upload this file type, we'll use
            this mapping automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          {detectedHeaders.map(header => (
            <div key={header} className="flex items-center gap-3">
              <div className="w-48 shrink-0">
                <Badge variant="outline" className="font-mono text-xs truncate max-w-full">
                  {header}
                </Badge>
              </div>
              <span className="text-muted-foreground text-sm">→</span>
              <Select
                value={mapping[header] ?? SKIP_VALUE}
                onValueChange={v => handleFieldChange(header, v)}
              >
                <SelectTrigger className="flex-1 h-8 text-sm">
                  <SelectValue placeholder="Skip this column" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SKIP_VALUE}>
                    <span className="text-muted-foreground">Skip this column</span>
                  </SelectItem>
                  {CANONICAL_FIELDS.map(f => (
                    <SelectItem key={f.key} value={f.key}>
                      <span>
                        {f.label}
                        {f.required && <span className="text-red-500 ml-1">*</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {mapping[header] ? (
                <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
              ) : (
                <div className="h-4 w-4 shrink-0" />
              )}
            </div>
          ))}
        </div>

        {/* Validation warnings */}
        {missingRequired.length > 0 && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded bg-amber-50 border border-amber-200 text-amber-800 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Required fields not yet mapped:</p>
              <ul className="mt-1 list-disc list-inside space-y-0.5">
                {missingRequired.map(f => <li key={f}>{f}</li>)}
              </ul>
              {!mappingHasAmountColumn(mapping) && (
                <p className="mt-1 text-xs">
                  Map either <strong>Debit</strong> + <strong>Credit</strong> (two columns)
                  or <strong>Amount</strong> + optionally <strong>Dr/Cr Flag</strong> (single column).
                </p>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-2 flex items-center gap-2 p-3 rounded bg-red-50 border border-red-200 text-red-800 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveAndIngest}
            disabled={saving || missingRequired.length > 0}
            className="bg-[#0E6B55] hover:bg-[#0E6B55]/90"
          >
            {saving ? "Saving & ingesting…" : "Save mapping & continue"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Auto-detect canonical fields from header names using fuzzy matching.
 * Returns mapping: { originalHeader → canonicalField }
 */
function autoDetect(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const used = new Set<string>();

  const PATTERNS: [RegExp, string][] = [
    [/^(account[_\s-]?code|gl[_\s]?code|acc[_\s]?no|ledger[_\s]?code)$/i, "account_code"],
    [/^(account[_\s-]?name|description|narration|details?)$/i,              "account_name"],
    [/^(date|txn[_\s]?date|trans[_\s]?date|value[_\s]?date|posting[_\s]?date)$/i, "txn_date"],
    [/^(debit|dr|dr\.?|debit[_\s]?amount|withdrawal)$/i,                   "debit"],
    [/^(credit|cr|cr\.?|credit[_\s]?amount|deposit)$/i,                    "credit"],
    [/^(amount|sum|total|net)$/i,                                           "amount"],
    [/^(type|dc|dr[_\s]?cr|flag|indicator)$/i,                             "type"],
    [/^(currency|ccy|curr)$/i,                                              "currency"],
    [/^(reference|ref|narration|memo|remark|particulars|cheque[_\s]?no)$/i, "reference"],
  ];

  for (const header of headers) {
    for (const [pattern, canonical] of PATTERNS) {
      if (pattern.test(header.trim()) && !used.has(canonical)) {
        result[header] = canonical;
        used.add(canonical);
        break;
      }
    }
  }

  return result;
}

function mappingHasAmountColumn(mapping: Record<string, string>): boolean {
  const vals = Object.values(mapping);
  return vals.includes("debit") || vals.includes("credit") || vals.includes("amount");
}

function validateMapping(mapping: Record<string, string>): string[] {
  const vals = Object.values(mapping);
  const missing: string[] = [];
  if (!vals.includes("account_code")) missing.push("Account Code");
  if (!vals.includes("txn_date"))     missing.push("Transaction Date");
  if (!mappingHasAmountColumn(mapping)) missing.push("Amount (Debit, Credit, or Amount column)");
  return missing;
}

function labelSourceType(sourceType: string): string {
  const map: Record<string, string> = {
    bank_csv:      "Bank Statement (CSV)",
    bank_excel:    "Bank Statement (Excel)",
    momo_csv:      "Mobile Money (CSV)",
    subledger_csv: "Subledger (CSV)",
    subledger_excel: "Subledger (Excel)",
  };
  return map[sourceType] ?? sourceType;
}
