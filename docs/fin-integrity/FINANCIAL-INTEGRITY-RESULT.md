# WORKSTREAM A — FINANCIAL-INTEGRITY RESULT

**Worktree:** `D:\DevStorage\Temp\claude\cfoclose-fin-integrity-20261014` · **branch:** `fix/signoff-authorization-20261014` · **base:** `dfd4098` (origin/main, current).
**Scope:** the sign-off authorization path. **Date:** 14 Oct 2026.

> **STATUS (updated 2026-10-14).** The five defects are now **(a) CONFIRMED present on the deployed database** by Lovable's read-only production read-back (project `bvyivmmfjejbmqoydezk`, PostgreSQL 17, 2026-10-14 04:56:30 UTC), and **(b) reproduced and repaired in an EXECUTED before/after proof on PostgreSQL 17.11** (CI run `signoff-authorization-proof` #38530479479: BEFORE 9/9 defects demonstrated → AFTER 12/12 with the candidate repair applied). See `TEST-RESULTS.md`. Local embedded-PostgreSQL does not boot on this Windows host (`$libdir/utf8_and_win` missing), so the proof runs as a disposable **CI** Postgres-17 job (the directive's authorized route). The candidate repair migration remains **NOT applied to any hosted DB** — this batch is for release review, not deployment.

---

## 1. Reconciliation of the original audit claim

**Old claim (against `b32aa4f`):** *"`statement_sign_offs` RLS UPDATE allows ANY company member; the `hesabu_gate_before_signoff` trigger checks validation-pass only, NOT role, and only on BEFORE INSERT."*

**Verdict at `dfd4098`: CHANGED (materially strengthened), one sub-claim CONFIRMED.**

| Sub-claim | Verdict | Evidence (`dfd4098`) |
|---|---|---|
| "UPDATE allows ANY company member" | **CHANGED** | UPDATE split into `sso_update_preparer` (`prepare_close`, unlocked-only, cannot set reviewer/approver fields) and `sso_update_partner_owner` (`approve_certification` + SoD). `20260925140000_workspace_capability_authorization.sql` (final `ALTER POLICY` bodies ~L1948-1973) |
| "trigger checks validation only, NOT role" | **CONFIRMED (by design, not itself a defect)** | `hesabu_block_signoff` checks only validation; role/tier is RLS's job now. `20260713000000_hesabu_trigger_fix.sql:43-80` |
| "only BEFORE INSERT" | **CONFIRMED (unchanged)** | Trigger is still `BEFORE INSERT` only. `20260713000000:94-99` — root of Defects A & D. |

**Important architectural note:** there are now **two** sign-off systems. The **newer `financial_statement_publications` path** (RPC `fs_set_publication_state`, migrations `2026101x–2026102x`) is genuinely hardened — single SECURITY-checked RPC write path, capability-gated REVIEWED/FINAL, input-digest (`inputSha256`) binding, FINAL immutable. **It does not share the defects below.** The defects are specific to the **legacy `statement_sign_offs` table** (KINGA 3-tier Preparer→Reviewer→Approver), which is still written **directly from the browser** and only loosely gated. The newer work did not retire it.

---

## 2. Demonstrated* defects (*statically substantiated; not runtime-reproduced — see disclaimer)

Common facts: `GRANT SELECT, INSERT, UPDATE ON public.statement_sign_offs TO authenticated` (`20260707183617_...sql:319`) → any authenticated user can write via **direct PostgREST** (`POST/PATCH /rest/v1/statement_sign_offs`), independent of the UI. The only server gates are RLS + four triggers. **Reachability caveat (honest):** the `trg_sso_statement_certification_wall` trigger (`20260925100000:54`) raises `ENTITLEMENT_REQUIRED` unless the **company** holds the `STATEMENT_CERTIFICATION` entitlement. So these are reachable for **certification-entitled companies**, by any authenticated member with `prepare_close`, via the API — not for trial-balance-only companies (billing wall blocks). DB privilege ≠ universal reachability; it is real reachability for the entitled tenant set.

### Defect A — INSERT bypasses BOTH the HESABU validation gate and the approver-tier gate *(CRITICAL)*
- **Gap:** `sso_insert` WITH CHECK requires only `workspace_capability_allowed(company, uid, 'prepare_close')` — **no column/status restriction** (`20260925140000` ~L1948-1950). `hesabu_block_signoff` returns early (`RETURN NEW`) when `NEW.preparer_signed_at IS NULL` (`20260713000000:45-47`), and the trigger is INSERT-only (`:94-99`). `sso_distinct_signers` passes when only one signer id is set (`20260720082546:52-75`). `cascade_period_lock` is UPDATE-only.
- **Failing scenario:** an actor holding only `prepare_close`, on a `STATEMENT_CERTIFICATION`-entitled company+year with no existing row and no passing `hesabu_validations`, issues ONE PostgREST INSERT: `{preparer_signed_at:null, approver_id:<any distinct uid>, approver_signed_at:now, status:'locked', locked_at:now}`. → Row created **locked & approved**: HESABU gate skipped, no `approve_certification` required, no SoD exercised, and `guard_upload_on_locked_period` then blocks further uploads for the period. **Expected:** refused (no validation; insufficient tier).

