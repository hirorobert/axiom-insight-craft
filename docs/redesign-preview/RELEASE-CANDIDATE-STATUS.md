# CFOClose Release Candidate — SINGLE CURRENT STATUS

**This file supersedes all earlier status notes.** Earlier commit/head/count claims are preserved as dated history at the
bottom (§ Superseded history) — they are kept for the audit trail, not as current fact. Where this file and any older note
disagree, **this file is correct**.

- **Branch / PR:** `integration/release-candidate-20261014` · **PR #127** (draft).
- **Base:** fully contains `origin/main` (0 behind, 30 ahead at the time of writing).
- **Head:** the latest commit on the branch. The authoritative CI record is the GitHub Actions run linked on PR #127 for
  **that exact commit** — this document does not pin a stale SHA; see § Exact-head verification.
- **State:** **not merged, not deployed.** Repo-side work complete. Merge + deploy blocked on external gates (§ Blocked).
- **Candidate financial migration:** `docs/fin-integrity/candidate-migration/20261103100000_signoff_authorization_hardening.sql`
  — **UNAPPLIED** · **sha256 `9c706f5e4a1252e0ec174e63c6d160970b431a9c855dd723435001a5deb4c279`**.

## What this release is
1. **Presentation (WS-B, #125):** the approved CFOClose brand (slate `#2E2F3A` + mint `#7FE0A0`), accessibility, currency
   wiring, regenerated favicon/icons/manifest/theme-color, and the re-established brand-governance baselines. **Frontend only —
   no database dependency.**
2. **Financial-integrity repair (WS-A, #124):** the sign-off authorization hardening candidate migration (UNAPPLIED) + its
   PostgreSQL-17 proofs. **Touches only `statement_sign_offs`.**

These two are **independently shippable** — see § Presentation ships independently.

## Composition (reconciled, no duplication)
- **#124** WS-A fin-integrity — candidate (unapplied) + PG17 proofs.
- **#125** WS-B presentation — brand/a11y/currency.
- **#123** self-service purchase e2e — incorporated (not duplicated); payment-refusal controls untouched.
- **#126** payment session — reconciled; only `LandingHero.tsx` + `index.html` overlapped; main's self-service flow preserved
  (secondary CTA → `/plans`; "Request activation" **not** restored).

## Exact-head verification
Required checks run on the **exact current head** of PR #127 (not a prior SHA). Jobs: Golden Fixtures, Release Gate (full
suite), Lint/Build/Typecheck, Real-app E2E (local Supabase), Disposable-DB Contract, Migration Audit, Edge ×2, Merge-Conflict,
and `signoff-authorization-proof` (PG17). **Staging RLS Regression is intentionally manual (write-capable) and shows as
skipped — a skip is not a pass and is not required for this frontend+docs change.** Treat pending/skipped as not-passed; the
PR's Actions run for the head SHA is the authority.

## Financial repair — proven on the real system (PG17)
Two complementary proofs, both executed on PostgreSQL 17 via `.github/workflows/signoff-proof.yml` (postgres:17 service,
bun-only, synthetic data, loopback, production ref refused):

1. **Full-chain integration proof** (`scripts/db-proof/signoff_integration_proof.mjs`, CI step INTEGRATION) — replays the
   **entire authoritative migration chain from zero**, then applies the **exact candidate**, and exercises the sign-off path
   through the **real RLS policies, triggers and capability/entitlement functions** (Practice licence → `STATEMENT_CERTIFICATION`;
   roles → capabilities) — not stubs. Covers: every defect (A, A′, B, D, E, cross-tenant, over-grants) **refused**; the
   authorized **three-distinct-signer** journey **succeeds** with records intact (real segregation-of-duties enforced);
   the **two-connection signing-vs-input-change race** in **both commit orders** (§ below); same-key concurrency and
   duplicate-replay **refused**; and **candidate isolation** (the repair trigger binds only to `statement_sign_offs`).
2. **Focused fixture proof** (`scripts/db-proof/signoff_fixture_proof.mjs`) — the real table + real trigger bodies + final
   RLS + capability-backed stubs; BEFORE (no repair, defects demonstrated) → AFTER (repair, defects closed). **Supplements,
   does not replace** the integration proof.

The proof applies the candidate **file** directly — tested == shipped (sha above, pinned in `candidate-migration/SHA256SUMS.txt`).

### Signing-vs-input-change race (two connections, controlled synchronization, both orders)
- **Order A — input change commits first:** the validation engine (connection I) commits a newer *failing* validation; the
  approver's lock (connection S) then executes → **REFUSED**; no stale approval is persisted. The HESABU gate re-reads the
  latest validation at the signing statement, so a basis that went stale before the write is rejected.
- **Order B — approver lock commits first:** the lock commits while the validation still passes (valid at that instant); the
  input then changes. The persisted approval is **sealed (`statements_hash`) + locked + immutable**, and because the current
  validation now fails, it **cannot be extended or relied on** without re-validation — a stale approval never remains *usable*.
- **Persisted approval validity** is checked in both orders: Order A → no approval row; Order B → a sealed, immutable,
  re-validation-gated record. This replaces the earlier *sequential* stale check, which did not exercise a true race.

## Brand-governance pass (RESOLVED)
From the approved masters (`docs/redesign/brand/`): favicon/icons/og-image regenerated to the slate+mint monogram (generator
rule-detection → mint; visually verified); manifest + `theme-color` → slate; `omega3BrandRegression` assertion 61 re-pinned to
slate `#2E2F3A` (with provenance); `serviceEnquiryGate` Header/Footer fixtures **machine-re-captured** through the
`withGate(false)` path — diff is brand-colour-only, nav/link-set/structure byte-identical, Contact-gate guarantee preserved
and still asserted. Governance is re-pinned to the **new approved brand** (not weakened).

## Presentation ships independently
The brand/presentation is **frontend-only** and has **no dependency on the candidate migration**. Lovable **Publish** deploys
the frontend; the candidate is a `docs/`-only file that **Publish does not apply** (applying it is a separate hosted DB
action). So the presentation can go live **without** financial-migration access:
- **Independent path:** merge + Publish #127 (or the presentation-only #125) → redesign live; migration stays unapplied until
  the financial owner is ready.
- The deploy order (§ handoff) lists **Publish frontend as step 1 with no migration dependency**, migration apply as a later,
  separately-gated step.

## Blocked (external gates only — repo side is done)
| Gate | Why | Owner action |
|---|---|---|
| **Merge #127** | `gh pr merge` is denied by the harness permission classifier (a shared-repo write needing explicit approval). Not bypassed. | Owner merges #127, **or** grants the merge permission (§ handoff names the exact command). |
| **Publish** | Production deploy is via Lovable Publish; merge ≠ Publish (cfoclose.com still serves the old navy brand, bundle `index-CCThLW1-.js`). | Owner clicks Publish in Lovable. |
| **Migration apply** | Candidate must be registered + applied through the authoritative Drizzle-journal mechanism on the hosted DB; no hosted access here. | Production-owning session applies + registers; verify sha `9c706f5e…`. |
| **Staging rehearsal** | Needs `STAGING_*` secrets. | Owner provides / runs the staging job. |

`#124` and `#125` are **superseded** by the combined `#127` for merge purposes (they remain the independent presentation /
financial views for review).

---

## Superseded history (dated — audit trail only, NOT current)
- **2026-10-14, earlier RC note (head `2b8c4f0`):** reported the sign-off proof as "BEFORE 9/9 → AFTER 12/12" and listed
  three brand-identity tests as *failing*. Both are **superseded**: the brand-governance pass resolved the three tests, and
  the proof was subsequently enhanced (fixture BEFORE/AFTER + the full-chain integration proof). The "9/9→12/12" figure was an
  early fixture run before the enhancement.
- **2026-10-14, WS-A note (head `9dec395`):** TEST-RESULTS.md previously carried a "9/9→12/12" table **and** an "11/11→17/17"
  table side by side, and described the full-chain integration proof as *NOT YET RUN*. Superseded: the integration proof is
  executed and green; the current executed detail (correct, non-conflicting) lives in TEST-RESULTS.md as the detail appendix.
- **Head `a2e726b` / `be33870`:** an earlier package claimed "CI green on `a2e726b`" while the branch head was `be33870`.
  Superseded by this file's § Exact-head verification, which ties the green claim to the **head SHA's own** Actions run and
  stops pinning a prior SHA.
