# First-period governed review (20261217100000)

**Status: authored, NOT applied to any hosted database.** Stacked on the Ready for Reporting pilot head
(PR #255, `feat/ready-for-reporting-pilot`, `d688387`); `origin/main` was `f366367` when this was written. The change
that is specific to this PR is everything except the pilot: review `git diff feat/ready-for-reporting-pilot...`.

Charter references (`docs/architecture/CFOCLOSE_DEVELOPMENT_CHARTER.md`, v4, **not yet adopted**; existing controls stay in
force): P3, P4, P6, L8 (Answer: a confirmed fact with evidence and confirmer, bounded narrative), R7, §11.1 (first-period
paths are explicit and requirement-driven, never a fictitious prior report; unknown applicability never defaults), §11.3
(request identity, locks, same-transaction decisions). No amendment is claimed or needed: the change tightens a gate.

## The defect

`fs_declare_first_period` (20261017100000) accepted **any** certificate reference with **any** issue date, and
`fs_first_period_declared` was true whenever that declaration was the latest record and CFOClose held no earlier trial
balance. "No earlier trial balance **in CFOClose**" is a fact about the workspace, not about the entity: an established
entity that started using CFOClose this year could cite its 2018 certificate and clear `COMPARATIVE_PERIOD_MISSING`
(and the comparatives status became `first_period_exception`).

Reproduced before any change on both `origin/main` (`f366367`) and the pilot head (`d688387`) on disposable PostgreSQL:
`scripts/db-proof/firstPeriodBypassReproduction.mjs`.

| | origin/main f366367 | pilot head d688387 | this PR |
|---|---|---|---|
| `COMPARATIVE_PERIOD_MISSING` after a 2018-certificate declaration | **cleared** | **cleared** | present, with `FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED` |
| comparatives status | `first_period_exception` | `first_period_exception` | `missing` |

## What changes

* `fs_first_period_declared` — the one predicate behind the blocker, the comparatives status and its dependency hash — is
  true only for a **verified, still-bound review**: structured facts (legal name, registration number, TIN, basis,
  registration and effective-start dates, the exact reporting dates), cited **immutable evidence revisions** (hash,
  issue date, the date the document establishes), a bounded written basis, and a decision by a **different** approver
  (`approve_certification`), bound to the entity, the period dates the server reads from the authoritative trial balance,
  the facts, the cited revisions, **every** evidence revision of the relevant kinds (cited or not, whenever it arrives)
  and the rule version `first-period-rules/1`.
* Anything that changes afterwards ends the exception and names why (`FIRST_PERIOD_DECISION_STALE`,
  `FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS`, …); a re-review restores it. Nothing is deleted: claims, decisions and evidence
  revisions are append-only.
* Legacy declarations stay recorded, unchanged, as **claims**. They are never promoted. No claim or decision is created by the
  migration (its postcondition asserts zero).
* A **dormant** entity qualifies only through the dormancy basis: registration before the period, dormancy evidence
  covering registration to the day before the start, commencement evidence, "no earlier statements prepared", no
  contradicting record, and an approver's decision.
* **Opening balances are independent.** While the exception is the comparative requirement's basis, the openings need their own
  verified support (`OPENING_SUPPORT_*`): a nil opening (books begin no later than the entity's start, opening position
  evidenced) or activity before bookkeeping began, reconciled item by item to the stated total, each item inside
  `[effective start, bookkeeping start)` and each citing evidence that establishes its date.
  Activity inside that window is **never** a contradiction; activity before the effective start is.
* Drafting stays available; every unresolved item carries one specific next action
  (`fs_first_period_status`, `public._fs_fp_next_action`, mirrored byte for byte in
  `src/lib/financialStatementsWorkspace/firstPeriodNextActions.ts` and pinned by a test).
* `fs_publication_blockers` is **not re-created from a copy.** The migration reads the live definition (document-structure v7 +
  the 20261123100000 server-compilation splice + the 20261216100000 readiness splice), asserts the anchored block occurs
  exactly once, replaces it with itself plus two calls (six added lines), re-asserts every splice afterwards, and the
  proof shows the pre-migration text is a line-subsequence of the new one with exactly those six lines added.
* Every writer takes `_fs_scope_lock(company, period)` first, as the sign-off transition does.

## Rollout (read-only preflight)

`docs/release/first-period-governed-review/preflight.sql` — one `BEGIN READ ONLY` statement, run **before** applying. It returns
the active legacy declarations, those with an open engagement (a report lineage without a FINAL), those whose certificate
predates the period, issued FINAL reports without comparatives (reported, **never altered or revoked**), and the
single action affected users will see. **The hosted counts have not been obtained** (this work had no hosted access); the
owner runs the query. The proof's synthetic result: 2 active declarations, 2 with an open engagement, 1 whose certificate
predates its period, 0 issued without comparatives, 3 declaration rows in all.

What an affected user sees after the migration: `COMPARATIVE_PERIOD_MISSING` plus
`FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED` — *record the first-period facts, cite the registration evidence, and have a
different partner or manager review them.*

## Proof

`scripts/db-proof/firstPeriodGovernedReview.mjs` (CI step added; its `FIRST_PERIOD_GATE_ABSENT=1` regression run must fail). It
replays the chain before the migration, builds issued history and legacy declarations, runs the preflight, applies the
migration, and exercises: the old-certificate bypass (also with forged dates, a wrong name/TIN/dates, and self-approval), a
genuine first period, legitimate activity before bookkeeping began, unresolved dormancy (missing evidence, coverage gap, earlier
statements, resolved by a different approver), a verified first period with unsupported openings, contradictory evidence
arriving after approval (stale → retract → re-review, history kept), the valid comparative path to FINAL, the
server-compilation blocker, a pilot-opted-in scope, and an evidence change and a decision change racing with sign-off in
**both** orderings. Issued history is compared byte for byte before and after.

## Remaining gaps (stated, not hidden)

1. **A first-period IFRS-for-SMEs report cannot reach REVIEWED/FINAL on this commit, with or without this change.** The
   statement-evidence engine builds the cash-flow roll-forward from comparative balances
   (`CASHFLOW_ROLLFORWARD_BALANCE_MISSING`, `STATEMENT_EVIDENCE_MISSING:smes.set.scf/socie`); there is no first-period path in
   it. This PR clears only the comparative requirement and the opening-balance support; it deliberately does not edit financial
   calculations (CLAUDE.md §8.1). The sign-off outcome for a genuine first period is therefore "refused at independent
   blockers", and the races are proven on the blockers the real sign-off function returns, not on a successful FINAL. A
   first-period cash-flow/equity path (nil or reconciled opening) is a separate task needing a statutory reference.
2. **The server cannot read the documents.** It binds their hashes, dates, kinds and references and requires a different
   approver's decision; whether a certificate is genuine and describes this entity is the approver's judgment, recorded and
   bound — not mechanically verified.
3. **Accounting review pending.** The rule set `first-period-rules/1` / `opening-balance-rules/1` and the evidence kinds are
   unreviewed by an accounting reviewer, and no IFRS for SMEs paragraph is cited in code. Edition/paragraph references need
   verification before the rules are described as meeting the framework.
4. Opening support is judged on its own facts and evidence; it is **not** tied to the ledger's opening journal here (the pilot's
   `opening_bridge` does that for opted-in scopes).
5. Proofs ran on embedded PostgreSQL 18.4 (CI uses `postgres:16`); no browser acceptance and no UI for the new flow exists in this
   PR (the page still shows the server's reasons and next actions through `serverBlockers.ts`).
6. Any new evidence revision of a relevant kind re-opens the review (deliberate, conservative): a harmless extra copy needs a
   one-click re-decision.

## Client change that is not the gate

`src/lib/reporting/signoff.ts`: the reporting-input schema required dates on a *missing* comparative
(`{ "state": "missing", "periodYear": 2025 }`), so the browser could not prepare any version for a first period. Dates on a missing
comparative are now optional; a present one still carries both.
