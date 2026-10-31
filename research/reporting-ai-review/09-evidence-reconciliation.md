# 09 — Evidence Reconciliation (corrected handoff — authoritative)

This file is a bounded, correction-only reconciliation. It **supersedes** any conflicting phrasing
in `00`–`08`. It implements no recommendation and approves no engine activation. Where `00`–`08`
say "live", read the terminology rule in §1. No hosted execution or database access was available;
every claim is static source inspection.

## 1. Exact baseline + terminology + reconciliation target
- **Inspected baseline:** branch `redesign/audit-20261013` at commit **`b32aa4f`**
  ("feat(workspace): harden file context and navigation affordances"). All of `00`–`08` were read
  from `b32aa4f`.
- **Reconciled against NORMAL's current repaired candidate `69155ae`**
  ("fix(trial-balance): a refused replacement can be withdrawn and the previous trial balance
  restored"). `69155ae` contains material changes that postdate `b32aa4f` (notably the upload
  resource bounds and a workspace capability-authorization layer).
- **Terminology rule (applies throughout `00`–`08`):** replace "live" with **"reachable in
  inspected source"** unless hosted execution or deployment evidence is cited. None was available
  here, so **no claim in this review establishes deployed/live availability**; "reachable" means a
  wired code path exists in source, not that it runs in production. Migration *apply* state on any
  hosted database is **UNKNOWN** throughout — RLS/triggers only take effect once applied.

