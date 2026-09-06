# Read-only commercial-offer diagnostic

No source, database, deployment, offer, licence, market, jurisdiction, payment configuration, or admin state will be changed.

## Verified findings

- **DEPLOYED SOURCE SHA:** `278179d3df82980f08c723d65298c1890640e2ad`
- **CUSTOMER CURRENT PLAN:** `FREE`
- **CUSTOMER LICENCE STATUS:** `ACTIVE`
- **TARGET PLAN CODE SENT:** `PAID`
- **MARKET CODE SENT BY SETTINGS:** omitted; the database function applies `GLOBAL`
- **MARKET CODE SOURCE:** `CheckoutUpgradeButton` calls `resolve_commercial_offer` with only `{ p_plan_code: "PAID" }`; PostgreSQL supplies the function default `p_market_code = 'GLOBAL'`
- **RESOLVE_COMMERCIAL_OFFER INPUT:** `PAID / GLOBAL`
- **RESOLVE_COMMERCIAL_OFFER RESULT:** `NOT_AVAILABLE` with `requested_market: GLOBAL`
- **MATCHING OFFER EXISTS:** `YES` for `PAID / TZ`; `NO` for the actual `PAID / GLOBAL` request
- **OFFER ACTIVE:** `YES`
- **OFFER PURCHASABLE:** `YES`
- **OFFER MARKET:** `TZ`
- **OFFER CURRENCY:** `TZS`
- **ROOT CAUSE:** Settings omits the market argument, so resolution defaults to `GLOBAL`. The only controlled offer is market `TZ`. The resolver supports fallback from a requested non-global market to `GLOBAL`, but it does not infer or fall back from `GLOBAL` to `TZ`; therefore it correctly returns `NOT_AVAILABLE` for the exact request it receives.
- **SOURCE DEFECT:** `YES` — the Settings checkout entry point does not supply the intended explicit market to either offer resolution or checkout creation.
- **DATA/CONFIGURATION DEFECT:** `NO` — `SANDBOX-TEST-PAID-TZ` exists, is currently effective, active, purchasable, and has the stated TZS economics. The failure is the request-market mismatch, not malformed offer data.

## Evidence

Authenticated browser verification returned `FREE / ACTIVE`, then captured HTTP 200 from `resolve_commercial_offer` with `{ plan_code: "PAID", resolution: "NOT_AVAILABLE", requested_market: "GLOBAL" }`. Live database inspection confirmed `SANDBOX-TEST-PAID-TZ` as `PAID / TZ / TZS / 100000 minor units / exponent 2`, active, purchasable, and currently effective.
