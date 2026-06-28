# Lovable — Kinga Phase 3 Complete Integration
# ALL TASKS IN ONE SHOT — NO BACK AND FORTH

---

## RULES BEFORE YOU START

- Do NOT ask clarifying questions. Execute everything below sequentially.
- Do NOT modify any migration files.
- Do NOT touch RLS policies, storage, or auth settings.
- Do NOT address the 54 pre-existing linter warnings.
- Do NOT modify any component other than the ones explicitly named below.
- After completing ALL tasks, produce ONE final verification report covering everything.
- Do NOT stop between tasks asking for approval.

---

## TASK 1 — DEPLOY EDGE FUNCTION

Deploy `supabase/functions/process-trial-balance/index.ts`.
- Do not modify the source file.
- Function name must be exactly `process-trial-balance`.
- Confirm deployment succeeded.

---

## TASK 2 — ADD TAX PAYMENT ENTRY UI TO KingaFindingsPanel

The file `src/components/KingaFindingsPanel.tsx` already exists. It needs one addition: a small inline "Record Payment" form so CPAs can enter what they have already paid for each statutory category. This is how the engine computes net variance (gross obligation minus declared paid).

### What to add inside `KingaFindingsPanel.tsx`:

**Step A** — Add this new interface near the top of the file with the other interfaces:

```typescript
interface AddPaymentForm {
  tax_category: string;
  amount_paid_tzs: string;
  payment_date: string;
  payment_reference: string;
  notes: string;
}
```

**Step B** — Add this new sub-component inside the file (before the main `KingaFindingsPanel` function):

```typescript
function AddPaymentModal({
  companyId,
  createdBy,
  onSaved,
}: {
  companyId: string;
  createdBy: string;
  onSaved: () => void;
}) {
  const [open, setOpen]     = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm]     = useState<AddPaymentForm>({
    tax_category:     "sdl",
    amount_paid_tzs:  "",
    payment_date:     new Date().toISOString().substring(0, 10),
    payment_reference:"",
    notes:            "",
  });

  const TAX_CATEGORIES = [
    { value: "sdl",                       label: "SDL" },
    { value: "nssf",                      label: "NSSF" },
    { value: "nhif",                      label: "NHIF" },
    { value: "wcf",                       label: "WCF" },
    { value: "paye",                      label: "PAYE" },
    { value: "vat",                       label: "VAT" },
    { value: "wht_undistributed_earnings",label: "WHT (Undistributed Earnings)" },
    { value: "service_levy",              label: "Service Levy" },
    { value: "corporate_tax",             label: "Corporate Tax" },
  ];

  const handleSave = async () => {
    if (!form.amount_paid_tzs || !form.payment_date) return;
    setSaving(true);
    const { error } = await supabase.from("tax_payments").insert({
      company_id:        companyId,
      tax_category:      form.tax_category,
      amount_paid_tzs:   parseFloat(form.amount_paid_tzs.replace(/,/g, "")),
      payment_date:      form.payment_date,
      payment_reference: form.payment_reference || null,
      notes:             form.notes || null,
      payment_source:    "preparer_declared",
      created_by:        createdBy,
    });
    setSaving(false);
    if (!error) {
      setOpen(false);
      setForm({ tax_category: "sdl", amount_paid_tzs: "", payment_date: new Date().toISOString().substring(0, 10), payment_reference: "", notes: "" });
      onSaved();
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        + Record Payment
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4">
            <h3 className="font-semibold text-lg">Record Declared Payment</h3>
            <p className="text-sm text-muted-foreground">
              Enter what was actually paid to TRA / statutory authority. The engine will deduct this from the gross obligation to compute the net gap.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Tax Category</label>
                <select
                  className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                  value={form.tax_category}
                  onChange={e => setForm(f => ({ ...f, tax_category: e.target.value }))}
                >
                  {TAX_CATEGORIES.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Amount Paid (TZS)</label>
                <input
                  className="w-full mt-1 border rounded-md px-3 py-2 text-sm font-mono"
                  placeholder="e.g. 61930070"
                  value={form.amount_paid_tzs}
                  onChange={e => setForm(f => ({ ...f, amount_paid_tzs: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Payment Date</label>
                <input
                  type="date"
                  className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                  value={form.payment_date}
                  onChange={e => setForm(f => ({ ...f, payment_date: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">TRA Receipt / Reference (optional)</label>
                <input
                  className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                  placeholder="e.g. TRA-2025-00123"
                  value={form.payment_reference}
                  onChange={e => setForm(f => ({ ...f, payment_reference: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Notes (optional)</label>
                <input
                  className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                  placeholder="e.g. Paid in two instalments"
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || !form.amount_paid_tzs}>
                {saving ? "Saving…" : "Save Payment"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

**Step C** — In the `KingaFindingsPanel` props interface, add:
```typescript
userId: string;
```

**Step D** — In the `KingaFindingsPanel` function signature, add `userId` to destructured props:
```typescript
export function KingaFindingsPanel({
  companyId, uploadId, periodYear, periodMonth, companyName, userId,
}: KingaFindingsPanelProps) {
```

**Step E** — In the `KingaFindingsPanel` JSX, find the section that shows the "Run Analysis" idle state buttons and add `AddPaymentModal` next to it. Find the idle state div and add the modal. Also add it near the top of the card header area so it's always accessible. In the `CardHeader` section, add `AddPaymentModal` as a sibling to the Reset button:

```typescript
<AddPaymentModal
  companyId={companyId}
  createdBy={userId}
  onSaved={loadLiveFindings}
/>
```

Place this inside the `CardHeader`'s button row (same div as the Reset button, so it always shows regardless of phase).

---

## TASK 3 — WIRE KingaFindingsPanel INTO Dashboard.tsx

### Step A — Add import at the top of `src/pages/Dashboard.tsx`

Add this import line with the other component imports (after the existing imports, before the interface definitions):

```typescript
import { KingaFindingsPanel } from "@/components/KingaFindingsPanel";
```

### Step B — Insert the component in the JSX

In `src/pages/Dashboard.tsx`, find the `NoteSynth` block (around line 887):

```tsx
{/* NoteSynth - Disclosure Notes */}
{mapping && (
  <NoteSynth
    uploadId={selectedUpload.id}
    existingNotes={result?.disclosureNotes}
    onNotesGenerated={fetchUploads}
  />
)}
```

Immediately AFTER that closing `)}` and BEFORE the `{/* AI Processing Notes */}` block, insert:

```tsx
{/* Kinga — Statutory Compliance Analysis */}
{selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (
  <KingaFindingsPanel
    companyId={selectedUpload.company_id}
    uploadId={selectedUpload.id}
    periodYear={new Date(selectedUpload.uploaded_at).getFullYear()}
    periodMonth={new Date(selectedUpload.uploaded_at).getMonth() + 1}
    companyName={selectedUpload.company_name ?? undefined}
    userId={user?.id ?? ""}
  />
)}
```

### What this does:
- `companyId` — from `selectedUpload.company_id`
- `uploadId` — from `selectedUpload.id`
- `periodYear` / `periodMonth` — derived from the upload date (e.g. upload in December 2025 = period 2025-12)
- `companyName` — from `selectedUpload.company_name` (nullable, converted to undefined if null)
- `userId` — from the authenticated user context (`useAuth` hook already provides `user`)
- Only renders when the upload is `complete` and `is_valid = true` — no compliance analysis on blocked/invalid TBs

---

## TASK 4 — VERIFY EVERYTHING

After completing all tasks above, run these verification queries and checks, then report results:

### SQL Verifications:
```sql
-- V1: tax_payments table has RLS
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'tax_payments';
-- Expected: rowsecurity = true

