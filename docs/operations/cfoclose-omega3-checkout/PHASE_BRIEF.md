# Ω3-CHECKOUT — Phase Brief

**Status: DESIGN / AUDIT ONLY. NO IMPLEMENTATION PERFORMED.**

## Design-correction round

An independent review of the first draft of this package found several concrete defects and gaps, all resolved in this revision without any implementation being performed:

1. The proposed `resolve_commercial_offer` signature was invalid Postgres (a required parameter declared after a defaulted one, and a `NOT NULL` annotation in a function parameter list, which is not valid syntax) — corrected in `DATA_CONTRACTS.md` §1.
2. The signature change would have created a second, overloaded function rather than replacing the original — the old, ambiguous 2-arg overload would have remained live and callable. Corrected with an explicit three-phase deployment order (schema → application → `REVOKE`/`DROP` cleanup) in `DATA_CONTRACTS.md` §1 and `IMPLEMENTATION_PLAN.md` §3.
3. `marketCode` is removed from the browser checkout contract entirely — market is a server-owned literal (`'GLOBAL'`) for this launch, never client-supplied or inferred from locale/IP/currency/jurisdiction. A future persisted, admin-controlled per-customer market is recorded as separate, later scope.
4. A new, confirmed finding: plan-code resolution was not scoped to the billing customer's product, relying on `commercial_plans.code` being globally unique when the schema only guarantees uniqueness per-product. Corrected in `COMMERCIAL_ARCHITECTURE_AUDIT.md` §3a and `DATA_CONTRACTS.md` §1.
5. `commercial_platform_state` (created by Ω3.0) was never enforced by any Edge Function — a confirmed, previously-unaddressed gap. A full state × provider-environment × caller-identity matrix is now specified in `DATA_CONTRACTS.md` §2 and §10.
6. The checkout-intent concurrency design (an Edge-Function-level `SELECT`-then-reuse) was not atomic and could not guarantee its own invariant under a genuine race. Replaced with a database-enforced, advisory-lock-based `acquire_or_reuse_checkout_intent` RPC — `DATA_CONTRACTS.md` §6.
7. `commit_verified_commercial_payment` was assessed as needing no change; independent review correctly identified that its locking was scoped to the intent, not the customer, leaving two different successful payments for the same customer able to race. Corrected with a customer-level advisory lock — `DATA_CONTRACTS.md` §11. This moves the function from MUST NOT CHANGE to MUST CHANGE in `IMPLEMENTATION_PLAN.md`.
8. Webhook Gate B failures are now split into definitive (rejected, never retried) and transient (retriable, plus a new reconciliation mechanism for paid-but-uncommitted transactions) — `DATA_CONTRACTS.md` §8.
9. The launch product is explicitly defined as a prepaid term licence with manual renewal — no automatic recurring billing, automatic renewal, or provider-initiated cancellation is implemented or implied anywhere in this package. Recurring billing is recorded as a later, separate phase.
10. The DB commercial offer is restated as the sole pricing authority with an *enforcing* (checkout-disabling), not merely advisory, parity check against the frontend's display constants — `IMPLEMENTATION_PLAN.md` §5. The previously-proposed `list_purchasable_commercial_offers` function is withdrawn entirely; no caller was ever proven for it.
11. Public `/pricing` authentication behavior (unauthenticated → sign-in/signup with interval preserved; authenticated → billing-state-aware CTA suppression for existing PAID/GRACE customers) is newly specified.
12. The Flutterwave payment-identity correction is completed in full (title/description/logo/metadata, a forward-only `CFOCLOSE-` reference prefix that never touches historical column names or historical row values, and a two-phase redirect-env-var migration path if one is found necessary at implementation time) — `DATA_CONTRACTS.md` §9.
13. The two USD offers are now seeded non-purchasable, with activation as a separate, later, explicitly audited operation gated on staging acceptance — `DATA_CONTRACTS.md` §5, `IMPLEMENTATION_PLAN.md` §1.
14. The acceptance matrix is expanded with simultaneous-checkout, crash-recovery, two-different-successful-intents, transient-verification-outage, platform-state-matrix, server-owned-market, product-binding, and manual-renewal-disclosure tests.

## Design-correction round 2

A second independent review found that round 1's own fixes for two of its findings did not actually work at their real call sites, and that several items were resolved as an open choice rather than a specified design. All resolved in this revision, with no implementation performed:

1. **Round 1's product-scoping fix for `resolve_commercial_offer` relied on `auth.uid()`, which is always `NULL` under the service-role client `commercial-create-checkout` actually uses** — the fix would have silently never activated at its one real call site. Corrected by splitting into `resolve_commercial_offer` (display, `auth.uid()`-based, correct because the frontend calls it with a real forwarded session) and a new `resolve_commercial_checkout_offer` (checkout, service-role-only, takes an explicit `billing_customer_id` the Edge Function derives itself from the already-validated JWT) — `DATA_CONTRACTS.md` §1.
2. Exact `REVOKE`/`GRANT` privilege DDL is now specified for every function this package proposes, not only described in prose — `COMMERCIAL_ARCHITECTURE_AUDIT.md` §8's grant table, with matching privilege-denial tests in `ACCEPTANCE_MATRIX.md` §8.
3. Round 1's checkout-intent concurrency design (a single atomic RPC) released its advisory lock before the external Flutterwave call completed, leaving a window where a live in-flight attempt could be wrongly treated as safely supersedable. Replaced with a three-RPC, token-fenced lease protocol (`PROVIDER_CREATING` status, `creation_token`, `lease_expires_at`, a compare-and-swap persistence step that never returns a checkout URL on a failed CAS) — `DATA_CONTRACTS.md` §3.
4. **`admin_supersede_commercial_offer`, which round 1 implicitly relied on for offer activation, cannot do that job** — direct source review confirms it only ever creates a new successor row; it has no path to toggle an existing row's `is_purchasable` flag in either direction. A new, narrow, compare-and-swap-protected `admin_set_offer_purchasable` RPC is specified instead — `DATA_CONTRACTS.md` §4.
5. `admin_upsert_commercial_offer` gains an explicit `p_product_code` parameter (as a new overload, following the same three-phase deployment discipline as the resolver split) and STRICT product-scoped plan resolution — `DATA_CONTRACTS.md` §5.
6. Exact `DROP`/`ADD CONSTRAINT` migration DDL is specified for the `chk_pwpe_result` CHECK constraint, adding four values (`VERIFICATION_TRANSIENT_FAILURE`, `RECONCILED`, `RECONCILIATION_NO_TRANSACTION_FOUND`, `RECONCILIATION_TERMINAL_FAILURE`) — `DATA_CONTRACTS.md` §6.
7. Reconciliation is committed to one fully-specified mechanism — `pg_cron` + `pg_net` triggering a dedicated Edge Function, row claiming via `FOR UPDATE SKIP LOCKED`, exponential backoff, an 8-attempt terminal-failure cap with audit-row escalation, and verification/commit through the identical `authoriseCommit`/`commit_verified_commercial_payment` path a webhook would use — `DATA_CONTRACTS.md` §7.
8. The platform-state gate is corrected on two points: it now validates the provider `selectPaymentProvider()` actually selected for the offer (not an arbitrary array index), and the restricted-acceptance-identity mechanism is committed to one option (a direct `commercial_admins` table lookup on the already-validated user id, avoiding the identical `auth.uid()`-under-service-role defect as item 1) rather than left as a choice — `DATA_CONTRACTS.md` §2.
9. The GLOBAL-only checkout decision's effect on Tanzania offers is now stated explicitly rather than by omission: checkout is GLOBAL-only, TZ-market checkout is categorically unreachable through it, and this is proven non-regressive only because both existing TZ offers are already non-purchasable — re-verified at deployment time, not merely asserted from this design snapshot — `DATA_CONTRACTS.md` §9.
10. The acceptance matrix gains a dedicated section of executable tests for every round-2 mechanism: service-role auth context, direct RPC privilege attacks against every new `service_role`-only function, live-lease contention, stale-lease takeover, failed-CAS non-disclosure, offer activation and deactivation, transient-result constraint insertion, reconciliation concurrency under `SKIP LOCKED`, selected-provider-mismatch, and TZ/GLOBAL routing — `ACCEPTANCE_MATRIX.md` §8.

## Design-correction round 3

A third independent review checked round 2's proposed SQL directly against this repository's real, live `payment_checkout_intents` and `payment_webhook_processing_events` schemas — not against the design's own prior reasoning — and found that several of round 2's blocks would have failed outright had they ever been run. All resolved in this revision, with no implementation performed:

1. **`acquire_checkout_intent_lease`'s `INSERT` targeted a nonexistent `checkout_url` column** (the real column, present since Ω2-G, is `provider_checkout_url`) **and omitted four columns the real table declares `NOT NULL` with no default** — `plan_id`, `market_code`, `provider`, `created_by_user_id`. It would have failed with a constraint violation the first time it executed. Corrected: the function now derives `plan_id`/`market_code`/every economic field from the locked `commercial_offers` row (rather than trusting separately-passed parameters that could mismatch the named offer), accepts `provider` only as the value the server's own routing already chose, and explicitly re-verifies that the supplied `billing_customer_id` is actually owned by the supplied, already-validated `created_by_user_id` — `DATA_CONTRACTS.md` §3a.
2. Every SQL reference to the imagined `checkout_url` column across this package is corrected to `provider_checkout_url`; the TypeScript-facing `checkoutUrl` field name is unaffected, since it is a presentation-layer name assigned at the existing translation boundary, not a database column.
3. Exact `DROP`/`ADD CONSTRAINT` and `DROP`/`CREATE INDEX` DDL is specified for adding `PROVIDER_CREATING` to `chk_pci_status` and `idx_pci_status_active` — `DATA_CONTRACTS.md` §3.0.
4. **Reconciliation outcomes cannot be written to `payment_webhook_processing_events`** — its `receipt_id` column is `NOT NULL`, foreign-keyed to a real webhook receipt, and reconciliation by definition has none. A dedicated, purpose-built, append-only `payment_reconciliation_attempts` table is specified instead, with admin-read/service-role-write grants mirroring the existing webhook-evidence tables — `DATA_CONTRACTS.md` §7.1.
5. The reconciliation claim, previously timestamp-only, is corrected to a durable, token-fenced lease (`reconciliation_claim_token`/`reconciliation_lease_expires_at`) with an atomic claim-or-terminal-transition — closing a real risk that a worker crashing immediately after claiming the terminal (8th) attempt would permanently strand the intent with no further automatic path to resolution — `DATA_CONTRACTS.md` §7.2.
6. The backoff schedule is corrected to a fixed, table-driven sequence, and the exact maximum elapsed window is stated for the first time: **265 minutes (4h25m) by design, 305 minutes (5h5m) worst-case including `pg_cron`'s own 5-minute tick granularity** — `DATA_CONTRACTS.md` §7.3.
7. Cron authentication moves from an unusable literal placeholder to a named Supabase Vault secret, referenced by name and never inlined; a dedicated `X-Reconciliation-Cron-Secret` header distinct from the service-role key; constant-time verification reusing the exact pattern already established in `verifyWebhookAuthenticity`; and a two-phase rotation/rollback procedure — `DATA_CONTRACTS.md` §7.5.
8. The `LEASE_HELD` response is corrected from an unspecified 409 to an exact contract: 202 `CHECKOUT_IN_PROGRESS` with a `Retry-After` header, and a bounded client retry (3 attempts, 15-second wall-clock cap) that terminates on success, provider failure, or the cap being reached — `DATA_CONTRACTS.md` §2.
9. The platform-state gate's fail-open gap — an unresolved provider capability silently evaluating as "not sandbox, therefore fine" in `LIVE_ACCEPTANCE`/`CUSTOMER_PAYMENTS_ENABLED` — is closed with an explicit, unconditional fail-closed check — `DATA_CONTRACTS.md` §2, §10.
10. `admin_supersede_commercial_offer`'s identical unscoped-plan-lookup defect, previously flagged and explicitly deferred, is no longer left as a knowingly-unscoped commercial-authority RPC — it is fixed in the same migration as `admin_upsert_commercial_offer`, via the identical new-overload pattern — `DATA_CONTRACTS.md` §5.
11. Flutterwave's lookup-by-reference now has an exact, stated behavior for zero matches, exactly one match, multiple matches (never auto-resolved), a wrong-merchant scenario (structurally foreclosed by the provider's own API-key-scoped authentication, not a fabricated additional check), a sandbox/production mismatch, and every non-successful status — `DATA_CONTRACTS.md` §7.4.
12. A new, required acceptance gate is added: executable migration replay against a real, ephemeral Postgres instance, distinct from this repository's existing static-source-text test convention — motivated directly by this round's own findings, which static text review had missed entirely — `ACCEPTANCE_MATRIX.md` §9.

- Repository: `hirorobert/axiom-insight-craft`
- Main at mission start: `d75f92f7e0ca06b1d7c38de0fb45d41079336166`
- Code baseline actually audited: `6ac832b03371329faa8a6738771b5523e9ef15bf` (identical commercial-relevant source to `d75f92f7`; the only diff between the two is the addition of the non-authoritative `.lovable/plan.md` file — see "Correcting the Lovable plan" below)
- Product: CFOClose (cfoclose.com)
- Target public commercial economics: USD 49/month, USD 499/year (Professional plan)
- Author role for this pass: Engineering Designer / audit preparer — **not** the final auditor. This package exists so an independent Codex reviewer can attack the design before any line of implementation code is written.

