# Financial Statements Workspace — operating architecture

Sits on the canonical engine (`src/lib/canonicalStatement/**`, PR #22), which stays the sole accounting authority.

## Layers (dependencies point downward only)
1. `components/financialStatements/*` — presentation; computes nothing.
2. `hooks/useCanonicalStatementPreview.ts` — read-only fetch of `account_mappings`; runs the orchestrator in memory.
3. `lib/financialStatementsWorkspace/evaluationOrchestrator.ts` — prepare / evaluate / correct / decide; idempotent, deterministic ids, refuses to overwrite a lineage whose input changed.
4. `lib/financialStatementsWorkspace/trialBalanceAdapter.ts` (+ `mapWorkspaceTrialBalance.ts`) — reviewed trial balance to canonical extraction; exact minor-unit conversion, rejects sub-scale precision.
5. `reportRepository.ts` — storage boundary; only an in-memory implementation exists.

## Not built, deliberately
- Statement of Cash Flows, SOCIE, net-result total: no honest source data / signed-summation support (see adapter header; DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001).
- IPSAS cash basis: rejected by the orchestrator.
- Document (PDF/DOCX/XLSX/iXBRL) extraction: none exists; `DOCUMENT_REVIEW_ENABLED` stays false.
- DOCX output; reviewer-decision UI; comparative periods from the workspace (adapter supports them, the data source does not yet supply them).

## Persistence
`supabase/migrations/20260917000000_financial_statement_reports.sql` is authored and UNAPPLIED. Until it is applied and an Edge Function (validateAuth + assertCompanyMembership, firm_members.id as actor) wraps the orchestrator, the UI is labelled "Draft — not saved".
