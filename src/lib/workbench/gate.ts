/**
 * The workbench navigation gate (five-group navigation, canonical workbench routes and their legacy aliases).
 *
 * A reviewed source constant, the same pattern as the financial-statements workspace gate: no environment variable,
 * query parameter, browser storage, cookie or server value feeds it (asserted by gate.test.ts). While it is false the
 * existing workspace layout, tab bar and routes render exactly as before. Turning it on is its own reviewed commit — this
 * one (workbench activation, after I1-A was applied as hosted 0031/0032). Only released pages are reachable
 * (routes.ts RELEASED_WORKBENCH_PAGES); withheld modules stay hidden (moduleAvailability.ts).
 */
export const WORKBENCH_NAVIGATION_ENABLED = true;
