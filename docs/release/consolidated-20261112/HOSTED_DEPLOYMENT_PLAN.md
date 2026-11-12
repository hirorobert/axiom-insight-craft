# Consolidated release — hosted deployment plan (PREPARED; separate owner authorization required)

Nothing in this plan is executed by the integration session. Merge, migration apply, function deploy, feature activation and
Publish are four separate, separately authorized Lovable operations. The repository mirror (journal 0101) is NOT proof of the
hosted state: run `HOSTED_READ_ONLY_VERIFICATION.sql` first and stop on any mismatch.

## 0. Preconditions (all must hold before step 1)
- The consolidated candidate is merged into `main` after every required CI check is green on its exact SHA (see the register).
- Hosted read-only verification recorded: journal ends at `0101_qbo_readiness_controls`; nothing from `20261215100000` onward
  applied; receipt CHECK is the single original digest; `_rfr_blockers`, `_fs_first_period_pending`, `fs_first_period_claims`,
  `rfr_runs` and `account_mappings.is_contra_account` absent; `fs_publication_blockers` anchors as expected.
- Backup: a Lovable/Supabase point-in-time recovery point (or a full `pg_dump` of `public`, `drizzle`, `auth`, `storage`
  schemas) taken AFTER the verification and BEFORE step 1, its identifier recorded.
- GitHub Actions budget confirmed (one complete run ≈ 60 job-minutes).

## 1. Dependency-safe sequence (pending chain in source order = hosted order)

| # | Operation | Precondition | Recovery |
|---|---|---|---|
| 1 | Deploy `safisha-efdms-ingest`, `safisha-categorize`, `safisha-score`, `maono-cashflow`, `maono-risk` (service-role writers, PR #270) | caller-token writes would fail with 42501 after step 3 | redeploy previous closure (`known` in `verifyDeployedClosure.mjs`) |
| 2 | Apply `20261215100000_api_cache_control_headers` | none | documented rollback inside the file |
| 3 | Apply `20261221100000_financial_table_member_write_revocation` | step 1 done; PR #270 body preflight (grants/policies, no long transactions); aborts on drift or 5 s lock wait by design | forward journalled migration only; NEVER re-grant member writes |
| 4 | Apply `20261222100000_fs_cash_transfers_and_post_closing` | none beyond 3 | forward only |
| 5 | Apply `20261222200000_statement_compiler_transfers_post_closing` (second identity) | receipt CHECK single-digest (verified) | forward only; do NOT deploy the 2.4.0-only bundle |
| 6 | Apply `20261223100000_first_period_governed_review_standalone` | `docs/release/first-period-governed-review/preflight.sql` counts recorded; owner accepts that legacy declarations become unverified claims | forward only |
| 7 | Apply `20261224100000_contra_account_designation` | none | forward only (existing mappings stay NULL) |
| 8 | Apply `20261225100000_ready_for_reporting_pilot` | 20261223 applied (splice anchors) | forward only |
| 9 | Apply `20261226100000_issued_comparative_schedules` | 20261223 and 20261225 applied (PREFLIGHT names both) | forward only |
| 10 | Apply `20261227100000_rfr_prior_pack_basis` | 20261225, 20261226 applied | forward only |
| 11 | Apply `20261228100000_statement_compiler_casting_declaration` (third identity) | receipt CHECK = exactly the two-digest state of step 5 | forward only |
| 12 | Deploy `compile-financial-report` ONCE with the combined bundle (closure `8419ff17…`, compiler `85a0f362…`, rule pack 2.5.0) | step 11 applied (receipts are refused, never mis-recorded, while either side is missing) | redeploy the `known` 745c8170… closure (original identity still accepted) |
| 13 | Deploy `rfr-check-books` (new) | step 8 applied | undeploy / leave: the UI is gated by the rollout allow-list |
| 14 | Redeploy `process-trial-balance`, `trial-balance-layout`, `layout-assist` if the deployed closures are not `f0fef38c…` / `8052b224…` / `8ec2f43e…` (PR #267 + #271, merged) | compare in Lovable | redeploy previous closure |
| 15 | Publish the frontend (one Publish, after 1–14) | all above | re-publish the previous SHA |
| 16 | Record journal mirrors 0102–0112 on `main` (chore PR, `releaseJournal.mjs` + `drizzle/migrations`); pending lists empty | the apply bot's `_journal.json` | — |

Customer-facing activation (rollout allow-list, pilot company) is a separate decision and is not part of this plan.

## 2. What the plan does NOT cover
- The hosted database was not read by the integration session; every "must be" above is an expectation to verify, not a fact.
- Earlier IPSAS / FS-integrity batches: the mirror records them as applied (journal ids 92–101); confirm in the journal read-back.
- #270's six deferred tables (`fiscal_periods`, `findings`, `evidence_requests`, `account_corrections`,
  `safisha_client_mappings`, `audit_logs`) stay member-writable; a later revocation migration owns them.
