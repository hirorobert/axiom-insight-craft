# S1 close-out — mapping and processing authority

Blueprint Revision 2, stage S1. Migration `20261006100000_mapping_and_processing_authority.sql` is **pending hosted
application**: no hosted journal number, hash or applied timestamp is stated anywhere until a hosted read confirms it.

S1 is three coordinated parts that are released together (§6): the migration, the provenance-aware functions
(`process-trial-balance`, `_shared/certifiedTbSource.ts` for MAONO), and the frontend. No intermediate state is
"hardened".

## 1. Decisions accepted

| Item | Decision |
| --- | --- |
| Reprocess request ledger | Dedicated append-only `tb_reprocess_requests` (not `idempotency_keys`, whose `engine_run_id NOT NULL` and bounded `replay_result` cannot hold a request that has no engine run). |
| Retry while `status = 'processing'` | Accepted. Confirmed from the real handler (`process-trial-balance/index.ts`): the handler never writes `processing`; its claim is `validating`; the certification is committed while still `validating` and the final status write is followed only by the response; every early exit restores the prior status and returns. So `processing` means *requested/queued, no handler past its claim*. `register_trial_balance_upload` creates every upload at `processing`. `IN_PROGRESS` is answered for `validating` and for a held discard/cleanup claim. |

### Remaining processing limitations (S2/E2 — not fixed by S1)

- **Crash at `validating`.** A worker killed after its claim (timeout, OOM) never reaches its restore path; the upload
  stays `validating` and `tbu_request_reprocess` answers `IN_PROGRESS` until S2's lease/abandon lands. Before S1 the
  browser could overwrite the status; it no longer can. Recovery until S2: a service-role status reset by an operator.
- **Pre-claim window.** Before its claim the handler runs authorization, entitlement and source-binding reads with no
  write. A request accepted in that window starts a second worker. The claim is an unconditional `UPDATE`, not
  compare-and-set, so two workers can run; the later certification wins. Fencing is S2.
- **Two operation ids.** Two different operation ids for one upload can both be accepted (the second finds no
  certification left to invalidate). Same root cause; S2.

## 2. Mapping trust — provenance consumption

### Contract and why the link is sufficient

A company mapping is the company's **professionally reviewed** mapping only when it carries `review_decision_id`.
Checking that column is sufficient because the database enforces the whole contract on every write path, for every
role (the service role included):

- `trg_account_mappings_provenance` accepts a link only for a decision with the **same company**, the **same account key**
  (code, else normalized name), an **approving action**, and **identical seven-field content** (statement,
  classification, line_item, normal_balance, is_cash_account, is_retained_earnings, is_payroll_account); otherwise 42501.
- Any later change to that content, the company or the account key **without a new matching decision clears the link**.
- Decisions are append-only (`trg_ard_immutable`); a global (`company_id IS NULL`) row cannot carry a link.
- Client roles cannot write mappings at all; the only writer is `resolve_account_review_batch`, which writes the decision
  first and links it.

Evidence: `mappingProcessingAuthority.mjs` checks the contract independently (in JavaScript, not through the trigger's
own functions) for **every** linked row after all provenance attacks and again at the end of the proof — zero
violations. Limit: the guarantee assumes the trigger stays enabled; only the table owner can disable it.

### Readers

| Reader | Linked company row | Unproven company row (absent, cleared, malformed link) | Global row | Another company's row |
| --- | --- | --- | --- | --- |
| `process-trial-balance` | Tier 1/2 — trusted | Suggestion (Tier 3) → needs review; reason: "Saved for this company as …, but no recorded review decision confirms it — confirm the classification before the trial balance is accepted." | Suggestion (Tier 3) → needs review ("shared chart of accounts") | Never read (query + a second guard) |
| `certifiedTbSource.loadCashPerimeter` (MAONO) | `is_cash_account` decides CASH / NOT_CASH | Decides nothing → UNKNOWN (fails closed) | Not read (company-scoped query) | Not read |

Precedence among suggestions is deterministic: this company's unconfirmed row is suggested over a shared row for the
same code or name, whatever order the rows arrive in.

### Compatibility (function × schema)

| | Pre-S1 database | Post-S1 database |
| --- | --- | --- |
| **Old handler / old MAONO reader** | Today's behaviour | **Unsafe:** unproven company rows still count as reviewed; unproven cash flags count |
| **New handler** | Fails safe: no row carries a link → every company mapping is a suggestion (all accounts to review) | Contract above |
| **New MAONO reader** | Fails closed: the column does not exist → `CANNOT_ASSESS` | Contract above |

