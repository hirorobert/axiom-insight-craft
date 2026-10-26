# Guided account correction r2 — review of the journey, bounded repair, and what remains

Base: PR #204 head `b384f9d56cdb1f0b50d3d63dbea1213769af788a` (`codex/guided-correction`, one commit on main
`53e6e37724d6b387dc113ffcba244f58e2a82301` = the #203 merge). Candidate branch: `fix/guided-correction-r2`. Candidate only:
no migration, no Edge Function change, no hosted record, no activation setting, no AI provider call, no API spending.
**Depends on #204** (it is based on #204's exact head and must merge after it, or be re-based if #204 changes).

The journey under review (unchanged in shape): Close Review › Findings → "Review this account's classification" →
Prepare page `AccountCorrection` (`?account=&finding=`) → `resolve_account_review_batch` (canonical receipt) →
`tbu_request_reprocess` + `process-trial-balance` → `close_review_refresh_findings` → the finding as the new run reports it.

## 1. Confirmed defects (evidence), and allegations withdrawn

| # | Where | Defect | Evidence | Status |
|---|---|---|---|---|
| D1 | #204 `correctionGuidance.ts` | "Keep the original debit and credit amounts" presented the uploaded amount as verified; the amount sentence had no path for an amount that is itself wrong. | `CLASS_GUIDANCE.non_current_assets` at #204 head; asserted by #204's own test. | Fixed: `AMOUNT_GUIDANCE` ("Changing the classification does not change the uploaded amount. If the amount itself is wrong, use the adjustment workflow.") with a link to Close Review › Adjustments only for a person who may propose there. The workflow exists: `20261015100000` (`close_review_propose_adjustment`, `prepare_close`), page `close/adjustments` in `RELEASED_WORKBENCH_PAGES`. |
| D2 | Findings page + correction page, rule A01 | After correcting an accumulated-depreciation account from an expense to a non-current asset, the next run raises A01 again (`20261014100000` l.276–279: `class_side_minor < 0`, the only exemption being a confirmed `closing_stock_credit` treatment, current assets only). The page then showed the same "Review this account's classification — start here if the category may be wrong" and "Correct the category, then recheck", i.e. asked the user to repeat a completed correction, and never said why the warning stays or what closes it. | Migration SQL; `FindingsView.tsx` l.185–186 and `AccountCorrection.tsx` l.230 at #204 head. | Fixed: `findingGuidance()` states the facts, when an asset credit is legitimate (contra account) and that the warning is raised again and is closed by an explanation on the finding; `returnStatus` says whether the new check used the saved classification and names what closes the finding (explanation for a warning; adjustment or overdraft presentation for A03). |
| D3 | `FindingsView.refresh`, `AccountCorrection.refreshFindings`, `onCheckAgain` | "Nothing was recorded" / "Nothing was changed" after a THROWN error — the request (a findings run, a reprocess) may have reached the server. | #204 head `FindingsView.tsx` l.95; `AccountCorrection.tsx` l.156, l.166. | Fixed: a server refusal (`ReprocessRefusedError`, a PostgREST code) still says nothing changed; a lost answer says "could not confirm" and keeps reading state. |
| D4 | `FindingsView` | The opened finding was remembered by its **id**, which belongs to one run. "Check again" produced a new run with new ids: the detail disappeared silently while the address still named the finding; a finding the new run no longer raised was not said to be gone. | `selected` = `r.id`, `sel = rows.find(r => r.id === selected)` at #204 head. | Fixed: selection by `finding_key`; after a check the key is re-read from the new run; every notice carries `data-finding-key` and `data-run-id` and names the finding in words. |
| D5 | #204 reason aid | `guidanceReasonComplete` only tested for the bracketed placeholder: "Changing from Revenue to Cost of goods sold because ." passed as a reason. | `correctionGuidance.ts` at #204 head. | Fixed: at least `REASON_AUTHORED_MIN` (10) characters must be the person's own beyond the template; the page counts them. The aid never replaces typed text (disabled while text exists, and guarded in the handler). |
| D6 | `FindingsView` | The prominent correction button was shown to every reader, including a reviewer without `prepare_close`, who then landed on a read-only page. | `correctionHref` rendered unconditionally. | Fixed: primary button only with `prepare_close`; otherwise a plain "Open this account … Correcting it needs Prepare" link. Server authority unchanged. |
| D7 | #204 repository checks | #204 adds `src/lib/workspace/correctionGuidance.ts` without listing it in CLAUDE.md §7 — `src/lib/__tests__/claudeFileMap.test.ts` **fails** at #204 head (passes at main `53e6e37`). The PR body's "41 focused tests passed" did not include it. | `bunx vitest run src/lib/__tests__/claudeFileMap.test.ts` at `b384f9d`: 1 failed. | Fixed here (CLAUDE.md entry). #204 itself still fails that test until it is merged with this or amended. |
| D8 | correction page | After a save the page said "Correction saved." without the receipt or the consequence (certification invalidated, re-check needed to see the finding's state). | `AccountCorrection.tsx` l.242 at #204 head. | Fixed: receipt reference and the invalidation stated; the one re-check path is the next action. |

**Withdrawn / not reproduced.** (a) "Open beside a notice claiming the finding disappeared" as a *literal* simultaneous state
was not reproduced from the code: the table lists only the current run's rows. The real contradiction was D4 (the address
and the user's mental model naming a finding the page had silently dropped, or a vanished finding not being said to be
gone); it is fixed and covered by tests. (b) "Classification preselected or saved silently" — not present at #204 head
(select starts empty; nothing writes without the Save button). (c) "Keyword dictionary in the browser" — #204 added none;
this candidate adds none. The only structured provenance the browser reuses is the finding row's own `classification`
(the class the certified check used) and A10's `detail.evidenceTier` (1–5, written by `buildCertifiedRows`); the account
name is never read as treatment.