## 0. Infrastructure constraints in force for this pass

- Lovable credits are exhausted — this pass does not depend on, or publish through, Lovable.
- No production changes were made. No Supabase access occurred. No migration was written or applied. No commercial offer was created. No payment code was modified.
- Work product is Git/GitHub-only: six documents under `docs/operations/cfoclose-omega3-checkout/`, no source diffs.

## 1. What this package is

Six documents, each scoped to one part of the required audit:

| Document | Covers mission steps |
|---|---|
| `PHASE_BRIEF.md` (this file) | Scope, constraints, plan.md correction |
| `COMMERCIAL_ARCHITECTURE_AUDIT.md` | Steps 1, 3, 4, 5, 7, 9 — system inventory, 16-requirement proof (A–P), resolver contract critique, offer-uniqueness audit, payment-authority-chain trace, RLS/security audit |
| `DATA_CONTRACTS.md` | Exact current and proposed schema/RPC/Edge-Function contracts |
| `THREAT_AND_FAILURE_MODEL.md` | Steps 6, 8 — concurrency scenarios, failure-state classification |
| `ACCEPTANCE_MATRIX.md` | Steps 12, 13 — staging and browser acceptance tests |
| `IMPLEMENTATION_PLAN.md` | Steps 10, 11, 14 — file-level MUST/MAY/MUST NOT CHANGE slices, migration safety, rollback |

## 2. Correcting the Lovable-generated plan

`.lovable/plan.md` (present on `main` at `d75f92f7` via two Lovable-bot commits, `75ebf4f`/`d75f92f`, layered on top of this session's own `6ac832b` brand commit) is **not proof of independent review** — this was true before this pass started and remains true after it. Its 7 numbered findings were independently re-verified against the actual source in this pass; findings 1–4 and 6 are accurate. Two corrections matter enough to drive the implementation plan:

1. **Finding 5 and the "minimum safe correction" both understate how much schema-level safety work is already shipped.** Plan.md proposes, as new work, "a partial unique index preventing two purchasable, currently-effective offers for the same plan+market+interval." This is **already done** — migration `20260906120000_omega3_0_effective_history_and_platform_state.sql` (Ω3.0), which post-dates the commit plan.md was generated against, already dropped and rebuilt `uq_co_current_offer` as a 5-column key `(plan_id, market_code, currency_code, billing_interval, billing_interval_count)`, plus a parallel GiST exclusion constraint (`excl_co_no_overlapping_purchasable_periods`) covering historical non-overlap on the same 5 columns. See `COMMERCIAL_ARCHITECTURE_AUDIT.md` §5 for the full proof. **No new offer-uniqueness migration is needed.**
2. **Finding 7's "cheap, additive constraints" framing undersells the genuine analysis required.** A guard against concurrent CREATED/PENDING checkout intents is real, still-open work, but it is not "cheap and additive" in isolation — it interacts with retry semantics, abandoned-checkout recovery, and the existing `saff_reference` UNIQUE constraint. See `THREAT_AND_FAILURE_MODEL.md` §Concurrency and `IMPLEMENTATION_PLAN.md` §2 for the actual recommendation (reuse-existing-open-intent, not a hard unique index that would 409 a legitimate retry).

Plan.md's proposal to add an *optional* `p_billing_interval` parameter to `resolve_commercial_offer` is explicitly **not accepted as-is** — see `COMMERCIAL_ARCHITECTURE_AUDIT.md` §4 for the independent analysis and the recommended contract (a required parameter plus a separate, explicitly-named read-only listing function).

## 3. Explicit non-goals (Ω4/other scope this pass does not touch)

Per the mission's own guardrail: do not broaden into Ω4-WORKSPACE, do not redesign the workspace, the marketing site, or Pricing.tsx beyond what checkout requires, and do not introduce a new market architecture (the existing `GLOBAL/TZ/MU/GB/EU` vocabulary is not objectively insufficient for USD dual pricing — see audit §3, requirement C). This package proposes zero changes to `stageMetadata.ts`, the 7-stage workspace lifecycle, SAFISHA/HESABU/KINGA/MAONO, or any accounting-authority table.

## 4. Stop condition

This phase produces documents only. It does not:
- create authoritative USD offers,
- modify payment code, migrations, Edge Functions, or the frontend,
- touch production or Supabase,
- publish through Lovable,
- claim Ω3-CHECKOUT is approved for implementation.

Approval to proceed to implementation is a decision for the independent Codex auditor and the user, not for this pass.