### Defect B — signer identity is client-supplied, unbound to `auth.uid()` *(HIGH; violates CLAUDE.md §4.3)*
- **Gap:** no RLS clause or trigger ties `preparer_id/reviewer_id/approver_id` (or `*_firm_member_id`) to the authenticated user; `enforce_sso_distinct_signers` only requires the three to differ from each other, and the `*_id → auth.users` FK is **not company-scoped**.
- **Failing scenario:** one `approve_certification` holder UPDATEs the row setting `reviewer_id=<user Y>`, `approver_id=<user Z>` (Y,Z arbitrary distinct uids, even cross-tenant), with `reviewer_signed_at/approver_signed_at/locked_at=now()`. SoD WITH CHECK passes (three ids differ). → One person completes all three tiers; review/approval attributed to people who never acted (non-repudiation failure). **Expected:** `*_signed_at` writable only when the matching `*_id = auth.uid()` and that member belongs to the company.

### Defect C — locked sign-off rows are mutable by approvers *(MEDIUM; contradicts the table's own immutability claim)*
- **Gap:** `sso_update_partner_owner.USING` lacks `locked_at IS NULL` (`20260925140000` ~L1960-1962), unlike `sso_update_preparer` which has it. No post-lock immutability trigger exists (`cascade_period_lock` only acts on the NULL→NOT NULL transition).
- **Failing scenario:** after lock, an `approve_certification` holder UPDATEs `approver_note`/`approver_id`/`approver_firm_member_id` (SoD still satisfied). → A "locked, immutable" record is mutated — the comment at `20260707183617:308-309` ("even authorized users cannot update … DB enforces immutability") is false for the approver policy.

