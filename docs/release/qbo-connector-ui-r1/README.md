# QuickBooks Online connector screens (B9), release record r1

**Status: authored and unit-tested; OFF.** The card is not rendered while `QBO_CONNECTOR_ENABLED` is `false` (`src/lib/workspace/qboConnectorClient.ts`, a reviewed source
constant, the same gate pattern as `TWO_PERIOD_INTAKE_ENABLED`). Publishing the frontend with the constant `false` changes nothing a customer can see.

## What the person sees (when released)

On the trial balance upload page, beside (never instead of) the file upload, for a workspace and period:

| State | The card says | The one action |
|---|---|---|
| Checking | "Checking the QuickBooks connection…" | none |
| Not connected | Why, in plain words: you sign in at QuickBooks, we never see your password, access reads the trial balance report only | **Connect QuickBooks** |
| Connected | "Connected to QuickBooks company N (a test company)." and the dates it will import (the period's own start and end dates) | **Import from QuickBooks** |
| Connected, period has no dates | "Set this period's start and end dates first" | none |
| Expired or removed | "The connection has expired or was removed. Connect again to continue." | **Reconnect QuickBooks** |

After Intuit returns the browser, a one-time line says "connected", "you chose not to connect (nothing was shared)" or "could not be connected". After an import the card says how many accounts
and in which currency were saved, and **the same check a file upload starts is started** (the server's check decides everything; this page only starts it). Every refusal has its own plain sentence
(`QBO_MESSAGES`: 23 outcomes; none names an engine or a credential). If the card cannot read the connection status (the backend is not there), it shows nothing.

The browser only asks. Every write is made by an Edge Function that judges the person's right itself; the status is read through `qbo_connection_status`, which never returns a token, an envelope or a key.

## To release it (each a deliberate step, in this order)

1. The storage migration (PR #239) is applied hosted (the owner's explicit approval; not yet generated).
2. The three functions (PR #240) are deployed and the owner's secrets are set (`docs/release/qbo-connector-functions-r1/README.md`); a sandbox connection and import is tried by the owner.
3. `QBO_CONNECTOR_ENABLED` is changed to `true` in a reviewed commit and the frontend is published (separate approval).
4. `QBO_ENVIRONMENT` stays `"sandbox"` until Intuit has approved production access (support case 00231947; the UK-entity route).

## Evidence

`qboConnectorClient.test.ts` (client: gate off and sandbox pinned, connection states, status read failing closed, the authorisation address followed only if https, plain sentences for all 23 outcomes,
unknown or malformed answers never thrown or shown raw) and `QuickBooksImport.test.ts` (every state rendered from props: exactly one action, the right words, disabled while working, the returned status
word, success as a status and refusal as an alert, no engine or credential term in any state, nothing rendered while the connector is off). The file map (`CLAUDE.md`) lists the new client.

## Not built, not claimed

- **Disconnect** (no Edge Function exists for it yet; the database function `qbo_disconnect` is built). **Replacing** an existing import with QuickBooks figures (the card reports that a trial balance
  is already saved and points to the existing Replace flow).
- Never seen in a real browser against a real QuickBooks sandbox; the card is unit-tested only. jsdom component tests could not run on the author's machine (CI runs them).
- The card is shown only while the upload page is empty; once a file is chosen or an upload exists the page behaves exactly as before.
