# QuickBooks Online connector: design plan (read-only, user-initiated)

> **STATUS: PROPOSAL. Nothing here is built, approved or installed.** It implements charter rule R14 ("Connectors. Read-only first") and build item B9,
> whose exit criterion is the A2 parity test. **Every statement about Intuit's API, terms, limits or regional availability is from the author's
> memory and is UNVERIFIED**; section 9 lists each one to check against Intuit's current documentation before any code is written.
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

## 10. Not claimed

This plan does not establish that QuickBooks Online is the right first connector (that rests on your statement that most firms use it), that API access exists for those firms, that any term permits our use, or that the effort is small. Items 6 and 8 in section 9 could change or end the plan.
