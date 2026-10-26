# classification-r1 — specific names win over general words in classification suggestions

Base: `main` 5b2f087b (after PR #200). Scope: the classification SUGGESTIONS made by `process-trial-balance`. No migration, no
change to any reviewed mapping, decision, certification or report.

## What was observed (hosted, read-only, recorded by the owner's connector; not re-read here)

Company `d7c13682-98f1-4512-9c82-0a187609b5ea`, upload `7977ad21…`, decisions saved together on 2026-10-25 17:39:56 UTC:

| Account | Saved mapping | Decision | Fixture expects |
|---|---|---|---|
| 91510 Accumulated depreciation | operating_expenses, debit | USER_ACCEPTED_SUGGESTION of a MACHINE_SUGGESTION | non_current_assets (contra, credit) |
| 95000 Cost of sales | revenue, credit | USER_ACCEPTED_SUGGESTION of a MACHINE_SUGGESTION | cost_of_goods_sold, debit |
| 92500 Bank loan | current_liabilities | USER_MANUAL_CLASSIFICATION (upload `89d486db…`, 17:46:35 UTC) | non_current_liabilities |

The same classifications are in both years' certification snapshots: the saved mappings take precedence over every rule
and were applied on re-check, as designed. The question this record answers is where the SUGGESTIONS came from.

## Root cause — reproduced with the real handler (current source)

`scripts/db-proof/classificationSuggestions.mjs`, BEFORE mode (`BEFORE_REF=5b2f087b…`): the handler at main, a fresh
company, the shipped keyword dictionary, no global mappings, the unchanged file `trial_balance_FY2025_current.csv`:

| Account | Suggestion | Path |
|---|---|---|
| 95000 Cost of sales (acceptance r1) | revenue | Dictionary "cost of sales" is an EXACT term, so the qualifier stops it; the Tier 5 rules take the FIRST match in order and the revenue rule (`\bsales\b`) precedes the cost-of-sales rule. |
| 91510 Accumulated depreciation (acceptance r1) | operating_expenses | Dictionary "contains" correctly picks "accumulated depreciation" (non-current asset), but the expense-over-asset override ("FIX B") saw the shorter term "depreciation" (expense) INSIDE it and discarded the answer; Tier 5 then matched `\bdepreciation\b` (expense) before the accumulated-depreciation rule. Plain "Accumulated depreciation" failed the same way. |
| 92500 Bank loan (acceptance r1) | current_assets, as a CASH account | No dictionary term; Tier 5 `\bbank\b` (cash) is the first match. |
| 94100 Interest income (acceptance r1) | revenue | Dictionary "interest income" is EXACT; Tier 5 `\bincome\b` (revenue) is the first match. |
| (found by the name tests) "Bank" | non_current_assets | Fuzzy dictionary match at distance 2: "bank" ~ "land". |

Every account goes to review with its suggestion pre-selected (`AccountReviewPanel` initial choices), so "Save" accepts it.
That is consistent with the hosted record. **What this does and does not prove:** it proves what the CURRENT source
suggests; the rule array and the Tier 4–5 logic involved are unchanged in source since 2026-09-26. It does not attest which
code the hosted function ran on 2026-10-25: stored hosted reasons ("Revenue", "Depreciation & Amortisation", "Cash & Bank" in
upload `7977ad21…`'s review list) would corroborate the path but are not a deployment attestation. The user did not invent
the classifications; they accepted machine suggestions that were wrong.

## Fix (supabase/functions/process-trial-balance/index.ts only)

1. **Containment wins in Tier 5.** The first rule in order is the candidate; a later rule replaces it only when its match
   CONTAINS the candidate's match ("cost of sales" ⊃ "sales", "accumulated depreciation" ⊃ "depreciation", "interest income"
   ⊃ "income", "bank loan" ⊃ "bank"). A match elsewhere in the name never displaces the candidate, so the established
   compound cases keep their result ("Repair & Maintenance — Motor Vehicles", "Motor Vehicle Insurance", "Equipment
   Repairs" stay expenses). No account code is special-cased.
2. **The expense override ignores an expense term inside the winning term** ("depreciation" inside "accumulated
   depreciation"); an expense term elsewhere in the name still applies the override.
3. **Other income:** a rule for "interest income/received/earned", "dividend income", "other income".
4. **Loans and borrowings:** a name with "loan"/"borrowing" and no maturity cue goes to review with NO suggestion and the
   reason "whether it is a current or a non-current liability … depends on its terms". Names that state it ("long term
   loan", "short-term loan", "term loan", "loan interest", "borrowing costs") contain the match and keep their result. A
   reviewed loan mapping is used as reviewed.
5. **Fuzzy distance scales with length:** at most 1 edit below 8 characters, 2 from 8.

Unchanged: reviewed mappings decide first (Tier 1–2); every non-reviewed result is still only a suggestion that a reviewer
must confirm; class-side arithmetic (accumulated depreciation stays an asset with a credit balance, class side −6,000.00);
decisions are append-only.

## Evidence

`scripts/db-proof/classificationSuggestions.mjs` (CI disposable-DB job, both modes):
- after: 72/72 — every suggestion for both acceptance years equals `account_classification.csv` (loan: review, no
  suggestion); one review batch (17 accepted, 1 manual) and a governed re-check certify both years with total assets,
  liabilities, equity and profit equal to `EXPECTED_TOTALS.csv`; 26 names with and without qualifiers; a reviewed loan
  mapping and a reviewed mapping that disagrees with the rules both decide their account; decisions cannot be deleted.
- before (handler at 5b2f087b): 5/5 — the four registered wrong suggestions reproduce.

## Deployment

Takes effect only when **`process-trial-balance` is deployed** from this commit: closure digest `d0e8eb018c50e870d561c1bd45b21472ab0d29fd57c199cee852bd6f9dee19db` (`node scripts/release/functionClosure.mjs process-trial-balance`; pinned as REQUIRED in `scripts/release/verifyDeployedClosure.mjs`, the previous `89dfebd2…` now KNOWN_OLDER). A deploy response is not an attestation: verify the downloaded bundle with `verifyDeployedClosure.mjs`. No
migration. Merging or publishing the frontend alone does NOT activate it. It changes only new suggestions: the test
company's saved (wrong) mappings stay until a reviewer corrects them in Account review — see the correction plan in the PR.

## Not in scope (recorded)

- Accumulated depreciation's normal balance: a review decision takes the class's default side (assets: debit) — metadata
  only; class-side arithmetic is by class. Close Review A01 still flags its credit balance; a contra-asset treatment is a
  separate, designed change.
- Other qualifier cases of EXACT dictionary terms not named above (e.g. "Bank overdraft (x)") are unchanged.
