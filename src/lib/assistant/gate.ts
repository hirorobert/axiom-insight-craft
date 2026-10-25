/**
 * Ask CFOClose (Release 0.1) — the panel gate. A reviewed source constant, the same pattern as the workbench gate: no
 * environment variable, query parameter, browser storage, cookie or server value feeds it (asserted by gate.test.ts).
 *
 * While it is false the Statements page renders exactly as before: no "Ask" column, no panel, no assistant request.
 * Turning it on is its own reviewed commit, after the owner decisions (data handling, terms, provider settings, budgets)
 * are recorded and the accountant-reviewed evaluation has passed its thresholds. Even when on, the server decides every
 * request (ai_assistant_settings, workspace enablement, budget) and the reporting workflow never depends on it.
 */
export const ASK_CFOCLOSE_ENABLED = false;
