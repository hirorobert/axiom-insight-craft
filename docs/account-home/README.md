# Account home and company setup

The signed-in home uses the approved dark workflow rail, compact engagement portfolio, a prominent **Add company** entry, and header menus for settings/profile/sign-out. Add company opens `/companies/new`, reusing `FirstRunEngagement` and the existing `create_entity` contract. Settings sections have shareable URLs, for example `/settings?section=companies`.

The global rail describes the reporting workflow; it does not invent completion states across companies. Company setup marks only its own step. Engagement statuses and next actions still come from the existing server-paged portfolio. Framework labels are supplemental RLS-authorized reads of at most 25 visible company IDs. A missing label never hides an engagement or substitutes a framework. Framework filtering is not offered because the current portfolio RPC does not implement it. Currency and latest-upload columns are optional. Desktop tables scroll within their own container; mobile uses cards.

Currency is explicitly selected; no default currency is introduced. Persistable framework identities are shared with the existing setup form. Framework selection does not imply that financial-statement publication is released for that framework. Existing automatic single-engagement routing, service intent, archive access, capacity checks and server authorization remain intact.

No backend migrations, deployed functions, accounting engines, RLS policies, plan entitlements or payment configuration are changed by this UI release.

## Verification

- Local full Vitest run: **6,152 passed, 0 failed, 22 skipped** (6,174 total). Separate database-inertness run against base `38d93becdf697d52f0cc46e4ba51432157cbf425` passed with zero failures.
- TypeScript app check and production Vite build passed. ESLint: zero errors; existing warnings remain.
- Real Chromium local rendering of the actual routes, with invented HTTP fixtures and all external requests intercepted: desktop and mobile, focused setup, explicit currency, account/settings menus, company-options dialog, optional columns, search, settings deep links, empty account, plan-required and error states. No page overflow or runtime errors.
- `scripts/e2e/localStackJourney.mjs` and `paymentJourney.mjs` follow the new home/setup routes while retaining accounting, company-creation and payment assertions. Their real-stack CI result is required separately; local fixtures do not replace it.

Thirteen stale tests also failed on unchanged base `38d93be`: static inventories omitted the already-installed `20261122100000_tb_decision_catalogue_read_predicate.sql`, and wrapper tests still classified the installed TB transports as pending. Their explicit inventories/fixture isolation were updated; authority and SQL checks were retained. CI also exposed the historical rollout rehearsal applying the later catalogue policy before its tables existed. It now defers that one explicit dependent migration, applies it after the historical cutover, checks signed-in versus identity-less catalogue visibility, preserves earlier certifications, and drives the real generation-7 engine on the final chain.

## Reproduce visual acceptance

Install Python Playwright and Chromium, then from the repository run:

```sh
python3 docs/account-home/visual_acceptance.py
```

Use `CHROMIUM_PATH` if Chromium is installed separately. The script serves Vite locally, seeds an invented session, intercepts every non-local request, exercises the actual components, and saves the captures below. It never reaches the hosted database. Python Playwright is a developer tool and is not added to app dependencies.

## Captures

All captures contain invented names and data, not customer records.

| Capture | Screen |
| --- | --- |
| [01](screens/01-engagements-desktop.png) | Desktop portfolio |
| [02](screens/02-settings-menu.png) | Settings menu |
| [03](screens/03-profile-menu.png) | Profile menu |
| [04](screens/04-company-setup-desktop.png) | Dedicated company setup |
| [05](screens/05-settings-desktop.png) | Settings |
| [06](screens/06-engagements-mobile.png) | Mobile portfolio |
| [07](screens/07-navigation-mobile.png) | Mobile drawer |
| [08](screens/08-company-setup-mobile.png) | Mobile setup |
| [09](screens/09-settings-mobile.png) | Mobile settings |
| [10](screens/10-empty-account.png) | Empty account |
| [11](screens/11-plan-required.png) | Missing plan |
| [12](screens/12-connection-error.png) | Read failure |
