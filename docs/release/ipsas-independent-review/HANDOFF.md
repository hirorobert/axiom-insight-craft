# IPSAS repair candidate (#229) - repair after the independent review, and re-review handoff

Written 2026-10-31 by the author side (not an independent reviewer). **Nothing here records independent acceptance.** The first independent review of `c0d195bad36ae99029a984fdc03fb4fc59c7ac89` returned **CHANGES REQUIRED**; this file records the repair of each finding. The earlier handoff (which called that head "ready" and described an "accepted bounded behaviour" and microsecond window) is superseded: those statements were wrong and are retracted. The rejected candidate is kept distinct below. Merge, hosted installation, function deployment, publication, activation and accounting acceptance remain separate decisions (`docs/release/ipsas-accrual-chain-r1/REVIEW_PACKAGE.md`). Post-merge CI verifies the integrated result; it is not a prerequisite for merging.

## 1. Candidate
| Item | Value |
|---|---|
| Pull request | #229, draft, base `main` (`db6cef701b0856b98cd485d30431ac7b1137f2e4`) |
| Rejected candidate (reviewed) | `c0d195bad36ae99029a984fdc03fb4fc59c7ac89` (code evidence head `8a2467b`). Its CI results remain valid evidence about *that* head only. |
| Repair, code | `2165066cd6d2dda2d3faca19d4b41a1fbd524817` (migrations, Edge Function, client, proofs, ordering document) |
| Repair, transports | `efcba3c` (regenerated exact-byte transports and re-pinned fingerprints; `SOURCE_COMMIT` of the generators is `2165066`) |
| Exact head to re-review | the head of the `codex/ipsas-independent-review` branch when this file was written; the PR description names it and the CI run on it. Later commits are documentation only unless the description says otherwise. |

The reviewer's local `D:/` paths in the review are on their machine; nothing here claims to have read them. Every result below was reproduced independently from the repository.

## 2. Finding-by-finding resolution
| # | Finding (reviewed head) | Resolution | Evidence |
|---|---|---|---|
| 1 | [P1] Membership withdrawal, demotion, rollout closure or framework change can complete after a mutation was admitted and before it commits (all five mutation RPCs) | One ordering contract: from admission to commit, no withdrawal of an authority input completes; every writer waits, or the mutation refuses `authority_changing` (nothing persisted). Implemented in `_ipsas_authorize_mutation` (`20261207100000`); applies to preparation save, confirmation, grants save, grant confirmation and presentation save. Contract and writer inventory: `docs/release/ipsas-accrual-chain-r1/AUTHORITY_ORDERING.md` | `ipsasAuthorityRaces.mjs` 41/41; reviewed code **23/41** (18 violations across all five RPCs); earlier ordering proof still 15/15 |
| 2 | [P1] Removing a member left independently granted original-file access (`manage_source_files`) active; the download helper still answered ready | Independent grants of a person are tied to their membership: a new trigger revokes the person's workspace grants (and records the revocation events) in the removing transaction. A collaborator who was never a member keeps the owner's grants (the supported grant-only path). Migration `20261211100000` | `sourceAccessAuthority.mjs` 14/14; reviewed code: 5 failures then stopped (section 5) |
| 3 | [P2] Download authorization could be stale while signing waited | Ordering contract: authorize -> sign -> **authorize again (linearization point)** -> durable record -> return. A link is never returned if the second check fails or the record cannot be written. The second check narrows the window; it is not atomic (see 4) | `sourceDownload.test.ts` 31 tests (deferred signer, real DB authorization changes in `sourceAccessAuthority.mjs`) |
| 4 | [P1] PPE and grants applied TZS / two decimals to every currency (JPY 14,000 displayed as 140.00) | The unit of every typed amount is the **server-confirmed** denomination (currency + exponent) of the certified period; figures are exact minor units of it; any payload built in another denomination, unknown or unsupported (exponent above 3) is refused by name and nothing is written. Supported set: exponents 0-3 | `ipsasCurrency.mjs` 28/28; 14 component tests fail on the reviewed components; fixtures in 3 |
| - | Audit acceptance: a console event is not a durable authorization record | Durable append-only table `trial_balance_source_download_events` for link-issuance **decisions** (see 6) | `sourceAccessAuthority.mjs` |

