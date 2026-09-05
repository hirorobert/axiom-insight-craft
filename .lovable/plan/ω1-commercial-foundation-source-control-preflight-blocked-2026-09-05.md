# Ω1 Commercial Foundation — Source-Control Preflight BLOCKED

## Verified now (read-only)

| Check | Result |
| --- | --- |
| Lovable-managed HEAD | `fbebaedec833284aa088598aa908d3c89624b16e` (post-release plan commit) |
| Certified candidate `982c208d42bc7bceb6cf8c8a9ffa0a7cee48a600` present | **ABSENT** — `git cat-file` cannot resolve the object |
| Working tree | Clean |
| Ω1 migration file in `supabase/migrations/` | **ABSENT** — latest is `20260904154709_…` (Phase-6 tri-state) |
| Ω1 commercial source anywhere in tree | **ABSENT** — zero matches for `commercial_licences` / `commercial_plans` / `billing_customers` |

Conclusion: the certified Ω1 candidate has not reached this environment. There is
no Ω1 migration SQL to apply and no Ω1 frontend (`/terms`, `/privacy`, Settings
commercial summary) to publish. Per rule 1 and rule 16 I stop rather than
improvise a replacement commercial architecture, and per rule 2 I cannot record a
pre-application SHA that contains the candidate.

Interim status:

```text
SAFF Ω∞ COMMERCIAL FOUNDATION Ω1 PRODUCTION —
PROJECT bvyivmmfjejbmqoydezk —
CERTIFIED SOURCE 982c208d42bc7bceb6cf8c8a9ffa0a7cee48a600 [NOT PRESENT] —
MIGRATION [NOT ATTEMPTED] —
Ω1 PRODUCTION [NOT_CLOSED — SOURCE_UNAVAILABLE]
```

## Exact action required from you

Bring `982c208d…` into this project through the supported GitHub sync, then tell
me it is synced:

1. Push the certified Ω1 commit to `hirorobert/axiom-insight-craft` `main` (it is
   currently not in GitHub main either, as of the last verified main
   `fbebaede…`).
2. In the project, Plus (+) menu → GitHub, confirm the connected branch is `main`
   and that Lovable reports synced.
3. Confirm the synced HEAD contains `982c208d…` in its ancestry.

Alternatively, paste the certified Ω1 migration SQL and frontend diff here and
authorise it explicitly as the applied source — I will then treat that text as
the candidate and report the identity divergence openly rather than silently.

## What I will execute once the candidate is present

1. **Preflight (§2–3):** record pre-application SHA; confirm `982c208d…`
   ancestry; inspect live `bvyivmmfjejbmqoydezk` for existing/conflicting
   `commercial_admins`, `commercial_products`, `commercial_plans`,
   `billing_customers`, `commercial_licences`, `payment_events`,
   `entitlement_overrides`, `billing_audit_events`, RPC name collisions,
   `btree_gist` availability, `companies.user_id` assumptions, and absence of any
   second-company Premium trigger. Any material conflict → STOP and report.
2. **Apply (§4):** apply only the Ω1 migration semantics through the canonical
   migration tool; report the generated live migration identity verbatim
   (divergence disclosed, no history normalisation, no replay).
3. **Structural verification (§5):** tables, RLS, policies, FKs, indexes,
   generated `effective_range`, `btree_gist`, EXCLUDE constraint, immutability
   triggers, SECURITY DEFINER + `search_path`, commercial RPCs; confirm
   MULTI_COMPANY stays vocabulary-only with no company-creation gate.
4. **Licence authority acceptance (§6):** cases A–K on isolated acceptance
   records only; adjacent renewal allowed, overlap/identical-start/reactivation
   overlap rejected by the database; cleanup without deleting immutable
   audit/payment history.
5. **Entitlement acceptance (§7):** free, active, unknown-feature, expired,
   suspended, active override, revoked override — fail-closed, UNKNOWN distinct
   from NOT_ENTITLED.
6. **RLS isolation + admin escalation + payment ledger (§8–10):** cross-owner
   denial, ordinary-user write denial on every commercial table,
   service-role-only admin bootstrap, no self-escalation, append-only
   `payment_events`, idempotency duplicate handling, no payment secrets.
7. **Regression (§11):** authentication, company access, non-gated company
   creation, SAFISHA/CertifiedTB/HESABU/MAONO authority unchanged, no accounting
   rows or professional decisions rewritten.
8. **Frontend (§12) + types (§13) + observability (§14):** publish the candidate
   frontend, verify `/terms`, `/privacy`, footer links, Settings commercial
   summary, no checkout/Pay/placeholder banners; reconcile generated types only
   if deterministic, otherwise report the needed source change separately;
   confirm error-correlation path with no sensitive logging.
9. **Source control (§17) and the §18 final report** in the exact required
   format, with registered debt preserved untouched.