## 2. Account cap — corrects `03`
- `03` said "no account-count cap in this branch." Correct for `b32aa4f`.
- **On `69155ae` the cap exists** as a resource bound in `supabase/functions/_shared/uploadPolicy.ts`
  (`maxAccounts: 2_000`, with `maxRows`/byte limits), enforced through `_shared/tbIngestion.ts`
  and surfaced as an `INGESTION_REFUSED`/refusal that **names the limit and next step; nothing is
  truncated**. It is explicitly **provisional (owner decision pending)**, measurement-derived, and
  **a resource bound, not an accounting rule** (per the file's own header). Verification level:
  unit (`src/lib/ingestion/tbIngestion.test.ts`, `src/lib/workspace/trialBalanceRefusal.test.ts`,
  `certificationFindings.test.ts`), an e2e probe (`scripts/e2e/draftJourney.mjs`) and a db-proof
  (`scripts/db-proof/certificationCapacity.mjs`). Hosted execution: unverified.

## 3. Capability-specific conclusions — corrects the "hard, correct parts are built" framing (`08`, executive verdict)
Replace the blanket phrase with these per-capability statements (no activation implied):

| Capability | Implemented? | Tested at which level | Disabled? | Remaining verification |
|---|---|---|---|---|
| Deterministic TB parse + excluded-row accounting | Yes (source) | Unit + function-path (`process-trial-balance/functionpath/functionPath.test.ts`) | No (reachable in source) | Hosted execution; blank-row logging gap |
| Upload resource bounds / account cap | Yes (`69155ae`) | Unit + e2e + db-proof | No | Owner decision on the provisional limits |
| `account_mappings` repeat-year reuse | Yes | Unit (pure) | No | Hosted; see §6 on period vs evidence |
| Certification ledger + 6-layer readiness | Yes | Migration + pure-fn tests | No | Migration **apply state UNKNOWN** |
| `resolve_account_review_batch` versioned, authorised ledger | Yes | Migration | No | Apply state UNKNOWN |
| Canonical statement engine ("World B") | Yes | **Extensive unit/property** (determinism, permutation, rule packs) | **DISABLED** (`FINANCIAL_STATEMENTS_WORKSPACE_ENABLED=false`; persistence gate false; migrations `20260919100000/110000` unapplied) | Integration/e2e, output correctness, permissions, reproducibility, migration state — see §7 |
| Narrative LLMs (`maono-decide`, `maono-root-cause`) | Yes | Internal validators present | Not reachable from any UI path | Would need membership assert + controls if ever wired |
| `cashFlowEngines.ts` (indirect, Slice-1) | Yes (pure) | Unit | Dormant (no caller) | — |

"Implemented and unit/property-tested in source" is **not** "proven end-to-end in production."
Engine activation is **not approved** and is not recommended here (see §7).

## 4. Sign-off finding (C-1) — RE-SCOPED and, for `69155ae`, RESOLVED — notify NORMAL
**Static finding; no live reproduction was run (no hosted/DB access).**

- **Exact endpoint:** there is **no edge function** for sign-off. The write is a PostgREST
  `UPDATE` on `public.statement_sign_offs` issued directly from the client —
  `src/components/PeriodCloseManager.tsx:274` (`handleSign` → `.update(nextStatusPayload(...)).eq("id", …)`;
  the status advances preparer → reviewer → approver → locked via `nextStatusPayload`).
- **Reachable route:** `/settings` → `PeriodCloseManager` (rendered by `src/pages/Settings.tsx`).
- **Affected roles/identities:** the table carries `preparer_id`/`reviewer_id`/`approver_id`.
  **Distinguish** ordinary **workspace ownership** (the `owner` *title* — assigned only at company
  creation, protected by integrity guards; *not* an authorization) from the **governed sign-off
  authority**, which on `69155ae` is a **capability**, not a title.
- **Server permission checks — on my inspected baseline `b32aa4f`:** the only server gate was the
  `hesabu_gate_before_signoff` trigger (HESABU pass) plus **membership-only RLS** — **no role/
  capability predicate**. On that baseline the segregation-of-duties gap was real, and CLAUDE.md
  §4.6's description of the *mechanism* ("enforced by the hesabu trigger … partner/manager") was
  inaccurate (the trigger has no role check). **This is the correctly-scoped finding: it applies to
  `b32aa4f`.**
- **Server permission checks — on NORMAL's current candidate `69155ae`: the gap is addressed.**
  Migration `20260925140000_workspace_capability_authorization.sql` makes `firm_members.role`
  display/template-only and governs sign-off by stored **capabilities**, enforced in RLS on
  `statement_sign_offs` with explicit SoD:
  - `sso_update_partner_owner` — `USING`/`WITH CHECK` require
    `workspace_capability_allowed(..., 'approve_certification')` **and** `reviewer_id` distinct from
    `preparer_id` **and** `approver_id` distinct from both (DB-level segregation of duties).
  - `sso_update_preparer` — a holder of `prepare_close` **without** `approve_certification` may
    update only while `locked_at IS NULL` and before any reviewer/approver signature.
  - `sso_insert`/`sso_select` require `prepare_close`. Exercising prepare/review/approve also
    requires a current plan (`workspace_capability_allowed`), which is the structured `PT402
    STATEMENT_CERTIFICATION` refusal handled at `PeriodCloseManager.tsx` (≈:280-289).
- **Net corrected conclusion:** a preparer/viewer **cannot** approve or lock on `69155ae`
  (server-enforced by capability RLS with SoD). My original C-1 ("any member can sign off; HIGH;
  live") is **withdrawn for the current candidate** and **retained only as a baseline-`b32aa4f`
  observation**. **Remaining verification:** confirm migrations `20260925130000`/`20260925140000`
  are **applied** on the hosted database (RLS is inert until applied) — apply state is UNKNOWN from
  the repo. §4.6 should still be reworded to describe the *capability* mechanism rather than a role
  check in the hesabu trigger.

## 5. Remove the general 0.1% numeric acceptance criterion — corrects `01` and `06`
- The `0.1%` figure is **only** `maono-decide`/`maono-root-cause`'s internal check that a *numeric
  token in generated narrative* matches a snapshot figure. It is **not** a general acceptance
  criterion and must not be presented as one.
- **Corrected rule:** **source amounts retain their full precision** — extraction/mapping must
  match exactly; there is no acceptable numeric "closeness" for a figure. Any **presentation-
  rounding** tolerance is a separate, **explicit, documented contract** (scale, rounding policy,
  where applied) and **must never conceal an extraction difference**. The evaluation design (`06`,
  "unsupported-claim rate") should score narrative-token support as exact-to-source, and treat any
  figure-level discrepancy as a fail, not a tolerance.

## 6. A new period alone does not invalidate a compatible mapping — corrects `03`/`05`/`08`
- `account_mappings` is period-agnostic by design (no `period_year`; keyed by account identity).
  **A new reporting period, on its own, does not invalidate or reopen a compatible mapping** — the
  *treatment* (classification) is reusable across periods.
- **Distinguish** the reusable **treatment** (mapping/classification) from **period-specific
  evidence and allocations** (e.g. movement splits cash/credit/transfer/disposal, cash-perimeter
  evidence, current/non-current and other allocations) — those are **re-supplied/re-derived each
  period** and are what a period boundary legitimately requires afresh.
- Reopening of a decision is therefore driven by a change in **account identity, meaning, governing
  rule/framework, or the staleness/absence of period-specific evidence** — **not** by period
  rollover per se. Any wording in `03`/`05`/`08` implying a period change reopens mappings is
  corrected accordingly.

## 7. Engine rollout recast as verification-and-completion — corrects `08` S2 and owner-decision #2
**Engine activation is not approved and is not prescribed from source inspection.** Replace "flip
the gate / apply the migrations" with a verification-and-completion proposal, to be scoped and
approved separately, that first establishes evidence (not assumptions) for:
1. **Actual migration state** on the target database (are `20260919100000/110000` — and the
   capability migrations — applied? divergent? partially applied?).
2. **Evidence requirements** per statement actually satisfiable (the `EVIDENCE_GAP` families).
3. **Permissions** (capability RLS + publication role gate) verified on the target, not assumed.
4. **Reproducibility** (content-hash restore / `DIVERGED` behaviour) exercised against real data.
5. **Output correctness** (statement figures, totals, comparatives, notes) validated end-to-end.
Only after that evidence exists should any enablement decision be made. Do **not** treat a source
constant's value as authority to change a running system.

## 8. Items unchanged by this reconciliation (still accurate on `69155ae`)
- World-B statement workspace gate still `false`; XBRL silent framework default still present
  (`generate-xbrl/index.ts:124`, C-3); `policy-compass` still unrouted (C-2). These remain
  source-reachability observations, not live claims.
- C-4 ("Processing with AI" copy): **already removed on `69155ae`** — a render test now asserts the
  HTML does **not** contain "Processing with AI" (`trialBalanceWorkflow.render.test.ts:54`).
  Treat C-4 as fixed in the current candidate.
- The `DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001` repair migration
  (`20260904120000`) is present on `69155ae`; deployed/apply state remains UNKNOWN.
