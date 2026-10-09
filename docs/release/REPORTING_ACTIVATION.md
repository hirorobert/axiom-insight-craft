# Reporting activation: demo company only

**Scope.** The reporting workbench pages are released in code:
- Financial Statements: Statements, Notes, Schedules, Comparatives;
- Sign-off & Exports: Sign-off, Exports.

They are **offered only to a company that the server reports as enabled for reporting**, via
`financial_statements_workspace_access`. That requires an accepted membership, the kill switch off, and the company on
the financial-statements rollout allow-list.

Everywhere else nothing changes. The Statements stage stays withheld from customers in general (`moduleAvailability.ts`),
and a company that is not on the allow-list sees exactly what it saw before: no reporting navigation, and the neutral
"unavailable" page at `/statements`.

**Not activated:**
- AI layout assist (`LAYOUT_ASSIST_ENABLED = false`; no provider);
- two-year intake (`TWO_PERIOD_INTAKE_ENABLED = false`);
- tax, compliance, filing and monitoring (withheld);
- the legacy financial-statements workspace (`FINANCIAL_STATEMENTS_WORKSPACE_ENABLED = false`);
- the **legacy official Reporting Pack** (the `reporting-pack` service intent is withheld). It is blocked by
  `DEFECT-REPORTING-PACK-SEAL-RACE-001`.

The reporting routes cannot reach that sealing path. `src/lib/reporting/activation.test.ts` checks this on every CI run,
over the pages' full import closure.

**Accounting status.** The IFRS for SMEs coverage is **implemented, not independently validated** (0 VALIDATED rows).
Nothing here is a compliance claim. General customer reporting stays off until a qualified accountant's review is
recorded (`docs/reporting/review-package/`).

## 1. Publish

Publish the frontend at the verified `main` commit named in the release record. Do not publish any other commit.

## 2. Enable the demo company, and only it

Use `docs/release/sql/03_activate_company.sql` unchanged: service role, a named operator, and a reason of at least 8
characters. It is written to the append-only rollout audit.

- Before enabling: confirm the kill switch is off, and that `financial_statements_rollout_companies` contains nothing
  else.
- After enabling: exactly one company is enabled.

To roll back, run the same script with `false`, or `05_kill_switch.sql` for every company at once.

## 3. Hosted acceptance (the actual hosted app, the demo company)

| # | Step | Expected |
|---|---|---|
| 1 | Sign in as the demo company's owner. Open the workspace. | Navigation shows Financial Statements and Sign-off & Exports. |
| 2 | Statements | The two statements show the server's figures. Enter on a line opens its lineage. |
| 3 | Notes | Each requirement shows its server status. 5.5(e), (g) and (h) need a decision. Recording wording succeeds ("Recorded."). |
| 4 | Comparatives | The state is shown. A reviewer (or the owner) approves the comparatives with a reason. |
| 5 | Sign-off | Add evidence and save a version. The new version shows "ready". Mark it REVIEWED, then FINAL, each with a reason. |
| 6 | Exports | The pack shows the FINAL seal with the recorded approver and both hashes. Print/PDF and CSV both work. |
| 7 | **Stale-result refusal** | Change one disclosure on Notes. On Sign-off, the FINAL version stays sealed. Its readiness shows "changed after this version was saved" (`REPORTING_DEPENDENCIES_STALE`), and the next action is "Save a new report version". Marking the stale version reviewed is refused. |
| 8 | **Cross-workspace refusal** (only if a second account exists) | Sign in as an owner of a different workspace. Open the demo company's `/statements` URL. The result is "unavailable" with no figures, and direct RPC calls are refused. |
| 9 | **Not enabled elsewhere** | Open any other company's workspace. It has no reporting navigation, and `/statements` shows "unavailable". |

Record any failure exactly, with its step, the screen text and the response. Do not enable any other company.