Proven by: function-path suite (`functionPath.test.ts`, 17 tests, CI `deno test`; the new tests fail against the
pre-change handler — 5 failures); `src/lib/accounting/certifiedTbSource.test.ts`; and the real-PostgreSQL proof
(pre-S1 `CANNOT_ASSESS`, post-S1 reviewed flag known / unproven flag UNKNOWN, tenant isolation).

**Verification still pending:** the real `process-trial-balance` handler has **not** been run against real PostgreSQL.
Its proof is the function-path suite (the real, unmodified handler over in-memory doubles of the Supabase client,
Storage and auth). The database contract is proven separately on real PostgreSQL. Running the real handler on real
PostgreSQL needs the harness extension the blueprint schedules for E1 (I-1a: `.or()`, `.is()`, Storage download,
`auth.getClaims`); until then that end-to-end claim is not made.

Expected once after release: accounts whose mappings were not linked by the OD2 backfill reappear in review once.

Not changed here: `kinga-findings-engine` (withheld; DEFECT-KINGA-MAPPING-TENANCY-001) still reads mapping flags without
provenance — it must consume provenance before it is re-enabled.

## 3. CONFIRM_ACCOUNT_TREATMENT — pending before E1 (OPEN)

Blueprint S1 lists it ("add action `CONFIRM_ACCOUNT_TREATMENT` stored in `account_review_decisions`"); OD4 records a
per-account treatment; R3 requires it ("needs_review until a treatment decision exists, then complete").

