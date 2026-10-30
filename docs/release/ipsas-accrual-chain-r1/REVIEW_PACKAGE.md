> Historical candidate evidence. The independent review confirmed further defects in the #227/#228 chain. Unapplied PPE/grants source and all three transport fingerprints below are superseded by [the independent review](../ipsas-independent-review/REPORT.md). Existing CI evidence applies to its named commits; it does not validate the repairs. Nothing has been installed or published by this review.

# IPSAS accrual preparation + grants + Download original - review package

**All of this is DRAFT. Nothing is merged, installed, deployed, published or activated.** CI results are mechanical evidence. They are **not** independent code review, accountant acceptance, privacy/rights approval or hosted verification; none of those has been obtained for the whole (one independent human review exists and found the defects in section 2). This file is committed so reviewers do not depend on anyone's local files; the final head SHA and CI links are in the pull request description, not here (a file cannot name the commit that contains it).

Scope: a **bounded IPSAS preparation increment** - property, plant and equipment under the cost model with an opening bridge, and grants/revenue by period - plus an authorized "Download original" for an uploaded trial balance. It is not a set of IPSAS financial statements, has no comparatives or transition, and cannot issue an official report.

## 1. States used
**DRAFT** (open draft PR) / **REVIEWED** (a named human or accountant has reviewed it; none yet for the release as a whole) / **INSTALLABLE** (reviewed + owner-approved + hosted state re-read; none yet).

## 2. Independent review findings and their disposition
| # | Finding (from the independent review of combined head `a992cad`) | Status | Reproduction | Correction and evidence |
|---|---|---|---|---|
| 1 | **High: a successful save replaced edits typed while it was in flight** (PPE page) | **CONFIRMED**; grants page **independently confirmed** | Rendered component: add a class, "First saved label", Save with the response held, type "New unsaved label", release: the text reverted. Reproduced first in `IpsasPreparation.saveHandling.test.ts` - 9 of 13 tests failed on `a992cad`; the grants file `GrantsPreparation.saveHandling.test.ts` failed 7 of 10 on its own | A receipt now confirms the submitted snapshot only: the server's version is adopted only if the draft still equals what was submitted, so a newer edit stays visible and unsaved; one request per save key; an answer for another company, period or actor, or from a superseded operation, is dropped without touching draft, banner, request identity or recovery state; "send the same request again" resends the stored original request with its original identity; only the newest read may set the server's version. The page remounts per company, period **and signed-in actor** (`IpsasPreparationPage.boundary.test.ts` proves the route/auth boundary by rendering the page). After: all pass (43 component and page tests) |
| 2 | **Security: authority checked before waiting for locks, not again** (4 mutation functions) | **CONFIRMED** (source-level concern -> executable reproduction) | `ipsasAuthorityOrdering.mjs`, deterministic multi-session proof (hold the lock, prove the mutation is WAITING in `pg_locks`, commit the change, release, inspect rows): **4 of 15 cases passed** on the previous SQL - a revoked preparer's/reviewer's save, confirm, grants save, grants confirm **and an idempotent replay** were recorded or answered | `_ipsas_authorize_mutation` re-judges authority after the request and company-period locks and before any replay or write, under the shared member-capability lock that `revoke_member_capability` takes exclusively (revocation and an in-flight mutation are totally ordered); fresh READ COMMITTED snapshot; fails closed otherwise. **15 of 15** pass incl. membership/rollout/framework changes, plan-change ordering, contention without deadlock. Contract: `AUTHORITY_ORDERING.md` |
| 3 | **Release documents contradicted the candidate; review package and carry only on a local machine** | **CONFIRMED** | `GRANTS.md`/`RECORD.md` said no transport and no authenticated journey existed; the package/patch were untracked | Documents corrected; this package and the carry are committed (section 5) |
| 4 | **"43 acceptance checks" overstates coverage** | **CONFIRMED** | Checks 1-6 are setup; check 6 is a service-role operator action | Relabelled (section 4): 6 setup + 37 acceptance **assertions**, which are not 43 independent user workflows and do not prove onboarding |

Not reproduced / disproved: none of the four findings was disproved.

