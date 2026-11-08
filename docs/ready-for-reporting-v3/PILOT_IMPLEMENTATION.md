# Ready for Reporting — pilot implementation (rfr-acceptance/2)

Status: **authored and tested locally; nothing is applied, deployed, published or switched on.** The migration is not applied to any
hosted database, the Edge Function is not deployed, and customer QuickBooks access stays off (`QBO_CONNECTOR_ENABLED = false`).
This document records what the pilot implements, the evidence for each claim by category, and what is still open.
Companion files: `READY_FOR_REPORTING_V3.md` (design), `ACCEPTANCE_CONTRACT.md`, `CHANGE_LOG.md`.

## 1. The five audited defects

The independent review of `8bb3b1fb9eecf4cb5d564e43299107cea070f398` found five defects. Each was reproduced first
(`scripts/acceptance/rfr-v3/auditRegression.mjs --audited` reads the audited model and runner from git: 15 of 17 cases fail, the two
controls pass), then fixed in the reference model, the runner, the real engine and the database.

| # | Defect | Fix | Where it is proved |
|---|---|---|---|
| D1 | Missing evidence could pass: required scopes started `READY`; a balanced TB alone cleared everything. | Nothing starts READY. A scope is READY only on a **designated positive proof** (or a confirmed finding resolved by an effective correction) and no holding finding. Required scopes are **derived** from the scope facts, every known bank account and the rule pack (`rulePack.ts`); the caller's list can only add. An unevaluated required scope is HELD with reason `NOT_EVALUATED`. Drafting stays available. | cases `D1-*`; `auditRegression D1-a/b`; PostgreSQL `a3`, `a4` |
| D2 | An adjustment counted twice (proposal path and persisted path); a credit payable remained and readiness cleared. | **One authoritative set of effective corrections** keyed by identity (`corrections.ts`): a repeat counts once; one identity with two effects, or two identities with one effect, hold and apply neither; reversals remove their target; post-conditions (payable nets to zero, expense falls by exactly the payment, cash untouched) are checked on the result, counting the part of the fix the source already carries. The database layer must equal the engine's balances (`balances_agree`) or finalization is blocked. | cases `D2-*`; PostgreSQL `b1`–`b6` with exact balances |
| D3 | The sandbox runner could manufacture a pass (a header-only CSV twice, dummy metadata). | `sandboxProof.mjs`: strict CSV, no empty files, no duplicate keys, validated metadata, byte-distinct independent export with its own provenance, **seeded known postings**, and a **recorded run** (ids, times, Intuit request ids, raw response hash). File parity alone is reported as `EXPORT_PARITY`, never as a sandbox proof. Without access the status is `NOT_RUN` (exit 3). | `sandboxProof.test.ts` (12 tests), `auditRegression D3-*` |
| D4 | Evidence passed without the facts a rule requires (an undated invoice in a date window; a right-type document for an opening difference). | `probative()` requires every fact the rule depends on to be **present and equal**; a date window needs a date; opening classifications need the amount, the account and a date within a window; cut-off dates come from the evidence and absence from the reliable ledger, not caller-typed fields. Human confirmation and extraction status make facts admissible, never relevant. | cases `S1-M3..M5`, `S10-M1..M6`, `E2-M4/M5`; `auditRegression D4-*` |
| D5 | Finalization mixed reviewed content with refresh timing. | The **review binds a content digest** (certification, applied adjustments, scope facts, every input's payload hash; it excludes pull times). Freshness is a **separate attestation**, bound to that digest, that expires after ten minutes. Identical books renew it without re-review; changed books change the digest and need re-review. Missing, expired, mismatched, over-long or "changed" attestations hold finalization for QuickBooks-bound inputs. | cases `D5-*`; PostgreSQL `c1b`, `f1`–`f6` |

**Residual limitation, stated in every FINAL manifest:** the check cannot see an edit made in QuickBooks after the last pull and before
the commit ("Source re-read at <time>").

## 2. What was built

* **Engine** — `supabase/functions/_shared/readiness/` (pure TypeScript; no clock, no I/O): `evaluateReadiness`, the rule pack, the
  effective-correction set, evidence tests, finalization holds, and `runReadinessCheck` (load → evaluate → record). Independent of the reference model.
* **Database** — `supabase/migrations/20261216100000_ready_for_reporting_pilot.sql` (authored, **not applied**): opt-in per company and period
  (`rfr_set_scope`); immutable, hash-addressed inputs (`rfr_register_input`, hashes computed by the database); corrections bound to adjustments
  (`rfr_propose_correction`, with bundles and `supersedes`); `rfr_runs`, `rfr_reviews`, `rfr_source_attestations`, `rfr_finalization_manifests`
  (all append-only, no client write path); `rfr_content_digest`; the blockers spliced into `fs_publication_blockers` **in place** (asserted, not copied);
  REVIEWED/FINAL recorded by a trigger in the transition's own transaction. Every writer takes `_fs_scope_lock`, including the existing
  adjustment tables (trigger). Scopes that did not opt in are unchanged.
* **Edge Function** — `rfr-check-books` (signed-in member with `prepare_close`; service credential for the engine). Not deployed.
* **Intake** — strict readers (`src/lib/readiness/intake`) for the general ledger, one complete bank account, approved prior-year figures and the evidence register; refusals name file, line and column.
* **Pilot fixtures** — `src/lib/readiness/pilot/fixtures` (synthetic; constructed facts labelled in its README).
* **Page** — Close Review › **Check my books** (`close/books`): import, one dominant action, one issue per held check with exact figures and one next action, a supported correction proposed as an opening-first bundle, the status of each check, and the handoff to Statements.
* **Acceptance** — `scripts/acceptance/rfr-v3/` (fixtures `cases.mjs`, model, strict runner, `adapters/implementation.mjs`, `auditRegression.mjs`); proofs in `scripts/db-proof/readinessFinalization.mjs`.

## 3. The user journey verified

Frozen exports → *Check my books* → exact issue → reviewed correction → reviewed adjusted trial balance → existing reporting workflow →
server-enforced finalization:

1. The trial balance is certified through the existing processing (PostgreSQL proof, World 3).
2. The accountant opts the period in, imports the general ledger, the bank statement, the approved prior-year figures and the evidence register (`rfr_register_input`).
3. *Check my books* runs the engine over the stored rows and records the run; the page shows the confirmed double charge: *"TZS 33,518,793.00 was charged to … expense on 2 July 2025, but it paid last year's approved bill 003/2024.2025 … Cash does not change."* and the two supported corrections.
4. The preparer proposes them (`rfr_propose_correction` → the existing `close_review_propose_adjustment`); a second person approves (`close_review_decide_adjustment`).
5. The adjusted trial balance (`close_review_adjusted_trial_balance`, which `fs_reporting_input` already hands to Statements) is exactly: expense 105,279,755.00, payable 0, Opening Balance Equity (271,838,585.30) credit, cash unchanged; the engine agrees (`balances_agree`).
6. REVIEWED records the content digest; FINAL recomputes it under the scope lock and refuses on any difference. Alternatively the correction is posted in QuickBooks and verified on reimport (PostgreSQL `b5`), or completed after a partial fix (`b6`).

## 4. Results, by category (none stands in for another)

| Category | Command | Result at the recorded commit |
|---|---|---|
| Runner self-checks | `node scripts/acceptance/rfr-v3/run.mjs --self-check` | fixtures vs the reference model; proves nothing about CFOClose |
| Implementation tests | `bun scripts/acceptance/rfr-v3/run.mjs --implementation scripts/acceptance/rfr-v3/adapters/implementation.mjs`; `bunx vitest run src/lib/readiness src/components/readiness` | the real engine on every case and mutation; the page on the real engine |
| PostgreSQL concurrency proofs | `bun scripts/db-proof/readinessFinalization.mjs` | C1, C2 (both orderings with held transactions), C3, C4 (catalogue and behaviour), C7, freshness matrix, exact balances |
| Authenticated QuickBooks tests | `run.mjs --sandbox <manifest>` | **NOT_RUN** — no authenticated sandbox company or recorded run is available |

## 5. Open items and what clears them

| Blocker | Evidence that clears it |
|---|---|
| The migration is not applied; production deployment, hosted migrations, merge and publishing are outside this work | owner or Lovable applies it through the registered path, then a staging replay |
| QuickBooks `GeneralLedger` is not allow-listed; C5/C6 are `NOT_RUN` | a recorded run against an authenticated sandbox company that passes `run.mjs --sandbox` (known postings, independent export, Intuit request ids) |
| The real EWMA General Ledger export, opening journal, voucher and payee confirmation are not held; E2 is constructed | the real exports replacing the constructed rows, E2 re-run; the draft fixtures' freeze checks closed |
| The pull-side caller of `rfr_record_source_attestation` and `rfr_register_source_input` is not wired into the QuickBooks pull | a reviewed change to `qbo-pull-trial-balance`, then C5/C6 |
| `rfr-check-books` has no Deno type-check run here (no Deno on this machine) | the CI step `deno check` |
| A signed-in browser session of the page against a real backend | staging acceptance |
| Citation register: IAS 8 and IFRS for SMEs Section 10 stay unverified | read against the current standards before any rule cites them |

## 6. Contract changes from rfr-acceptance/1 (also logged in CHANGE_LOG.md)

* Required scopes are derived (`scope_facts`, every bank account) and carry `required_scopes` and `scope_reasons` in the result.
* `freshness` now carries an `attestation` object and `now`; `review` and `content_sha256_now` bind the review to content. The old boolean `reconfirmed` is not accepted.
* Ledger tie-out: an account on one side only ties when its closing is exactly zero (a trial balance may omit a zero-balance account); entries with no stated opening are never assumed to open at zero.
* The original posting of a double charge is never read as its correction; a posting recognised as the verified fix is not a second settlement.
* A finding is resolved by an applied correction **or** by a fix the source ledger already carries (verified or completed by a residual).
* Cut-off absence is shown by the reliable ledger, not by a list the caller typed (the S1 fixture now carries a ledger).