## 3. Authorization ordering contract (finding 1)
- **Admission:** acquisition of the locks below by `_ipsas_authorize_mutation`, then a fresh re-judgement of authority on a READ COMMITTED snapshot, after the mutation's request and company-period locks and **before** any replay lookup or write, in all five RPCs.
- **Guarantee:** from admission until the mutation's transaction commits, no withdrawal of an authority input completes. A withdrawal that committed before admission is seen by the re-judgement (`forbidden`, `feature_disabled`, `framework_not_ipsas_accrual`). A mutation therefore never records a write under authority withdrawn before its commit.
- **How:** member-capability advisory lock (shared); plan, named-user seats and framework locks (shared); rollout keys **try-locked and never waited for** (open and close take them in opposite orders; unavailable means `authority_changing`); `FOR SHARE` row locks on the person's membership row, open capability rows and the company row (writers' UPDATE/DELETE wait); `lock_timeout` 5 s as an operational protection (not what orders anything).
- **Framework change:** `set_company_reporting_framework` refuses `FRAMEWORK_LOCKED` once a certified trial balance or report exists, so at the mutation level it cannot race a certified company; it is proven at the helper level on an uncertified company.
- **Not claimed:** a clock-based expiry is not a writer; a future writer that takes none of these keys and updates none of these rows is not covered; the readers (`ipsas_*_context`) refuse as soon as a withdrawal commits.

## 4. Download signing ordering contract (finding 3) - what is and is not claimed
`authorise (read 1) -> sign -> authorise again (read 2) -> record -> return`. A withdrawal committed before read 2 prevents any link being returned (a token minted by Storage is discarded unseen, never logged). A withdrawal after read 2 is ordered after the issuance: the link stays usable for `DOWNLOAD_EXPIRY_SECONDS` (60 s) because a signed URL is a bearer credential and cannot be revoked. **This is not atomic revocation.** Evidence is separated: the orchestration ordering is proven locally with a deferred signer against the real database predicate (`sourceDownload.test.ts`, `sourceAccessAuthority.mjs`); the behaviour of Supabase Storage's signing endpoint and token is *not* exercised by those and is covered only by the real-stack CI job, which signs for real.

## 5. Deterministic before/after
Method: a test-only barrier trigger on the INSERT parks a mutation *after admission and before persistence*; ordering is decided by observed `pg_locks` / `pg_stat_activity`, never a sleep; both orderings are tested (withdrawal first, admission first), plus replay, fresh-read refusal after the race, no partial or cross-company writes, and contention. Negative controls ran in a detached worktree at `c0d195b` with only the new proof files overlaid.

| Proof | Reviewed head `c0d195b` | Repair |
|---|---|---|
| `ipsasAuthorityRaces` (41 cases) | **23/41**: member removal, demotion and rollout closure complete while an admitted prep-save, confirm, grants-save, grant-confirm and statement-save is pending and the mutation then persists; member removal vs admitted replay; both framework helper cases | 41/41 |
| `ipsasCurrency` (28 cases) | **1/28** (only setup passes) | 28/28 |
| `sourceAccessAuthority` (14 cases) | **not completed, by construction:** 5 failures before the run could not continue - the removal does not revoke the grant, a new link request after removal is not refused, reinstatement resurrects the old grant, a withdrawal while signing still returns a link; the next case then waits forever because the reviewed code has no durable-record step to pause at, so the run was stopped (passes before: grant-only collaborator, owner/other workspaces, pending invitation, demotion, atomic rollback) | 14/14 |
| `ipsasAuthorityOrdering` (15) | 15/15 | 15/15 |

Preserved: independent regression 9/9, preparation 29/29, grants 29/29, statement review 28/28, preparation transport 23/23, grants transport 24/24, F1-F5 and #227's controls unchanged in behaviour (the authorize helper body changed deliberately; call sites are the same).

