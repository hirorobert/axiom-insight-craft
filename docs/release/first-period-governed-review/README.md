# First-period governed review — standalone on main (20261223100000)

**Status: authored, NOT applied to any hosted database.** Defect **S2-A03**. Branch
`fix/first-period-governed-review-standalone-20261111`, cut from `origin/main` `d20a36b`.

This is a **standalone port** of draft PR #256 (`20261217100000_first_period_governed_review.sql`, stacked on the Ready for
Reporting pilot, PR #255). The first-period controls are the same objects with the same behaviour; the port removes only what
existed because of #255 — the preflight requirement on `_rfr_blockers` and the assertions that the pilot's readiness splice is
present in `fs_publication_blockers`. It does not need, create or change anything of the pilot.

**`20261223100000` supersedes `20261217100000` for main. The two cannot both apply**: they create the same tables and
functions, and each one's preflight refuses when the other's objects exist. If #255/#256 later land on top of this,
`20261217100000` must be dropped from that stack (or rebuilt on top of this file).

## The defect

`fs_declare_first_period` (`20261017100000`) accepted any of four evidence kinds, any reference text and an evidence date
checked only against `current_date`; one `approve_certification` holder declared alone; `fs_first_period_declared` was then
true whenever that declaration was the latest record and CFOClose held no earlier trial balance. That suppressed
`COMPARATIVE_REQUIRED_MISSING` (`20261020100000`) and `COMPARATIVE_PERIOD_MISSING` (`20261111100000` and every later
definition of `fs_publication_blockers`). "No earlier trial balance **in CFOClose**" is a fact about the workspace, not the
entity: an established entity that started using CFOClose this year could cite its 2018 certificate and clear both blockers.

Reproduced on `d20a36b` before any change (`scripts/db-proof/firstPeriodBypassReproduction.mjs`, and the
`FIRST_PERIOD_GATE_ABSENT=1` run of the proof below):

| | main `d20a36b` | with `20261223100000` |
|---|---|---|
| `COMPARATIVE_PERIOD_MISSING` after a 2018-certificate declaration | **cleared** | present, with `FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED` |
| comparatives status | `first_period_exception`, no `COMPARATIVE_REQUIRED_MISSING` | `missing`, `COMPARATIVE_REQUIRED_MISSING` |

## The standard (what this does and does not change)

IFRS for SMEs (2015 amendments), Section 3: comparative information is required for all amounts presented in the current
period's financial statements (paragraph 3.14 as recorded in this repository at
`docs/accounting-content/sme-2015-equipment/REQUIREMENTS_MATRIX.md`; the standard's own text is not in the repository, so the
paragraph number is **citation unverified** against the primary source). Presenting no comparatives is acceptable only for an
entity's first financial statements — **citation unverified** (no paragraph for that exception is held in the repository).

This change governs the **authorisation and evidence** of the first-period exception. It does not change the accounting rule:
whether comparatives are required still comes from `financial_statement_framework_requirements`, unchanged.

## What changes

* `fs_first_period_declared` — the one predicate behind the blocker, the comparatives status and its dependency hash — is
  true only for a **verified, still-bound review**: structured facts (legal name, registration number, TIN, basis,
  registration and effective-start dates, the exact reporting dates), cited **immutable evidence revisions** (hash,
  issue date, the date the document establishes), a bounded written basis (20–1500 characters), and a decision by a
  **different** approver (`approve_certification`), bound to the entity, the period dates the server reads from the
  authoritative trial balance, the facts, the cited revisions, **every** evidence revision of the relevant kinds (cited or
  not, whenever it arrives) and the rule version `first-period-rules/1`.
* Anything that changes afterwards ends the exception and names why (`FIRST_PERIOD_DECISION_STALE`,
  `FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS`, `FIRST_PERIOD_DATES_MISMATCH`, `FIRST_PERIOD_ENTITY_NAME_MISMATCH`, a new claim →
  `FIRST_PERIOD_REVIEW_PENDING`); a re-review restores it. Claims, decisions and evidence revisions are append-only.
