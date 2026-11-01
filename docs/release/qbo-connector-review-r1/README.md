# QuickBooks connector (B9): independent review findings, response r1

**Scope.** Nine matters raised against the storage migration (PR #239) and the two PRs stacked on it (#240 functions, #241 screens). **Nothing was merged, deployed or applied, no hosted migration transport was generated, and no unrelated
functionality was changed.** Every claim below names the file that backs it and the test that proves it; what could not be proved here is said plainly under "Remaining risk".

| # | Matter | Severity (before) | Status |
|---|---|---|---|
| 1 | Actor identity convention | Medium (consistency) | Evidence packet ready; **needs Patrick Sawe's review** |
| 2 | Upload registered, provenance not recorded | High | **Corrected and proved** |
| 3 | `qbo_pulls` kept after workspace deletion | Medium (privacy/legal) | Policy proposed; **needs the lawyer's written conclusion** |
| 4 | Cleanup and seven-year retention | Medium | **Corrected for states and dead tokens; evidence purge deliberately deferred** |
| 5 | Migration chain, negative controls, CI, authority | Evidence | **Supplied; CI to be re-read on the final head** (r2: on the last pre-r2 head `987ba97`, eight checks passed, Staging RLS is skipped by design, Disposable-DB was still running when this was written; the final head is read in #242) |
| 6 | Token refresh concurrency | High | **Corrected and proved; one Intuit behaviour still unverified.** r2 found and corrected three further defects (S1–S3) |
| 7 | The two permissions | Medium-High | **Corrected (one rule for every function) and proved** (r2: re-read, no defect) |
| 8 | Deno type-check of #240 | Medium (unverified) | **Closed in r2:** `deno check` passes in CI (PR #242) and locally (see 8) |
| 9 | Stack and merge order | Low | **Verified** (r2: re-verified) |
| S1–S5 | Second pass (lease ownership, call timeouts, swap retry, OAuth callback binding, realm check) | High to Low | S1–S4 **corrected and proved**; S5 **narrowed, still open** (no realm read) |

Findings 1 and 3 stay open: there is no written review from Patrick Sawe and no written conclusion from the lawyer in this repository or this record. Nothing in r2 changes either.

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
3. *The lease is released on every path that did not rotate* (Intuit down or refusing, an exception); rotation and "reconnect needed" clear it themselves; after a lost swap it is not ours to release. (r2: superseded by S1, the lease is now given back by its own id on every path except a stored rotation.)

**Failure and recovery, case by case.**

| Situation | What happens | Recovery |
|---|---|---|
| Two imports at once | Second gets `busy` before any call to Intuit | Retry in a moment |
| Lease lapsed (holder crashed) and two refreshes did occur | Exactly one stores its token; the other is `busy` and fetches nothing | If Intuit retired the stored token, the next refresh is refused -> connection becomes `reconnect_needed` (token deleted) -> person reconnects |
| Process dies after Intuit issued a new token and before it was stored | The stored token may already be retired | Same: detected on the next refresh, never silent; reconnect |
| Intuit unavailable / refuses for another reason | Nothing stored, lease released | Retry later |
| Intuit says `invalid_grant` | Connection marked `reconnect_needed`, token deleted | Reconnect |

**Severity.** High. **Test.** Database: `lease.only-one-caller-holds-it...` (8-way concurrency), `lease.lapses-by-itself...`, `lease.never-outlives-an-active-token`, `rotation.is-compare-and-swap...`. Function: "two pulls at once" (3 tests: one refresh reaches Intuit; a third request is not blocked afterwards;
with a lapsed lease the swap still lets exactly one win), plus the lease-release tests. T2 and T5 fail them. **Remaining risk.** (i) Intuit's exact behaviour is unverified at the primary source. (ii) The crash window above cannot be closed without Intuit's cooperation; it is detected, not prevented. (iii) A refresh slower than 90 s could let a second caller in; the swap still protects the stored token. (r2: closed by S2, the token call is abandoned after 30 s.)

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

**Result (r2).** The verification pull request is #242 (`feat/qbo-connector-ui` -> `main`). Its first two runs failed, and both failures were real:
(i) `Could not find "@supabase/supabase-js" in a node_modules folder`: the three entry files imported `npm:@supabase/supabase-js@2` (and `.../cors`), which Deno 2 resolves from a `node_modules` folder when a `package.json` exists, and that job installs none.
The fix (`eca35fd`) imports the client the way the other 39 Edge Functions in this repository do (`https://esm.sh/@supabase/supabase-js@2`) and the CORS headers from `_shared/auth.ts`; the workflow is unchanged. Provisioning `node_modules` in that job was not needed and was not added: no checked connector file uses an `npm:` specifier any more.
(ii) Five `TS2345`/`TS2322`/`TS2769` errors at the WebCrypto calls (`Uint8Array<ArrayBufferLike>` is not a `BufferSource` under Deno's TypeScript): fixed by type-only casts (`206d0b3`, no runtime change).
On head `987ba97` the job *Edge function checks (Deno, process-trial-balance)* passed; its step "Type-check the QuickBooks connector functions" printed `Check` for each of the three files and no error. The check is not weakened: it is the same `deno check` of the same three entry files, against the real
`@supabase/supabase-js` declarations. A local `deno check` (Deno 2.9.6, an empty cache) downloaded those declarations from esm.sh (`@supabase/auth-js@2.112.4`, `realtime-js`, `phoenix` and others) and exited 0, again after the r2 changes.
**Remaining risk.** `https://esm.sh/@supabase/supabase-js@2` is a floating major version, the same as every other function here; a future 2.x release could change types. That is the repository's existing convention, not a connector-specific gap.

## Second pass (r2): defects found beyond the existing tests

Read again, line by line, against crashes and timing rather than the happy path: the evidence-first order, reservation recovery, lease expiry, token rotation, the two-permission rule and the OAuth callback. Three defects were corrected, two are registered.

**S1. The refresh lease could be released by an import that no longer held it (High; corrected).** `qbo_release_refresh_lease(connection)` cleared *any* lease on the connection. Sequence: import A takes the lease; Intuit is slow; A's lease lapses; import B takes it and is now at Intuit; A's
refresh fails and A's `finally` releases the lease, **B's** lease; import C takes it and presents the same refresh token while B is still in flight. The lease existed to prevent exactly that. Related: `qbo_mark_reconnect_needed(connection)` deleted whatever token was stored, so a refusal of an
*out-of-date* token (after a lapsed lease) deleted the newer, valid token another import had just stored and forced a needless reconnect.
*Correction:* the lease has its own id (`refresh_lease_id`, returned by `qbo_acquire_refresh_lease`); `qbo_release_refresh_lease(connection, lease_id)` releases only that lease; `qbo_mark_reconnect_needed(connection, refused_envelope)` acts only if the refused envelope is still the stored one;
`chk_qbo_conn_lease_pair` keeps the id and its expiry together. The import gives its lease back on every path except a stored rotation, by its own id (harmless when already cleared).
*Proof:* `lease.only-its-holder-releases-it-a-lapsed-holder-cannot-clear-the-next-holders-lease`, `reconnect-needed.only-for-the-token-intuit-refused-never-a-newer-one`; `qboPull.test.ts` "an import whose lease lapsed gives back only its own lease", "a refusal of an out-of-date token never deletes a newer one".
Negative controls: a release that ignores the id, and a mark that ignores the envelope, each fail exactly their new case (37/38).

**S2. No call to Intuit had a time limit (High; corrected).** The token call went through `fetch` with no timeout, so a slow answer could outlast the 90-second lease: the window S1 depends on, and the one the r1 "remaining risk (iii)" accepted. *Correction:* the guard gives every call
`AbortSignal.timeout` (token 30 s, report 60 s, `QBO_TIMEOUTS_MS`); an abandoned call is a network failure (`unavailable`), so the lease is given back. A unit test pins `3 x token timeout <= lease`, and another shows a hanging call is abandoned.
*Remaining risk:* the database calls inside the lease (the swap) have no client-side limit; the lease still covers them by 60 s.

**S3. A failed or unanswered token swap threw away the newest token (Medium-High; corrected).** After Intuit answered, `qbo_rotate_refresh_token` was called once; any error (a database fault, or a swap that was stored but whose answer was lost) ended the import, and a retry would have been
reported as a lost race. Because Intuit may already have retired the token we presented, that could force a reconnect for nothing. *Correction:* the swap is safe to retry (if the stored envelope is already the new one, it answers `true` and writes nothing; every envelope has its own random IV, so no other
writer can have stored that value) and the import retries it three times. *Proof:* `rotation.a-retry-whose-first-answer-was-lost-is-recognised-and-writes-nothing-twice`; unit tests "the swap fails for a moment...", "the swap cannot be stored at all..." (nothing fetched, lease given back,
old token kept, no secret in the outcome). Negative control: a non-retryable swap fails exactly the new case.

**The crash window between Intuit's rotation and our storage (re-examined; cannot be closed in code).** Once Intuit has answered with a new refresh token, the only durable copy is in the function's memory until `qbo_rotate_refresh_token` commits. If the process dies in that window (or Intuit's answer
is lost on the way back, which looks the same), the database still holds the token we presented. If Intuit keeps that token valid, the next import simply works; if Intuit has retired it, the next import gets `invalid_grant`, the connection becomes `reconnect_needed` (only that token is deleted, S1)
and the person reconnects. Nothing is imported wrongly, no token is leaked and the failure is visible. S2 and S3 shrink the window to a process death or a lost network answer; nothing on our side can remove it, because Intuit offers no idempotent refresh. Which of the two Intuit behaviours applies is
still the open question in support case 00231947.

**S4. The OAuth callback is not bound to the browser or person who started it (Medium; corrected and proved, see below).** The single-use state is the callback's only credential, and it is tied to the *starting* person and workspace, not to the browser that completes it. A person who
holds both rights in workspace X can start a connection, keep the authorisation address, and persuade someone else to open it and approve; that person's QuickBooks company would then be connected into workspace X. It needs social engineering and the victim's approval on Intuit's own consent screen,
and the browser then lands in a workspace the victim cannot open, but the books would be readable by X. *Standard correction (needs a design decision):* the callback stores the result as pending and hands the browser a one-time code; the app, as the signed-in person, finishes the connection only if
that person is the one who started it; or bind the state to a cookie set on the start request. Not attempted in this pass: it changes the flow across all three PRs and the screens.
*Design:* `S4_CALLBACK_BINDING_DESIGN.md` (the cookie and PKCE alternatives are rejected there with reasons). *Built:* the callback exchanges nothing and never calls Intuit. It seals the code (bound to the handoff's hash), parks it with `qbo_record_oauth_return` (consuming the state once) and redirects with
`#qbo_handoff=` in the fragment. The new `qbo-finish-connection` (JWT) calls `qbo_take_oauth_return`, which gives the code back once, only to the person who started the attempt, before expiry (5 minutes), while they hold both rights; any answer deletes the parked code. Only then is the code exchanged and the
connection stored. The card reads the handoff, removes it from the address first, and calls the finish step; "connected" is no longer taken from the address. *Proof:* storage 42/42 (`return.*`, four cases, including "anyone else, even a person with both rights here, gets nothing" and two simultaneous
takes giving exactly one code); `qboConnect.test.ts` 34 (including the attack: refused before Intuit, no token, attempt ended; single use); client and card 32. Negative controls: a take that ignores the starter, a repeatable take that keeps the code, and housekeeping that keeps expired codes were each
caught by the proof; a finish that ignores `not_yours` fails four unit tests. *Remaining:* Intuit's authorisation-code lifetime is not verified at the primary source (the build does not depend on it: an expired code is answered `expired` and the person connects again); a person signed out during
the minute at Intuit is sent to sign in without the handoff and connects again; the sealed code's binding names the handoff, not the workspace (it is sealed before the state is consumed, so the workspace is not yet known; the handoff's hash identifies the one row it may live in).

**S5. The callback's `realmId` is taken from the query string as sent (Low; narrowed by S4, still open).** A person completing their own authorisation could edit `realmId` before the browser reaches the callback; the token would then be stored under a QuickBooks company it does not belong to. Imports for
that connection would fail at Intuit (a token is scoped to its company), so no wrong figures can be imported, but the connection record would name the wrong company. Since S4, only the person who started the attempt can finish it, so an edited realm can only mislabel that person's own connection.
*Still open:* confirm the realm with one read after the exchange (that endpoint is not on the guard's list yet and is not added unverified).

**Re-read with no defect found.** Evidence first: no store or register without a recorded intent; `qbo_complete_pull` takes the upload id from the reservation, never the caller; recovery skips one bad row and finishes the rest; an expired reservation with an intent stays as "fetched, not imported".
The two rights: the import checks both before any Intuit call, and `qbo_record_pull_intent` checks them again in the database with the reservation's owner. (Two code comments, in `qbo-connect-start/index.ts` and `_shared/qboConnect.ts`, still say the start judges only "prepare a trial balance";
the database function judges both. Wording only.) Callback: no code, state or token in a redirect or log; an unknown, expired or used state is a plain 400; the return address is built from the configured app address and a UUID.

**Evidence for r2.** Storage proof 38/38 (`node scripts/db-proof/qboConnectorStorage.mjs`, disposable local PostgreSQL), validated by `scripts/ci/validateProofResult.mjs`; three negative controls each failed exactly their target case and the migration was restored (same SHA-256 as the corrected
file). Unit tests: `src/lib/ingestion/` 28 files, 486 tests pass. `tsc --noEmit -p tsconfig.app.json` clean; ESLint clean on the touched files; `deno check` of the three entry files passes locally. Pin-list guards (`migrationAuthority`, `releaseJournal`, `databaseInert`, `migrationReplayCompatibilityGuard`,
`claudeFileMap`): 650 pass. CI on the final head is read in PR #242, not recorded here (this file is part of that head).

## 9. Stack and merge order

**Verified (`git merge-base --is-ancestor`).** `origin/main` is an ancestor of #239's branch; #239's branch is an ancestor of #240's; #240's of #241's. The **only** migration in the whole stack is in #239 (`20261212100000`), later than every migration on `main` (latest `20261211100000`); no other open PR carries a migration at or after
`20261212` (#149 and #47 carry older timestamps and are unrelated). #240 and #241 add no migration.
**Merge order.** #239 -> #240 -> #241, each retargeted to `main` after the one below merges (GitHub does not retarget a stacked PR whose base branch is not deleted; do it explicitly). Merging is safe in any state because the connector is inert: no function is deployed, the migration is unapplied, and the screen constant `QBO_CONNECTOR_ENABLED` is `false`.
**Release order is a different thing and is fixed:** (1) apply the storage migration through the repository's release route; (2) create the secrets; (3) deploy the three functions; (4) the owner tries a sandbox connection; (5) set `QBO_CONNECTOR_ENABLED = true` in a reviewed commit and publish; (6) production only after Intuit approves it. **Severity.** Low. **Remaining risk.** The merge-train needs the manual retargets above.
