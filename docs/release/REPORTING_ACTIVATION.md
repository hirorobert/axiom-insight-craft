# Reporting activation: demo company only

**Scope.** The reporting workbench pages are released in code:
- Financial Statements: Statements, Notes, Schedules, Comparatives;
- Sign-off & Exports: Sign-off, Exports;
- Close Review: Findings only. Sign-off requires a checked Close Review with no unresolved blocking finding
  (`20261017100000`). Adjustments stay unreleased.

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

Follow `docs/release/ACCEPTANCE_R1_DEMO_SETUP.md`:
- the read-only preflight (`sql/07_acceptance_preflight.sql`) chooses Path A (an existing dated, reviewed year other
  than FY2026) or Path B (the dedicated synthetic FY2025/FY2024 engagement), or stops;
- then journey steps J1–J11, including stale-result refusal, a company that is not enabled, and the cross-workspace check
  (NOT RUN without a genuine second account).

Record any failure exactly, with its step, the screen text and the response. Do not enable any other company.
