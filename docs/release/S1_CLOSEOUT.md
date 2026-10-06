# S1 close-out — mapping and processing authority

Blueprint Revision 2, stage S1. Migration `20261006100000_mapping_and_processing_authority.sql` is **pending hosted
application**: no hosted journal number, hash or applied timestamp is stated anywhere until a hosted read confirms it.

## 1. Decisions accepted

| Item | Decision |
| --- | --- |
| Reprocess request ledger | Dedicated append-only `tb_reprocess_requests` (not `idempotency_keys`, whose `engine_run_id NOT NULL` and bounded `replay_result` cannot hold a request that has no engine run). |
| Retry while `status = 'processing'` | Accepted. Confirmed from the real handler (`process-trial-balance/index.ts`): the handler never writes `processing`; its claim is `validating` (line 1301); the certification is committed while still `validating` and the final status write is followed only by the response; every early exit restores the prior status and returns. So `processing` means *requested/queued, no handler past its claim*. `register_trial_balance_upload` creates every upload at `processing`. `IN_PROGRESS` is answered for `validating` and for a held discard/cleanup claim. |

### Remaining processing limitations (S2/E2 — not fixed by S1)

- **Crash at `validating`.** A worker killed after its claim (timeout, OOM) never reaches its restore path; the upload
  stays `validating` and `tbu_request_reprocess` answers `IN_PROGRESS` until S2's lease/abandon lands. Before S1 the
  browser could overwrite the status; it no longer can. Operator recovery until S2: a service-role status reset.
- **Pre-claim window.** Before its claim the handler runs authorization, entitlement and source-binding reads with no
  write. A request accepted in that window starts a second worker. The claim is an unconditional `UPDATE`, not
  compare-and-set, so two workers can run; the later certification wins. Fencing is S2.
- **Two operation ids.** Two different operation ids for one upload can both be accepted (the second finds no
  certification left to invalidate). Same root cause; S2.

## 2. Mapping trust after S1

Proven on the real handler (`functionpath/functionPath.test.ts`, run in CI by `deno test`; locally the same unmodified
suite was run under Bun with only the import-map edges rewritten):

| Mapping row | After S1 (handler unchanged) |
| --- | --- |
| Company row **linked** to a matching review decision | Trusted (Tier 1/2) — correct. |
| Company row **without** provenance (legacy, OD2-unlinked, edited, or forged into a tenant before S1) | **Still trusted as professionally reviewed**: certified with no review (`S1 OPEN GAP` test). |
| Global row (`company_id IS NULL`) | Suggestion only: Tier 3 always needs review. |
| Another company's row | Never read (`.or(company_id.eq.X,company_id.is.null)`). |

S1 stops *new* unproven rows (clients can no longer write mappings; every RPC write is linked), but the handler does not
read `review_decision_id`, so existing unproven company rows still count as reviewed. **S1 must not be released as
complete on its own.**

Other readers with the same gap: `_shared/certifiedTbSource.ts` `loadCashPerimeter` (MAONO cash perimeter, advisory)
reads `is_cash_account` from unlinked rows; `kinga-findings-engine` (withheld; also DEFECT-KINGA-MAPPING-TENANCY-001).

### Smallest provenance-consumption change (recommended; not applied)

`process-trial-balance/index.ts`, mapping loop — two lines:

```ts
const isCompany = companyId != null && m.company_id === companyId && typeof m.review_decision_id === "string";
const isGlobal  = m.company_id == null || (companyId != null && m.company_id === companyId && !isCompany);
```

An unlinked company row becomes a suggestion (Tier 3 → needs review). Evaluated on the real handler (14/14): linked rows
certified; unlinked row → needs review; mixed → only the unlinked account in review; a row with **no**
`review_decision_id` field (pre-migration database) → needs review (fails safe). The suggestion reason for such a row
currently reads as a shared-chart match; its wording should name "not yet confirmed for this company". Same filter for
`loadCashPerimeter` (select `review_decision_id`, skip unlinked).

