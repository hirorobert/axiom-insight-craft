# QuickBooks Online connector: recommended decisions, and the questions only Intuit and the firms can answer

> **STATUS: RECOMMENDATIONS for the owner and the team. Nothing here is appointed, approved by a lawyer, or sent to anyone.** The owner asked
> for the best recommendation on each open item (2026-11-01). Where an item can only be decided by a named person, a company or a lawyer, this
> document says so and gives them what they need to decide in one sitting. Companion to `QUICKBOOKS_ONLINE_CONNECTOR_PLAN.md`.

## A. Decisions the owner can take today (with the recommended answer)

| # | Decision | Recommendation | Why (one line) |
|---|---|---|---|
| D1 | **Connector scope for version 1** | QuickBooks **Online** only; the **Trial Balance** report only; **user-initiated** Connect and Refresh only (no schedules, no background pulls); **regions proven by a recorded sample** (US, UK, Australia, Canada today); every other region **refused with a stated reason**, never guessed. | The converter and guard already enforce exactly this; it is the smallest thing that is safe and useful. |
| D2 | **Manual path stays first-class** | Keep Excel/CSV upload and the QuickBooks **Desktop** export recogniser for every user, always. The connector is a convenience for QuickBooks Online users, never a requirement. | Tanzania firms may use Desktop or an edition Intuit's API does not serve; the manual path must never degrade. |
| D3 | **Storage design (plan section 12)** | **Approve the design** as written: tokens only in `qbo_connections` as an AES-256-GCM envelope (key in an Edge Function secret, bound to workspace + connection + purpose), service role only; `qbo_oauth_states` single-use and short-lived; `qbo_pulls` append-only provenance with the upload id as a plain uuid (no foreign key). | It follows the repository's existing rules (service-role writes, `firm_members.id` as actor, append-only evidence). The migration is then written as its own PR with a disposable-database proof, **after** D5. |
| D4 | **AI exclusion** | Connector-sourced data is **excluded from AI features by default**; a person with authority may lift it per workspace only after a lawyer has read Intuit's terms. | The terms are unread; excluding by default is reversible, including by default is not. |
| D5 | **Who builds the rest (charter section 9)** | **Do not start the connect/pull functions or the migration until the three roles for B9 are named.** The offline parts (converter, guard, envelope, fixtures) are done and do not need them. | The charter requires a technical owner, an accounting author and an independent reviewer per item; only the team appoints them (see C). |
| D6 | **Production access** | **No production Intuit app, keys or client data until Intuit has answered questions 1 to 3 in section B in writing.** Develop and test only against sandboxes. | The partner programme's country restriction may bar a Tanzania-based developer; finding that out after building is the expensive way. |
| D7 | **Fiscal-year boundary** | The pilot's exit criterion includes a **real company with two years of history**, to prove how income and expense accounts behave when a report's end date is in a later fiscal year than its first data. Until then the connector always sends **both** dates and records them. | The sandbox holds one year only; the behaviour is unproven. |
| D8 | **Reader tolerance for Excel noise** | **Approved and built** (PR #237): number cells within a millionth of a minor unit of a whole minor unit are read as that unit; text and real third decimals still refused. | Real QuickBooks exports (AU, CA) were being refused. |
| D9 | **Redeploy plan for the two reader fixes** | Deploy `process-trial-balance` and `layout-assist` **together, once**, from main after #235, #236 and #237 are merged and CI is green; verify on the 2025 test file (not live client data) before announcing; roll back by redeploying the previous known closure (digests are in `verifyDeployedClosure.mjs`). Each deploy is a separate explicit step in Lovable. | One deploy, one verification, one rollback target. |

## B. Questions that only Intuit can answer (draft; the owner sends, from Intuit Developer Support)

Send as one message from the account that owns the developer app. Do not include any secret, key or client data.

> Subject: QuickBooks Online Accounting API: production eligibility and regional coverage for a developer based in Tanzania
>
> We are building a read-only integration that reads the Trial Balance report of a user's QuickBooks Online company, user-initiated, for audit and
> tax firms in Tanzania. We have a development app (Accounting scope) and sandbox companies. We would like written answers to:
>
> 1. **Eligibility.** The App Partner Program page says it is available for partners based in the US, UK, Australia and Canada. Can a company based in Tanzania publish an app and obtain production keys? Under which tier and fees? If not, what is the supported route for a developer outside those countries?
> 2. **Regional coverage.** Which QuickBooks Online editions and countries does the Accounting API (`/v3/company/<realm>/reports/TrialBalance`) serve? Is a company in Tanzania served, and under which edition (for example a Global or UK/US edition)? The sandbox country list offers only the US, Australia, the UK and Canada; how can a developer test other editions? Please also confirm the report shape for France (`TrialBalanceFR`) and India.
> 3. **Call classes.** Does the Reports API count as a Core or a CorePlus call for the Builder tier's 500,000 CorePlus calls per month?
> 4. **Read-only access.** Is there a read-only variant of the `com.intuit.quickbooks.accounting` scope? If not, is a read-only integration compatible with the app assessment?
> 5. **Terms.** Do the developer terms restrict (a) storing report data after a user disconnects, (b) processing it with machine-learning or AI features, or (c) transferring it outside the US? Which clause?
> 6. **Production review.** What does the app assessment require (security questionnaire, penetration test, privacy policy), and how long does it take?
> 7. **Fiscal-year semantics.** For the Trial Balance report with `start_date` and `end_date`, are income and expense accounts cumulative from the fiscal-year start, or from the first transaction? We observed that `start_date` had no effect on the figures.
> 8. **Disconnect.** What is the supported token-revocation endpoint, and is there a webhook when a user disconnects the app inside QuickBooks?
> 9. **Home currency.** In reports for a company with foreign-currency accounts, are all amounts in the home currency?

## C. What only people can supply (a one-page fill-in for the team)

| Item | Who | What the charter asks |
|---|---|---|
| B9 **technical owner** | the engineering lead | Owns the Edge Functions, migration and proofs. |
| B9 **accounting author** | a qualified accountant (not the technical owner) | Writes and signs the parity and fiscal-year acceptance cases. |
| B9 **independent reviewer** | a person who did not build or author it | Reviews parity evidence and the abuse-case results. |
| **Lawyer** | counsel | Reads Intuit's developer terms (storage, AI/ML, cross-border transfer) and Tanzania's data-protection rules; answers D4. |
| **Pilot firm** | one willing firm with a QuickBooks Online company of **two fiscal years** | Consents in writing to a read-only pull; supplies D7's evidence. |

## D. Questions for the Tanzanian firms (one short form)

1. QuickBooks Online or Desktop? If Online, the address you sign in at and the country shown for the company.
2. The company's home currency and the month its fiscal year starts.
3. Do you export to Excel today, and does the file open without edits in our upload?
4. Would you let us read the Trial Balance through a Connect button (you sign in at QuickBooks; we never see your password)?

## E. Order of work once the names exist

1. Intuit's written answers to B1 to B3 (decides whether production is possible at all).
2. Lawyer on B5 and D4.
3. Migration PR (D3) with the disposable-database proof, then the connect and pull Edge Functions behind the existing gates.
4. Pilot read-only pull with the two-year company (D7), reviewed by the independent reviewer.
5. Production app assessment (B6), only if B1 allows.
