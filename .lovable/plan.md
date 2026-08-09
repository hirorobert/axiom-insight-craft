# Engagement Mandate Architecture — final, authorised-pending schema

All twelve objections accepted. `fiscal_periods` is a reporting period, not an
engagement. `engagements` becomes first-class now, while live history is zero
(`fiscal_periods` 0 rows, `trial_balance_uploads` 0 rows, no artefacts anywhere).

## 1. Entity model

```text
COMPANY            reporting entity, sector, master identity
   |
FISCAL PERIOD      reporting_start, reporting_end, accounting_basis,
   |               reporting_framework, active_upload_id
ENGAGEMENT         professional work mandate container (first-class)
   +-- MANDATE EVENTS      what was contracted
   +-- AUTHORITY EVENTS    what may be submitted, to whom, until when
   |
WORKFLOW PROJECTION  accounting truth + mandate + prerequisites + artefacts
   |
VISIBLE WORKSPACE    active stages only
   +-- Previous engagement work (immutable, read-only by construction)
```

One fiscal period may carry several engagements: statements, tax-only,
special compliance review, restatement, successor-accountant review.

## 2. Schema

```text
fiscal_periods (existing, unpopulated — extend, do not repurpose)
  id, company_id, reporting_start, reporting_end, accounting_basis,
  reporting_framework, active_upload_id

engagements
  id, fiscal_period_id, company_id, firm_id, engagement_type,
  status (open|closed), opened_at, closed_at, created_by_member_id

engagement_mandate_events            -- append-only
  id, engagement_id, capability, action GRANT|REVOKE,
  sequence_no BIGINT, actor_member_id, occurred_at, reason, source
  UNIQUE (engagement_id, sequence_no)

engagement_authority_events          -- append-only, richer than mandate
  id, engagement_id, authority_type, action GRANT|REVOKE,
  sequence_no BIGINT, granted_to_member_id, actor_member_id,
  jurisdiction, filing_type, effective_from, expires_at,
  occurred_at, reason, source
  UNIQUE (engagement_id, sequence_no)
```

- `company_id` is denormalised onto `engagements` only so RLS can reach
  `get_member_company_ids()` in one hop; `fiscal_period_id` remains the parent.
- No `supersedes_event_id`. The stream alone determines state; correction chains
  are not needed and would add unenforceable referential ambiguity.
- Ordering is `sequence_no`, allocated inside the write command as
  `max(sequence_no)+1` under a row lock on the engagement. `occurred_at` is
  reporting metadata, never the fold key.

### Vocabulary

Capabilities: `FINANCIAL_STATEMENTS`, `TAX_COMPUTATION`, `COMPLIANCE_REVIEW`,
`FILING_PREPARATION`, `MONITORING`.

Authority types: `SUBMIT_CIT_RETURN`, `SUBMIT_VAT_RETURN`, `SUBMIT_WHT_RETURN`,
`SUBMIT_REGULATORY_PACKAGE`. No generic `REGULATORY_SUBMISSION`.

## 3. Capability activation vs stage prerequisites — separate layers

```text
CAPABILITY ACTIVATES STAGES        STAGE PREREQUISITES (existing gate engine)
FINANCIAL_STATEMENTS -> prepare,   prepare      : source data present
                        reconcile, reconcile    : trial balance parsed
                        statements statements   : Dr=Cr, mappings resolved
TAX_COMPUTATION      -> tax        tax          : statements validated,
                                                  SAFISHA clean, mgmt inputs
COMPLIANCE_REVIEW    -> compliance compliance   : statements validated
FILING_PREPARATION   -> filing     filing       : tax signed (when tax in scope)
MONITORING           -> monitor    monitor      : at least one processed period
```

The capability map decides *whether a stage exists*. `deriveWorkspaceState`
continues to decide *whether it may run*. The map is never a gate, and a grant
can never satisfy a prerequisite. `TAX_COMPUTATION` no longer implies
`statements` is contracted — statements may be prerequisite evidence prepared
elsewhere, so the stage is present read-only for input review without claiming a
statements mandate.

## 4. Invariants

1. Mandate is declared, never inferred from framework, TIN, or artefacts.
2. Event tables accept INSERT only; no UPDATE, no DELETE, ever.
3. `sequence_no` is unique and monotonic per engagement; the fold is
   `ORDER BY sequence_no` and therefore deterministic under concurrency.