Not a defect of this journey but recorded: `matchesClosingStockRule` in `process-trial-balance` (code prefix 4–9 or name
patterns) is the server's own heuristic that decides which current-asset credits get a treatment request; it is the
server's contract and is not duplicated or interpreted in the browser.

## 2. What the user now sees and does

On **Close Review › Findings**, opening an A01/A03/A10 finding shows, in this order: *What the check found* (the
classification the check used and the side the balance is on, from the finding row), *When this can be legitimate*,
*What decides it*, then the correction button (Prepare) or a read-only link, then *Record a decision on this finding* with
each offered decision's effect in words (explanation = reasoning, not a correction; accept = a reviewer's judgement, not a
fix; not applicable = a recorded reason, not a way past an unresolved issue), the statement that comments are discussion
only, and the history/comments.

On the **trial balance page** (`AccountCorrection`): the same four facts/possibility/judgement lines, the amount sentence
with the Adjustments link where allowed, the account's balance, *Classification used by the current check* and *Saved
classification* side by side, the category chooser with each category's meaning, the reason box with the writing aid (it
writes only the opening from the two categories), and Save. After Save: the receipt, "certification is invalidated", and
*Check the trial balance again* (confirmation dialog, unchanged). After the check: still raised / no longer raised / not
checked, tied to the finding key and the run id; for "still raised", the classification that check used, whether it was
the saved one, why the warning can legitimately remain, and what closes it; then *Back to the finding*.

Capabilities: unchanged. `canCorrect` (`prepare_close` + processing entitlement) gates the form, the re-check and the
Adjustments link; `offeredActions` gates decisions; the server decides every write.

## 3. Junior-accountant task script (automated evidence vs human usability)

Start: Close Review › Findings, finding "Balance on the unexpected side — 1510 Accumulated depreciation — plant" (check used
Operating Expenses; credit 25,000.00).
1. Read the three facts lines. Expected: understands the check used an expense class and the balance is a credit; sees that
   an asset-reducing account is a legitimate reason for a credit.
2. Click "Review this account's classification". Expected: lands on the account; sees Used = Operating Expenses, Saved =
   Operating Expenses; chooses Non-Current Assets; reads its meaning; writes a reason (or uses the aid and completes it).
3. Save. Expected: "Correction saved (server receipt …). … certification is invalidated"; Saved = Non-Current Assets,
   Used = Operating Expenses; the only action is "Check the trial balance again".
4. Check again → confirm. Expected: "still raises this finding with the saved classification (Non-Current Assets)"; the
   contra explanation; "closed by recording an explanation on the finding"; Back to the finding.
5. Back → Record explanation. End state: finding Explained (resolved warning); classification Non-Current Assets; the
   earlier run's finding and its history untouched.

**Automated evidence** (this candidate): `AccountCorrection.journey.test.ts` runs steps 2–4 on the real component against a
fake server; `FindingsView.test.ts` runs steps 1 and 5's surface (effects, notices, selection across runs).
**Human usability testing: not performed.** No representative user has been observed on this candidate; nothing here
claims "no coaching required". That observation is the owner's next step, with the script above.

## 4. Tests

New: `src/components/workspace/AccountCorrection.journey.test.ts` (11), `src/components/closeReview/FindingsView.test.ts`
(7), `src/lib/workspace/correctionGuidance.test.ts` (rewritten, 10), `accountCorrection.test.ts` (return status extended).
Preserved and passing: `AccountCorrection.scope.test.ts` (7, concurrency and receipts), `AccountCorrection.review.test.ts`
(2), `findings.test.ts` (13). Coverage of the brief's list: corrected classification with a remaining warning ✔; changed but
not rechecked ✔; switching findings with an old notice ✔; typed reasoning surviving help ✔; unknown save + same-request
retry across a reload ✔; stale / unavailable after recheck ✔; restricted users ✔ (both pages); deterministic journey with AI
off ✔ (no AI element exists; the journey completes). Repository checks run on the committed candidate are reported in the PR.

## 5. Governed contra-account treatment — proposal (NOT implemented here)

