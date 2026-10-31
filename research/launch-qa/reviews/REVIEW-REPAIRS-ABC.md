# Independent read-only review — repairs A / B / C

BLACK, 2026-10-16. Read-only review of NORMAL's pushed repairs; I did not modify any production/migration/workflow/registry/
lockfile. A clean review does **not** prove correctness — most proofs here were read, not executed by me (see each item).

## Heads reviewed
| PR | Repair | Branch | Head |
|---|---|---|---|
| #141 | A — certification findings capacity | `fix/certification-capacity-20261016` | `559dd38241e7` |
| #142 | B — account identity (same name, different code) | `fix/account-identity-20261016` | `47bd80ae4d4f` |
| #143 | C — concurrent sealing / orphan cleanup | `fix/seal-race-20261016` | `13e305cf9fc4` |
| #139 | combined candidate | `integration/candidate-20261016` | `c558cf8f25dc` |

The three repair branches are stacked over the combined candidate; findings are attributed to the repair that introduces them.

## Criteria verdicts (reviewed)
| # | Criterion | Repair | Verdict (reviewed, not a correctness proof) |
|---|---|---|---|
| 1 | Full findings preserved; summaries cannot hide blockers | A | **Met by design.** Complete findings in append-only `tb_certification_findings` (attempt-fenced, RLS); the `exceptions` summary keeps *every kind* (layer\|code\|severity) with examples + a count record, so a blocker kind is always present; `tb_finalize_attempt` refuses a summary that disagrees; `tb_certification_findings_supported()` fails the attempt closed on a DB without the table (never a summary without the full findings). |
| 2 | Aggregate dependencies invalidate results after relevant changes | A | **Met.** `tb_snapshot_dependencies` still records **every** dependency key; only the per-account advisory **locks** are bounded (`tb_dependency_lock_limit()=1000`), which does not weaken invalidation. |
| 3 | Different coded accounts cannot inherit each other's treatment by name | B | **Met.** `20261108100000` replaces the all-names index with `uq_acct_map_company_codeless_name` (name-unique only where `account_code IS NULL`); coded accounts stay keyed by `account_key = code` and conflict on `(company_id, account_key)` — 4000/4100 "Sales" are distinct keys/decisions, nothing merged. |
| 4 | Ambiguous lookups refuse safely | B | **Met.** Engine generation 6 name-fallback "counts candidates: zero, one, or several — several is never resolved by picking one; it goes to review" (`accountNameMatch` + `process-trial-balance` v6; `min_engine_generation` floor of 6 retires last-wins engines). |
| 5 | Failed/concurrent seals + cleanup cannot delete valid sealed evidence | C | **Met.** The seal no longer removes **canonical** bytes on a failed/concurrent put (only non-canonical); canonical-unsealed bytes become listed orphans. The sweeper (sole deletion rule) **never deletes a sealed object**, spares anything still sealable (grace > any seal txn), re-decides on a **fresh read**, and is idempotent. Linchpin verified: `reporting_pack_seal` does `… FOR UPDATE` then `expires_at <= now() → 'expired'` (`20260925120000`), expiry immutable — an expired issuance can't be sealed. |
| 6 | History, permissions, retry intact | A/B/C | **Met.** A: findings append-only + attempt-isolated per retry. B: "no row rewritten, merged or removed; every account key, decision and its history stays"; tenant `company_id` in every key; client-write guard unchanged; proof asserts byte-identical history. C: sealed artefacts preserved whatever their age; a retry reuses the canonical orphan; failed deletion idempotently retried. |

## Findings (concrete)
**No executed failures.** The items below are static concerns / missing-proof, with the smallest correction.

1. **C — orphan sweeper had no behavioural test (MEDIUM, missing proof → FILLED).**
   - Location: `supabase/functions/_shared/reportingPackOrphans.mjs` (the *sole* rule by which an unsealed object may be deleted). The change set ships `reportingPackSeal.test.ts` (seal never removes the canonical object) but the sweeper's decisions were referenced only by an inertness/scope allow-list (`databaseInert.test.ts`), not exercised.
   - Mechanism if wrong: the one authority that deletes storage objects was unproven — a regression could delete a still-sealable or sealed object with no test catching it.
   - Evidence: I added `research/launch-qa/reviews/reportingPackOrphans.review.test.mjs` and **executed it (12/12)** against the real module bytes — sealed→never-deleted (any age), still-sealable→kept, after-expiry+grace→deleted, no-issuance grace, fail-safe on unparseable dates, a **seal landing between the two reads spares the object**, genuine orphan deleted, failed deletion reported-not-deleted.
   - Smallest correction: **NORMAL adopt an equivalent sweeper test in its own suite** (I don't edit shared tests), and add a one-line assertion/comment tying `ORPHAN_GRACE_MS` (1h) to the DB `statement_timeout`, since the no-delete-during-seal guarantee rests on grace > max seal-transaction duration.

2. **A — bounded summary collapses per-account detail (LOW, static).**
   - Location: `certificationFindings.ts` `summarizeFindings` + `tb_certifications.exceptions`. When >5 findings share a kind, the summary carries ≤5 example `accountCode`s + one count record with `accountCode: null`; the full per-account list lives only in `tb_certification_findings`.
   - Mechanism: not a blocker-hiding defect — every *kind* and the gates (`is_blocking`, `requires_review`, readiness error/layer checks) are preserved — but a consumer reading only `exceptions` does not get the exact blocked-account set.
   - Smallest correction: none required if all blocker-gating consumers rely on kind-presence/count or read `tb_certification_findings`; **confirm** no consumer enumerates blocked accounts from `exceptions` alone. Document it.

3. **A — `FindingsSummaryTooLarge` / finalize-agreement DB path (LOW, confirm proof).**
   - Mechanism: if distinct kinds were numerous enough that even one count record per kind exceeds 32 KB, `summarizeFindings` throws; practically unreachable (per-account `NEEDS_REVIEW` all share one kind → one count + 5 examples, which is exactly the fixed defect). I confirmed `certificationFindings.test.ts` (145 lines) exists but did **not execute** it or the DB finalize-agreement refusal.
   - Smallest correction: **confirm** an executed proof that `tb_finalize_attempt` rejects a disagreeing summary and that the too-large path fails the attempt closed (never certifies without a valid summary).

4. **B — no finding.** Strong executable proof `scripts/db-proof/accountIdentity.mjs` (real embedded PostgreSQL): reproduces the 23505 defect without the repair, then proves two keys/two decisions/nothing-merged, renaming, 12-way concurrency → exactly two mappings, history byte-identical, index swap correct. I **did not execute** it here (needs `DB_PROOF_MODULES_DIR`); reviewed statically + confirmed its assertions.

## Executed vs reviewed (honesty)
- **Executed by BLACK here:** repair C's orphan-sweeper behavioural test — **12/12** against the real fetched module bytes.
- **Reviewed statically (code read; proofs confirmed to exist but not run by me):** A's `certificationFindings` + migration `20261107100000` + `certificationFindings.test.ts`; B's migration `20261108100000` + `accountIdentity.mjs` + gen-6 `accountNameMatch`. The A/B DB proofs need embedded PostgreSQL this host lacks.
- This review does **not** assert the repairs are correct — only that, as read, they address criteria 1–6, with the three concrete items above.