**Compatibility:** new handler + pre-migration database → every company mapping goes to review (safe, noisy).
Old handler + post-migration database → the open gap above. Therefore deploy the handler change **after** the migration
and **before** treating S1 as complete; the function-path fixtures gain `review_decision_id`, and the `S1 OPEN GAP`
test flips to the proposed behaviour.

## 3. CONFIRM_ACCOUNT_TREATMENT — restored to the ledger (OPEN)

Blueprint S1 lists it ("add action `CONFIRM_ACCOUNT_TREATMENT` stored in `account_review_decisions`"); OD4 records a
per-account treatment (keep a credit-balance current asset as mapped, or change the mapping); R3 requires it
("needs_review until a treatment decision exists, then complete").

**Where it belongs.** E1 is "no schema change", so the database support — the `decision_action` CHECK value, the RPC
branch that records it (bound to the account key and the mapping's current `review_decision_id`, writing no mapping
content) and its proof — must land **before E1**: in S1 or an S1 follow-up migration. The treatment-question UI ships in
E1 (Revision 2 moved it there) and is published in the same step as the E1 deploy. No engine release may require a
treatment decision the RPC cannot record, so the order is: DB support → E1 handler + UI together.

Not implemented in this S1 change: the payload contract (which accounts require it, the allowed treatment values, its
dependency key kind `treatment`) is defined by E1's detection rule and is not fixed yet. **Status: OPEN; required before
E1.**

## 4. Retry availability = RPC authorization

`tbu_request_reprocess` requires the **workspace capability** `prepare_close` (accepted active membership,
`has_workspace_capability`) plus the processing entitlement. The **engagement service grant** (e.g. Trial Balance Review in
the engagement scope) is a different thing and confers no workspace capability. Retry is now offered only when
`mayRequestReprocess` holds: an active upload **and** `prepare_close` in `get_my_workspace_capabilities().allowed`
(held, current plan). Unknown capabilities → no Retry. Residual: `allowed` checks a current plan, the RPC checks the
`CLOSE_ASSURANCE` entitlement; a plan without it is refused server-side (`ENTITLEMENT_REQUIRED`, shown by name).

## 5. Proof reliability

The CI invocation (`createdb <db>` then `node scripts/db-proof/<proof>.mjs`, `DB_PROOF_MODE=external`, bash `-e`) was
reproduced against a standalone PostgreSQL: clean → exit 0; one temporary mutation of the S1 migration
(`get_authoritative_certification` no longer honours invalidations) → `mappingProcessingAuthority.mjs` exit 1 and
`uploadLifecycle.mjs` exit 1, each naming the failing assertion; the migration restored byte-identical (SHA-256 checked).
Local **embedded** mode can print FAILED with exit 0 for proofs ending in `process.exitCode = …` (the embedded server's
exit hooks); that is never used as evidence and is tracked separately.

## 6. Release sequence — what remains unsafe at each step

1. **Lovable applies `20261006100000`.** Old frontends: their direct processing write is refused, the error is ignored at
   all three call sites, the handler sets its own status. *Still unsafe:* unproven company mappings count as reviewed
   (§2); crash-at-`validating` now needs an operator reset (§1).
2. **Hosted journal read → record PR** (actual journal number, hash, timestamp, drizzle mirror, pins). Also run G0:
   count unlinked company mappings and pre-S1 forged/global rows.
3. **Deploy the provenance-consumption change** (§2) to `process-trial-balance` and `certifiedTbSource` readers. Only
   after this is S1's mapping-trust claim true. Expect some accounts to reappear in review once (OD2).
4. **Publish the S1 frontend.** Must follow step 1 (before it, Retry calls a missing RPC and fails visibly).
5. **Before E1:** `CONFIRM_ACCOUNT_TREATMENT` database support (§3). E1 handler and treatment UI then release together.
6. **S2/E2:** attempt fencing, leases, preemption (§1 limitations), the notes/letter `processing_result` writers.