E1 is "no schema change", so its database support — the `decision_action` value, the RPC branch that records it
(bound to the account key and the mapping's current `review_decision_id`, writing no mapping content) and its proof —
must land **before E1**, in an S1 follow-up migration. The treatment-question UI ships in E1 and is published with the E1
deploy. No engine release may require a treatment decision the RPC cannot record. Its payload (which accounts need it,
the allowed treatment values, the `treatment` dependency key) is defined by E1's detection rule and is not fixed yet.
Not implemented in S1; no inventory treatment or E1 calculation is part of this change.

## 4. Retry availability = RPC authorization

`tbu_request_reprocess` requires, for a workspace upload: an accepted active membership with the **workspace capability**
`prepare_close`, and the processing entitlement `_authorize_paid_action(user, company, 'CLOSE_ASSURANCE')`. Retry is
offered only when `mayRequestReprocess` holds all three:

1. an active upload;
2. `prepare_close` in `get_my_workspace_capabilities().allowed`;
3. `get_workspace_commercial_state().capabilities.CLOSE_ASSURANCE` = `{ allowed: true, code: "ALLOWED" }` — computed by
   the same `_authorize_paid_action` the server uses.

An engagement's service scope (e.g. Trial Balance Review in the engagement) is not a workspace capability and never
makes Retry available. Unknown or unreadable state → no Retry. Residual: the UI reads both answers once per load; a
plan or capability change in between is refused server-side with its named code. Personal uploads (no workspace) are not
offered Retry from these workspace surfaces; the server's uploader rule still applies to them.

## 5. Proof reliability

The CI invocation (`createdb <db>`, then the proof in `DB_PROOF_MODE=external`; bash `-e`) was reproduced against a
standalone PostgreSQL: clean → exit 0 (`bun scripts/db-proof/mappingProcessingAuthority.mjs`,
`node scripts/db-proof/uploadLifecycle.mjs`); one temporary mutation of the S1 migration (`get_authoritative_certification`
no longer honours invalidations) → exit 1 for both, each naming the failing assertion; the migration restored
byte-identical (SHA-256 checked). The S1 proof runs under **bun** in CI because it imports the real TypeScript
cash-perimeter reader. The S1 proof was also run on the chain the hosted database is expected to have: every migration **except** the
parked `20261004100000` and `20261005100000`. It passed 162/162. S1 references no object they define, and they touch
only `safisha_status`, which S1 leaves client-writable as before. Local **embedded** mode can print FAILED with exit 0 for proofs ending in `process.exitCode = …`;
that is never used as evidence and is tracked separately.

## 6. One coordinated release window

Forward-only. Every step uses the existing paths only: Lovable's native migrator for the migration, ordinary function
deploys, an ordinary publish. No new executor or wrapper. Until step 5 completes, S1 is **not** described as hardened.

### Step 0: before apply, G0 read-only checks (Lovable, read-only, never preview)

Record the results; any surprise stops the release before anything changes.

- **Journal and chain:** the hosted journal head; whether `20261004100000` and `20261005100000` are absent (expected:
  parked, not applied); `pgcrypto` is in schema `extensions` (`extensions.digest` exists).
- **Grants and policies today:** on `account_mappings` and `trial_balance_uploads` (table- and column-level grants for
  `anon` / `authenticated`, policies, triggers). This confirms what S1 replaces.
- **Mapping counts (the OD2 baseline):**
  - company mappings in total;
  - how many have a latest decision for the same company and key that is approving and whose content equals the
    mapping's seven fields (the rows the backfill will link);
  - how many will stay unlinked (they go to review once);
  - global (`company_id IS NULL`) rows;
  - rows whose `user_id` is not an accepted member of their `company_id` workspace (forged-looking);
  - unsupported combinations (`statement = 'cash_flow'`, cash-flow classes, statement/class mismatches).
- **Processing state:** uploads at `status = 'validating'` (in flight or stuck), pending discard / cleanup operations,
  and the latest authoritative certification per active upload (the set the release must not silently change).

### Step 1: hold processing activity

The migration takes short exclusive locks on `account_mappings` and `trial_balance_uploads`, and until step 3 the old
engine still trusts unproven mappings. So, during the window:

- **Drain in-flight processing:** wait until no upload is at `validating` (G0 query). Record any upload stuck at
  `validating` and leave it alone; after the release, recover it with a service-role status reset (§1).
- **Hold new processing:** announce a short maintenance window. This repository has no processing kill switch, so the
  team does not invoke uploads, Retry or review saves during the window. Any invocation that happens anyway is
  identified afterwards (step 6) and re-checked.
- **Pause the scheduled sweeper:** `trial-balance-source-sweeper` (the only `cron.schedule` in the repository), and do
  not run `trial-balance-storage-cleanup` or `maono-monitor` manually, so no discard/cleanup claim or MAONO run
  straddles the change.

### Step 2: apply `20261006100000` (Lovable native migrator)

One transaction. On failure nothing changes; the release stops and the failure is investigated.

### Step 3: deploy the provenance-aware functions immediately

`process-trial-balance`, `maono-compute` and `maono-cashflow` (the two MAONO functions bundle
`_shared/certifiedTbSource.ts`).

### Step 4: publish the frontend

The `tbu_request_reprocess` Retry, with capability and entitlement gating. It must follow step 2: before it, Retry calls
a missing RPC and fails visibly.

### Step 5: resume and verify

Resume the sweeper and processing. Then read back:

- the S1 objects are present (grants, policies, triggers, functions);
- the linked-row count equals the G0 backfill prediction;
- one synthetic upload on the demo workspace reaches its expected state;
- an unproven mapping goes to review.

### Step 6: after confirmed application

- **Hosted journal reconciliation:** a read of the hosted journal confirms the application. Then a separate record PR
  writes the **actual** journal number, hash and applied timestamp, adds the numbered drizzle mirror, and moves the file
  into the applied-immutability and inventory/ordering pins. If the journal shows a different number or hash, or an
  intervening entry, the record PR uses the hosted values.
- **Parked migrations:** once S1 is mirrored, the migration-authority guard (rule 3) treats the parked
  `20261004100000` / `20261005100000`, which sort before it, as skipped by the hosted journal. The record PR must
  reconcile them with the repository's existing mechanisms: the precedent of moving an unapplied source to
  `supabase/migrations_historical/` (PPG-1), or an owner decision to apply them first. Not decided here.
- **Re-check anything processed between steps 2 and 3:** list the certifications committed after the step-2 applied
  timestamp and before the step-3 deploy. The old engine made each of them, and each is re-checked through
  `tbu_request_reprocess` by its workspace.

### Recovery: migration applied, deployment fails

The state is: migration in; old functions (and possibly the old frontend) still live.

- **What stays safe:** clients cannot write mappings or processing fields. The old frontend's direct writes are refused
  and the error is ignored, and processing still sets its own status. Certification invalidation and the reprocess RPC
  work.
- **What is unsafe:** the old handler and the old MAONO reader still trust unproven company mappings and cash flags.
- **Do:**
  - keep processing held (step 1);
  - retry the failed deploy;
  - if only some functions deployed, deploy the rest. Every combination fails safe towards review / `CANNOT_ASSESS`,
    never towards trust;
  - do not publish the frontend until step 3 is complete;
  - if a deploy cannot be completed in the window, keep the hold, record the state, and resume processing only after
    the provenance-aware handler is live.
- **Never:** revert the migration, restore the old `get_authoritative_certification`, or re-grant client write access
  to mappings or processing fields (blueprint §9). There is no down migration.
- **If the frontend publish fails:** there is no safety impact, because the old frontend works against the new backend
  (its writes are refused and processing still runs). Retry the publish.

### Still unsafe after the window (not S1)

- Crash at `validating`, the pre-claim window and two-operation-id acceptance (§1): S2/E2.
- Notes and management-letter writers to `processing_result`: E2.
- `kinga-findings-engine` reads mapping flags without provenance; fix it before it is re-enabled.
- Real handler on real PostgreSQL: pending (I-1a harness, E1).
- **`CONFIRM_ACCOUNT_TREATMENT`: required before E1** (§3).
