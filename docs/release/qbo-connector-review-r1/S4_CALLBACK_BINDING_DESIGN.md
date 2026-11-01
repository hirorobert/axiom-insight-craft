# S4: binding the QuickBooks OAuth callback to the person who started it (design, not built)

**Status.** Built on the stack (storage, functions, screens) in review r2; still unapplied and undeployed. Intuit's authorisation-code lifetime is still unverified at the primary source; the build does not depend on it (an expired code is refused by Intuit and the person connects again). It corrects review finding S4 (`README.md`, Second pass) and closes most of S5. Building it changes all three PRs (#239 storage, #240 functions, #241 screens) and needs the owner's go-ahead first.

## 1. The defect

The callback (`supabase/functions/qbo-oauth-callback/index.ts`, `_shared/qboConnect.ts` `runQboCallback`) has no login: Intuit's redirect carries no Supabase token. Its only credential is the single-use state. The state is tied to the person and workspace that **started** the connection, not to whoever **finishes** it. Today the callback exchanges the code and stores the connection immediately (`qbo_store_connection`), so whoever approves at Intuit decides which QuickBooks company gets connected.

**Attack.** Person A holds both rights in workspace X. A clicks *Connect*, keeps the Intuit authorisation address (it is returned by `qbo-connect-start` and contains the state), and gets person V to open it. V signs in to Intuit and approves. The callback consumes A's state, exchanges V's code and stores **V's QuickBooks company** as a connection of workspace X. A can now import V's books. The attack needs V's approval on Intuit's consent screen (which names the app), and V then lands in a workspace V cannot open. It is still a real cross-account data exposure.

## 2. The design: the browser hands back, the signed-in person finishes

The rule: **a connection is stored only when the signed-in person who started the attempt finishes it.** The callback no longer exchanges anything. It parks the authorisation code, sealed, and hands the browser a one-time *handoff* code. The app, signed in, then calls a new function. That function checks the caller is the person who started, and only then exchanges the code and stores the connection.

```
browser (A, signed in)        qbo-connect-start          Intuit             qbo-oauth-callback            app page               qbo-finish-connection
  Connect ───────────────────> state S, hash(S) stored
  <── authorize URL (S) ──────
  ── open ───────────────────────────────────────────> person approves
                                                       ── ?code&state&realmId ─> consume hash(S) once
                                                                                 seal(code) with H's binding
                                                                                 store: sealed code, realm, hash(H)
  <──────────────────── 302 /workspace/<X>/<year>/trial-balance/review#qbo_handoff=H ────────────────────────
                                                                                                         read H from fragment,
                                                                                                         remove it from the address
                                                                                                         ── POST {handoff:H} + Bearer JWT ──────────> who? (JWT)
                                                                                                                                                       take(hash(H), who): only if who = A
                                                                                                                                                       open code, exchange (Intuit),
                                                                                                                                                       seal refresh token,
                                                                                                                                                       qbo_store_connection (unchanged)
                                                                                                         <── connected | not_yours | expired | failed ─
```

In the attack, V's browser receives H, but V's app session is not A's. `qbo-finish-connection` refuses with `not_yours` and consumes the pending return. **No token is ever obtained**, because the code is exchanged only after the identity check. A never sees H: it travels only in V's browser.

### Why the code is parked rather than exchanged first

Exchanging in the callback and parking the *refresh token* would also bind the connection, but a token for V's books would then exist in our database (sealed) until it expires or is cleaned up, and Intuit revocation is not on the guard's list (unverified endpoint). Parking the *code* means a refused attempt never produces a token at all. The cost is that the code must be exchanged within Intuit's code lifetime. The app calls the finish function on page load, seconds after the redirect, and **the code lifetime must be confirmed against Intuit's documentation before building** (not assumed here).

### Why identity, not a cookie or PKCE

- **A cookie set at start** (`SameSite=Lax` on the Functions host) would bind the *browser*. But the start call is a cross-site `fetch` from the app to `*.supabase.co`, so the cookie would be a third-party cookie, which current browsers block or partition. It would fail closed for legitimate users and is not reliable.
- **PKCE** binds the code to whoever holds the verifier. Intuit's support for PKCE on this flow is not verified here. Even with it, the verifier would have to live in the starting browser, which gives the same guarantee as the handoff below with more dependence on Intuit.
- **The signed-in identity** is already the repository's authority (`workspace_authority_basis`, `qbo_connector_basis`). Binding to it needs nothing from Intuit or the browser beyond the session the app already has.

## 3. Changes

### 3.1 Storage (`20261212100000_qbo_connector_storage.sql`, still unapplied, so changed in place)

`qbo_oauth_states` gains the return leg. Columns (all NULL until the callback):

| Column | Meaning |
|---|---|
| `returned_at timestamptz` | When the callback consumed the state (replaces the role of `consumed_at`, which stays) |
| `handoff_hash text` (unique, `^[0-9a-f]{64}$`) | SHA-256 of the handoff code. The code itself is never stored. |
| `realm_id text` (`^[0-9]{1,20}$`) | As returned by Intuit |
| `code_envelope text` (envelope shape) | The authorisation code, sealed (AES-256-GCM). Never in clear. |
| `handoff_expires_at timestamptz` | `returned_at + 5 minutes` (CHECK: at most 10) |
| `finished_at timestamptz`, `finish_outcome text` (`connected`, `not_yours`, `expired`, `forbidden`, `failed`) | Set exactly once |

