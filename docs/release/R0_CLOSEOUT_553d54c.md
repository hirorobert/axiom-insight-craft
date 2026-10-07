# R0 close-out — Trial Balance Review (RELEASED)

- Source: `main` 553d54cac9921cfc7b2698842bd4fff2a6be8f1b (clean tree)
- Amendment SHA-256: f373082534a7096b3063238fac22fd4f780192fd9c0aeea2c98e18eabbd49c74
- Release: 2026-10-07 09:21:09Z

## 1. W2 — deployed functions
Every closure was recomputed from the checkout and equals the closure in amendment §5. All five were deployed together.

| Function | Closure |
|---|---|
| kinga-tax-engine | 493f362ee1d63ad65bc4494529382dabf4935165113ce2c492081b3ed8f67042 |
| kinga-findings-engine | 088be7143253bf64ce3e7cdf521706456ae87c168d2bd3f81e9379dc384e74d4 |
| maono-compute | c294375706e1cce819fcf75276639d23a2f0900d3e450f550b8be5e7cb511628 |
| generate-disclosure-notes | 773f8dd5271cf9988d53534b473162075b2cb98d073e51f28b5ee33a3fde151a |
| generate-management-letter | 94bdea2ca60cdd408c228fe0280fd6943b2c75b46eab348d0c4e86899a1727d5 |

Not redeployed: process-trial-balance, maono-cashflow, comparative-assurance-engine, kinga-comparative-engine.

## 2. W3 / E-RESTR — PASS
- **Calls:** 10 POSTs of `{}`: each of the 5 functions with the publishable key only, then with a signed-in token.
- **Result:** all 10 returned HTTP 503 with exactly this body:
  `{"error":"SERVICE_RESTRICTED","code":"SERVICE_RESTRICTED","message":"This analysis is not available yet."}`
- **No writes:** counts before (09:08:12Z) and after the calls were identical.

| Table | Rows (before = after) |
|---|---|
| engine_runs | 67 |
| idempotency_keys | 54 |
| audit_logs | 218 |
| tax_computations | 0 |
| findings | 0 |
| period_closing_balances | 0 |
| adjusting_journal_entries | 0 |
| aje_lines | 0 |

## 3. Cut-over gates

| Gate | Status | Evidence |
|---|---|---|
| L1 | PASS | Journal id 30 = 3591b7d0… (07:20:43Z); id 31 = 169a3771… (08:11:39Z) |
| L2 | PASS (earlier record) | Earlier §J verification, zero discrepancies. Not re-run in this close-out. |
| L3 | PASS | Event 8a0c47b7: 07:58:03Z, hold=true, canary list empty; before 0030 was applied |
| L4 | **OWNER-APPROVED EVIDENCE EXCEPTION** — not recovered, not passed | See below |
| L5 | PASS | Events log has only `set` rows; no drain |
| L6 | PASS | See below |
| L7, L8 | Earlier records | From the earlier verification; not re-read this close-out |
| L9 | PASS | W2 and W3 above |
| L10 | PASS | Version 3 (event af57aaf2, 08:13:12Z): floor 3, canary = demo company 659daa94 only |
| L12 | PASS | Event aef07ef4 (09:21:09Z): hold=false, floor 3, canary list empty. Runs below generation 3 since release: 0 |

**L4 exception.** The G1/G2/G3 readings taken before S2 are not recoverable. They are not reported as recovered or passed. The owner accepted the exception on this basis:
- the hold was recorded before S2 (07:58:03Z);
- 816 s passed before S2 was applied (08:11:39Z);
- zero engine_runs were created between 07:58:03Z and 08:11:40Z;
- the events log has no drain row.

**L6 detail.** Fingerprint = `md5(to_jsonb(row) - 'current_engine_run_id' - 'processing_attempt')`.

| Upload | Fingerprint now | C1 baseline (07:02Z) | State |
|---|---|---|---|
| 6bcbfb34-0519-4e0d-8451-6adf99056112 | 2cc90ee20842edbc48f61ff40156f221 | equal | blocked / validating, processing_attempt 0 |
| e19f592b-a1ab-424f-adbd-2323859aec7e | 584811915bbeb789fc32777792dd8359 | equal | blocked / validating, processing_attempt 0 |

The fingerprints were re-read after release and are unchanged.

## 4. Canary cases
All demo runs: company 659daa94-116c-4803-99f8-157e0bdd4c62; every run engine_generation 3.

### Fixtures

| SHA-256 | Upload | Year |
|---|---|---|
| a993d7bc…1e84 | 4135771d | FY2016 |
| 0c2fc834…ed3 | 3ffaabf3 | FY2017 |
| f08467ba…bed | 7acc2eae | FY2018 |
| 61e59512…7f0 | 2bc4c98c | FY2019 |
| f7e4eea0…25b | e8777ba5 | FY2019 |
| d6e83520…37 | e36d81b6 | FY2020 |
| 90886881…e83 | fd292939 | FY2021 |
| 2ef99880…758 | 9714b667 | FY2021 |
| 5ea2dd37…5c2 | 5318db78 | FY2022 |