## 3. Review units
For stacked PRs review only the "own diff" (`git diff <base>..<head>`). Heads below are the source PRs' heads when this package was written; the remediation PR carries them by merge, so its own diff is the review target for the corrections.

| Unit | Head | Depends on | Content | Migration / function |
|---|---|---|---|---|
| #155 | `e15a25f` | - | attestation test made deterministic | none |
| #225 | `c524601` | - | safisha preflight check on as-left / zero-duplicate / seeded-duplicate inputs (no claim of deterministic race reproduction) | none |
| #216 | `29a4e39` | - | inert IPSAS candidate (domain code) | none |
| #217 | `370c767` | #216 | PPE + opening bridge + page | migration `20261207100000` (source bytes changed by the remediation) |
| #218 | `6040c8c` | #217 | preparation staged transport (regenerated by the remediation) | none |
| #219 | `828dd3c` | #218 | browser journey, simulated identity | none |
| #220 | `a0482a3` | #219 | grants + revenue | migration `20261208100000` (changed by the remediation) |
| #223 | `abdd9f9` | #220 | grants staged transport (regenerated) | none |
| #222 | `f2224e2` | - | Download original | function `trial-balance-source-download` (+ shared module), no migration |
| #221 | `b434e76` | #220 (and #222 for the carry) | authenticated local-stack journey | none |
| remediation | see the PR | all above | findings 1-4 | amends the two unapplied migrations (new helper `_ipsas_authorize_mutation`), regenerates both transports |

## 4. Evidence categories - what the journeys prove, and what they do not
The authenticated IPSAS journey (`scripts/e2e/ipsasAuthJourney.mjs`: real GoTrue sign-in, PostgREST, RLS and private Storage in headless Chrome, loopback) records every check with a kind. Reported separately and never added together:

- **Setup assertions - 6** (checks 1-6 below): sign-in and company/period/trial-balance preconditions; 2-5 use the real UI and uploader; **6 is an operator action by the service role** (it enables the reporting rollout). They prove the preconditions held, not that onboarding works.
- **Product acceptance assertions - 37** (checks 7-43): server enforcement, the PPE and grants pages, concurrency and lost-response recovery, revoked access, private Storage and download, layout. **These are assertions, not 37 independent user scenarios** - several belong to one scenario (for example the PPE chain is checks 13-21).
- **Operator/service-role integrity check - 1**: compares the stored object's bytes with the uploaded file using the service role; proves storage content only, not owner retrieval.
- **Recorded limitation (gap record) - 1**: a signed link issued before a revocation still works until it expires (60 s). It cannot fail and is not an acceptance pass.
Other journeys: the retrieval journey (14), the main local-stack journey (71), drafts (4), finding correction (18). Database proofs: preparation 29, grants 29, authority ordering 15, preparation transport 23, grants transport 24, safisha ingestion 44.

### The 43 checks of the authenticated journey (as run on `a992cad`; the final head's CI reports the same counts)
 1. [SETUP] an unauthenticated deep link to the IPSAS page lands on sign-in; a wrong password is refused; the owner signs in through GoTrue
 2. [SETUP] the owner creates the company through the real first-run form (calendar year, TZS, IPSAS accrual); it is saved with that framework
 3. [SETUP] the owner sets the explicit calendar periods (FY2026 with FY2025 as its prior period) in the real period settings
 4. [SETUP] FY2026 is uploaded through the real uploader into private Storage, checked by the real edge function, classified and certified
 5. [SETUP] FY2025 is uploaded, checked and certified the same way (the prior year the equipment opening is tied to)
 6. [SETUP] operator enables the reporting rollout for the company; both years are certified and the framework is IPSAS accrual
 7. [ACCEPTANCE] owner, preparer and partner (reviewer) are served by the server; a viewer member and an outsider are refused, for both the preparation and the grants
 8. [ACCEPTANCE] writes are refused by the server for a viewer member and an outsider, and a preparer cannot confirm (nothing is recorded)
 9. [ACCEPTANCE] cross-company: the owner of one workspace is refused on another's, and the outsider on the owner's; a payload naming another company is invalid