**What exists.** `20261007100000` H1b: the engine emits a *treatment request* per flagged account
(`treatment_requests` in the upload's `processing_result`; id = SHA-256 of rule, version, company, upload, source hash,
account key/code, debit, credit, mapping decision), and `resolve_account_review_batch` accepts
`CONFIRM_ACCOUNT_TREATMENT` with `treatment = 'keep_as_mapped'` only for a request that exists in THIS upload's current
result with the current mapping decision. `get_confirmed_treatments` is rule-agnostic; `close_review_refresh_findings`
exempts from A01 every account whose confirmed request is current (`v_treated`), also rule-agnostic. The Account review
panel already renders any treatment row ("Keep as mapped or reclassify…" with a reason). **The only emitting rule is
`closing_stock_credit` v1 (current assets).** Nothing emits for a non-current-asset credit, so accumulated depreciation has
no governed treatment: the honest outcome today is "A01 stays; record an explanation".

**Smallest forward change.** Engine only, no SQL:
1. `_shared/treatmentRequest.ts`: add `CONTRA_ASSET_RULE = { rule_id: "contra_asset_credit", rule_version: "1" }`.
2. `process-trial-balance` STEP 6: beside the closing-stock group, a group for `non_current_assets` (and current assets
   not matching closing stock) with `credit > debit`, emitting a request with `CONTRA_ASSET_RULE`; unconfirmed → `takeForReview`
   with the words "A credit balance on an asset account. Keep it as mapped if it reduces a related asset (record why), or
   reclassify it." — no name heuristic decides eligibility; every asset credit asks.
3. Tests: `functionpath/functionPath.test.ts` (a non-current-asset credit raises exactly one request; a confirmed one does
   not; figures are not moved), `scripts/db-proof/h1Authority.mjs` (id equality for the new rule's facts; confirmation
   bound to the exact request), `close_review_findings` proof that A01 is exempt only while the confirmation is current.
4. Optional later: a `detail.treatment` on A01 findings naming the confirmed request, so the finding page can say "kept as
   mapped on <date>".

**Owner decision required before building it** (accounting policy): asking a treatment question for every asset credit makes
such trial balances `needs_review` until a person answers — it gates certification. Alternatives: emit the request without
taking the account for review (A01 still raised; the confirmation becomes available from the finding) — needs
`close_review_refresh_findings` to read requests from a certified result, a small SQL change — or keep the status quo
(explanation only). This candidate does none of these and says so on the page.

## 6. Optional AI — assessment and a separate implementation contract (NOT implemented; no provider call)

**Fit.** The existing assistant (`assistant-explain`, `_shared/assistantHandler.ts`) accepts exactly
`{action, companyId, periodYear, lineId, requestId, refinement}`; `lineId` must match a statement line and the context
is `fs_statement_composition`; the reservation is `ai_assistant_reserve(p_line_id, p_action, …)`. A classification finding
cannot be sent through it without disguising the finding as a statement line, which would also misbind the freshness
check (composition hash) and the spending record. **Do not reuse it.**

**The three actions assessed.** "Explain this more simply" — useful only if it rewrites the deterministic facts/possibility/
judgement text at a lower reading level; low risk, low value, and must not add claims. "What evidence should I check?" —
the deterministic page already names the evidence per rule; an AI answer would add value only with the chart of accounts
and documents as context, which are untrusted data. "Help me describe my reasoning" — highest risk: it is the one most
likely to produce fabricated evidence ("checked against the register") and must never prefill the reason box.

**Contract for a future `assistant-explain-finding` (server):**
- Request: `{ action: "explain_simply" | "evidence_to_check" | "reasoning_outline", companyId, periodYear, findingId, requestId }`
  — identifiers only; no account text, no user prose.
- Server: `validateAuth`; the finding read with the PERSON's token (`close_review_findings` RLS) from the CURRENT run only
  (`close_review_findings_summary` state `current` and `run_id` match; otherwise `STALE_CONTEXT`); context = the finding row's
  structured fields plus `RULE_WORDS`-equivalent server text; account name and any document text are quoted as data inside a
  delimited block and the model is told they are untrusted; tenant isolation by RLS on the read and `company_id` on the
  reservation.
- Freshness binding: the answer carries the `run_id` and the finding's `id`; the page shows it only while the current run
  is that run (re-check → the answer is withdrawn, not re-shown).
- Spending: `ai_assistant_reserve` / `ai_assistant_complete` as today (needs a new `p_subject` kind or a new reserve
  function — a migration, with `ai_assistant_runs` proof); disabled by default at every layer; explicit click only; no
  request on page load; existing budget, unknown-cost-at-ceiling and idempotency rules apply.
- Output: advisory text only; the server strips or refuses anything that names a classification to apply, a status to set,
  or evidence as checked; "reasoning_outline" returns an outline the person copies by hand — never written into the reason
  field by the page.
- Evaluation before enabling: an accountant-labelled set with adversarial account names and documents (prompt injection,
  fabricated evidence), measured for refusal and for absence of verdicts; recorded with the release.
- Fallbacks: disabled, unavailable, out of budget, refused or stale → the deterministic page is complete (this candidate's
  tests assert the journey has no AI dependency).

No button for any of this ships in this candidate.

## 7. Hosted installation requirements

None for this candidate (frontend only). Note for the owner: the pages this touches are behind the financial-statements
rollout (`ReportingAccessGate`, allow-list + master switch) exactly as before.
