## Kinga Phase 3 — Complete Integration

Execute all four tasks sequentially in one pass, then produce a single verification report. No intermediate stops.

### Task 1 — Deploy edge function
- Deploy `process-trial-balance` via `supabase--deploy_edge_functions(["process-trial-balance"])`.
- Do not modify the source file.

### Task 2 — Extend `src/components/KingaFindingsPanel.tsx`
Read the file first, then apply these additions only:
- Add `AddPaymentForm` interface near other interfaces.
- Add `AddPaymentModal` sub-component (props: `companyId`, `createdBy`, `onSaved`) that inserts into `tax_payments` with `payment_source = "preparer_declared"`. Uses existing shadcn `Dialog`, `Input`, `Label`, `Textarea`, `Button`, native `<select>` (or shadcn select if already imported) for tax category. Tax category list exactly as specified.
- Add `userId: string` to `KingaFindingsPanelProps`.
- Destructure `userId` in the component signature.
- Render `<AddPaymentModal companyId={companyId} createdBy={userId} onSaved={...} />` inside the `CardHeader` button row, next to the Reset button. `onSaved` triggers whatever findings refresh the panel already exposes (will reuse the existing reload/refetch callback identified during file read).

No other behavior changes.

### Task 3 — Wire into `src/pages/Dashboard.tsx`
- Add `import { KingaFindingsPanel } from "@/components/KingaFindingsPanel";` with the other component imports.
- After the `NoteSynth` block (~line 887) and before the AI Processing Notes block, insert the `KingaFindingsPanel` JSX exactly as specified, gated on `status === "complete" && is_valid === true && company_id`, deriving `periodYear`/`periodMonth` from `uploaded_at`, passing `userId={user?.id ?? ""}`.
- `user` already comes from `useAuth()` in this file (confirm during read; if not, add the hook usage minimally).

### Task 4 — Verification report
Run all five SQL checks via `supabase--read_query` and report results in a single consolidated report, plus a checklist confirming:
- `process-trial-balance` deployed
- `kinga-findings-engine` already deployed (prior session)
- Dashboard import + JSX added
- `AddPaymentModal` added to panel
- No TS errors (rely on harness typecheck output)
- No other files modified

### Constraints
- Do not modify migrations, RLS, storage, auth, or the 54 pre-existing linter warnings.
- Only files touched: `src/components/KingaFindingsPanel.tsx`, `src/pages/Dashboard.tsx`. Edge function deployed without source edits.