## 6. Audit semantics and limits
`trial_balance_source_download_events` records link-issuance **decisions** by the function: `issued`, `denied` (authenticated caller naming a real upload of a real company without the right), `withdrawn_before_issue`. Stores who, company, upload, outcome, expiry and the recorded fingerprint - **never a URL, token or path**. It is append-only (update/delete/truncate refused), owner-readable under RLS, written by the service role. It does **not** establish that the file was transferred: the bytes go from Storage to the browser, which the function cannot observe; no browser report is treated as evidence. Unauthenticated calls and requests naming an unknown upload or a mismatched company are not recorded (they name nothing real; recording would let anyone write). A link is never returned if its record could not be written (`audit_unavailable`, 503). **Undecided:** retention and who may read the table beyond the workspace owner.

## 7. Currency fixtures and expected amounts (finding 4)
Each fixture processes and certifies a real trial balance in that currency. Whole-unit fixture: PPE closing carrying 14,000, opening 16,000, depreciation 2,000.
| Denomination | Exponent | Closing (minor) | Opening (minor) | Depreciation (minor) | Displayed |
|---|---|---|---|---|---|
| TZS | 2 | 1,400,000 | 1,600,000 | 200,000 | 14,000.00 |
| USD | 2 | 1,400,000 | 1,600,000 | 200,000 | 14,000.00 |
| JPY | 0 | 14,000 | 16,000 | 2,000 | 14,000 (not 140.00) |
| KWD | 3 | 14,000,000 | 16,000,000 | 2,000,000 | 14,000.000 |
Also covered: exponent 4 refused by name (`denomination_unsupported`); no certified source refused (`denomination_unavailable`, never a default); prior period in another currency or scale makes the opening *unknown* (not zero); a saved draft entered in another denomination is refused, never re-read in the new one (it is **not converted**, and there is no "start over" action yet); negative and zero amounts, parse/format/round-trip, missing and conflicting metadata and notes (`currency.test.ts`, `draft.test.ts`); grants use the same rules; both confirmations refuse a mismatched denomination.

## 8. Migration and transport evidence
- Changed, **unapplied**: `20261207100000`, `20261208100000`; new: `20261211100000`. No installed history was rewritten *as far as this repository can show*. **Hosted state was not read and is not verified**; repository notes do not prove it, and the earlier statements about the hosted journal head are unverified. If any of the changed migrations has already been installed, a new forward migration is required instead of this edit - to be confirmed from authorised evidence before installation.
- The unapplied-candidate convention was followed (edit in place, regenerate the exact-byte transports, re-pin fingerprints): `ipsasStagedTransport.mjs` (preparation, 60,510 B), `ipsasGrantsStagedTransport.mjs` (32,017 B), `ipsasStatementReviewStagedTransport.mjs`; the generators' `--check` passes; transports proven on a disposable database (prerequisites, tamper, order refusal, rollback, concurrency, postconditions): 23/23, 24/24, statement review passes.
- **Installation gates (unchanged by this work, now stated):** the stage table body cap was raised to 65,536 bytes because the preparation source is 60,510 B; whether the owner's stage channel carries a statement that large is **unverified** (equipment carried 54,129 B); fallback is splitting the source into two batches. The hosted journal head must be read at install time and `20261116100000` confirmed present.

## 9. Gates and unresolved items
| Gate | State | Blocks |
|---|---|---|
| Independent re-review of the repair, and of the full accumulated scope (#227/#228/#222 incl. the download function and signed-link permissions) | not done | merge |
| Required CI on the exact final head | see the PR | merge |
| Hosted migration state, journal head, stage-channel capacity | not verified here | hosted installation |
| Deployed function/frontend identity | not done | deployment |
| Download event retention / read rights | undecided | activation |
| Bearer-link residual (60 s) | accepted design limit, documented | - |
| Converting an existing draft into another denomination | not built; refused instead | product decision |
| Accounting acceptance, adopted responsibilities, commercial matters | as in the earlier package | activation / launch |

Nothing was merged, installed, deployed, published or activated; no paid service was called; Stage C was not begun.
