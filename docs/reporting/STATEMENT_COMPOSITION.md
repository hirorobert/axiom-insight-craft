# Statement composition (database-authoritative)

Migration `20261018100000_fs_statement_composition.sql`; client `src/lib/statements/composition.ts`; proof
`scripts/db-proof/statementComposition.mjs` (real PostgreSQL; certifications made by the real `process-trial-balance`).

## What the database composes
`fs_statement_composition(company, year)` composes the **statement of financial position** and the **statement of
comprehensive income**. Its only inputs are:
- `fs_reporting_input`: the authoritative certification with approved Close Review adjustments applied as a layer, and
  the prior year as reported;
- the current **presentation assignments**, i.e. which pack line each reviewed account is presented on.

It uses exact `numeric` arithmetic on minor units. Its rules:
- **Sections follow the reviewed classification.** A line's position is enforced: cash is current, PPE is non-current,
  deferred tax is always non-current, equity lines hold only equity.
- **Compatibility:** an account whose nature does not fit its line (for example a payable on an asset line) is
  *incompatible*. It is not presented, and it blocks.
- **Unpresentable accounts:** accounts with cash-flow classifications cannot be presented on either statement. They are
  listed and they block.
- **Totals only for a fully presented period.** If any account of the period is unassigned, incompatible or
  unpresentable, the totals are `incomplete` (missing, with the count). They are never zero.
- **One expense analysis (5.11):** by function or by nature. Mixing the two blocks (`EXPENSE_ANALYSIS_MIXED`).
- **Balance check:** total assets − (liabilities + equity accounts + profit or loss for the period). A non-zero result
  blocks (`BALANCE_DIFFERENCE:<minor>`).
- **Comparative:** shown only when the prior year is available in the same currency. Otherwise its state is stated
  (`missing`, `not_authoritative`, `legacy_certification`, `different_currency`). Approval of comparatives is the
  comparatives increment.

**Lineage, per line and period:** account, certification, adjusted amount, certified amount, approved adjustment ids,
and the assignment event.

**Identity:** `compositionSha256` covers the contract, the pack edition and line-vocabulary version, the reporting input's identity, the lines
with their lineage, the totals, the accounts not presented and the blockers. It is deterministic, and it changes
whenever anything it rests on changes.

**Edition:** the period start decides (`_fs_smes_edition_decide`, the same table as `editionPolicy.ts`, pinned by the
proof). Early application of the third edition needs a recorded election (`approve_certification`) carrying a
jurisdiction confirmation.

## Authority
- **Assign** (`fs_assign_presentation`): `prepare_close`, under the financial-statements rollout and kill switch.
  Batched, idempotent per request, append-only. A withdrawal is a new event.
- **Elect** (`fs_elect_early_application`): `approve_certification`, append-only.
- **Read:** members with workspace access, through the rollout. Another workspace reads nothing.
- No client writes any table. The vocabulary is immutable and pinned to the TypeScript pack.

## Not composed here
- Cash flows and the statement of changes in equity. Both need evidence a trial balance does not carry (the
  evidence-driven generators in `src/lib/financialGeneration/`).
- Other comprehensive income, and discontinued operations.
- Sign-off binding to `compositionSha256`. That is the sign-off increment.