4. Effective mandate = latest event per capability with `action = GRANT`.
5. Revoking a capability never deletes, hides, or restates any artefact.
6. Mandate status and workflow status are orthogonal and never merged.
7. Authority is never a stage and never implied by any capability.
8. Existing accounting gates (SAFISHA unskippable, balanced TB before
   statements) are untouched and unweakened.
9. Closed engagements accept no further mandate or authority events.

## 5. Transition table (enforced by the write commands)

| Current effective state | GRANT | REVOKE |
| --- | --- | --- |
| ABSENT | valid | rejected — nothing to revoke |
| GRANTED | rejected — already granted | valid |
| REVOKED | valid — re-engagement | rejected — already revoked |

Repeated identical actions are **rejected**, not silently no-op'd and not
appended as duplicates: a professional file must not contain events that assert
a change which did not occur. Rejection is an explicit error the UI surfaces.

## 6. Write path and RLS

All writes go through two security-definer commands. No client ever inserts
into an event table directly.

```text
grant_engagement_capability(engagement_id, capability, reason)
revoke_engagement_capability(engagement_id, capability, reason)
grant_engagement_authority(engagement_id, authority_type, granted_to,
                           jurisdiction, filing_type, effective_from,
                           expires_at, reason)
revoke_engagement_authority(engagement_id, authority_type, reason)
```

Each command: resolves `firm_members.id` from the JWT server-side (never from
the body), asserts partner/manager role, asserts engagement is open, locks the
engagement row, folds current state, enforces the transition table, allocates
`sequence_no`, inserts one event.

```text
RLS per event table
  SELECT  authenticated, engagement in get_member_company_ids()
  INSERT  no policy (commands only, security definer)
  UPDATE  no policy
  DELETE  no policy
Trigger  BEFORE UPDATE OR DELETE -> RAISE (defence in depth)
GRANT    SELECT to authenticated; ALL to service_role; nothing to anon
```

`fold_engagement_mandate(engagement_id)` and
`fold_engagement_authority(engagement_id)` are stable security-definer readers
used by both UI and gates.

## 7. Presentation projection — two dimensions, never one enum

`MissionStatus` is unchanged and `not_applicable` keeps its workflow meaning.
A new pure module composes rather than mutates:

```text
EngineMissionState + MandateProjection = WorkspaceMissionView

{ stage: "tax", workflowStatus: "locked",
  mandateStatus: "out_of_scope", visible: false, retainedWork: false }
```

`WorkspaceLayout` renders views where `visible` is true. `WorkspaceOverview`
renders the in-mandate path, then **Previous engagement work** for
`out_of_scope && retainedWork`. That section is a purpose-built read-only
evidence view — artefact, date, actor, status at time of work, the mandate event
that ended it, permitted exports — never an active stage component with disabled
buttons.

## 8. Routes — compatibility strategy

`engagement_id` is the canonical internal identity. `/:companyId/:periodYear`
routes remain as **compatibility routes** that resolve to the single open
engagement for that company and period; ambiguity presents a chooser.
`/workspace/engagement/:engagementId/...` is introduced as canonical and
becomes primary in a later, separate change. Year is presentation metadata.

Out-of-mandate stage URLs render a restrained boundary — "Tax computation is not
included in this engagement" plus **Amend engagement scope** when authorised.
Hiding is never the control; RLS and the gates are.

## 9. Atomic migration sequence

1. Extend `fiscal_periods`; create `engagements`; backfill nothing (zero rows).
2. Create both event tables with grants, RLS, append-only triggers, unique
   `(engagement_id, sequence_no)`.
3. Create the four write commands and two fold readers.
4. Engagement creation writes a `fiscal_periods` row, an `engagements` row, and
   the declared mandate events; uploads stamp `period_id` and `engagement_id`.
5. Creation UI asks "What are you preparing for this client?" with professional
   outcomes and **no universal default** — prerequisites are added invisibly by
   the capability map, not by pre-selecting `FINANCIAL_STATEMENTS`.
6. Pure projection module + rail/overview consumption.
7. Scope-aware boundary on each stage page.
8. Tests: fold determinism under equal timestamps, transition-table rejections,
   UPDATE/DELETE rejection, concurrent grant/revoke, idempotency, the seven
   mandate scenarios, retained-work rendering, and the existing 14-path engine
   suite unchanged.

Rollback: every step is additive; steps 1–3 drop cleanly while zero rows exist,
and the UI steps are revertible independently of the schema. Dry-run each SQL
step against the live schema before applying.

## 10. Out of scope

No entity-type classification work, no microcopy changes, no gate or RLS
weakening, no route cutover in this migration.