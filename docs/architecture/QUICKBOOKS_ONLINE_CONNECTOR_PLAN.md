# QuickBooks Online connector: design plan (read-only, user-initiated)

> **STATUS: PROPOSAL. Nothing here is approved or installed; only the offline pieces listed in 12.1 are built (PR #236), and nothing is connected to QuickBooks.** It implements charter rule R14 ("Connectors. Read-only first") and build item B9,
> whose exit criterion is the A2 parity test. **Statements about Intuit's API, terms, limits or regional availability were first from the author's
> memory; section 9.2 records which were then read from Intuit's own pages or observed in a real call (2026-10-31/11-01), and which remain OPEN.**
> The charter's section 9 rule applies: B9 needs a technical owner, an accounting author and an independent reviewer, none of whom is named for B9 yet.

## 1. What the user sees

1. On the trial-balance intake page, next to "Upload a file": **Connect QuickBooks**.
2. The user signs in to QuickBooks (on Intuit's page, never in our form), picks the company, and approves read access.
3. They pick the period. The trial balance appears as a normal import, labelled **"From QuickBooks, pulled [date and time]"**, and goes through the **same** processing and the **same** review gates as a file.
4. A **Refresh** button pulls again. Nothing changed: "Up to date". Changed: a new version replaces the old one through the existing replace flow, and the existing stale-data rule sends any stage that depended on the old figures back to "in progress".
5. **Disconnect** revokes access at QuickBooks and deletes our stored keys. The data already imported, and its provenance, stay.

## 2. Principles (why this is small and safe)

- **A connector is another source of the same file, not a new authority.** It produces the same canonical trial-balance rows the upload produces and enters the existing upload steps (upload to storage, register, check). It never certifies, never skips review, never writes financial tables except through the existing edge functions.
- **User-initiated only in version 1.** Every pull happens because a signed-in person pressed Connect or Refresh, so the actor is that person's firm-member identity, derived from their login, exactly as for every other financial write (`CLAUDE.md` 4.3). **No unattended or scheduled pulls** in version 1: that removes the need for a machine identity, which does not exist today.
- **Read-only by construction**, enforced in our code (see 4.2), because the OAuth permission itself may not be read-only (unverified).
- **Provenance is immutable and complete**: where the numbers came from, when, with which parameters, and a hash of exactly what was received.
- **Outside data is excluded from AI by default** until a person with authority decides otherwise (see 5).

## 3. Data flow

**Connect.** Browser asks a new edge function for an authorisation link (it carries an unguessable `state` bound to the user, workspace and expiry). Intuit redirects back to a second edge function, which exchanges the code for tokens, stores them encrypted (4.1), records the connection and writes an audit event. The browser never sees a token.

**Pull** (new edge function, called by Connect and Refresh):
1. Validate the login and membership, require the same capability as uploading a trial balance (`prepare_trial_balance`), take an idempotency key.
2. Load the connection; refresh the access token if needed, storing the new refresh token **atomically** before using it.
3. Call the QuickBooks **trial balance report** for the chosen period (a read-only GET). Check it: debits equal credits, every row has a name and an amount, the report's own period matches the request.
4. Save the **raw response** unchanged in private storage (provenance) and compute its SHA-256.
5. Convert it deterministically to the canonical columns (account id, name, debit, credit) in a file, compute its SHA-256, store it at the normal workspace path, and **register and check it through the existing upload steps** on behalf of the signed-in user.
6. Record a provenance row (see 4.3).

**Refresh** is Pull with a comparison: same canonical hash as the current import means "up to date"; different means a new version through the existing replace flow.

## 4. Building blocks that do not exist today (found by searching the repo)

### 4.1 Credential storage
No third-party tokens are stored anywhere today. Needed: encrypted at rest, scoped to one workspace, never logged, rotated on every refresh, deleted on disconnect. Mechanism **to be decided after checking what the hosting platform supports** (a database vault extension, or envelope encryption with a key held as a function secret). Not decided here.

### 4.2 Read-only guard
Our own allow-list of exactly which QuickBooks endpoints may be called (report GETs and the token calls only), enforced in one wrapper, with a test that fails if any other method or path appears in the connector code.

### 4.3 Provenance record
Uploads have **no** field for where a file came from. New append-only table, one row per import, with: upload id, source kind (`file` / `quickbooks_online`), connection id, QuickBooks company id, pulled-at, request parameters, SHA-256 of the raw response and of the canonical file, and `ai_use` (default `excluded` for connector rows). Created by a migration through the normal reviewed route.

### 4.4 Audit
Connect, pull, refresh, disconnect and failures each write an event with the actor, workspace and outcome, never a token.

## 5. AI exclusion
Some accounting vendors restrict AI/ML use of connected data (the team's own notes say Xero's developer terms do); **Intuit's terms have not been read by anyone here, and a lawyer must read them**. Until decided, connector-sourced data is excluded: one shared guard that every function calling an AI model on workspace data must use, with a test that fails if such a function does not. Today `assistant-explain`, `maono-decide` and `maono-root-cause` call AI models; `layout-assist` is not yet wired to one (its own comment says its AI controls are a separate reviewed change). **Open policy question for the lawyer:** does exclusion cover figures derived from connector data (for example the cash-flow analysis), or only the raw import?

## 6. Parity test (charter A2)
The same company's trial balance, once through the connector and once as a manually exported Excel file, must produce the **identical normalised accounting-result hash**; only the provenance hashes differ, and both are kept. Built from a QuickBooks sandbox company; the connector's network calls are replaced by recorded fixtures in CI.

## 7. Phases and exit criteria

| Phase | Work | Exit |
|---|---|---|
| P0 | Decisions and accounts (section 8). Verify section 9. | Every item in section 9 checked and recorded. |
| P1 | This plan accepted; B9 owner, author and reviewer named. | Names recorded in charter section 9. |
| P2 | Provenance table, token storage, read-only guard, connect and pull functions, intake card; unit and database proofs; recorded fixtures. | Proofs pass in CI. |
| P3 | Parity test, security review, abuse cases (forged `state`, stolen link, expired and rotated tokens, another workspace's connection). | A2 passes; negative tests pass. |
| P4 | One pilot firm, one real company, read-only, with consent. | Pilot signed off by the named reviewer. |
| P5 | Intuit's production-app approval, if required. | Approved. |

## 8. Decisions and things only the owner can do

1. Register a developer account and an app with Intuit and create a sandbox company (the assistant cannot do this and must never be given the app secret in chat).
2. Confirm which **QuickBooks edition and country** the firms' clients use, because API availability may differ by edition (section 9).
3. Have the vendor's developer terms read by a lawyer, including AI/ML use and cross-border transfer, and Tanzania's data-protection rules.
4. Name the B9 technical owner, accounting author and independent reviewer, and a pilot firm.

## 9. To verify before any code (all UNVERIFIED, from memory)

| # | Claim to verify | Why it matters |
|---|---|---|
| 1 | The authorisation flow is standard OAuth 2.0 authorisation-code | Shapes the connect function |
| 2 | The accounting permission may be read **and write**, with no read-only variant | Why the read-only guard (4.2) is mandatory |
| 3 | A trial-balance report endpoint exists with start and end dates and an accounting method | The data source |
| 4 | Access tokens last about an hour; refresh tokens rotate and expire after a long idle period | Token storage and "reconnect needed" behaviour |
| 5 | Rate limits per company | Refresh behaviour and retries |
| 6 | Whether API access works for the **edition sold in the clients' country** | Could block the whole plan |
| 7 | Whether a production app needs Intuit's review, and what it asks | P5 timing |
| 8 | The terms on AI/ML use and on storing data | Section 5, legal |
| 9 | Whether report rows carry stable account ids, and how sub-accounts appear | Stable source account ids (charter L1) |
| 10 | Home-currency and multi-currency behaviour in the report | Our currency and denomination checks |

### 9.1 What was checked on 2026-10-31, and how (and what could not be)

Intuit's documentation pages are rendered by script and **could not be read directly** by the assistant's fetch tool (they returned only the page heading), so nothing below is a reading of Intuit's own text. It is what web-search summaries of those pages said.

| Item | Result | Strength |
|---|---|---|
| Sign-up and first steps | Create a developer account (this also gives a sandbox company), create an app and choose the **Accounting** scope, find the client id and secret under "Keys and credentials" (Development toggle), set the redirect URI in the app's Settings, test with the API Explorer or Postman; the sandbox base address is `sandbox-quickbooks.api.intuit.com/v3`. Menu paths differ between documentation versions. | Search summary of Intuit pages; **re-check in the live portal** |
| Sandboxes | Up to 10; for development and testing, **not commercial use**; **region-specific, the country is chosen when one is created**. | Search summary; matters for item 6 |
| Item 6, regions | Sources disagree on which editions exist and which are covered (some call the US and European products different, with different API links). **Unresolved.** The sandbox's country choice gives a practical test once the clients' edition is known. | Weak; needs Intuit or a real sandbox in the right country |
| Item 8, AI terms | The developer terms page shows an effective date of 14 October 2025, but its text could not be read. Third-party summaries conflict; one says AI use is not categorically banned but carries conditions (consent, responsible-AI, written data-protection duties). **Not verified. A lawyer must read the actual terms.** | None usable |
| Items 1 to 5, 7, 9, 10 | **Still unverified.** | None |

### 9.2 Read from Intuit's own pages and run against the sandbox (2026-10-31 and 2026-11-01)

**Method (this corrects 9.1's reading problem):** Intuit's documentation pages are script-rendered, so the assistant's fetch tool saw only a heading, but they **can be read as text in the built-in browser pane**; that is how everything below was read. One real call was also made: the Trial Balance report in Intuit's API Explorer against the owner's sandbox company (read-only, no consent prompt appeared). Strength words: **DOCS** = read on Intuit's page; **RUN** = observed in a real response; **OPEN** = not established.

| # | Item | Result | Strength |
|---|---|---|---|
| 1 | Authorisation flow | Standard OAuth 2.0 authorisation-code flow. The user is sent to `https://appcenter.intuit.com/connect/oauth2` with `client_id`, `scope`, `redirect_uri`, `response_type=code` and a `state` (Intuit "strongly recommends" an anti-forgery token in it). Intuit redirects back with `code`, `state` and `realmId`. The code is exchanged at `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` with HTTP Basic client credentials. The authorisation request must be made in a browser modal. | DOCS |
| 2 | Scopes | The Accounting scope is `com.intuit.quickbooks.accounting`. **No read-only variant appears on the pages read**, and Intuit advises requesting scopes incrementally. So the read-only guard (4.2) stays mandatory. | DOCS (absence of a read-only scope is not proof there is none) |
| 3 | Report endpoint | `GET /v3/company/<realmID>/reports/TrialBalance` with optional `start_date`, `end_date` (YYYY-MM-DD), `accounting_method` (Cash or Accrual), `date_macro`, `sort_order`, `summarize_column_by`; `Accept: application/json`. **France uses `TrialBalanceFR`** instead. Bases: production `https://quickbooks.api.intuit.com`, sandbox `https://sandbox-quickbooks.api.intuit.com`. A real call returned the report. | DOCS + RUN |
| 4 | Token lifetimes | Access token 3,600 s. Refresh token: **rolling 100-day expiry; always store the newest `refresh_token` from the latest response**; there is also a five-year hard lifetime (`x_refresh_token_hard_expires_in`, returned only when the request header `x-include-refresh-token-hard-expires-in: true` is sent). After expiry the user must reauthorise. Implications: rotate and store the new token **before** using it; a connection idle 100 days dies; the product needs a "reconnect needed" state. | DOCS |
| 5 | Limits | 500 requests/minute per company (realm), 10/second per company and app, HTTP 429 means wait 60 s, 120 s request timeout, 1,000 entities per query. App Partner Program Builder tier (no monthly fee): Core API uncapped, **CorePlus capped at 500,000 calls per calendar month**. **OPEN:** whether the Reports API counts as Core or CorePlus is not stated on the pages read. | DOCS (one OPEN) |
| 6 | Regions | See section 11. | see 11 |
| 7 | Production | The partner tiers page says the Intuit App Partner Program is "available for partners based in the US, UK, Australia, and Canada (excluding Quebec)". **OPEN:** whether a Tanzania-based developer can obtain production keys and under what tier or terms; Intuit's app-assessment requirements were not read. Ask Intuit support in writing before any production work. | DOCS + OPEN |
| 8 | AI and storage terms | Still unread. A lawyer must read the developer terms. | OPEN |
| 9 | Account ids and sub-accounts | Each account row carries QuickBooks's own `id`; sub-accounts are flat names joined by `:`; **no account codes and no account types** in the report. | RUN |
| 10 | Currency | The report header states the currency (`USD` in the sandbox); Intuit's page says values are not localised unless indicated; amounts arrive as decimal strings with two decimals. Multi-currency behaviour not tested. | DOCS + RUN (multi-currency OPEN) |

### 9.3 Date range versus as-of balances (income and expense accounts)

**Tested 2026-11-01 against the sandbox** (API Explorer, same company, `minorversion=40` in the explorer; the earlier run used 75, same shape). The report is **cumulative as of `end_date`; `start_date` had no effect**:

| `start_date` | `end_date` | Result |
|---|---|---|
| 2026-01-01 | 2026-10-31 | 46 accounts, total 41,421.60 |
| 2026-10-01 | 2026-10-31 | identical to the row above |
| 2026-10-31 | 2026-10-31 (one day) | identical again, **including every income and expense account** (a one-day activity report would be near-empty) |
| 2026-01-01 | 2026-09-30 | different, still balanced (37 accounts, total 29,500.55): the end date does decide the figures |
| 2025-01-01 | 2025-12-31 | `NoReportData = true`: the sandbox holds nothing before 2026 |

**What this settles:** a range request does not turn a trial balance into period activity. **What it cannot settle:** how income and expense accounts behave across a **fiscal-year boundary** (real QuickBooks books may restart them at the fiscal-year start). The sandbox has only one fiscal year of data, so that needs a real company with two years of history (a firm's file, with consent) or a sandbox with prior-year data. Until then the connector treats the report as "balances as of `end_date`", always sends an explicit `end_date` (and a `start_date` that records the period), stores both in provenance, and the converter refuses `NoReportData = true` (tested: `NO_REPORT_DATA`).

## 11. Countries: what "works for any QuickBooks user in any country" can and cannot mean

**What can be promised:** the connector is **fail-closed per region**. It reads only a response whose shape matches a **recorded sample** (`qboTrialBalance.ts`), and its request guard (`qboReadOnlyGuard.ts`) allows only the `TrialBalance` report. Anything else (another edition's shape, the French `TrialBalanceFR`, another currency exponent, nested sections) is refused with a stated reason, never guessed or repaired. A region is "supported" only when a sample from a company of that region has passed the A2 parity test.

**What cannot be promised today:**
- Intuit's pages read do not list every country with a QuickBooks Online edition, and the sources found disagree. **The portal's own "Create a sandbox company" country list (read 2026-11-01, nothing created) offers four: United States, Australia, United Kingdom, Canada.** A developer-blog summary of unknown date had listed six (adding India and France); the portal does not offer them today, so the blog is out of date or the list varies by account. **Tanzania is not offered**, so no Tanzania sandbox can be created to test.
- Which edition Tanzanian firms actually use is not established; it must come from the firms.
- The partner programme's country restriction (item 7) may affect a Tanzania-based developer.

| Region | Sandbox available | Sample recorded | Status |
|---|---|---|---|
| US | yes | **yes** (this repository's fixtures) | shape proven |
| UK, AU, CA | **yes** (offered by the portal) | no | pending: create a sandbox, record a sample, run parity |
| India | not offered today (a blog listed it) | no | needs a real company's report from a firm, or a sandbox if Intuit offers one |
| France | not offered today (a blog listed it); **different endpoint (`TrialBalanceFR`)** | no | refused until a French sample exists |
| Tanzania and any other country | none known | no | needs a real company's report from a firm (with consent), or Intuit's confirmation of the edition |

Currency: the home currency comes from the report header; amounts with other than two decimals are refused until a sample for such a currency is recorded.

## 12. Storage design (a sketch for the owner's approval; **not a migration**, because new tables need approval under CLAUDE.md section 8.2)

- **`qbo_connections`** (one row per connected company per workspace): workspace, the connecting user's `firm_members.id`, `realm_id`, environment, **`refresh_token_envelope`** (AES-256-GCM, see below), key id, `refresh_expires_at`, `hard_expires_at`, status (`active`, `reconnect_needed`, `disconnected`), timestamps. **No client role can read or write it**; only Edge Functions with the service role. The access token is never stored (it lives one hour, in memory).
- **`qbo_oauth_states`**: hash of the `state`, workspace, user, expiry, consumed-at; single use; expires in minutes.
- **`qbo_pulls`** (append-only provenance, one row per import): the upload id as a **plain uuid, not a foreign key** (a foreign key to `trial_balance_uploads` makes uploads undeletable; found earlier in this repository), connection, realm, report, start and end date, accounting method, minor version, currency, pulled-at, **SHA-256 of the raw response, of the canonical file, and of the normalised accounting result**, the actor `firm_members.id`. Members of the workspace may read it; nobody may update or delete it.
- **Envelope** (`qboTokenEnvelope.ts`, built and tested): AES-256-GCM, key from an Edge Function secret (never the database), key id for rotation, additional authenticated data binding workspace, connection and purpose, so a copied ciphertext cannot be opened elsewhere.
- **Refresh rotation:** one refresh at a time per connection (a lock), the **new** envelope stored before the new token is used, failure to store aborts the pull; a refresh that Intuit rejects marks the connection `reconnect_needed`.
- Every write goes through an Edge Function with `validateAuth`, `assertCompanyMembership`, the idempotency key and an `engine_runs` row, exactly as other writes; no token, `code` or `state` value is ever logged or returned.

### 12.1 Built so far (PR #236, offline, nothing connected)

`_shared/qboTrialBalance.ts` (converter, 25 refusals, A2 parity with the sandbox's Excel export), `_shared/qboReadOnlyGuard.ts` (exact allow-list; a scan test fails if any other function code names an Intuit address), `_shared/qboTokenEnvelope.ts` (token encryption). Not built: the migration, the connect and pull functions, the intake card, revocation on disconnect (its endpoint is not verified, so it is not on the allow-list).

## 10. Not claimed

This plan does not establish that QuickBooks Online is the right first connector (that rests on your statement that most firms use it), that API access exists for those firms, that any term permits our use, or that the effort is small. Items 6 and 8 in section 9 could change or end the plan.
