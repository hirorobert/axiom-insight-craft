# Independent IPSAS review — 2026-10-30

**Verdict: CHANGES REQUIRED for the supplied PR heads.** Both contain confirmed accounting-source defects; #228 also contains three confirmed presentation/save defects. Repairs are committed locally on `codex/ipsas-independent-review`. They must be incorporated and receive final-head CI/review before these PRs can be considered technically ready. This review does not authorize the next feature stage or any release action.

## Exact scope and preservation

- #227: `d235708620c37467a38863b2cf1092f835988d82`.
- #228: `748be05bddb6508fd30bdbfb4d52d364c61cffc6`.
- GitHub heads were checked before implementation review and again after validation; both matched, remained open and were unmerged. Both target main at `db6cef701b0856b98cd485d30431ac7b1137f2e4` in the retrieved metadata.
- Read candidate AGENTS.md and the complete proposed development charter. Its adoption/accounting appointments remain unrecorded. Applicable requirements and repair scope are in [WORK_PLAN.md](WORK_PLAN.md).
- The original root checkout remains on `feat/workspace-ux-hardening`, with its six modified tracked files and untracked artifacts preserved. None of its tracked edits overlaps the candidate's main-relative file diff.
- Inventoried 89 registered worktrees: one missing, 68 with dirty status, many old scratch trees reporting large sets of pre-existing deletions. No cleanup, pruning, reset or restoration was attempted. Candidate Claude trees `remed-wt`, `integration-wt`, `prep-transport-wt`, `grants-transport-wt`, `w219`, and `w220` were clean; `ipsas-chain` held untracked journey/proof evidence. [Inventory](evidence/worktrees.json).
- An active Claude CLI process (PID 6692) and desktop processes were present and left running. The separate Claude worktree `adoring-hamilton-a45fb7` modifies `src/App.tsx` and deletes `IssuesWorkspace.tsx`; App.tsx overlaps the IPSAS route changes and needs reconciliation if that separate work is integrated. The `inspiring-hamilton-e426fd` worktree has eight component deletions. Neither was imported into this review checkout. Process presence alone does not establish which process authored those edits.
- No merge, push/publication, installation, hosted read/write, Lovable contact, paid service or next-stage development occurred. All native SQL ran against disposable local PostgreSQL with synthetic data.

## Findings against the reviewed commits

Line links below refer to immutable #228 source. The same PPE/grants source bytes occur in #227.