### Defect D — stale validation accepted; sign-off not bound to signed content *(HIGH)*
- **Gap:** `hesabu_block_signoff` counts **any** historical `gate_satisfied=TRUE` run for `upload_id` (`20260713000000:51-54`), with no "latest run" filter, and never checks `statement_sign_offs.statements_hash` (the column exists, `20260707183617:257, but is read by no code). Because `hesabu_validations` is append-only, a newer **failing** re-validation does not revoke the earlier pass.
- **Failing scenario:** validate upload (pass) → change inputs / re-validate producing a FAIL row → preparer-sign (INSERT with `preparer_signed_at`). → Allowed, because the old pass row persists. **Expected:** require the **latest** run to pass and bind the sign-off to the signed content digest (as the `fs_*` path binds to `inputSha256`).

### Defect E — tier sequence not enforced in the DB *(MEDIUM; underlies A)*
- **Gap:** nothing requires `preparer_signed_at` before `reviewer_signed_at` before `approver_signed_at`; the `status` CHECK (`20260707183617:275-276`) permits jumping straight to `'locked'`. Sequence is enforced only by UI button-gating in `KingaTaxPanel`.

### Defect F — over-broad table grants to `authenticated` *(HIGH; from the production read-back)*
- **Gap:** the deployed read-back shows `authenticated` holds **SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN** on `statement_sign_offs` (the repo at `20260707183617:319` granted only SELECT/INSERT/UPDATE — a later blanket grant widened it). DELETE has no RLS policy (fails closed), but **TRUNCATE is not row-level** and is not reachable via PostgREST — yet holding it is an unnecessary, dangerous over-grant (a grantee with any SQL path could wipe all sign-off history across every tenant). REFERENCES/TRIGGER/MAINTAIN are likewise unnecessary for a client role.
- **Repair:** `REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.statement_sign_offs FROM authenticated;` (keeps SELECT/INSERT/UPDATE, themselves gated by RLS + the trigger; `service_role` retains ALL). Verified in the proof (AFTER: authenticated loses TRUNCATE+DELETE; service_role keeps TRUNCATE).

**Severity:** A (critical) > B, D, F (high) > C, E (medium). All are DB-layer gaps distinct from the UI. **Production read-back explicitly corroborates A/D** (it calls the INSERT-only gate + un-gated signed UPDATE an "unresolved architectural nuance") and the capability-split RLS of B/C.

> **Practical reachability (honest):** the certification entitlement wall (`trg_sso_statement_certification_wall`) requires the company to hold `STATEMENT_CERTIFICATION`. Today that entitlement + the financial-statements rollout are confined to the DEMO company / sole live-acceptance tester, and the legacy browser writer (`KingaTaxPanel`) is in the un-offered TZ pack — so broad customer reachability is currently low. Severity is HIGH because these become reachable the moment Close Certification is sold, and the exposure is via the direct PostgREST Data API (not just the UI).

---

## 3. Candidate repair (NOT applied, UNVERIFIED)

File: `docs/fin-integrity/candidate-migration/20261103100000_signoff_authorization_hardening.sql` (added on this branch; **not applied to any DB**).

**Design — smallest justified, fail-closed, evidence-preserving:**
1. **Close the INSERT hole (A, E):** a `BEFORE INSERT OR UPDATE` trigger `enforce_signoff_authorization()` that (a) runs the HESABU latest-pass gate whenever ANY signature/lock field is being set — not only when `preparer_signed_at` is set; (b) enforces tier sequence (`reviewer_signed_at` requires `preparer_signed_at`; `approver_signed_at` requires `reviewer_signed_at`; `locked` requires `approver_signed_at`); (c) requires `approve_certification` capability for any write that sets `reviewer_signed_at`/`approver_signed_at`/`locked_at` (defence-in-depth beside RLS, and covering INSERT which RLS does not tier-gate).
2. **Bind identity (B):** each `*_signed_at` may transition to NOT NULL only when the matching `*_id = auth.uid()` **and** `*_firm_member_id` resolves to a `firm_members` row for this `company_id`. Reject client-supplied ids that don't match the actor.
3. **Lock immutability (C):** once `locked_at IS NOT NULL`, reject any UPDATE of the row (except a service-role correction path), mirroring the append-only discipline of `hesabu_validations`.
4. **Bind to signed content (D):** require `statements_hash` to be set and to equal the current authoritative input digest for `upload_id` at sign time; reject if a newer failing validation exists.

**Preferred alternative if verification is not possible before use (per directive "disabling is preferable to restoring a vulnerable policy"):** `REVOKE INSERT, UPDATE ON public.statement_sign_offs FROM authenticated;` and route all writes through a new SECURITY DEFINER RPC that performs 1–4 server-side (the proven `fs_set_publication_state` shape). This **disables the vulnerable direct-write path entirely**; because the sole browser writer (`KingaTaxPanel`, in the un-offered TZ jurisdiction pack) is not customer-reachable at `dfd4098`, customer impact is minimal while the hole is closed. The candidate migration includes this REVOKE as a commented, ready-to-enable block.

**Migration compatibility:** additive (new trigger + optional REVOKE); does not alter existing columns or drop data. The trigger is defensive — on a correctly-behaving caller it is a no-op. Must be verified on an isolated PG16 replay (all migrations in order) before any environment; confirm it does not break the existing `signoffAuthorization`/`hesabu` tests and the `fs_*` path (which it does not touch).

**Safe recovery (never reopens unauthorized signing):** rollback = `DROP TRIGGER` (and, if the REVOKE block was enabled, `GRANT` restore **only together with** the SECURITY DEFINER RPC remaining in place). A down-script must **not** restore the pre-repair grant without the RPC, i.e. recovery must leave the gate at least as strict. Existing sign-off rows are never deleted or back-dated; corrections are forward-only (new row/version). Financial evidence (`hesabu_validations`, existing sign-offs) is preserved throughout.

---

## 4. Tests (written, UNEXECUTED)

`scripts/db-proof/signoff_authorization_proof.mjs` — boots a disposable loopback PG16, applies every repository migration in order (reusing the project's proof approach), then asserts each failing scenario A–E is **refused** (before repair these assert the CURRENT broken behaviour as `KNOWN-FAILING`; after applying the candidate repair they must flip to `REFUSED`). It refuses any non-loopback host and the production ref, and never reads Supabase credentials.

**Status: UNEXECUTED** — no bootable PG on this host (see disclaimer). To run where Docker/PG is available:
```
# option 1: embedded (needs a working embedded-postgres binary for the OS)
DB_PROOF_MODULES_DIR=/path/to/proof-modules-16 node scripts/db-proof/signoff_authorization_proof.mjs
# option 2: external throwaway loopback DB (CI service container)
DB_PROOF_MODE=external DB_PROOF_CONN=postgres://user:pass@127.0.0.1:5432/throwaway \
  node scripts/db-proof/signoff_authorization_proof.mjs
```
Expected before repair: A–E report the insecure outcome (test FAILS = defect demonstrated). Expected after repair: all REFUSED (test PASSES). Existing checks (`bun run test`, the repo's own db-proof) must stay green — **not run here** (DB unavailable; TS/lint unaffected as changes are SQL + one `.mjs`).

---

## 5. Unresolved dependencies
- **Isolated PG16 runtime** — to execute the tests and verify the repair (blocked here).
- **Supplied production verification report** — to confirm which of these policies/triggers are actually **deployed** (repo ≠ deployed). The report was not provided.
- **Product decision** — whether the legacy `statement_sign_offs` / KINGA tier flow is being retired in favour of the `fs_*` publication path; if so, the "disable the direct-write path" option becomes the natural repair rather than hardening a path slated for removal.