10. [ACCEPTANCE] anon (no session) and the service role cannot call the functions; the tables and internal helpers are unreachable even to the owner
11. [ACCEPTANCE] through the page, a viewer member is shown no working editor (and the server refusal above is what actually protects the data)
12. [ACCEPTANCE] Prepare shows the IPSAS entry for this company, and following it opens the preparation page for the same year
13. [ACCEPTANCE] the page opens for a signed-in preparer: five areas, one next step, draft label, nothing invented
14. [ACCEPTANCE] bring: mapping the PPE accounts, the policy and last year's printed figure are entered by typing; the preparer cannot confirm
15. [ACCEPTANCE] prepare: one asset class with the entity's own estimates, the register tie and five answered questions saves on the server
16. [ACCEPTANCE] server: trial-balance figures come from the CERTIFIED rows, and the next step is the first open matter from the server's assessment
17. [ACCEPTANCE] review: before management confirms, no policy wording exists for the class and the open matters name what, why, which evidence and who
18. [ACCEPTANCE] reload: leaving and reopening restores the saved preparation from the server alone
19. [ACCEPTANCE] a partner (reviewer) confirms the printed figure and the estimates; the draft policy and note then appear and nothing remains open
20. [ACCEPTANCE] issue & history: official issuance is stated unavailable, with reasons, even though this slice has no open matter
21. [ACCEPTANCE] the preparer, reloading, sees the confirmed property, plant and equipment and is pointed to the grants still to record
22. [ACCEPTANCE] grants: the page says the period is read from the certified trial balance, offers only that period's classifications, and states that cash and spending never decide revenue
23. [ACCEPTANCE] grants: two agreements with obligations, satisfaction evidence, complexity answers and the trial-balance accounts are typed in and saved; the server calculates revenue, liability and receivable
24. [ACCEPTANCE] grants: changing the cash received changes the receivable but NOT the revenue; restoring it restores both
25. [ACCEPTANCE] grants: before a reviewer confirms, the note says so and the open matters name who must act
26. [ACCEPTANCE] grants: a reviewer confirms each assessment; the draft note then states the classification in words and totals match the trial balance; the page reports no open matter anywhere
27. [ACCEPTANCE] grants: reopening restores the register from the server alone, with the same confirmed state
28. [ACCEPTANCE] race: another writer saves meanwhile; the page's save is refused by name, the edit is kept, and reloading adopts the server's version
29. [ACCEPTANCE] lost: a response dropped after the server recorded it is reported as unconfirmed, and the retry reuses the ORIGINAL request identity (one revision, replay acknowledged)
30. [ACCEPTANCE] grants race: another writer saves meanwhile; the page's save is refused by name, the edit is kept, and reloading adopts the server's version
31. [ACCEPTANCE] grants lost: a response dropped after the server recorded it is reported as unconfirmed, and the retry reuses the ORIGINAL request identity (one revision, replay acknowledged)
32. [ACCEPTANCE] grants tamper: a preparer cannot confirm; a saved payload that forges confirmation, totals, period and the trial balance changes nothing the server computes
33. [ACCEPTANCE] AUTHENTICATED: the trial-balance bucket is private; an outsider, a viewer, anon and a public URL cannot read the uploaded object
34. [ACCEPTANCE] owner retrieval through the server path: a 60-second link for exactly this upload; the fetched bytes equal the uploaded file and the server's recorded SHA-256
35. [ACCEPTANCE] the owner presses 'Download original' on the real page; Chrome saves the exact uploaded file and the page says it matches the recorded fingerprint
36. [ACCEPTANCE] refused by the server with no URL: a viewer member, an outsider (naming this company or their own), anon, no session; injected path/bucket/user fields are 400
37. [ACCEPTANCE] cross-company: the owner is refused another company's upload however they name it, with the same answer as an unknown upload
38. [ACCEPTANCE] permissions and revoked access: a member without source-file authority is refused; the OWNER grants manage_source_files (the application's own RPC) and the member is served the same bytes; the owner revokes and the very next request is refused
39. [ACCEPTANCE] the page offers a view-only member no 'Download original'
40. [ACCEPTANCE] a revoked preparer reads and writes nothing, cannot replay an earlier request, and the recorded history is intact
41. [ACCEPTANCE] a revoked reviewer can no longer confirm; their earlier confirmations remain; the page shows them no working editor
42. [ACCEPTANCE] the preparation page at 1280 px and 375 px, on Bring, Prepare and Review: no horizontal overflow, no clipped action, no unlabeled field
43. [ACCEPTANCE] every browser request stayed on loopback (none named the production project); uncaught page exceptions are reported

### Recorded separately
- [GAP RECORD] GAP RECORD (observed; cannot fail): a link issued before a revocation still works until it expires (60 s), because it is a bearer credential
- [OPERATOR INTEGRITY] OPERATOR INTEGRITY READ (service role, NOT owner retrieval): the stored object is the uploaded file, byte for byte

## 5. The two-file change in `e4d84ba` and its durable home
`e4d84ba` changes exactly `scripts/e2e/ipsasAuthJourney.mjs` and `src/lib/__tests__/ipsasAuthJourney.test.ts`: it turns "owner retrieval is a recorded gap" into acceptance checks, adds the check kinds and token redaction. It needs **#221 (the journey file) and #222 (the function it calls)**, so neither PR alone can carry it.
- **Approved carrier: #221**, after #222 and the IPSAS chain are on `main`: merge `main` into #221's branch, then cherry-pick `e4d84ba` (an ancestor of the remediation branch). Its CI is the proof that the carry works there.
- **Committed form:** the commit is in the remediation branch's history, and `carry/ipsas-auth-journey.carry.patch` is the same change relative to #221's head `b434e76`. `node scripts/release/verifyCarry.mjs` applies it to `b434e76` in a scratch checkout and requires the two resulting files to be byte-identical to the final head's - verified when this package was written (output in the PR). #224 stays open until the carry is on #221.

## 6. Merge sequence, exact-byte installation, deployment, preservation, activation
**Merge != publish != function deploy != migration apply != activation; each is a separate owner decision.**
**A. Merge order (none done):** #155, #225, #222 first (independent); then #216, #217, #218, #219, #220, #223; then the remediation PR (it amends files from #217/#220/#218/#223, so it must come after them); then #221 re-based with the carry. If `main` moves, re-run CI before each merge.
**B. Database installation (owner-approved, nothing done).** Re-read the hosted journal first: the head must be **id 91**, tag `0090_eqp_2_multiclass_staged_apply`, SHA-256 `ed1ceb09...3644`. The equipment transport is **recorded** as installed (2026-10-28, ids 89-91, `docs/release/equipment-transport-r1/RECORD.md`); that is a record, not a fresh verification. If the head differs the transports refuse and must be regenerated. Never repeat an equipment migration.
| Step | Artifact (bytes, SHA-256) | Hosted id |
|---|---|---|
| 1 | `release/staged-transport-ipsas/00_ipsas_staged_transport.sql` (7,369; `b774ac26cd7476babd885985af825eb247e1b0004a29afef871b7e05900a1bbd`) | 92 |
| 2 | stage `1_ipsas-1-preparation.source.sql` as inert data (source `20261207100000`, 51,496 B, `3fb7460f4b5ff45623e8876a522394ce4eef67da32705b80dbe46caaf44d21b7`) | - |
| 3 | `10_ipsas_1_preparation_staged_apply.sql` (13,461; `e578516cc0a7068ed0efdfe815500b60a238d778454d816449e3bd009498afb8`) | 93 |
| 4 | `release/staged-transport-ipsas-grants/00_ipsas_grants_staged_transport.sql` (7,669; `4b68241a0d3064d16047de8c3f623c35e815e7e2852aff63f7d61d755c00e16b`) | 94 |
| 5 | stage `1_ipsas-2-grants.source.sql` as inert data (source `20261208100000`, 30,564 B, `012ac1bba2bdc1a2b2a41d81ed4d4a24716680486c3b8709d1297b678c8db3bf`) | - |
| 6 | `10_ipsas_2_grants_staged_apply.sql` (14,238; `4182251a069cd11b9707bb017a99233241cccf436c6f453b8b1df3adba8d60e8`) | 95 |
Before: both generators' `--check` print OK. The previously reviewed migration revisions (48,766 B `1bc89935...` and 30,002 B `d1ddcb3b...`) were never applied anywhere. The applies pin `search_path` to `pg_catalog, public` for the source only. After execution only: register the mirrors in Drizzle and `RELEASE_JOURNAL`, re-run the checks, record the final SHA.
**Preservation checks (before and after; hashes must match):** the baseline hashes the applies compute; original binding seq 1/2 digest `de1e521b8731b1fc5f30ee4a15c17a0834838fb0530335696aceb5fda8f78642`; runtime settings read and recorded, not reset; both new table pairs empty; the RPCs executable by `authenticated` only and all `_ipsas_*` helpers (now including `_ipsas_authorize_mutation`) by none; staged rows consumed; one `applied` event per transport.
**C. Function deployment (separate):** `supabase functions deploy trial-balance-source-download`; deployed-source attestation is not yet done. **D. Frontend publication (separate).** **E. Activation (separate, none done):** a company's framework set to `ipsas_accrual` (owner-run, per company); the rollout allow-list for it; capability grants (`prepare_close`, `review_close`, `manage_source_files`) for named users.

## 7. What users can do after release, and what is incomplete
**Can do** (a workspace whose framework is IPSAS accrual, rollout enabled; every figure server-computed; reload-safe; append-only history): record PPE asset classes under the cost model with their own estimates, tie them to the certified trial balance, bridge last year's printed figure with no balancing plug, answer the policy questions, see exactly what remains open and who must act, have a reviewer confirm the exact estimates, and get policy wording and a note after confirmation; record grants, with the applicable model chosen by the server-derived period, obligations and satisfaction evidence, server-calculated revenue/receivable/liability reconciled to the trial balance, per-grant reviewer confirmation and a draft note. A person with source-file authority can **Download original** of an uploaded trial balance through a 60-second link checked against the server's recorded SHA-256. Edits typed during a save are kept; a stale or concurrent save is refused by name; a lost response is retried as the same request; a revoked person cannot write.
**Incomplete / not supported:** official issuance and the frozen pack; the full statement set (cash flows, net assets by component, receivables, payables, leases, employee benefits, related parties, going concern, events after the period, authorisation); comparatives, restatement, first-time and early adoption; prior-report extraction; transfer expenses; partly funded or multi-year conditional grants, receivable impairment, grants in kind, agency grants, foreign-currency grants, revenue reversals, donor/fund views, restricted net-asset components; materiality; note numbering and manual-edit preservation; the timed no-coaching measurement; any claim that a figure is accountant-approved.

## 8. Pending decisions and explicit limitations (preserved, not resolved)
Accountant acceptance - **none**; D1 appoint the IPSAS accounting content owner and independent reviewer; D2 authorise a real NGO case with data-handling approval; D3 who may confirm management's estimates (today any `review_close` holder; both actors recorded); D4 approve release of the migrations/transports; **onboarding** (invitations, membership acceptance, rollout configuration through the UI) is **not proven** - the journeys create those users as operator fixtures; **privacy and rights** - P1 download rights from evidence capabilities, P2 retrieval after plan expiry vs revoked membership, P3 audited download-authorization events (`docs/release/source-download/POLICY_PROPOSALS.md`, proposals only; the original file may hold more than the trial balance; retention duties to be confirmed by counsel); **hosted verification** - none; the **signed link is a bearer credential**: anyone holding an issued link can fetch that one object for up to 60 s even after the issuer's access is revoked (recorded by the journey as a gap, not removable without proxying bytes through the function); whether hosted has a `public.gen_random_uuid()` is unknown from this repository; local Windows runs show 2 symlink-permission failures that also occur on clean `main` (CI on Linux is green).

## 9. How a reviewer verifies
`git diff <base>..<head>` per section 3; `node scripts/release/ipsasStagedTransport.mjs --check`; `node scripts/release/ipsasGrantsStagedTransport.mjs --check`; `node scripts/release/verifyCarry.mjs`; the PR's CI run for the journeys (`real-app-evidence` artifact, `results.json` `summary` per kind) and the disposable-database job (authority ordering, transports, preparation, grants, safisha). The journeys and proofs need Docker/PostgreSQL; CI is where they ran.
