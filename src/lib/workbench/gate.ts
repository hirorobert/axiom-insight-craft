/**
 * The workbench navigation gate (five-group navigation, canonical workbench routes and their legacy aliases).
 *
 * A reviewed source constant, the same pattern as FINANCIAL_STATEMENTS_WORKSPACE_ENABLED: no environment variable,
 * query parameter, browser storage, cookie or server value feeds it (asserted by gate.test.ts). While it is false the
 * existing workspace layout, tab bar and routes render exactly as before. Turning it on is its own reviewed commit.
 */
export const WORKBENCH_NAVIGATION_ENABLED = false;
