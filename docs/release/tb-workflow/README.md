# Trial Balance workflow — release candidate (Track A and Track B)

**Status: release candidate on branch `feat/tb-workflow`. NOTHING here is applied, deployed, published or activated.**
Production release (migration application, function deployment, enforcement floor, Publish) is a separate, explicitly
approved step. All data used anywhere in this work is invented.

## 1. What changes for a person

| Before | After |
|---|---|
| The account home listed every engagement from an unbounded read | A server-paged engagements list: search (entity, code, TIN; literal), status, purpose and period filters, three sorts, Previous/Next, exact count, and a notice when the list changed while paging |
| Upload was a compact card on the home | A focused page, `/upload`, linked from the list; saved (unchecked) uploads listed with an explicit, confirmed removal; a new entity whose name matches an existing one (the engine's normalisation) is asked about first |
| A differing entity name, unrecognised trailing text and clearing/in-transit balances were review notes that never held anything back | Each is a finding that **needs a recorded decision** before the trial balance can be accepted; the decision is made under the finding itself |
| An imbalance said "correct the file" | Same instruction, plus **"Look for likely causes in this file"**: bounded leads by row (an amount equal to the difference, half of it, a digit transposition, rows read as totals, rows with amounts not read, both sides on one row) — never a plug, never a claim about the ledger |
| A file for the wrong entity could only be "confirmed" or ignored | "Different entity" blocks it, with the way out: remove it here (when removal is allowed) and find the right engagement |
| An accepted trial balance ended there | "Continue to financial statements", only where the server enables reporting for the company |

## 2. Accounting-integrity rules this implements

* No plug, no suspense entry and no balanced journal is ever offered for an imbalance. The investigation proposes no figure.
* No silent row drop: trailing text decided "not part of the trial balance" stays recorded with its rows; "part of the
  trial balance" **blocks** the file with a layout correction (`LAYOUT_CORRECTION_REQUIRED`).
* An account name is never proof of error: clearing balances are explained with evidence, not reclassified or removed.
* Nothing claims the originating ledger is unbalanced: every investigation result says the leads are about **this file**.
* A decision changes no amount, row, account or mapping.

## 3. The decision model (20261118100000)

* **Registry** `tb_decision_actions` (fixed by migration): `ENTITY_NAME_DIFFERS` → `same_entity` (resolves, carries forward)
  / `different_entity` (blocks); `UNRECOGNISED_TRAILING_TEXT` → `not_part_of_trial_balance` (resolves) /
  `part_of_trial_balance` (blocks); `CLEARING_ACCOUNT_BALANCE` → `explained` (resolves). Anything else has no decision.
* **Append-only** `tb_finding_decisions`, written only by `record_tb_finding_decision`:
  * the actor is derived from `auth.uid()` with `prepare_close` (`_layout_actor`), never from the request;
  * the finding's identity (code + subject) is taken from the certification's **own stored findings**;
  * server-enforced confirmations: both entity names exactly; the exact rows; an explanation of 10+ characters and an
    evidence kind and reference; a reason of 3+ characters;
  * outcomes: `recorded`, replay of the same request, `IDEMPOTENCY_KEY_REUSED`, `STALE_EVALUATION`, `VERSION_CONFLICT`,
    `unchanged`, `FORBIDDEN`, `IN_PROGRESS`, `FINDING_NOT_FOUND`, `ACTION_NOT_AVAILABLE`, `CONFIRMATION_REQUIRED`,
    `EVIDENCE_REQUIRED`, `REASON_REQUIRED`;
  * **immediate invalidation**: the certification it was made against is invalidated in the same transaction
    (`reason = 'finding_decision'`) and `#finding_decisions:<upload>` is bumped.
* **Carry-forward**: only `same_entity`, to the company's later uploads naming the same entity, and only while the
  company's identity is unchanged (`#entity` revision recorded on the decision).
* **Dependencies**: `#entity` (company name, code, TIN — the rename race), `#finding_decisions:<upload>`, and
  `#entity_decisions` for a run that used a carried decision. A rename makes a dependent result non-authoritative at once.

## 4. Finalize: the evaluation manifest and generations (the trusted-handler boundary)

From engine generation 7, `tb_finalize_attempt` refuses a certification unless its `evaluation` (`tb-evaluation/1`):
names every rule of `tb_evaluation_rules(7)` exactly once (an omitted, unknown or repeated rule is refused); leaves a rule
`not_reached` only on a blocking result; agrees with the findings in both directions for `entity_name`, `trailing_text`,
`clearing_accounts` and `balance`; gives every decision-taking finding a subject; cites only **current** decisions; and,
when accepted, leaves no decision-taking finding without a current, resolving decision. A generation newer than
`tb_max_engine_generation()` (7) is refused at begin and at finalize. `tb_begin_attempt` refuses an engine below 7 for an
upload that has decisions.

**Boundary.** The database cannot re-parse the file. It verifies everything above from what it holds; it trusts the
service-role engine (process-trial-balance generation 7) for the parse itself — the same boundary as every earlier
generation. Generation 7 is **not enforced for uploads without decisions** until `processing_release_control.min_engine_generation`
is raised to 7 — a separate, approved step after the generation-7 engine is deployed.

## 5. Investigation (bounded)

`tb_investigations`: a durable reservation — one running investigation per upload (`uq_tbi_one_running`, a partial unique
index, not an advisory lock) with a lease (30–300 s; 120 s used). An expired reservation is abandoned by the next request
and its worker is fenced out at completion. A completed investigation of an evaluation is reused. Results ≤ 50 leads,
≤ 200 kB; ≤ 10 rows per lead; digit transpositions examined on ≤ 20,000 amounts. Only for the upload's current blocking,
out-of-balance evaluation.

## 6. Migration and cutover sequence (each step needs its own approval)

1. **Apply `tb-portfolio-a1`** (`20261117100000_engagement_portfolio.sql`, wrapper) — read-only additions plus revision
   triggers; independent of every pending FS batch. Postcondition `docs/release/tb-portfolio-a1/postcondition.sql`.
2. **Apply `tb-decisions-b1`** (`20261118100000_tb_finding_decisions.sql`, wrapper) — BEFORE step 3. Postcondition
   `docs/release/tb-decisions-b1/postcondition.sql`. With generation 6 still deployed nothing changes for users: no
   decision can be recorded (generation-6 findings have no subject → `FINDING_NOT_FOUND`).
3. **Deploy `process-trial-balance`** (generation 7; required closure `d454b31f…a957`) and **`trial-balance-layout`**
   (adds `investigate`). Generation 7 on a database without step 2 refuses before any write
   (`DECISIONS_AUTHORITY_UNAVAILABLE`; proven by `releaseOrder.mjs`).
4. **Publish the frontend.**
5. **Raise `min_engine_generation` to 7** only after step 3 is verified live (retires engines that cannot read decisions).

Rollback: before any decision or generation-7 certification exists, the migration's documented rollback; after, roll
forward only. Functions: redeploy the generation-6 closure (`e2553c3b…5bd8`) — it is refused for uploads that have
decisions (by design), and works for all others.

## 7. Evidence (executed on this branch, PostgreSQL 16, invented data)

| Proof | Result |
|---|---|
| `engagementPortfolio.mjs` — authorization matrix, keyset paging in every sort, filters, counts, view token, entity list, measured cost (median 25–41 ms at 130 engagements) | 25/25 |
| `findingDecisions.mjs` — manifest refusals, decision identity/confirmations/replay/conflict/stale/version, fence, immediate invalidation, carry-forward, rename race, 12-way concurrent investigation, lease recovery, bounds | 45/45 |
| `tbHandlerCharacterization.mjs` — the real handlers incl. 6 generation-7 requirements (decisions required, decide and re-check to acceptance, rename invalidates, wrong entity blocks, old engine refused, investigate through the real function) | 43/43 |
| `layoutAuthority.mjs`, `closeReviewAuthority.mjs`, `h1Authority.mjs`, `statementComposition.mjs` (real handler, generation 7) | 38/38, 99/99, 61/61, 37/37 |
| `releaseOrder.mjs` (stage-3 engine pinned to `daa23e4`; generation 7 refused before any write without the migration) | 17/17 |
| `selfCheckingWrappers.mjs` for `tb-portfolio-a1` and `tb-decisions-b1` | 32/32 each |
| Unit/component tests (vitest; decisions, investigation, portfolio, upload page, verdicts, accessibility via axe) | all pass locally (environmental 5 s timeouts on this Windows host excepted, re-run green with a longer timeout) |
| Local-stack browser journey (new "Trial Balance workflow" group, 7 checks) | **runs in CI on the draft PR** — not executable on this host (no Docker) |

## 8. Delivery checklist

- [x] Isolated branch and worktree; synthetic data only; no hosted change
- [x] Migrations with preflights, real-PostgreSQL proofs, wrappers, four registered forms each, postconditions, CI steps
- [x] Engine generation 7 proven with the real handler; release-order behaviour proven
- [x] Browser: portfolio, focused upload, saved uploads, entity pre-check, decision controls, investigation, wrong-entity
      recovery, statements handoff; accessibility checks; 1280/375 widths in the journey
- [x] Closure registries updated (process-trial-balance `d454b31f…`, layout-assist `9508a926…`)
- [ ] CI green on the PR head (including the local-stack journey)
- [ ] Independent review verdict on the final head
- [ ] Owner approval for the §6 sequence

## 9. Known limitations (stated, not hidden)

* **Account-home routing** (resume a single engagement, first run) still reads `useActiveEngagements` (companies,
  engagements and uploads without a page bound). The engagements **list** is server-paged; the routing decision is not
  yet moved onto server status.
* Settings relocation and a left-rail engagement context were not built in this candidate.
* Carry-forward covers only the same-entity confirmation; trailing-text and clearing decisions are per file and period.
* The adjustments page is offered only where already released (reporting groups); classification review is unchanged.
* `DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001` is unchanged: clearing-balance evidence is a reference the preparer records,
  not an independently matched bank transaction.
