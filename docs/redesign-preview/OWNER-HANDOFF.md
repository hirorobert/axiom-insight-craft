# CFOClose — Owner Handoff (one precise hand-off for hosted application + Lovable publication)

Everything that does not require your access is **done** (code, proofs, docs, packaging, CI). This is the single set of
actions that **require your access**, in order, with verification and recovery. Nothing below is destructive; none of it
touches customer financial records or performs real charges.

## 0. Tested commit
- **Branch / PR:** `integration/release-candidate-20261014` → **PR #127** (draft).
- **Tested head:** the latest commit on that branch. Its **own** GitHub Actions run (linked on PR #127) is the authority —
  do not rely on any earlier SHA. Confirm that run is green on the head you merge, with no required job pending or skipped
  (Staging RLS Regression is intentionally manual and may show skipped — that is expected and not required here).

## 1. Included components (deploy ONLY these)
| Component | What | Depends on migration? |
|---|---|---|
| **Frontend (presentation)** | CFOClose brand (slate `#2E2F3A` + mint `#7FE0A0`), a11y, currency wiring, favicon/icons/manifest/theme-color, re-pinned brand-governance baselines | **No** — ships independently |
| **Candidate financial migration** | `20261103100000_signoff_authorization_hardening.sql` — sign-off authorization trigger on `statement_sign_offs` + grant containment | n/a (it *is* the migration) |

No edge-function changes, no payment-session changes, no schema changes beyond the one candidate migration.

## 2. Migration checksum
```
20261103100000_signoff_authorization_hardening.sql
sha256 = 9c706f5e4a1252e0ec174e63c6d160970b431a9c855dd723435001a5deb4c279
```
Verify this exact digest at every step (branch, staging apply, hosted apply, journal registration).

## 3. Merge — THE ONE ACTION BLOCKED ON YOUR ACCESS RIGHT NOW
`gh pr merge` was **denied by the harness permission classifier** (a shared-repo write needing your explicit approval). It was
**not bypassed**. To proceed, do **one** of:
- **Merge it yourself** on GitHub (PR #127 → "Merge"), **or**
- **Run the exact command** (this is the precise approval being surfaced):
  ```
  gh pr merge 127 --repo hirorobert/axiom-insight-craft --squash --delete-branch=false
  ```
- or add a Claude Code permission rule allowing `gh pr merge` on this repo, then tell me to proceed.

Merge **after** confirming §0 (green on the head SHA). Merging does **not** deploy anything (see §5).

## 4. Fresh read-only hosted preflight (before any migration apply)
From the production-owning session (hosted DB access), capture read-only:
- current schema + **Drizzle journal** state (is `20261103100000` already present? expected: no);
- the live `statement_sign_offs` triggers/policies/grants still match the 2026-10-14 read-back the candidate targets;
- `enforce_signoff_authorization` does **not** already exist (idempotency/no-clobber);
- required privileges to apply + register; recovery readiness; no long-running/active transactions on the table.
Abort the apply if any expectation fails; re-reconcile first.

## 5. Deployment order (dependency-safe; presentation does NOT wait for the migration)
1. **Publish frontend (Lovable Publish).** This makes the redesign live. It has **no** migration dependency and can go first,
   immediately after merge. (Merge ≠ Publish; cfoclose.com currently still serves the old navy brand, bundle
   `index-CCThLW1-.js`.)
2. **Staging rehearsal of the migration** (needs `STAGING_*`): on an isolated synthetic DB, apply the candidate + run the app
   checks together; rehearse the recovery in §7. Verify sha `9c706f5e…`.
3. **Register + apply the candidate on hosted** through the **authoritative Drizzle-journal mechanism** (not an ad-hoc `psql`
   run) so the journal mirrors the authored file; verify the journal row + sha afterwards.

Steps 1 and 2/3 are independent — if you are not ready to touch the financial migration, **do step 1 alone** and the
presentation is fully live.

## 6. Verification (non-destructive, approved test accounts only)
- cfoclose.com serves the **new slate brand** (theme-color `#2E2F3A`, favicon = slate/mint monogram, new bundle hash) and all
  routes incl. mobile; no horizontal overflow at 320px; axe-core clean on `/`, `/pricing`, `/auth`.
- Auth, upload, validation, sign-off, and the self-service purchase / payment-refusal controls behave unchanged.
- Record the deployed **frontend build**, **edge-function versions** (unchanged), and **migration journal** state separately.

## 7. Recovery (preserves financial controls — never a shortcut)
- **Financial:** containment only — `REVOKE INSERT, UPDATE ON public.statement_sign_offs FROM authenticated;` (tested: blocks
  new signing, preserves every historical row). **Never** `DROP TRIGGER enforce_signoff_authorization` (that reopens
  unauthorized signing) and **never** GRANT direct writes back without the enforcing path. Never delete records or sign-offs.
- **Frontend:** redeploy the last compatible release via Lovable.

## 8. What needs your access vs. what is already done
- **Needs your access:** (a) merge #127 [§3, blocked now]; (b) Lovable Publish [§5.1]; (c) hosted preflight + migration
  register/apply [§4, §5.3]; (d) `STAGING_*` for the staging rehearsal [§5.2].
- **Already done (no access needed):** all code, the brand-governance pass, both PG17 proofs (full-chain integration +
  fixture), the exact-head CI, the review package/ZIP, this handoff. I will continue any non-access work on request.
