# Engagement Mandate Architecture — final model

Every critique is accepted. Scope is a **declared professional mandate**, never
an inference from framework, TIN, or artefacts. This plan replaces the derived
Phase 1 outright.

## New evidence that changes the shape of the answer

- `fiscal_periods` has **0 rows**, `trial_balance_uploads` has 0 rows, and no
  upload has ever carried `period_id`. So the table intended as the engagement
  container has never been used; today the de-facto identity is the
  `(company_id, period_year)` pair in the URL.
- No `tax_computations`, `statement_sign_offs`, `filing_obligations`, `findings`
  or `variance_runs` exist.

Read correctly: there is no history to protect and no identity to unwind. This
is the cheapest moment in the product's life to install the correct authority
model, so we install it now rather than shipping a presentation illusion.

## The model

```text
COMPANY              reporting entity, sector, master identity
   |
ENGAGEMENT           one fiscal_periods row = one engagement of record
   |                 reporting framework, accounting basis, active source data
   +-- MANDATE       what the professional was retained to perform (declared)
   +-- AUTHORITY     what this actor may actually do (permission)
   |
WORKFLOW ENGINE      derives required stages + gates from mandate + accounting truth
   |
ARTIFACTS            immutable evidence of work actually performed
```

### Capabilities are professional, not routes

`FINANCIAL_STATEMENTS`, `TAX_COMPUTATION`, `COMPLIANCE_REVIEW`,
`FILING_PREPARATION`, `MONITORING`. Stage requirements are a code-side mapping,
so the rail can evolve without rewriting historical mandates:

```text
FINANCIAL_STATEMENTS -> prepare, reconcile, statements
TAX_COMPUTATION      -> statements, tax
COMPLIANCE_REVIEW    -> compliance
FILING_PREPARATION   -> compliance, filing
MONITORING           -> monitor
```

`REGULATORY_SUBMISSION` is **authority**, not a capability, and never a stage.
Preparing a return and being permitted to submit it are separate mandates.

### Scope is event-sourced, truly append-only

```text
engagement_scope_events(
  id, fiscal_period_id, capability, action GRANT|REVOKE,
  actor_member_id, occurred_at, reason, source, supersedes_event_id
)
```

No row is ever updated or deleted. Effective mandate = a fold over the event
stream, newest event per capability wins. Revocation is a new event, so the
ledger reads as a professional file:

```text
08 Aug 09:00  GRANT   FINANCIAL_STATEMENTS   partner
08 Aug 09:00  GRANT   TAX_COMPUTATION        partner
12 Aug 16:20  REVOKE  TAX_COMPUTATION        partner  "client withdrew tax mandate"
```

Authority is a sibling stream (`engagement_authority_events`) with the same
shape, so submission rights can be granted and withdrawn without touching scope.

### Two distinct quiet statuses — no overloading

`not_applicable` keeps its current meaning (not part of the deterministic
workflow calculation). A new value `out_of_scope` carries the contractual
meaning. Both render quietly; they are never the same value.

### Historical work survives scope reduction

Revoking a capability never hides or restates evidence. A stage with artefacts
that leaves scope disappears from the active rail and appears under
**Previous engagement work** — read-only, attributed, timestamped. Nothing is
deleted, nothing re-enters the active workflow.

### Route behaviour: guard, never silently open, never rely on hiding

```text
/workspace/:id/:year/tax
   -> in mandate      : render normally, existing gates unchanged
   -> out of mandate  : restrained boundary page
                        "Tax computation is not included in this engagement"
                        [Amend engagement scope]  (only if authorised)
```

Hiding is not security; the guard reads the same authoritative mandate the rail
reads. RLS remains the enforcement boundary.

## Implementation

**Step 1 — Engagement of record.** Create a `fiscal_periods` row whenever an
engagement is created (`FirstRunEngagement`, `OnboardingFlow`) and stamp
`period_id` on every upload. `fiscal_period_id` becomes the identity everything
else references. No reconstruction from company + year.

**Step 2 — Migration (the two event tables).** Append-only, `authenticated`
grants, RLS scoped through `get_member_company_ids()`, INSERT restricted to
partner/manager `firm_members`, UPDATE and DELETE blocked by trigger. A
`fold_engagement_scope(fiscal_period_id)` security-definer function returns the
effective capability set.

**Step 3 — Mandate declaration at engagement creation.** One quiet checklist on
the engagement form, `FINANCIAL_STATEMENTS` pre-selected. Selections write GRANT
events. Amendment happens from an Engagement scope panel and writes further
events with a reason.

**Step 4 — Scope-aware projection.** `deriveWorkspaceState` keeps emitting all
seven missions; a new pure `projectMandate(state, mandate, artefacts)` marks
out-of-mandate stages `out_of_scope` and reports which carry retained work.
`WorkspaceLayout` renders only in-mandate stages; `WorkspaceOverview` shows the
in-mandate path plus a **Previous engagement work** section when applicable.
No gate is weakened: SAFISHA stays unskippable, statements still require a
balanced trial balance, and granting a capability never bypasses a prerequisite.

**Step 5 — Route guards.** Each stage page consults the mandate and renders the
boundary page when out of scope.

**Step 6 — Tests.** Fold correctness (grant, revoke, re-grant, superseding);
mandate matrix over statements-only, statements+tax, compliance-without-filing,
filing-preparation-without-submission-authority, monitoring-only, public-sector
IPSAS; append-only rejection of UPDATE/DELETE; retained-work rendering after
revocation; existing 14-path engine tests unchanged.

## UX outcome

```text
Arusha DC · FY2025
Prepare -> Reconcile -> Statements
Current action: Review 105 accounts
```

No padlocks for work nobody was hired to do. Tax appears only when the tax
mandate exists. Monitor appears only when monitoring is contracted.

## Explicitly not in this plan

Entity-type classification changes, microcopy changes, and any weakening of the
existing accounting gates or RLS.