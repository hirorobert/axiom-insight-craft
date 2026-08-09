# Engagement Scope — read-only architecture audit and verdict

ZERO code written. ZERO migration issued. The frozen state engine
(`deriveWorkspaceState.ts`) was read, not touched.

## A. Verdict first

1. **One column is NOT sufficient.** Proven below. A single ordered enum cannot
   express "compliance review without filing authority", and cannot carry
   amendment history.
2. **No migration is authorised yet — and none is needed for the UI fix.**
   The quiet-rail outcome can ship as a *presentation-only* projection derived
   from data that already exists. Persisted scope becomes necessary only when a
   professional must *declare* scope before any artefact exists.
3. Recommended sequence: **Phase 1 (UI-only, derived scope) → prove → Phase 2
   (append-only scope table, not a column)**.

## B. Evidence from the codebase

| Question | Finding |
| --- | --- |
| Existing scope field on `companies`? | None. Columns: code, currency, description, fiscal_year_end, industry, is_active, name, reporting_framework, tin, user_id. `reporting_framework` is framework, not scope. |
| Per-period engagement entity? | Yes — `fiscal_periods` (company_id, fiscal_year_end, period_label, prior_period_id, active_upload_id, status, reporting_currency, accounting_basis). This, not `companies`, is the engagement grain. |
| `MissionStatus.not_applicable` | Exists in `types.ts`; produced by `na()` in the engine and already used for reconcile / compliance / monitor in **every** path. Rendered as a grey dash in `WorkspaceLayout` and treated as non-actionable in `WorkspaceOverview` (lines 142, 356). So `not_applicable` is currently overloaded to mean "always available" — the opposite of out-of-scope. |
| Consumers of the state | `useWorkspaceData`, `WorkspaceLayout` (tab rail), `WorkspaceOverview` (path table), `StatementsWorkspace`, `TaxWorkspace`, `FilingWorkspace`, plus the 14-path test file. Any status-semantics change breaks 4 pages and the test suite. |
| Stage routes | All 7 stage routes are unconditional in `App.tsx`. Out-of-scope stages stay reachable by URL regardless of rail rendering. |
| Downstream artefacts in live data | `tax_computations` 0, `statement_sign_offs` 0, `filing_obligations` 0, `findings` 0, `variance_runs` 0. Frameworks present: `ifrs_for_smes`, `ipsas_accrual`. |

**Consequence of the last row:** there is currently *no* historical downstream
evidence anywhere in the system. Scope-reduction-versus-immutability is a future
invariant to design, not a live migration hazard.

## C. Why one column fails

Each engagement outcome mapped against a single ordered enum:

```text
                        TAX   COMPLIANCE   FILING   MONITOR
Statements only          -        -          -        -
Statements + tax         Y        -          -        -
Compliance, no filing    Y        Y          -        -      fits an order
Compliance, no tax       -        Y          -        -      BREAKS the order
Filing only (agent)      Y        -          Y        -      BREAKS the order
Ongoing monitoring       -        -          -        Y      orthogonal
```

Two rows break any monotonic ladder, and `monitor` is orthogonal to the tax
chain. An ordered enum also cannot record *who* amended scope, *when*, or *why*
— which a professional engagement file requires.

## D. The dimensions that must never be merged

```text
ENTITY CONTEXT        public / private / NGO      -> classification interpretation
REPORTING FRAMEWORK   IPSAS / IFRS / IFRS-SME     -> reporting treatment
ENGAGEMENT SCOPE      capabilities engaged        -> which stages exist at all
WORKFLOW STATE        ready/review/blocked/signed -> progress within scope
FILING AUTHORITY      may SAFF submit to TRA      -> a permission, not a stage
```

Filing authority is split out deliberately: "prepare the filing pack" and
"submit it" are different mandates. Arusha DC being IPSAS public sector implies
nothing about Tanzanian corporate tax filing.

## E. Canonical model (proposed, unbuilt)

- **Mandatory spine, never forkable:** `prepare → reconcile → statements`.
  These derive from the accounting truth and stay ungated by scope.
- **Elective capabilities:** `tax`, `compliance`, `filing`, `monitor` — a *set*,
  not a ladder.
- **Rail rule:** primary navigation renders the spine plus engaged capabilities
  only. Out-of-scope stages are omitted, not padlocked. `not_applicable` stays
  an internal engine value and is never rendered as a rail row.
- **Gates untouched:** SAFISHA stays unskippable; statements still require a
  balanced TB; adding a capability can never bypass a prerequisite.
- **Amendment, not downgrade-lock:** scope changes are append-only. Removing
  `filing` hides the stage prospectively while every completed artefact,
  sign-off and audit row stays readable, attributed and unaltered. A stage that
  already holds artefacts renders as "out of scope · completed work retained".

## F. Migration verdict

**Phase 1 — no migration, no engine change.** Derive scope in a new pure helper
(`computeEngagementScope`) from data already present: reporting framework, TIN
presence, and existence of tax / filing / compliance / variance artefacts.
Consume it only in `WorkspaceLayout` (which tabs render) and
`WorkspaceOverview` (which rows render). `deriveWorkspaceState` keeps emitting
all seven missions; the rail becomes a filtered projection. Add one restrained
"Add tax & compliance work" affordance so scope widens by intent, and keep
direct URLs working.

**Phase 2 — only if Phase 1 proves declared scope is needed.** The correct shape
is then a child table, not a column:

```text
engagement_scopes(id, company_id, period_year, capability, granted_by,
                  granted_at, revoked_by, revoked_at, reason)
```

Append-only, one row per grant or revocation, filing authority as its own
capability. Effective scope = capabilities with no live revocation. This
survives new capabilities, records amendment history, and satisfies audit.

## G. Out of scope for this audit

No entity-type work. No classification changes. No microcopy changes. No change
to the frozen state engine, the gates, or the schema.