* Legacy declarations stay recorded, unchanged, as **claims**. They are never promoted. The migration creates no claim and
  no decision (its postcondition asserts zero).
* A dormant entity qualifies only through the dormancy basis: dormancy evidence covering registration to the day before the
  start, commencement evidence, "no earlier statements prepared", no contradicting record, and an approver's decision.
* Opening balances are independent: while the exception is the comparative requirement's basis, the openings need their own
  verified support (`OPENING_SUPPORT_*`): nil (books begin no later than the entity's start, evidenced) or activity before
  bookkeeping began, reconciled item by item to the stated total.
* `fs_publication_blockers` is **not re-created from a copy.** The migration reads main's live definition (document-structure
  v7 of `20261126100000` + the `20261123100000` server-compilation splice), asserts the anchored comparative block occurs
  exactly once, replaces it with itself plus two calls (six added lines), and re-asserts every splice afterwards; the proof
  shows main's pre-migration text is a line-subsequence of the new one with exactly those six lines added.
* `_fs_scope_lock` exists on main (`20261125100000`, hardened by `20261127100000`); every writer takes it first, as the
  sign-off transition does.
* Client copy (not a UI): `serverBlockers.ts` gives each new reason its one next action
  (`firstPeriodNextActions.ts`, pinned byte for byte to `_fs_fp_next_action` by a test) and `comparatives.ts` no longer says a
  declaration is enough. No bundled statement-compiler file changes.

## Rollout (read-only preflight — run it first)

`docs/release/first-period-governed-review/preflight.sql` — one `BEGIN READ ONLY` statement, run **before** applying. It
returns the active legacy declarations (they **become unverified claims** — a behaviour change the owner must accept before
applying), those with an open engagement, those whose certificate predates the period, issued FINAL reports without
comparatives (reported, **never altered or revoked**), and the single action affected users will see. **The hosted counts have
not been obtained** (no hosted access); the owner runs the query. The proof's synthetic result: 2 active declarations, 2 with
an open engagement, 1 whose certificate predates its period, 0 issued without comparatives, 3 declaration rows in all.

## Proof

`scripts/db-proof/firstPeriodGovernedReview.mjs` with its case manifest
`scripts/db-proof/firstPeriodGovernedReview.manifest.mjs` (structured result validated by `scripts/ci/validateProofResult.mjs`).
Present mode applies the migration on main's chain; absent mode (`FIRST_PERIOD_GATE_ABSENT=1`) stops before it and exactly
the three weakness cases must fail. Both run in CI. PR #256's pilot scope group is not ported (there is no pilot on main);
three cases are added for staleness on new facts, a changed period and a changed company identity.

The browser client cannot read a missing comparative that carries no dates (`src/lib/reporting/signoff.ts`, inside the
pinned statement-compiler closure; its fix is PR #259). The proofs therefore wrap the transport so a missing comparative has
null dates (`lib/firstPeriodKit.mjs`, `withMissingComparativeDates`), as PR #256 did.

## Remaining gaps

1. **No UI.** There is no screen to record evidence, submit facts or decide. Once applied, a first-period entity cannot clear
   `COMPARATIVE_PERIOD_MISSING` until a UI or an owner-run path exists. Every workspace relying on a legacy declaration is
   blocked from REVIEWED/FINAL from the moment of application.
2. **A first-period IFRS-for-SMEs report cannot reach REVIEWED/FINAL on main, with or without this change** (the cash-flow
   roll-forward needs a prior balance: `CASHFLOW_ROLLFORWARD_BALANCE_MISSING`). Races are proven on the real sign-off
   function's blocker set, not on a successful first-period FINAL.
3. **The server cannot read the documents.** It binds hashes, dates, kinds and references and requires a different
   approver; whether a certificate is genuine is the approver's recorded judgment.
4. **Accounting review pending** for `first-period-rules/1`, `opening-balance-rules/1` and the evidence kinds.
5. Any new evidence revision of a relevant kind re-opens the review (deliberate): a harmless extra copy needs a re-decision,
   and prior-activity evidence also re-opens the opening-balance decision.
