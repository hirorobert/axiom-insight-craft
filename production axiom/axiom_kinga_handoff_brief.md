# Engineering Handoff Brief — Axiom Cleanup → Kinga Build
**For: Claude Code session**
**Status: Axiom verified against live repo (github.com/hirorobert/axiom-insight-craft, branch main). Kinga exists as design doc + HTML prototype only — no backend yet.**

---

## 0. Sequencing mandate (do not skip ahead)

**Phase 1 — Axiom data-integrity fixes (this session's priority)**
**Phase 2 — Kinga backend build, deliberately reusing Axiom's `companies`, `account_mappings`, `audit_logs` tables**
**Phase 3 — Integration: Kinga writes verified reconciliation results into Axiom's validation pipeline**

Do not start Phase 2 schema work until Phase 1 items are closed. Building Kinga against an Axiom data layer that still has the gaps below means inheriting them in both systems.

---

## 1. Phase 1 — Axiom fixes (verified against actual code/migrations)

### 1.1 Storage bucket public-read exposure — fix first, highest severity
**File:** `supabase/migrations/20251207114310_*.sql`
**Finding:** `trial-balance-files` storage bucket policy allows public SELECT with only a `bucket_id` check, no ownership/auth condition:
```sql
CREATE POLICY "Allow public read from trial-balance-files"
ON storage.objects FOR SELECT
USING (bucket_id = 'trial-balance-files');
```
**Risk:** Any authenticated (or possibly anonymous, depending on bucket `public` flag) request can read any user's uploaded trial balance file if they know/guess the path.
**Task:** Replace with an ownership-scoped policy (e.g. `storage.foldername(name))[1] = auth.uid()::text`), matching the pattern already correctly used for the `avatars` bucket in the `20260101095822_*.sql` migration. Verify the bucket's `public` flag in `storage.buckets` is `false` and stays false.

### 1.2 Client-supplied `user_id` on insert — spoofing risk
**Files:** `account_corrections`, `audit_logs` tables (migrations `20251209073333_*`, `20260102084718_*`)
**Finding:** INSERT policies check `auth.uid() = user_id`, but `user_id` is a column the client supplies in the insert payload, not a server-enforced default.
**Task:** Add a `DEFAULT auth.uid()` to the `user_id` column on both tables, or better, switch inserts in the edge functions to never accept `user_id` from the request body — derive it server-side from the validated JWT only (the edge functions already do this correctly for the JWT validation itself — extend that pattern to all writes).

### 1.3 Company-level RLS is incomplete
**Finding:** `companies` table has correct `user_id`-scoped RLS. `trial_balance_uploads` has a `company_id` foreign key (added in `20260108144134_*`) but RLS on that table is still `user_id`-scoped only, with `company_id` as a plain nullable FK with no enforcement that the company belongs to the requesting user.
**Task:** Add a policy/check ensuring `company_id`, when set, must reference a company owned by `auth.uid()`. This matters specifically because Kinga's multi-client model assumes this isolation is already solid before any multi-tenant logic is layered on top.

### 1.4 Incomplete deterministic checks — known gaps, not bugs
**File:** `supabase/functions/process-trial-balance/index.ts`
**Finding:** `profit_equity_linkage` is hardcoded `null` with comment "Future: implement when retained earnings tracking is added." Cash flow reconciliation only checks a single cash account balance match, not a full indirect-method reconciliation.
**Task:** Decide explicitly whether to complete these before Phase 2, or document them as known limitations in the validation report UI so a preparer doesn't mistake "valid" for "fully reconciled." Recommend completing `profit_equity_linkage` first since it's the cheaper fix and closes a real gap in the BS/IS articulation check.

### 1.5 Confirm no leftover permissive policies
**Task:** Run a full policy audit (`SELECT * FROM pg_policies WHERE schemaname = 'public';`) against the live Supabase project to confirm the original "Allow public insert/select/update" policies from the first migration were actually dropped everywhere they were superseded, not just on `trial_balance_uploads`.

**Definition of done for Phase 1:** all five items closed, policy audit query run and reviewed, and a smoke test confirming a second test user cannot read/write another user's uploads, mappings, or files via the API or storage bucket directly (not just through the UI).

---

## 2. Phase 2 — Kinga backend, built to share Axiom's core tables

### 2.1 Tables to reuse, not duplicate
| Axiom table | Reuse for Kinga as |
|---|---|
| `companies` | Kinga's client list — do not create a separate `clients` table |
| `account_mappings` | Kinga's rules engine reads ledger category from here instead of re-deriving it |
| `audit_logs` | Extend the `audit_action` enum with Kinga-specific actions (`reconciliation_run`, `evidence_requested`, `response_pack_generated`) rather than building a parallel log table |
| `trial_balance_uploads` | The natural attachment point for Kinga's `validation_report`/`accounting_errors` JSONB fields — extend these rather than creating a separate findings table disconnected from Axiom's record |

### 2.2 New tables Kinga genuinely needs (no Axiom equivalent exists)
- `efdms_records` — ingested EFDMS sales/purchase data per company/period, source for the reconciliation diff
- `statutory_rules` — the versioned, effective-dated rule table (Section 4 of the architecture doc) — confirm no overlap with `account_mappings.classification` enum before creating; likely these should reference each other (a rule trigger keys off an `account_mappings.classification` value)
- `findings` — one row per detected variance/rule trigger, foreign-keyed to `trial_balance_uploads.id` (or `companies.id` if not upload-specific) and to the relevant `statutory_rules.id`
- `evidence_requests` — the six-step workflow tracker (request → awaiting → received → review → sign-off → submitted), foreign-keyed to `findings.id`

### 2.3 RLS pattern to copy exactly
Use the same `auth.uid() = user_id` plus `company_id`-ownership-check pattern being fixed in Phase 1.3 — do not reinvent tenant isolation logic for Kinga; copy the corrected pattern once it exists.

---

## 3. Phase 3 — Integration point (the actual Kinga ↔ Axiom contract)

**Mechanism:** when Kinga's reconciliation engine completes a run against a company's EFDMS data and ledger, it should:
1. Write findings to its own `findings` table (full detail, workflow-tracked)
2. Push a summarized status back into the relevant `trial_balance_uploads.accounting_errors` array (or a new `external_verification_status` field) so Axiom's existing UI (`ValidationReport.tsx`, `MappingCoverageIndicator.tsx`) can surface "externally verified: clean" or "externally verified: N open findings" alongside its own internal balance/mapping checks — without Axiom needing to know anything about TRA, EFDMS, or Tanzanian statute logic directly.

This keeps the systems loosely coupled: Axiom owns trial-balance-to-FS correctness, Kinga owns external truth verification, and they meet at one well-defined field, not a deep merge of logic.

---

## 4. What NOT to build yet (carried over from prior review)
No predictive risk scoring, no "audit readiness %" score, no audit simulator. These remain deferred per the earlier design review — Phase 1-3 above is the actual buildable scope for this engineering pass.

---

## 5. Immediate first Claude Code session scope (recommend doing only this first)
1. Items 1.1 and 1.2 above (the two real security gaps) — small, testable, urgent.
2. Run the policy audit query from 1.5.
3. Write and run the smoke test described in "Definition of done for Phase 1."

Stop there, confirm clean, then return for the Phase 2 schema work in a follow-up session.