-- V2: Both dedup indexes exist
SELECT indexname FROM pg_indexes
WHERE tablename = 'findings'
  AND indexname IN ('uq_finding_per_rule_per_period', 'uq_statutory_payable_per_period')
ORDER BY indexname;
-- Expected: 2 rows

-- V3: finding_category column exists
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'findings'
  AND column_name = 'finding_category';
-- Expected: 1 row, data_type = text

-- V4: is_payroll_account column exists
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'account_mappings'
  AND column_name = 'is_payroll_account';
-- Expected: 1 row, column_default = false

-- V5: Kamanga SDL payment seed exists
SELECT company_id, tax_category, amount_paid_tzs, payment_source
FROM public.tax_payments LIMIT 5;
-- Expected: 1 row, sdl, 61930070, preparer_declared
```

### Code Verifications:
- [ ] `process-trial-balance` deployed ✅
- [ ] `kinga-findings-engine` deployed ✅ (already done in prior session)
- [ ] `KingaFindingsPanel` import added to Dashboard.tsx ✅
- [ ] `KingaFindingsPanel` renders in Dashboard after NoteSynth ✅
- [ ] `AddPaymentModal` added to KingaFindingsPanel ✅
- [ ] No TypeScript errors in modified files ✅
- [ ] No other files modified ✅

---

## END STATE

When complete, a CPA preparer using the dashboard can:

1. Upload a trial balance (XLSX or CSV, any format, any ERP)
2. Once processed (status = complete, is_valid = true), the **Kinga — Statutory Compliance Analysis** panel appears below the account mapping section
3. Click **"Run Analysis"** → engine runs a dry-run preview showing all statutory gaps colour-coded by severity (critical/high/medium/low)
4. Each finding shows: gross obligation, declared paid, **net variance**, estimated TAA penalty (5%/month), **total exposure**
5. Module C section shows outstanding statutory payables directly from the balance sheet (TRA assessments, NSSF arrears, SDL outstanding, etc.)
6. CPA clicks **"Record Payment"** to enter what has already been paid to TRA — engine deducts this from gross on next run
7. CPA clicks **"Commit Findings"** to save findings to the database
8. Live findings table shows all committed findings below

---

## TECHNICAL REFERENCE (do not deviate from these)

- Supabase project: `bvyivmmfjejbmqoydezk` (Lovable Cloud managed)
- `account_mappings` is keyed by `user_id` NOT `company_id`
- `findings` table has trigger `enforce_verified_statutory_rule` — Module C bypasses it via `finding_type = 'statutory_payable'` with `statutory_rule_id = NULL`
- `statutory_rules` has one verified rule: SDL (trigger_category = 'sdl', verified_at IS NOT NULL)
- WHT rule exists but `verified_at = NULL` — engine skips it by design until manually verified
- `kinga-findings-engine` is called via `supabase.functions.invoke` — NOT a direct fetch — because the engine needs the service role key internally
- `KingaFindingsPanel` already uses `import.meta.env.VITE_SUPABASE_URL` for the fetch call — this env var is already set in the project