| ID | Severity | Confirmed defect and evidence | Repair |
|---|---|---|---|
| F1 | P1 | PPE chooses the latest certification directly at [preparation SQL:127](https://github.com/hirorobert/axiom-insight-craft/blob/748be05bddb6508fd30bdbfb4d52d364c61cffc6/supabase/migrations/20261207100000_ipsas_accrual_preparation.sql#L127), including the prior year at line 128. Grants does the same for its period and sums at [grants SQL:69](https://github.com/hirorobert/axiom-insight-craft/blob/748be05bddb6508fd30bdbfb4d52d364c61cffc6/supabase/migrations/20261208100000_ipsas_grants.sql#L69) and [line 88](https://github.com/hirorobert/axiom-insight-craft/blob/748be05bddb6508fd30bdbfb4d52d364c61cffc6/supabase/migrations/20261208100000_ipsas_grants.sql#L88). A real mapping-review decision invalidated both certifications: canonical authority returned no row, but PPE still returned 1,400,000 closing / 1,600,000 opening and grants still returned 310,000 and the old period. Those stale figures can support misleading workpaper ties. | Reuse `_fs_reporting_input_compute`, which delegates to current certification authority. Invalidated, retired, blocked or stale sources cannot supply a tie. Unknown remains null, and incomplete drafts remain saveable. Prior amounts additionally require contiguous dates and matching currency/exponent. |
| F2 | P1 | The same helpers sum `_cr_certified_accounts` instead of adjusted accounts. Approving an actual balanced 30,000-minor-unit capital invoice left PPE at 1,400,000 instead of 1,430,000 and the selected liability at 310,000 instead of 340,000. Statement review used the canonical adjusted input, so the sections could disagree within one page. See [preparation SQL:130](https://github.com/hirorobert/axiom-insight-craft/blob/748be05bddb6508fd30bdbfb4d52d364c61cffc6/supabase/migrations/20261207100000_ipsas_accrual_preparation.sql#L130) and [grants SQL:90](https://github.com/hirorobert/axiom-insight-craft/blob/748be05bddb6508fd30bdbfb4d52d364c61cffc6/supabase/migrations/20261208100000_ipsas_grants.sql#L90). | Sum canonical adjusted debit minus credit (or the inverse for credit-side ties), preserving contra signs. Reject incompatible account sections as unknown. |
| F3 | P2 | Explicit refresh unconditionally installs the result with reset=true at [StatementReview.tsx:41](https://github.com/hirorobert/axiom-insight-craft/blob/748be05bddb6508fd30bdbfb4d52d364c61cffc6/src/components/ipsasStatements/StatementReview.tsx#L41). Start refresh, then choose cash while the response waits: the choice is erased. | Capture the draft at read start and replace it only if no newer editing occurred. |
| F4 | P2 | The refreshed view can change account order while newer draft edits are deliberately retained at [line 80](https://github.com/hirorobert/axiom-insight-craft/blob/748be05bddb6508fd30bdbfb4d52d364c61cffc6/src/components/ipsasStatements/StatementReview.tsx#L80), but controls read/write `draft[i]` at [line 113](https://github.com/hirorobert/axiom-insight-craft/blob/748be05bddb6508fd30bdbfb4d52d364c61cffc6/src/components/ipsasStatements/StatementReview.tsx#L113). Reordering a valid response makes a retained receivables choice disappear from its account and associates controls with another draft row. | Bind control lookup and edits to period + accountKey, including new accounts, rather than row index. Do not advance a retained draft's base onto an unconfirmed source. |
| F5 | P2 | After a confirmed receipt, a failed follow-up read leaves the old base revision and enables another save; [line 85](https://github.com/hirorobert/axiom-insight-craft/blob/748be05bddb6508fd30bdbfb4d52d364c61cffc6/src/components/ipsasStatements/StatementReview.tsx#L85) only reports the failure. The next save uses the obsolete expected revision; the offered discard-refresh path can lose newer edits. | Keep the confirmed receipt separately, disable a new write until refreshed, and recover the current base while retaining newer choices. An unknown write still retries its exact original request. |

The native reproduction initially had 2 passing and 6 failing checks. The added classification refusal brings the repaired regression to 9/9. The two initial UI reproductions failed against the candidate and pass after repair. F5 was separately run against an unmodified copy of the candidate component and failed at the obsolete-base save guard; the repaired case passes. No failures were converted into repository skips.

## Actual dependency graph and integration order

All source PRs use `main` as their GitHub base; their real stack is encoded in commit ancestry. [Exact heads and CI metadata](evidence/github.json), [ancestry checks](evidence/ancestry.json).

| PR | Exact source head | Relationship |
|---|---|---|
| #155 | `e15a25f39c8f679534bdf4dc16f5d5e75867697c` | Independent attestation-test fix |
| #225 | `c5246012ef268bbeacec32a3c83c5088057d9ec6` | Independent ingestion-test fix |
| #222 | `f2224e2d0178da66ecc4b010e55d263dbeb16f92` | Independent original-source download path |
| #216 | `29a4e396b5417356b35a7733b33e754fa233e98d` | IPSAS foundation |
| #217 | `370c767ab6f45474079147c65a9531f8c40e0c75` | Extends #216 with PPE authority/page |
| #218 | `6040c8cd0a6512f6835d8dbf4fb10c6f8d21b9a0` | Extends #217; preparation transport/search_path fix |
| #219 | `828dd3cb0d4e8e13dac36a995429a129f2fd0781` | Browser branch with #218 merged |
| #220 | `a0482a302eb8f843e36e234bd2c42a965b204279` | Grants branch with current #219 merged |
| #223 | `abdd9f9218de09aa7072bb77f58a14126f50058d` | Grants transport with current #220 merged |
| #221 | `b434e76f48a066c2978fb938576a457f02fb7e88` | Auth journey forked from grants commit `98b299aa48b6e976e97229f1b09ba99fc091c6fd`; it does not itself contain current #218/#219/#220 heads |
| #224 | `a992cadc84c94fa195b5b6b316daa5be19fa911e` | Combined candidate includes all above plus `e4d84ba` journey carry |
| #227 | `d235708620c37467a38863b2cf1092f835988d82` | Four remediation commits on #224 |
| #228 | `748be05bddb6508fd30bdbfb4d52d364c61cffc6` | Four statement-review commits on #227 |

Every source head #155, #225, #216–#224 is already an ancestor of #227 and #228. #227 is an ancestor of #228. Nothing from these PRs needs to be cherry-picked again into the review branch. The `e4d84ba` carry depends on #221 and #222 and is already present; applying it again is incorrect. The inherited carry verifier compares against its #227-era two-file result; #228 deliberately adds statement steps and trusted-click instrumentation, so that old patch alone is not a byte-equivalence certificate for #228. Those small later diffs were inspected directly and preserve the download authority/integrity assertions.

For individually reconciled source PRs: accept independent #155/#225/#222; then #216 → #217 → #218 → #219 → #220; reconcile #221 and #223; then the #224 combination/carry, #227 remediation, #228, and this review's repair commits. #224 is an aggregate validation carrier, not an additional independent feature that must be replayed. An ancestry-preserving aggregate integration already brings those source commits, but does not replace their required review/acceptance. Do not squash/reconstruct source files from old descriptions or reinstall old transport bytes. Main movement or conflict resolution requires CI on the resulting integration head.

## Controls independently inspected

- **Save and scope boundaries:** Claude's PPE/grants snapshot-adoption, original retry closures, operation identities, client identities and newest-read sequencing remain byte-identical to #228. The page's company/year/actor keys and per-actor DB wrapper remain unchanged. All 26 save/page boundary tests pass. Statement recovery storage validates actor/company/year/request/payload/expiry; malformed receipts are unknown, not assumed saved. Actor changes cannot apply a prior response or clear another actor's recovery entry.
- **Authority and locks:** `_ipsas_authorize_mutation` at preparation SQL:103 takes the shared member lock, requires READ COMMITTED, and rechecks authority after request/scope locks and before replay/write in all four PPE/grants mutations. Statement SQL:154–164 follows the same protocol after its scope and prior/current TB locks. Early shared plan locking is retained, so the later plan check is reentrant. Capability writers take the matching exclusive member key without an inverse scope dependency. Ascending prior/current TB locking creates no opposite-year cycle. No lock/control body was changed by these repairs. Reused final-head authority-ordering evidence covers the four mutations, replay, revocation ordering, admission and contention; statement's 28-case proof was rerun locally.
- **Precise revocation boundary:** explicit member capability revocations serialize with admitted writes. Out-of-protocol membership withdrawal, rollout closure, framework/billing changes are judged at the fresh boundary snapshot as documented; the PPE/grants protocol does not lock every such input through commit. This limitation must not be described as universal revocation serialization.
- **Figures:** statement SQL:57–124 uses canonical adjusted input, exact numeric minor units, reviewed section compatibility and signed contra arithmetic. Its fingerprint binds current/prior accounts, metadata, adjustments and revalidation state; save checks source/revision at line 169. Missing assignments yield null figures. Prior TB is reference-only and requires compatible dates/currency/exponent. The PPE/grants bypasses are F1/F2, repaired without changing existing hand-derived financial expectations.
- **Tenant/API boundaries:** server-derived auth identity and company checks precede financial reads/writes; private `_ipsas_*` helpers and tables are revoked from PUBLIC/anon/authenticated/service_role, while only intended RPCs are granted to authenticated. Native role/tenant refusals, immutable history and preservation checks pass. No API privilege was widened.
- **Transport:** exact committed source byte count/SHA, inert staging, exact predecessor, pinned `pg_catalog, public` execution, postconditions, preservation locks, atomic consumption and replay refusal remain enforced. All three staged/direct catalogues compare equal. The installed equipment transport and application-side download code remain byte-identical. Claude's mutation/replay/actor fixes remain intact; only the unapplied financial-source helpers and regenerated dependent transports changed.
- **Downloads:** inspected the strict two-field request, server-resolved tenant/path, per-request `manage_source_files` authorization, private bucket and SHA verification before saving bytes. #228 retains and strengthens the trusted-click assertion. Existing issued URLs remain bearer credentials for up to 60 seconds; immediate revocation of such a URL is not promised.
- **Incomplete accounting/issuance:** statement SQL:122 hardcodes officialIssuance.available=false with explicit reasons; the page labels incomplete draft, incomplete performance basis and reference-only prior amounts. Existing PPE/grants issue blockers remain. A balanced TB and a ready workpaper do not establish complete statements, standard compliance or issuance authority.

## Repair and transport identities

Source repair commit: `1cc08c0500ab4422366d9a364f878ec6b28fca3b`. Subsequent local commits pin/render the transport and record this review. No remote head was amended.

| Unapplied source | Bytes | SHA-256 |
|---|---:|---|
| `20261207100000_ipsas_accrual_preparation.sql` | 52,207 | `c5de982c6ee694999bcda2cb4b9b9dc80a49731cee7256da940179ced0c7e19d` |
| `20261208100000_ipsas_grants.sql` | 30,695 | `2598fc7adfed4f04225a59efb1ba8f95e01db81ea09586b54d86569bb938dced` |
| `20261210100000_ipsas_statement_review.sql` (unchanged) | 19,538 | `ec966e4fd1598f947ccd58b096cde0a1b3f842456aa02acec6bf39db508091c2` |

| Generated form | Bytes, excluding optional terminal LF | SHA-256 |
|---|---:|---|
| preparation bootstrap | 7,369 | `390b04a3841c0e5706fb41ea2089db26b29313e65a7098251105b83485814666` |
| preparation apply | 13,541 | `6b8fa74cfd0e720980bfc31830df5e3ba668c1e677b3ed1bda229b6aae59d5b2` |
| grants bootstrap | 7,669 | `ae8c16c80455d317481e8748504c97fb5f5dc84531fb3835c6ec29d3e2bcd3d9` |
| grants apply | 14,318 | `97d0c7d888c5fd95562a46a6d038c3868b73e18f624f99805de5fc7b43e59b9f` |
| statement bootstrap | 7,831 | `a1b8319658d088a5ae28b6a369c134807487cb9fa736dbfd847fddf165f6e532` |
| statement apply | 14,295 | `adf6edef9c9e6738a3390cb5692ceffd92093b26044d62067144a7273c006752` |

All generated SQL came from the generators, not hand edits. Explicit candidate rendering pins and their tests were updated to the new exact identities. Historical release documents are labelled superseded. No applied mirror/journal was changed. Conditional future installation remains equipment head 91 → preparation 92/93 → grants 94/95 → statement 96/97, only after a fresh separately authorized journal check. Existing old IPSAS bytes must not be used with this repair.

## Validation and evidence limits

Reused broad final-head evidence: [#227 run 40919852236](https://github.com/hirorobert/axiom-insight-craft/actions/runs/40919852236) and [#228 run 41000657309](https://github.com/hirorobert/axiom-insight-craft/actions/runs/41000657309), verified through the GitHub workflow/jobs API: each completed successfully with nine successful jobs and the manual write-capable staging RLS job skipped. The complete browser/auth journeys and broad suites were not rerun locally. Their records are commit-specific and do not certify the repair head or hosted state.

Local repaired-source checks:

| Check | Result |
|---|---|
| Component/client/scope/transport regression set | 117/117, 12 files; [log](evidence/targeted-tests.txt) |
| PPE real-engine/native proof | [29/29](evidence/ipsasPreparation.json) |
| Grants real-engine/native proof | [29/29](evidence/ipsasGrants.json) |
| New independent adjusted/stale-source regression | [9/9](evidence/ipsasIndependentReview.json), manifest validated |
| Preparation transport | [23/23](evidence/ipsasTransport.json) |
| Grants transport | [24/24](evidence/ipsasGrantsTransport.json) |
| Statement review and transport native proof | [28/28](evidence/ipsasStatementReview.json), including real adjustments, contra figures, ten-way writers/replays, revocation before/after admission, tenant/API refusals and history |
| All three generators `--check` | Passed |
| Migration-authority regression tests | 9/9 |
| Application typecheck; changed-file eslint; production build; whitespace check | Passed |

No expected monetary amount in the existing PPE/grants golden cases changed. Their setup now reviews the shared mapping once before certifying both years; the old second review invalidated the first certification and concealed F1. The incompatible equity-as-grant-revenue negative test now requires a null amount and UNKNOWN blocker instead of accepting the wrong-class amount and a numerical DIFFERENCE blocker. This is a stricter refusal, not an accounting-results relaxation.

Failures investigated: the first transport tests correctly rejected stale candidate rendering pins/source commit/byte counts after regeneration; these exact constants were updated, retaining byte-equivalence and tamper assertions. The initial new proof manifest used human-readable IDs with spaces; the validator rejected them. IDs now satisfy its existing schema, without changing its nine assertions. The release-journal suite had 64/65 passes and one five-second Windows timeout, also seen on its serial repeat, plus worker reporting timeout. The same remaining test's original missing/duplicate/reorder assertions completed in 8.65 seconds with a **local command-only 60-second budget**; 64 other tests were deselected for that focused run. No repository/CI timeout, assertion, skip or financial expectation was changed. This is not a claim that the default-timeout local suite passed.

## Remaining acceptance blockers

1. Incorporate the local source/UI/transport repairs and run final-head CI/review on the resulting integration commit. The supplied remote heads are still defective. Reconcile the separate Claude App.tsx work if it is brought into the same release.
2. Qualified accounting ownership/review, authorized real-entity evidence and the timed accountant/no-coaching acceptance remain outstanding. Synthetic fixtures and successful arithmetic do not constitute accounting acceptance.
3. Complete requirement-universe/register review, disclosures, prior published comparative/transition evidence, opening bridges, pre-close performance completeness, cash-flow and component net-assets workpapers, budget applicability/reconciliation, review policy and frozen issuance remain unaccepted/incomplete. No official IPSAS issuance is enabled.
4. Hosted journal/prerequisite verification, separately authorized installation/mirror registration, deployed-function attestation, frontend publication and hosted authenticated acceptance are unperformed. Invitation acceptance, member provisioning and rollout through the product UI were operator fixtures in existing journeys, not proven onboarding.
5. Source-file rights, retention/audited-download policy, post-plan access and acceptance of the 60-second bearer-link limitation remain recorded decisions. None was silently resolved by this technical review.

The next feature stage remains stopped at this review verdict. No release action is authorized by passing local checks.
