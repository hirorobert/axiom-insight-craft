# QuickBooks connector (B9): independent review findings, response r1

**Scope.** Nine matters raised against the storage migration (PR #239) and the two PRs stacked on it (#240 functions, #241 screens). **Nothing was merged, deployed or applied, no hosted migration transport was generated, and no unrelated
functionality was changed.** Every claim below names the file that backs it and the test that proves it; what could not be proved here is said plainly under "Remaining risk".

| # | Matter | Severity (before) | Status |
|---|---|---|---|
| 1 | Actor identity convention | Medium (consistency) | Evidence packet ready; **needs Patrick Sawe's review** |
| 2 | Upload registered, provenance not recorded | High | **Corrected and proved** |
| 3 | `qbo_pulls` kept after workspace deletion | Medium (privacy/legal) | Policy proposed; **needs the lawyer's written conclusion** |
| 4 | Cleanup and seven-year retention | Medium | **Corrected for states and dead tokens; evidence purge deliberately deferred** |
| 5 | Migration chain, negative controls, CI, authority | Evidence | **Supplied; CI to be re-read on the final head** |
| 6 | Token refresh concurrency | High | **Corrected and proved; one Intuit behaviour still unverified** |
| 7 | The two permissions | Medium-High | **Corrected (one rule for every function) and proved** |
| 8 | Deno type-check of #240 | Medium (unverified) | **Open until CI runs it** (see 8) |
| 9 | Stack and merge order | Low | **Verified** |

---

## 1. Actor identity convention (`actor_user_id`, `workspace_authority_basis`)

**Evidence and affected files.** `supabase/migrations/20261212100000_qbo_connector_storage.sql` records the authenticated user id as `actor_user_id`, judges every right through `workspace_authority_basis(user, company, capability)`, and (new) records
the *basis* of each right beside the actor (`prepare_basis`, `source_basis`: `workspace_owner` | `explicit_capability`). `CLAUDE.md` section 4.3 says `firm_members.id` is the actor for financial writes. These two statements disagree, and the repository's
authority model has moved on from the second:

- `workspace_authority_basis` (`20260923100000_upload_lifecycle_retire_and_replace.sql`, section 3) states in its own header: "Never reads firm_members or any occupational title." The workspace **owner** is authorised through `companies.user_id`
  and needs no `firm_members` row at all. In the proof's world (`scripts/db-proof/lib/reportingKit.mjs`, `makeWorld`) the owner has no `firm_members` row yet is fully authorised.
- `tbu_authorize` in the same migration returns `membership_id` and labels it "Compatibility metadata only. It is never consulted for authority."
- The tables written under that model (`trial_balance_source_reservations`, `trial_balance_source_download_events`, `workspace_capability_grant_events`) record the user id plus an `authority_basis`. The connector tables now do the same.
- So `firm_members.id` cannot be the identity for every actor (an owner has none). A text search of migrations since 2026-09-23 finds `actor_user_id` in 60 files, 32 of which also mention a membership column; this count is coarse and is offered only as orientation.
- Is the connector a "financial write" in the sense of section 4.3? It writes connector state and import provenance; it writes no `tax_computations`, `engine_runs` or statement table. The figures it hands over enter through the ordinary upload steps, which
  run **as the person** and record their own actor.

**Severity.** Medium: a governance inconsistency, not an exploitable defect. **Required correction.** An independent confirmation that this is the intended convention for B9, and a decision whether `CLAUDE.md` section 4.3 should be amended to say which
tables it still governs. **Test.** `qboConnectorStorage.mjs`: `completion.links-the-intent-to-the-upload...` and `completion.a-right-lost-after-registration...` assert the recorded actor and both bases (`workspace_owner`; `explicit_capability` for a delegate).
**Remaining risk.** This is a judgement the independent reviewer must make; I have not made it for them. The reviewer's independence declaration and the committed date are also still outstanding.

**Questions for Patrick Sawe.** (a) Do you accept `actor_user_id` + basis as the B9 convention? (b) Should evidence also carry `membership_id` as compatibility metadata, as `tbu_log_event` does (it is NULL for an owner)? (c) Should section 4.3 be amended?

## 2. A registered upload without complete provenance

**Evidence.** Before: `runQboPull` registered the upload and *then* wrote provenance; if that write failed it answered `provenance_failed` (500) and left a registered upload with no evidence, and the browser told the person it "was imported".
**Correction.** Evidence first, link after, recoverable (`_shared/qboPull.ts`, `qbo_*` functions in the migration):

1. After the report is fetched and the upload **reserved**, `qbo_record_pull_intent` writes the facts (request, currency, the three SHA-256 fingerprints, both bases) keyed by the **reservation id**, retried three times (idempotent). **If it cannot be written, nothing is
   stored or registered**: no upload exists, so none can lack evidence. The outcome is `provenance_failed` and the card now says "Nothing was imported".
2. The file is stored and registered as the person.
3. `qbo_complete_pull(reservation)` links the intent to the upload **the reservation itself recorded** (`consumed_by_upload_id`), never a caller-supplied id; idempotent; retried.
4. If only step 3 fails, the evidence is already complete and the answer is the distinct `imported_record_pending` (HTTP 202) with the upload id: a true statement, never "imported" and never an error that hides a real upload. The next import
   (and `qbo_complete_pending_pulls`) finishes the link. A report fetched but never imported keeps its intent as evidence ("fetched, not imported").

**Severity.** High (an audit gap in an accounting record). **Test.** Database: `intent.*` (4), `completion.*` (2), `recovery.*` (2): a real reserve, intent, register and complete on the full migration chain; recovery completes exactly the missing links and one bad
row never stops the rest. Function: `qboPull.test.ts` "the evidence cannot be lost" (7 tests, including: nothing stored when the intent cannot be written; retries; 202 when only the link fails; evidence strictly before `putObject` and `register`).
Breakage controls: removing the evidence-first guard (T3) and reporting `imported` on a failed link (T4) both fail the tests; linking an upload id the reservation did not vouch for (M4) fails three database cases.
**Remaining risk.** Between steps 2 and 3 the upload exists with its facts on file but not yet linked (seconds, or until the next import if step 3 keeps failing); the facts are never absent. The proof simulates the storage object row (`storage.objects`),
it does not run Supabase Storage. A crash exactly between `register` and the response leaves an unlinked but fully evidenced upload: the same recovery covers it.

## 3. `qbo_pulls` after workspace deletion: policy

**Facts.** `qbo_connections` and `qbo_oauth_states` cascade-delete with the workspace (tokens go with it). `qbo_pull_intents` and `qbo_pulls` have no foreign key and **survive**. What they hold, pinned by `evidence.holds-no-secret-url-or-payload-and-no-foreign-key`:
workspace id, QuickBooks company id (realm), dates, currency, account count, three SHA-256 fingerprints (not reversible to any figure), the actor's user id and the basis of their rights. **No** name, email, amount, account name, token, URL or payload.

**Proposed policy (for the owner to adopt after the lawyer's written conclusion).**
- *R1.* Evidence is kept **seven years from the pull** (the working figure from decision D3) and survives workspace deletion, because its purpose is to show where accounting figures that were produced came from. It contains no financial figures.
- *R2.* Everything that can act (connections, tokens, states) is deleted with the workspace and when expired or disconnected.
- *R3.* The actor id is a pseudonymous account identifier. An erasure request is handled as a documented, owner-approved, audited maintenance operation by the database owner (replacing `actor_user_id` with a fixed tombstone value for the affected rows), **not** by the application. This is not built, because it needs the append-only guard lifted for one column and that
  should be designed once the lawyer has said whether it is needed at all.
- *R4.* A purge at seven years is designed and approved later (see 4).

**Questions for the lawyer.** (a) Is retention of this evidence after workspace deletion permitted, and on what basis? (b) Is seven years right, and measured from what? (c) Is an orphaned user id (account deleted) still personal data? (d) What is owed to a person who asks
for erasure? (e) Does the answer differ by the customer's country?

**Severity.** Medium. **Test.** The structural facts above are pinned by the proof; the policy itself cannot be tested. **Remaining risk.** The lawyer's written conclusion is still missing; until it exists the retention position is the owner's working assumption, not a reviewed one.

## 4. Cleanup and retention

| Data | Rule | Mechanism | Proof |
|---|---|---|---|
| OAuth states | Removed one day after expiry | `qbo_housekeeping()`, run opportunistically by `qbo-connect-start` (best effort, never part of its answer) | `housekeeping.removes-old-states...` (a three-day-old state goes, a one-hour-old one stays) |
| Connections whose refresh token expired | Become `reconnect_needed`, dead token deleted | same function | same case, including `hard_expires_at` |
| Evidence (`qbo_pull_intents`, `qbo_pulls`) | Seven years, then a purge **to be designed and approved** | `qbo_provenance_past_retention(interval)` only **counts** (at least one year) | `retention.only-counts...`; and `housekeeping...never-evidence` shows evidence untouched |

No scheduler or automation surface is added. **Why no purge now:** the first row cannot reach seven years before late 2033; shipping a way to delete from an append-only evidence table years before it is needed is risk without benefit. **Action recorded:** a purge must be
designed, reviewed and approved before 2033-11-01. **Severity.** Medium. **Remaining risk.** If nobody connects again, expired states linger until the next connection start; they are tiny and harmless (single-use, hashed, expired).

## 5. Evidence

- **Migration chain.** `scripts/db-proof/qboConnectorStorage.mjs`: **35 of 35** cases pass on the full chain (`applyChain`, every migration, in order) in a disposable local PostgreSQL; includes real `reserve_trial_balance_source` and `register_trial_balance_upload`.
- **Negative controls (new).** Beyond the refusal cases, the migration was deliberately broken six ways and the proof had to fail at the expected case each time: M1 evidence function without the upload right, M2 a lease anyone can take, M3 no append-only guard on intents,
  M4 linking an upload the reservation did not vouch for, M5 housekeeping that also deletes evidence, M6 the shared rule forgetting the upload right. **All six were caught at the intended case** (M1 now reports "not applied" because the evidence function uses the shared
  rule, which M6 covers). The function side was broken five ways (T1 no upload right, T2 no lease, T3 store before evidence, T4 report success on a failed link, T5 never release the lease); **all five failed the tests**. The migration and the function file were restored after each run (verified by `git diff`).
  The first M2 run failed in setup because of a bug in my own mutation script (`$$` collapsed by JavaScript's `replace`); it was fixed and re-run, and the result above is from the corrected run.
- **Migration authority.** `node scripts/audit_migrations.mjs --strict` -> `VERDICT: CLEAN` (208 files). `node scripts/ci/assertMigrationAuthority.mjs` -> `OK ... PENDING_HOSTED_APPLY: 20261212100000_qbo_connector_storage.sql`.
- **Pin-list guards.** `releaseJournal`, `migrationAuthority`, `migrationReplayCompatibilityGuard`, `billingTriggerRepairMigration`, `databaseInert`, `claudeFileMap`: 675 tests pass (with a 120 s per-test limit: two child-process tests exceed vitest's 5 s default on this machine).
- **Unit and component tests.** `qboPull` 52, `qboConnectorClient` 16, `qboConnect` 23, card 13: all pass. Lint is clean on the touched files. The type-check reports errors only in files that need `tesseract.js` and `axe-core`, which are not installed locally; none is in a connector file.
- **CI.** #239 was fully green on its previous head (all ten checks). It re-runs on the final head after the push. **#240 and #241 have never had CI**: `.github/workflows/ci.yml` triggers only on pull requests whose base is `main`, and these are stacked (see 8, 9).

## 6. Token refresh concurrency

**What can go wrong.** Intuit rolls the refresh token. If two imports refresh with the same token at once, one of them may leave the connection holding a token Intuit has already retired. A search summary of Intuit's authorization FAQ says the previous token expires when a new one
is issued; I could not open that page (it is a dynamic site), so treat this as **reported, not verified at the primary source**. The question about simultaneous refreshes is in support case 00231947.

**Correction (prevent first, recover second).**
1. *Lease before Intuit.* `qbo_acquire_refresh_lease` is a compare-and-set on the connection row, naming the envelope the caller will present. Of eight simultaneous callers exactly one gets it; the rest are told `busy` **without any call to Intuit**. It lapses by itself (90 s) if the holder dies.
2. *Compare-and-swap on rotation* (already there): the new token is stored only if the stored one is still the one used; the loser's token is discarded and it is told `busy`. This is the backstop if a lease lapsed.
3. *The lease is released on every path that did not rotate* (Intuit down or refusing, an exception); rotation and "reconnect needed" clear it themselves; after a lost swap it is not ours to release.

**Failure and recovery, case by case.**

| Situation | What happens | Recovery |
|---|---|---|
| Two imports at once | Second gets `busy` before any call to Intuit | Retry in a moment |
| Lease lapsed (holder crashed) and two refreshes did occur | Exactly one stores its token; the other is `busy` and fetches nothing | If Intuit retired the stored token, the next refresh is refused -> connection becomes `reconnect_needed` (token deleted) -> person reconnects |
| Process dies after Intuit issued a new token and before it was stored | The stored token may already be retired | Same: detected on the next refresh, never silent; reconnect |
| Intuit unavailable / refuses for another reason | Nothing stored, lease released | Retry later |
| Intuit says `invalid_grant` | Connection marked `reconnect_needed`, token deleted | Reconnect |

**Severity.** High. **Test.** Database: `lease.only-one-caller-holds-it...` (8-way concurrency), `lease.lapses-by-itself...`, `lease.never-outlives-an-active-token`, `rotation.is-compare-and-swap...`. Function: "two pulls at once" (3 tests: one refresh reaches Intuit; a third request is not blocked afterwards;
with a lapsed lease the swap still lets exactly one win), plus the lease-release tests. T2 and T5 fail them. **Remaining risk.** (i) Intuit's exact behaviour is unverified at the primary source. (ii) The crash window above cannot be closed without Intuit's cooperation; it is detected, not prevented. (iii) A refresh slower than 90 s could let a second caller in; the swap still protects the stored token.

## 7. The two permissions

**Evidence and what was wrong.** The connector's own functions judged only `prepare_trial_balance`; the upload steps (`reserve_trial_balance_source`, `register_trial_balance_upload`, which run as the person) judge `manage_source_files` through `tbu_authorize`. So (a) a person with only the first could **connect a
QuickBooks company to the workspace** and be shown an Import button that could only fail, and the connected company would be what a fully-authorised colleague was offered; (b) the import function refreshed and rotated the token *before* the upload step discovered the person lacked the second right.
**Correction.** One rule for **every** connector function: `qbo_connector_basis(user, company)` requires **both** rights, each from `workspace_authority_basis`; used by start, consume (so losing either right between start and callback ends the attempt), store, disconnect, status and the
evidence function (which also re-checks the reservation is the person's own). The import function checks both **before** touching Intuit. The helper has no grant to any client role. Neither right implies the other.
**Severity.** Medium-High. **Test.** `connector.every-function-needs-both-rights-and-neither-alone-is-enough` (each single right refused at every function; either right lost mid-flow ends the attempt and the state cannot be retried), `intent.needs-both-rights...`;
function: "the right to prepare but NOT to manage source files: refused BEFORE Intuit is touched" asserts the stored token is untouched. M6 and T1 fail them. **Remaining risk.** Delegates now need two explicit grants to use the connector (the owner has both). That is intended; it is a product consequence, not a gap.

## 8. Deno type-check of #240

**Evidence.** CI `Edge function checks`-style `deno check` of the three entry files is defined in `ci.yml` on the #240 branch ("Type-check the QuickBooks connector functions"). **It has never run**: CI triggers only on pull requests whose base is `main` (`on.pull_request.branches: [main]`), and #240 is based on #239's branch; GitHub reports "no checks" for #240 and #241.
Deno is not installed on the author's machine, so there is no local type-check of the entry files either (ESLint ignores `supabase/functions`).
**Correction.** After this push, a *draft verification pull request* from the final head into `main` runs the whole suite including `deno check`, without changing the stack. Its result is recorded below when read. The entry files were simplified to avoid a typed helper parameter whose compatibility I could not check locally.
**Severity.** Medium until read. **Remaining risk.** Until that CI result is read, the claim "#240 type-checks under Deno" is **unproven**.

## 9. Stack and merge order

**Verified (`git merge-base --is-ancestor`).** `origin/main` is an ancestor of #239's branch; #239's branch is an ancestor of #240's; #240's of #241's. The **only** migration in the whole stack is in #239 (`20261212100000`), later than every migration on `main` (latest `20261211100000`); no other open PR carries a migration at or after
`20261212` (#149 and #47 carry older timestamps and are unrelated). #240 and #241 add no migration.
**Merge order.** #239 -> #240 -> #241, each retargeted to `main` after the one below merges (GitHub does not retarget a stacked PR whose base branch is not deleted; do it explicitly). Merging is safe in any state because the connector is inert: no function is deployed, the migration is unapplied, and the screen constant `QBO_CONNECTOR_ENABLED` is `false`.
**Release order is a different thing and is fixed:** (1) apply the storage migration through the repository's release route; (2) create the secrets; (3) deploy the three functions; (4) the owner tries a sandbox connection; (5) set `QBO_CONNECTOR_ENABLED = true` in a reviewed commit and publish; (6) production only after Intuit approves it. **Severity.** Low. **Remaining risk.** The merge-train needs the manual retargets above.
