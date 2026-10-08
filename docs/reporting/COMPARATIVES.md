# Comparatives

Migration `20261020100000_fs_comparatives.sql`; client `src/lib/comparatives/comparatives.ts`; proof
`scripts/db-proof/comparatives.mjs` (real PostgreSQL, real certifications).

## How the prior year is composed
The comparative column of `fs_statement_composition` (contract version 2) is the prior year's **authoritative
certification**, presented through this year's presentation assignments:
- **Account bridges** (`fs_bridge_comparative_account`, `prepare_close`, append-only): a prior-year account is presented
  through the current account it became when the chart changed. Without a bridge it is not presented and blocks.
- **Restatements** (`fs_propose_restatement` → `fs_decide_restatement`):
  - A restatement is a set of line deltas that keeps the statement of financial position in balance, with a reason and
    a reference.
  - Proposed by `prepare_close`. Approved or rejected by `review_close`, never by the proposer.
  - Only approved, unwithdrawn restatements apply. Withdrawing is a new decision.
  - The as-reported figure stays beside the presented one, and lineage names the restatement.
- Everything else is exactly version 1. The proof shows the hand-computed prior-year figures are unchanged.

## The comparative state (`fs_comparatives_status`)

| State | Meaning | Satisfies the requirement |
|---|---|---|
| `approved` | a reviewer (`review_close`) approved the comparative **as it is now** (its `comparativeSha256`) | yes |
| `unapproved` | available, presented and balanced, not approved | no (`COMPARATIVE_NOT_APPROVED`) |
| `approval_stale` | approved, then something changed (a restatement, a bridge) | no (`COMPARATIVE_APPROVAL_STALE`) |
| `accounts_not_presented` | prior-year accounts on no line | no (`COMPARATIVE_ACCOUNTS_NOT_PRESENTED:n`) |
| `unbalanced` | the prior-year position does not balance as presented | no (`COMPARATIVE_BALANCE_DIFFERENCE:<minor>`) |
| `different_currency` | the prior year is in another currency; translation is deferred, so it can never be approved | no (`COMPARATIVE_TRANSLATION_DEFERRED`) |
| `reference_only` | prior-year statements held only as evidence; shown for reference | no (`COMPARATIVE_REQUIRED_MISSING`) |
| `missing` | no authoritative prior year (including one made stale by later account-review changes) | no (`COMPARATIVE_REQUIRED_MISSING`) |
| `first_period_exception` | an approved first-period declaration is in force (genuinely first period only; `20261017100000`) | yes |

The requirement comes from the pack (`smes.comparatives`, 3.14). Absence never bypasses it.

## Limits (carried)
- One comparative period.
- No currency translation.
- Restatement disclosures (Section 10 wording) are the preparer's notes, not generated.
- Sign-off binding to `comparativeSha256` is the sign-off increment.
