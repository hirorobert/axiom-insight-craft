# Expected-output review package: IFRS for SMEs reporting

**Status: NOT VALIDATED.** No requirement of the coverage matrix is VALIDATED. Every expected figure in this repository
was prepared by the author, Claude. Passing tests prove that the product behaves as the author expected. They do not
prove compliance with IFRS for SMEs.

This package asks a qualified accountant to prepare the expected outputs **independently**, and to compare them with
the author's figures only afterwards.

## Reviewer

A qualified accountant (for example CPA(T) / NBAA registered, ACCA or ICAEW) who:
- did not prepare these inputs;
- is independent of the product.

## Procedure (blind)

1. **Read only the inputs and the worksheet.** That is `inputs/*` (two trial balances, the account classification, the
   presentation assignment, the evidence files, and the preparer's decisions and schedule) and
   `REVIEWER_WORKSHEET.csv`.
2. **Do not open the author's figures yet.** Leave `SEALED_AUTHOR_EXPECTED.csv` closed until step 5.
3. **Prepare your own figures.** For each worksheet row, prepare the FY2026 and FY2025 amounts you would present under
   IFRS for SMEs (2015 edition), and write your basis.
   - Where you would present something differently (a line, a classification or a policy choice), say so in `comment`
     and give the figures you would present.
   - Where an input is insufficient to determine a figure, write `INSUFFICIENT` and the reason. Do not estimate.
4. **Answer the judgement questions below** in the worksheet comments, or in a separate signed note.
5. **Compare.** Only then open `SEALED_AUTHOR_EXPECTED.csv` and the product's printed pack (`pack-final-v2.pdf` in the
   handoff). Fill in `agrees_with_product_output` with Y, N or —.
6. **Sign.** Record your name, qualification, registration number, the date, and the SHA-256 of the completed
   worksheet.

## Judgement questions the author could not settle alone

1. **Profit on the statement of financial position.** Equity is presented from a pre-closing trial balance, as the
   equity accounts plus "profit for the period not yet closed to retained earnings". Is this presentation acceptable,
   or should the equity lines be presented after closing?
2. **Classification in the cash-flow statement.** Interest received, interest paid and income tax paid are all
   classified as operating (7.14 and 7.17 policy choices). Agree?
3. **Expense analysis.** Expenses are analysed by function (5.11(b)), with depreciation inside "distribution,
   administrative and other". Does this need the additional disclosure of 5.11?
4. **Total comprehensive income.** With no item of 5.4(b), the product presents total comprehensive income equal to
   profit for the period, and also keeps the profit line (5.5(f) and (i)). Acceptable?
5. **Comparative cash flows (FY2025).** These rely on the preparer's FY2025 ledger and on the opening cash of the signed
   prior-year statements. FY2024 balances are not available. Is that sufficient evidence for comparative figures?
6. **Disclosures.** The notes wording in the proofs is placeholder text, so it is not under review here. Which of
   Section 8 and the section-specific disclosures does a complete set for this entity still need?

## How a completed review becomes VALIDATED

A signed worksheet is committed as a **golden fixture**, unchanged and with its SHA-256 recorded. A test then compares
the product's output for these inputs with the **reviewer's** figures, never the author's.

For every requirement the fixture covers, the coverage entry moves to `VALIDATED` with:
- the fixture's file;
- the reviewer's name and qualification;
- the sign-off date.

That matrix change is the only one allowed to produce VALIDATED (`src/lib/frameworkPacks/coverage.ts`). Where the
reviewer disagrees, the product is corrected first, or the limitation is registered.

## Regenerate

```
DB_PROOF_MODULES_DIR=<dir> bun scripts/release/renderReviewPackage.mjs          # writes this folder
DB_PROOF_MODULES_DIR=<dir> bun scripts/release/renderReviewPackage.mjs --check  # verifies it
```

The inputs are the proof fixtures in `scripts/db-proof/lib/reportingKit.mjs`.

**Fixture correction.** While this package was being prepared (2026-10-08), the author's own FY2026 ledger was found
inconsistent with the trial balance:
- tax paid was 500, but 700 + 900 − 900 = 700;
- interest paid was 500, but the expense is 600 and there is no accrual account.

The ledger was corrected. The product could not detect the inconsistency: it reconciles the ledger only to the cash
accounts. Catching errors like this is why an independent review is needed.