Constraints: `code_envelope` exists only while returned and not finished. A finished row holds no envelope (the same "a dead secret is deleted" rule as `qbo_connections`). Clients keep no access. `qbo_housekeeping` also nulls the `code_envelope` of any return past `handoff_expires_at` (codes do not linger until the row's one-day deletion).

Functions (service role only, SECURITY DEFINER, pinned `search_path`, like the rest):

- **`qbo_record_oauth_return(p_state_hash, p_realm_id, p_code_envelope, p_handoff_hash)`** replaces `qbo_consume_oauth_state`. It atomically consumes an unused, unexpired state, stores the sealed code, realm and handoff hash, and returns `company_id, environment, return_period_year` for the redirect. A denied or code-less return consumes the state with no envelope. It is unchanged in spirit: still single-use, and still refused if the starter has lost either right.
- **`qbo_take_oauth_return(p_handoff_hash, p_actor_user_id)`** is single-use. It locks the row and records the outcome whatever it is, so a handoff is never tried twice. It returns the sealed code, realm, company, environment and period year **only** when the handoff is unexpired and unfinished, `p_actor_user_id = actor_user_id`, and `qbo_connector_basis` still holds. Otherwise it returns only the outcome word (`not_yours`, `expired`, `forbidden`, `unknown`). On every answer it deletes the `code_envelope`.

`qbo_store_connection` is unchanged. `qbo_start_oauth_state` is unchanged.

### 3.2 Functions (#240)

- **`qbo-oauth-callback`** (still `verify_jwt = false`): it parses as now. It generates the handoff (32 random bytes, hex), seals the code with binding `{ workspace: company, connection: "oauth-return:" + hash(H), purpose: "qbo-auth-code" }`, calls `qbo_record_oauth_return`, and redirects to `<app>/workspace/<company>/<year>/trial-balance/review#qbo_handoff=<H>`. The handoff goes in the **fragment** so it is never sent to a server, never in a `Referer` and never in hosting access logs; `Referrer-Policy: no-referrer` and `no-store` stay. A denial still redirects with `?qbo=denied` and no handoff. **It no longer calls Intuit.** The token client and `exchangeCode` move to the finish function.
- **New `qbo-finish-connection`** (`verify_jwt = true`, POST `{ handoff }`, exactly that key):
  1. authenticate (`service.auth.getUser`) and validate the handoff shape;
  2. `qbo_take_oauth_return(hash(H), user)`;
  3. open the code;
  4. `exchangeCode` through the read-only guard (30-second timeout from S2);
  5. seal the refresh token with `connectionBinding(company, realm, environment)` (unchanged);
  6. `qbo_store_connection`.

  Answers: `connected` (200), `not_yours` / `forbidden` (403), `expired` / `unknown` (410), `failed` (502/500). The log line carries the outcome and company only, never H, the code or a token.
- `_shared/qboConnect.ts`: `runQboCallback` becomes "park and hand back"; a new pure `runQboFinish(deps, body)` holds the order above, unit-tested with injected dependencies like the rest.

### 3.3 Screens (#241)

`QuickBooksImport.tsx` reads `qbo_handoff` from `location.hash` on mount and removes it from the address at once (`history.replaceState`). It calls `qbo-finish-connection` and shows the result: *Connected*; *This QuickBooks connection was started by someone else, so it was not saved*; *The connection took too long, please connect again*. The existing `?qbo=denied|failed` handling stays. Two facts checked in the code:

- the Supabase client's URL detection reacts only to `access_token`/`error_description` in the fragment, so `#qbo_handoff=` is ignored by it;
- a signed-out visit to the workspace is sent to `/auth` without keeping the address (`WorkspaceLayout.tsx`), so a person whose session ended in the minute at Intuit simply connects again (the handoff expires unused).

### 3.4 S5 (realm)

With the code exchanged only by the starting person, editing `realmId` in the callback address can only mislabel the editor's own connection. The cross-person case is gone. Proving the realm (one read of the company's own record after the exchange) still needs an endpoint added to the guard's allow-list, verified against Intuit's documentation first. It is left as a separate, optional step.

## 4. Proof that would be required

- **Database proof (`qboConnectorStorage.mjs`), new cases:**
  - a return is recorded once, and a second callback with the same state records nothing;
  - only the starter takes it, and another person (even an owner of the same workspace) gets `not_yours` and consumes it;
  - an expired handoff gives `expired` and no envelope;
  - a starter who lost either right gets `forbidden`;
  - every answer deletes the code envelope;
  - housekeeping clears the envelopes of expired returns;
  - clients cannot call either function.
- **Negative controls:** a take that skips the actor check, one that is not single-use, and one that keeps the envelope must each fail their case.
- **Unit tests:**
  - the callback never calls Intuit and puts the handoff only in the fragment, never in the query or a log;
  - the finish function refuses another person before any Intuit call (asserted as zero token calls);
  - the refresh token is stored only after the identity check;
  - the handoff is single-use.
- **Screens:** the fragment is removed before the call, and the three outcomes show the plain sentences.
- **CI:** `deno check` gains `supabase/functions/qbo-finish-connection/index.ts`; `config.toml` gets its `verify_jwt` entry; the release order (`README.md` §9) gains "deploy the fourth function".

## 5. What it does not fix

- V still sees Intuit's consent screen and may approve. With this change, approving connects nothing unless V is the starter.
- A starter who is socially engineered into connecting the *wrong company of their own* is outside this design (that is S5's realm question).
- Intuit's code lifetime, Intuit's PKCE support and the realm-read endpoint are unverified. The first must be confirmed before building, and the other two are not relied on.
