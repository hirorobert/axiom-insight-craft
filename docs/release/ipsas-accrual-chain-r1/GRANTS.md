# IPSAS accrual — grants and revenue by period (candidate)

Status: **authored and proven on a disposable database and in a loopback browser journey; NOT installed, no installation transport yet, NOT accountant-reviewed.** Stacked on #216–#219. Migration `20261208100000_ipsas_grants.sql` (new objects only; the unapplied #217 migration and #218's pinned bytes are untouched).

## Workflow (one coherent path)
agreement and evidence → **period-specific assessment** (period read from the certified upload's fiscal period, never typed) → obligations and **satisfaction evidence** → server-calculated revenue, receivable and liability → reconciliation to the certified trial balance → generated note and remaining tasks → a reviewer confirms each grant's exact assessment.

## What decides what (the rules the code enforces)
| Question | Rule |
|---|---|
| Which vocabulary applies | Server period start < 1 Jan 2026 → restriction-only / enforceable-condition; ≥ 1 Jan 2026 → binding-arrangement / without-binding-with-present-obligation / without-binding-no-present-obligation. A classification from the other set is a blocker (`CLASSIFICATION_PERIOD_MISMATCH`). Periods outside 2024-01-01 … 2027-01-01 are `PERIOD_PROFILE_NOT_REVIEWED`. |
| Revenue | For classifications with obligations: the **sum of amounts evidenced as satisfied per obligation** (each needs a stated basis and evidence). For a pure restriction or no present obligation: the resources recognised. **Cash received and expenditure never enter the formula** (proved at the database, hand-derived fixtures, and in the browser). |
| Liability | recognised resources − cumulative revenue. A restriction is therefore not a liability by itself; a condition is, until satisfied. |
| Receivable | recognised resources − cash received. |
| Reconciliation | Σ period revenue, Σ liability, Σ receivable each tie **exactly** to certified trial-balance sums over chosen account keys; absent key/figure = unknown, never zero; no explained-difference escape in this slice. |
| Left open (never approximated, never "not applicable") | variable consideration, financing, agency, non-cash resources, modification, collection doubt, foreign currency; grants not fully funded; cash above recognised resources; revenue reversal; early application of the new standard; first-period transition; unanswered complexity questions; no grant recorded without an explicit answer. |
| Confirmation | A reviewer (`review_close`) confirms ONE grant's exact content bound to the server-derived period start; any change voids it; restoring the identical content restores it. Preparer-entered classification and figures are proposals until then; the note generates no wording for an unconfirmed grant. |

## Evidence
- `src/lib/ipsasAccrual/grants.test.ts` — 27 tests with hand-derived expectations (fixtures documented in `grants.fixture.ts`): IPSAS 47 period (revenue 4.5M + 2.0M; liability 5.5M; receivable 4.5M) and IPSAS 23 period (condition 2.4M with liability 3.6M; restriction 1.0M with no liability); metamorphic tests that cash, ordering and unrelated inputs do not move revenue.
- `scripts/db-proof/ipsasGrants.mjs` — 29 cases on the full chain: role/privilege matrix, framework gate, tampering (cross-company, unknown grant, direct helper call), forged confirmation/totals/period/TB fields ignored, **period read from the certified upload**, twenty-way replay, twenty writers on one revision, changed intent refused, both hand-derived fixtures through SQL, **SQL ≡ TypeScript blocker codes on 24 + 10 mutations with a distinct-code coverage floor (≥ 20 / ≥ 8)**, TB facts and unknown-is-not-zero, confirmation bound to grant and period, append-only history, SME and PPE rows byte-identical, revoked access incl. replay.
- Browser: `ipsasJourney.mjs` + `ipsasGrantsSteps.mjs` (headless Chrome, loopback bridge, **simulated identity**): grants typed in with obligations and evidence; server figures; cash changed, revenue unmoved; reviewer confirms; note and no open matter; reopen restores from the server; concurrent writer refused by name with the edit kept; dropped response retried with the original request identity; tampering through the bridge. 24 checks; 1280/375 px.

## Defects the browser and tests found while building (fixed, regression tests added)
1. Before the first save the server returns no assessment, so the editor offered **no classification** although the certified period was known; the vocabulary now comes from the server-supplied period.
2. The long "Discard grant edits…" button was clipped at 375 px.
3. A first integration displaced the opening guidance ("bring in the trial balance…") with "Record the grants"; grants now drive the next step only once the equipment work has started.

## Remaining accounting-review gaps (nothing here is accountant-approved)
- The classification vocabulary and the bounded revenue model come from the reviewed candidate (#216); **no paragraph-level mapping** of IPSAS 23 / IPSAS 47 / transition provisions has been reviewed by an accounting author (UNASSIGNED). Whether "restriction-only" revenue timing, the treatment of grants with a return clause, and the "binding arrangement" obligation model are correct for each real agreement is an accounting judgement the software only records and checks for consistency.
- First-period transition and early application are blockers, not supported. Comparatives and restatement are not produced.
- Not covered: partly funded / multi-year conditional funding, receivable impairment, grants in kind, agency (pass-through) grants, grants in a foreign currency, transfers expenses (the paying side), revenue reversals, donor/fund (management) reporting views and restricted-fund net-asset components.
- Prior-period cumulative revenue is an evidenced input, not read from an issued prior schedule.
- Disclosure wording is a draft: note numbering, cross-references, and manual-edit preservation/regeneration diffs are not built.
- Installation: no staged transport exists for `20261208100000`; it would extend the chain `…0090 → 0091/0092 (IPSAS transport) → …`. Not delivered.
- Browser proof uses simulated identity; **no authenticated end-to-end acceptance** (needs a local Supabase Auth + PostgREST + RLS journey).
