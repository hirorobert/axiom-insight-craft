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
| D6 | **Production access** (update 2026-11-01: the owner chose the UK entity route, see F3) | **No production Intuit app, keys or client data until Intuit has answered questions 1 to 3 in section B in writing.** Develop and test only against sandboxes. | The partner programme's country restriction may bar a Tanzania-based developer; finding that out after building is the expensive way. |
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
> 10. **Concurrent refresh.** If two requests refresh the same connection's refresh token at nearly the same moment, does the second response invalidate the first response's new refresh token, or are both valid? Which one should be stored?
>
> _(Question 10 was not in the case as filed on 2026-11-01, and the developer portal gives customers no comment box on a case: the comments list is read-only. Include it in the reply when Intuit answers, or in the community-forum post if no answer comes within about a week.)_

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

## F. Owner instructions of 2026-11-01 and the recommended answers to everything still open

> Recorded from the owner's messages. Where this section recommends, nothing is accepted on anyone's behalf: each item names who must say yes.

### F1. The B9 team (charter section 9)

The owner named three people for the connector: **Humphrey R Sawe, ACPA; Patrick R Sawe, CPA; Hendry R Sawe, CPA.** The owner did not say which role each takes, so the roles below were a **proposal**; **the owner confirmed them as proposed on 2026-11-01** (recorded in the charter, section 9, row B9). The independence declaration and the committed date are still outstanding.

| Role | Proposed | Why |
|---|---|---|
| Accounting author | **Humphrey R Sawe, ACPA** | Already the named accounting author for B6; writes and signs the parity and fiscal-year acceptance cases. |
| Independent reviewer | **Patrick R Sawe, CPA** | Must not have built or authored B9; reviews the parity evidence and the abuse-case results. |
| Technical owner | **Hendry R Sawe, CPA** (accountable owner), with engineering delegated | Accountable for what is released and operated. If an engineer should hold this role instead, the owner names them. |

**Independence must be declared, not assumed.** The three share a surname. The charter needs a written declaration that the reviewer is independent of the author (no financial or reporting dependence, no role in building or accepting the same item). Whether any family or business relationship exists is for the team to state; if one does, the reviewer for B9 should be someone outside it. The declaration form is in `docs/release/ipsas-register-r1/BRIEFING.md`.

The roles are confirmed, so D5 is met and the connector's database work may start; the reviewer signs nothing until the independence declaration is on file.

### F2. Lawyer review

Reported **done** by the owner on 2026-11-01. **No written opinion is in the repository.** To close the item properly, file a short written conclusion (even an email) on: (a) storing QuickBooks report data after a user disconnects; (b) AI/ML use of it (this decides whether D4's default can ever be lifted); (c) moving it out of the US; (d) Tanzania's data-protection rules. Until then D4 stays: connector data is excluded from AI features. `/terms` and `/privacy` remain not legally reviewed for the paid go-live gate (CLAUDE.md 9.2) unless the same review covered them; say so in the conclusion if it did.

### F3. Production access: the UK route (replaces the "Tanzania-only" assumption in D6)

The owner chose to pursue production access **through a UK entity**. Why it fits: the partner programme is open to UK-based partners; the UK is one of the four sandbox regions; a UK company's sandbox report is already recorded as a proven shape (GBP). What is needed from the owner, none of which an agent can do: (1) the UK legal entity (name, number, registered address) and confirmation it will own the Intuit developer account and production app; (2) whether the current development app and sandboxes are under that entity or must be recreated under it (the app secret is never shared with an agent); (3) the customer contract and data flow between the UK entity and the Tanzanian firms, checked against Tanzania's and the UK's data-protection rules (add to F2's conclusion); (4) the Intuit answers to case 00231947, or a community-forum post if none arrives within a week. **Do not state the entity's country on the Intuit account unless it is true.**

### F4. Scope order

**QuickBooks first** (Online connector and Desktop export reading). Tally is deferred and nothing for it is started. D1 stands.

### F5. Recommended answers to the open decisions

**Hosted entry 97 (statement review apply), recorded `PENDING_REVIEWER`.** The hosted text differs from the reviewed wrapper by one extra leading space on one line (inside the second `has_function_privilege` condition) plus the migrator's final LF. Recommendation: **accept as a recorded variant** once the independent reviewer confirms in writing that the difference is whitespace only and the privilege postcondition behaves identically; then change the journal entry from `PENDING_REVIEWER` to an accepted state citing that confirmation. Do not edit the hosted history, and do not loosen the strict check. If the reviewer will not confirm, re-apply the reviewed wrapper through a new forward entry.

**Source-download audit (open from the design, items a to e).** Recommended defaults, each adjustable:
- (a) **Who may read the audit rows:** the workspace owner and the firm's partner and manager roles for that company (the same roles that may sign off); the actor sees their own rows; the service role keeps SELECT only; no one else. Auditors only through an explicit, logged grant added later.
- (b) **Retention:** keep rows for **7 years from the end of the period they concern**, append-only; deletion only by a recorded retention job after that, denials included. Seven covers the usual five-year tax look-back with a margin; the lawyer's conclusion (F2) should confirm or change the number.
- (c) **Other-company or unknown-upload attempts:** **do not write them to the tenant audit table** (a row naming another company's upload would leak that company's existence). Keep them in the operational log with rate counters for security monitoring.
- (d) **Clock-skew margin:** **keep the 5-second margin and the 60-second link life**, and add measurement before changing them; revisit with measured data.
- (e) **Delivery evidence:** **not wanted.** The function cannot observe delivery, so the record claims issuance only and says so.

**IPSAS accrual register (`DRAFT_REGISTER.md`).** Recommendation: the accounting author reviews it line by line against the standard text and signs the register; the independent reviewer then re-checks a sample (every row marked uncertain plus a tenth of the rest); the register is **not** accepted by the owner alone. Which of the three people is the IPSAS reviewer ("Sawe" was named for B6) is to be confirmed in the same line as F1.

### F6. What happens next, in order

1. The owner confirms the F1 roles and the independence declaration (one line each).
2. Then: the connector's database migration (plan section 12) as its own PR with a disposable-database proof, followed by the connect and pull functions behind the existing gates.
3. In parallel, with no dependency: the owner sends the written lawyer conclusion (F2), the UK entity details (F3), and the pilot firm's consent (D7, one firm with a QuickBooks Online company of two fiscal years).