### Results

| Case | Result | Evidence |
|---|---|---|
| E-ARITH-1 | PASS | 4135771d complete/valid; tb-amounts/1; 118,345.67 = 118,345.67 exact; equation balanced |
| E-ARITH-2 | PASS | 3ffaabf3: a 0.01 imbalance (revenue 59,999.99) is `blocked`, is_valid=false; authority reason "blocked", not authoritative |
| E-CASH-1 | PASS | 7acc2eae: 2 cash accounts reported (10,000.00); reconciliation `not_checked` |
| E-CASH-2 | PASS | Cash flag on equity account 3000 (08:16:07Z) → certification seq 46: requires_review, NEEDS_REVIEW/3000 |
| E-TREAT-1 | PASS | 2bc4c98c: closing stock credit → seq 49: NEEDS_REVIEW/1300; figure unmoved (seq 50 row: credit 4,000) |
| E-TREAT-2 | PASS | CONFIRM_ACCOUNT_TREATMENT keep_as_mapped → seq 50 (3f2ea81b): requires_review=false |
| E-TREAT-3 | PASS | e8777ba5: closing stock debit → seq 51: no review |
| E-TREAT-4 | PASS | 9714b667: 1410 marked non-reporting with 100.00 → in review with the engine message "A non-zero account can't be left out …"; not authoritative |
| E-EQ-1 | PASS | e36d81b6: credit-normal contra asset 1510 reduces assets (20,000 = 5,000 + 20,000 − 5,000); balanced; seq 53 Reviewed |
| E-EQ-2 | PASS (source) | AccountReviewPanel offers 10 statement classes; no cash-flow class |
| E-EQ-3 | PASS | Non-zero amount outside the statements (9714b667, 1410 = 100) → is_valid=false; requires_review (seq 56); authority not authoritative; get_authoritative_certification(FY2021) = 0 rows |
| E-NR-1 | PASS, explained | See below |
| E-NR-2 / E-NR-3 | PASS | A later non-zero suppressed 1410 → review with its amount: 9714b667 = 100 (seq 56); 5318db78 = 250 (seq 57) |
| E-HIST-1 | PASS | Pre-S2 results → "Needs re-check": demo FY2025 c699c3d8 authority = legacy_certification; tb_run_authoritative(FY2026 pre-S2 cert d75e96e7's run 046ec10f) = false |
| E-HIST-2 | PASS | tb_upload_attempts(4135771d) is newest first: 5, 4 (abandoned/PREEMPTED), 3, 2, 1 |
| E-STALE-2 | PASS (run now) | Decision on unused account 1010 (batch 8a6bbbe4) → 4135771d still `current` |
| E-STALE-1 | PASS (run now) | Decision on used account 6000 (batch e9149320) → `dependency_changed` ("Needs re-check"); cert 9d07fc07 md5 7e906a07… unchanged; 0 invalidations |
| E-RETRY-1 | PASS (run now) | e8777ba5, op e739c79c: replay returned `replay:true`, reference 7554462e; runs 2 → 2 |
| E-RETRY-2 | PASS | 4135771d, op 5f9e337c: run 37d01621 running → abandoned, event code PREEMPTED |
| E-HOLD | PASS (at release) | See below |

**E-NR-1 explanation.** In fixture fd292939 the zero row (1410 Suspense, 0.00/0.00) is recorded in lineage as `zero_balance`:
- row 3 appears in rejected_rows with disposition `zero_balance`;
- the lineage summary shows `zero_balance: 1`;
- the "every row accounted for" milestone passed.

This is the approved contract: tbIngestion line 687, and process-trial-balance's E1 rule (line 1709) that only a zero-balance account may be left out. Zero-net accounts *may* be suppressed.

The account that is net zero but not empty (1420, 50/50) went to review (seq 54). After it was marked non-reporting, the run was Reviewed (seq 55).

The earlier mismatch came from the fixture's expectation that 1410 would appear in review. It was not an engine defect.

**E-HOLD sequence.**
- Demo company allowed while held: canary runs 08:13–08:21Z.
- Version 4 (09:20:57Z): canary list cleared, hold kept. Demo upload e36d81b6 was then refused: `PROCESSING_HELD`, op 9889cfd2, runs 2 → 2.

**Deferred (never pass):** BHD three-decimal currency; forced lease expiry → Retry now.

## 5. Release and normal processing
- Version 5 (09:21:09Z): hold=false, canary list empty, min_engine_generation 3.
- Normal processing check: e36d81b6, op f4ac81ae → HTTP 200 `valid`.
  - New run 5066bc2d: generation 3, attempt 3.
  - New authoritative certification 30403e6d.

## 6. Final processing-control state
hold=false, version 5, canary_company_ids = {}, min_engine_generation = 3.

## 7. Preservation
- Both protected uploads are unchanged (L6 above).
- No migrations, drains, publications, period/engagement creation or customer-data changes.
- All test writes were synthetic records of the demo company only.
