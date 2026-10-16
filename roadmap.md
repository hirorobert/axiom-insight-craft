# CFOClose roadmap and status — trial balance programme (directive of 15 October 2026)

This is the ONE status file for this programme. It is updated in place; earlier notes are kept at the bottom.
`docs/redesign-preview/RELEASE-CANDIDATE-STATUS.md` remains the status of the separate release candidate (#127) only.

**Status words used here, and nothing stronger:**
- **IMPLEMENTED — UNVERIFIED**: code exists; no passing evidence yet.
- **VERIFIED IN ISOLATION**: passing unit tests and/or real-PostgreSQL proofs, without the full stack.
- **VERIFIED END TO END**: passing on the local Supabase stack (real Auth, PostgREST, RLS, Storage, Edge Functions) in CI.
- **INTEGRATED**: merged to `main` with every required check green on the merged head.
- **DEPLOYED AND READ BACK**: live on the hosted project, with installed versions and a synthetic check read back.

Nothing in this programme is INTEGRATED or DEPLOYED yet. Payments: public payments remain **disabled** until both Polar and
Snippe pass (owner decision 14 October); no payment state is changed by this work.

## Customer flow

**Today (main):** sign in → first run creates an entity (name, year end) → "What would you like to complete?" → "Add
financial data" → upload a trial balance inside the entity → checks → review. An entity must exist before any file.

**Intended (Phase 2):** sign in → one page: drop the file (stored privately as a draft, not yet in any entity) → stages File
read → Columns confirmed → Checks completed → confirmation card (entity, period, currency) under the results → "Start trial
balance check" → the draft is committed to the entity and processed. Returning users get a compact drop zone above their
entity list. The two removed screens never appear while only one service exists.

## Phases

| Phase | Scope | Status | Depends on |
|---|---|---|---|
| 0 | §1 apply the ingestion repair (PR #132) | VERIFIED IN ISOLATION; green only when combined with #133 (draft #134, old base; draft #137, current base) | #133 |
| 1 | §3 engine correctness: footers, earlier-version results, entity/period/currency evidence, review rules, one status vocabulary (PR #135, draft) | VERIFIED IN ISOLATION (all PR checks green except the payment proofs #133 fixes) | 0 |
| 2 | §5 the one-page journey (PR #136, draft) | IN PROGRESS — see batches below | 1 |
| 3 | Source-to-result review report with check-coverage matrix | NOT STARTED (not to start until Phase 2 is accepted) | 2 |
| 4 | Gated records-to-draft-TB assistance | NOT STARTED (same) | 2, 3 |
| 5–6 | Not defined by the 15 October directive | — owner to define | — |

## Phase 2 batches

| Batch | Content | Status |
|---|---|---|
| P2-1 | One way in while one service exists (entry card); header status; entity wording | VERIFIED IN ISOLATION (PR #136 at `578ac97`: every job green except the payment proofs #133 fixes) |
| **P2-2 (current)** | Draft upload authority: owner-scoped drafts, commit to an entity, recovery protocol, 7-day retention | VERIFIED IN ISOLATION; end-to-end journey written and running in CI — see evidence |
| P2-3 (next) | First-visit drop zone; stages File read → Columns confirmed → Checks completed; confirmation card (entity, period, currency); draft message | NOT STARTED |
| P2-4 | Returning Home list; Orders → Settings › Billing with redirects; payment notice; Reconcile locked with reason | NOT STARTED |
| P2-5 | Integrity across entity creation → commit → job → usage; acceptance journeys 1–14; desktop/mobile screenshots | NOT STARTED |

### P2-2 — what exists and what it proves

Files: `supabase/migrations/20261106100000_trial_balance_drafts.sql`, `supabase/functions/trial-balance-draft/`,
`supabase/functions/_shared/draftUpload.ts`, `src/lib/workspace/trialBalanceDraft.ts`, the sweeper kind `draft`.

- **Idempotency, per operation.** *Reserve* binds the authorised owner and the file's identity (name, size, SHA-256 of
  the bytes); no entity is needed. *Commit* is its own record, binding the draft and its content hash, the target entity,
  the period (year, period, engagement) and the confirmed context (entity, period, currency). Same key + same inputs →
  the existing outcome; same key + changed inputs → conflict; a new key with the same file → a new, legitimate draft. A
  draft is committed at most once. Every commit call, a replay included, re-checks the caller's CURRENT authority.
- **Recovery protocol (not a distributed transaction).** begin → read the draft back (size + SHA-256) → workspace
  reservation as the user, recorded → service-role copy, read back and verified, recorded → registration as the user (the
  single-use reservation is consumed with the upload row in one database transaction, so registration happens at most
  once) → finish. A stop or lost response at any step leaves a recorded state the next call resumes from. Between Storage
  and the database there is no atomicity: a copy can exist without a registration (an unconsumed reservation's object,
  reclaimed by the existing reservation sweep), never a registration without a verified copy.
- **Retention.** Unconfirmed drafts expire after 7 days (owner approval 15 October: "approved at 7 days for unconfirmed
  draft uploads only"). The scheduled sweeper removes expired, deleted, rejected and committed drafts' own `drafts/`
  objects. Committed evidence is the separate workspace copy the upload is bound to; a `drafts/` path can never be a bound
  source. Not shown to users until implemented, tested and deployed (P2-3 shows it only then).
- **Constraint changes.** Only the two new tables carry new constraints. No existing table, constraint, policy or grant
  is altered; the three sweeper functions are redefined with marked additive blocks. The drafts tables deliberately hold
  NO foreign key to `trial_balance_uploads`: `tbu_upload_evidence()` reads any such key as processing evidence and would
  have made an unprocessed upload from a draft undeletable (caught by the comparison proof and fixed).
- **Rollout compatibility.** Order: migration → function → frontend. Old frontend + new backend: the entity-first path is
  unchanged (the existing real-app journey runs it on the new backend). New frontend + old backend, or an interrupted
  rollout (function before migration, or migration without function): every draft step refuses with
  `drafts_unavailable` and the message "Uploading before choosing an entity isn't available yet. Add the entity first,
  then upload your trial balance." — never a false success; committed evidence is untouched.

### Evidence for the tested commit

Recorded below with the exact head SHA and CI run once pushed.

## Outstanding owner decisions

1. **#132/#133 integration**: recommended arrangement is the combined candidate draft #137 (current `main` + #132 + #133,
   no file overlap); merge only with every required check green on its final head. No merge permission is assumed.
2. **Draft size cap**: 50 MB is a technical bound in the drafts migration. No trial balance upload size limit existed
   before, so this is a new policy to confirm.
3. **Hosted application** of `20261106100000` and deployment of `trial-balance-draft`: owner/Lovable only; not requested.
4. **Payments** stay disabled until Polar and Snippe both pass (decided 14 October; restated 15 October).

## Earlier notes (kept)

Ω2 sandbox GLOBAL offer creation (TEST data only)

- [x] Frontend-only onboarding and plan presentation: no-plan first-run, archive preservation, current plan, capacity-only Add entity boundary, public access-request removal, tests and private screenshots. No publication.
