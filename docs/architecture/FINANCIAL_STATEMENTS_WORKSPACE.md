# Financial Statements Workspace — operating architecture

Sits on the canonical engine (`src/lib/canonicalStatement/**`, PR #22), which stays the sole accounting authority. Everything here reads or adapts; nothing duplicates a canonical rule.

## The seven stages (inside the existing Prepare Statements stage; `?fs=<stage>`)
Sources → Structure → Statements → Notes & Policies → Validate → Professional Review → Final Outputs.
Exactly one dominant next action is derived from the first unmet precondition (`nextAction.ts`).

## Layers (dependencies point downward only)
1. `components/financialStatements/*` — presentation; computes nothing.
2. `hooks/useFinancialStatementsWorkspace.ts` — assembles the workspace model; read-only fetch of `account_mappings`; in-memory repository.
3. Domain models (`lib/financialStatementsWorkspace/`): `frameworkProfiles` (IFRS / IFRS for SMEs / IPSAS accrual / IPSAS cash), `statementComposition` (evidence-gap model), `structureModel`, `sourcesModel`, `comparativeSource`, `reportingPeriod`, `noteNumbering`, `findingsView`, `correctableFacts`, `reviewerDecisionCommands`, `nextAction`.
4. `evaluationOrchestrator` — prepare / evaluate / correct (with atomic recast of derived totals) / decide. Idempotent, deterministic ids.
5. `trialBalanceAdapter` + `mapWorkspaceTrialBalance` — reviewed trial balance to canonical extraction; exact minor units; ambiguous mappings excluded and reported.
6. `reportRepository` (in-memory) and `persistenceContract` (remote client contract, gated by `persistenceGate`).

## Evidence gaps are a supported state
SOCIE, Cash Flow, Budget-vs-Actual and the IPSAS cash primary statement are shown as explicit incomplete statements with the evidence required — never omitted, never estimated. IPSAS cash gets a precise unsupported boundary (no accrual model is ever shown in its place).

## Persistence (not enabled)
`supabase/migrations/20260917000000_financial_statement_reports.sql` is authored and UNAPPLIED: append-only tables, RLS by accepted firm membership, RPC-only service-role writes, per-report advisory lock with an exact latest+1 version guard (`PT409 STALE_REPORT_VERSION`), no float money. `FINANCIAL_STATEMENT_PERSISTENCE_ENABLED = false` until the migration is applied and an Edge Function (`financial-statement-workspace`: validateAuth + assertCompanyMembership, actor derived from the JWT) exists. The client never sends an actor id.

## Outputs
Web preview and browser print (A4, repeating headers, page breaks, DRAFT watermark). DOCX and XBRL are labelled unavailable. Signature blocks only when explicitly configured.

## Not built
Document extraction (`DOCUMENT_REVIEW_ENABLED` stays false); supporting-schedule intake; SOCIE/cash-flow/budget statements (need evidence the product does not hold); the persistence Edge Function.

## Browser harness
`dev-harness/` (dev server only, outside `src/`, refuses to run unless `import.meta.env.DEV`). `harnessIsolation.test.ts` proves it cannot reach production.
