# 12 — FS reconciliation (pinned) + ranked correction plan

Isolated reconciliation lane. Read-only. **No FS activation, hosted change, broad rewrite, or
automatic implementation.** Pinned verification commit: **`origin/main` `02c516a`**. The TB
refusal/restore verification (#151/#153/#157) stays in its own lane and is not revisited here.

Evidence grades: **SOURCE** (in code/schema) · **REACHABLE** (an authenticated caller can reach it;
for Edge Functions "no UI" is *not* a boundary) · **EXECUTED** (a named test/proof ran) · **HOSTED-
UNKNOWN** (deploy/apply/live-RLS state not determinable from the repo).

## P0 — client-data exposure (tracked privately; not detailed here)
A P0 client-data exposure finding is recorded in a **private** incident record kept **outside this
repository** (no figures, no specifics in any public artifact). It is the **top-ranked action** below.
Its containment is staged and owner-gated. Deliberately not described further in this public document
so as not to signpost it; see the private record for provenance, affected files and the containment
steps.

## Reconciliation of the critical FS claims (against `02c516a`)

| # | Claim | Verdict | Grade | Evidence |
|---|---|---|---|---|
| 1 | SCF server-composed? | **No** — evidence-gated only; face only in disabled World B; cash tie is **presence-based** at sign-off | SOURCE | `composition.ts:34` (enum SFP/SCI); `20261018100000:22`; gate `20261019100000:487-491`; `financialGeneration/cashFlowDirect.ts`; blockers `20261021100000:161-172,276-279` |
| 2 | SOCIE server-composed? | **No** — evidence-gated only; face only in disabled World B | SOURCE | `composition.ts:34`; `20261019100000:483-486`; `financialGeneration/equityStatement.ts` |
| 3 | Evidence-dependency binding of REVIEWED/FINAL | **Yes** — SHA-bound (composition+notes+comparative), stale-input invalidates via blocker **and** trigger | SOURCE + **EXECUTED** | `20261021100000:28-71,243-266,303-327`; proof `scripts/db-proof/signoffBinding.mjs:125-170` |
| 4 | Any unsupported publication path to FINAL? | **No** — `fs_set_publication_state` hard-blocks on non-empty `fs_publication_blockers` (folds SCF/SOCIE evidence-missing, `REPORTING_CASE_UNSUPPORTED`, `REQUIREMENT_UNDECIDED`); required_statement_types incl. SOCIE+SCF | SOURCE + **EXECUTED** | `20260925140000:920-924`; `20260919110000:258`; `20261021100000:122-146`; proof `scripts/db-proof/reportingClosure.mjs:74-93,177-188` |
| 5 | Disclosure coverage | All 50 seeded requirements `blocking=true`; granular enforcement is **transitive via the TB-derived/IFRS-SME dependency path** — complete for the composed SMES path; a non-TB/non-SMES document would hit only the coarse `disclosure_area_ids` checklist | SOURCE | `20261019100000:45-94`; `ifrsForSmes.ts:69-139`; `20261021100000:243-266` |
| 6 | Edition handling | By period **start**, **no default**; early-application only with recorded confirmation. **Correction:** ≥2027 **resolves to the mandatory 2025 edition (not refused)**; `EDITION_UNSUPPORTED` is the **pre-2017** case | SOURCE | `editionPolicy.ts:37-47`; `ifrsForSmes.ts:4-6` |
| 7 | Gate topology | 3 gates: two **frontend-only** constants (bundle/render, write — both false) + one server-backed per-company route guard. **None shields the server RPCs** — if deployed, `fs_*` RPCs are reachable by authenticated POST, gated only by capability + RLS. `persistenceGate` comment ("no DB/Edge Function here") is **stale** vs this pin | SOURCE + **REACHABLE** + HOSTED-UNKNOWN | `workspaceGate.ts:21`; `persistenceGate.ts`; `ReportingAccessGate.tsx`; grants `20260919110000:1249`; capability `20260925140000:905-907` |
| 8 | Sign-off policy | FS reporting layer signs off via `financial_statement_publications`/`fs_set_publication_state` (`review_close`→REVIEWED, `approve_certification`→FINAL) + `fs_publication_bindings` — **not** `statement_sign_offs`. The legacy table's RLS **was hardened** (`20260925140000:1948-1972`) to `approve_certification` + SoD; the role-less `hesabu` trigger now guards only the preparer tier | SOURCE + **EXECUTED** | `signoff.ts`; `reportingClosure.mjs:194-213`; `20260925140000:1948-1972`; `20260713000000:32-99` |
| 9 | Deployed AI endpoints (control boundary) | All three reachable-if-deployed by authenticated POST. **`policy-compass` is `verify_jwt=false`** (platform JWT off; only a self-rolled token check) with **no tenant/company authz**, relaying caller-supplied `financialData` to Gemini. `maono-decide`/`-root-cause` require a JWT, derive company via RLS + a `CLOSE_INSIGHTS` entitlement, **no explicit `assertCompanyMembership`**, and send real variance data to Anthropic | SOURCE + REACHABLE; deploy HOSTED-UNKNOWN | `config.toml:14-15`; `policy-compass/index.ts:12-70,107,165-176`; `maono-decide/index.ts:199-223,341`; `maono-root-cause/index.ts:127-150,196` |

## Corrections applied to design 11 (this commit)
- **Edition:** ≥2027 resolves to the mandatory 2025 edition (not "refused/UNSUPPORTED"); pre-2017 is `EDITION_UNSUPPORTED`; the real gap is transition/first-time-adoption reliefs. (§B.4, scenario 8, top banner.)
- **"Gated off" scoped to the frontend;** server RPC surface is reachable-if-deployed (capability+RLS-gated). (Top banner + §A note.)
- **Sign-off path** = `financial_statement_publications`/`fs_set_publication_state`, not `statement_sign_offs`; legacy table hardened. (Top banner.)
- **SCF/SOCIE** evidence-gated, faces in disabled World B; SCF cash tie presence-based at sign-off. (Already in §E.0; banner reinforces.)
- **Evidence binding** strengthened with the `fs_bind_publication` trigger + executed proof `signoffBinding.mjs`.

Corrections also apply to earlier docs (do not re-assert the old wording): **`01-ai-inventory`'s
"unrouted/DISABLED/unreachable" framing for the AI endpoints is wrong** — they are reachable-if-deployed;
the control boundary is auth/entitlement/RLS, not UI routing. **`00` C-1** is refined: the legacy
`statement_sign_offs` RLS is hardened on this pin, and it is not the FS reporting-layer path.

## Ranked correction plan (with acceptance proofs)
Each item: owner-gated where noted; **no auto-implementation**. Acceptance = an **executed** proof.

1. **[P0] Contain the client-data exposure** (specifics in the private incident record). *Action:*
   (a, owner) reduce public reachability; (b) forward synthetic-data replacement PR (structurally
   identical, renamed, importers updated); (c, gated) history purge + notification only by separate
   agreement. *Acceptance (verified against the private record):* no real client data on HEAD; the
   affected tests pass on synthetic data; no figures in any public artifact/comment. *Do NOT* rewrite
   history/force-push/notify without sign-off.
2. **[HIGH, control] `policy-compass` edge exposure.** `verify_jwt=false` + no tenant authz + external-
   model egress of caller content. *Action (proposal):* remove `verify_jwt=false` **or** add explicit
   workspace authorization + an allow-list, and bound what may be sent to the model. *Acceptance:* a
   test that an authenticated non-member (and an anonymous caller) is refused; config shows JWT
   verification on or an explicit documented exception. *(Deploy state HOSTED-UNKNOWN — confirm with the owner.)*
3. **[HIGH, control] MAONO endpoints lack explicit membership assertion.** *Action (proposal):* add
   `assertCompanyMembership` as defence-in-depth alongside RLS + `CLOSE_INSIGHTS`. *Acceptance:* a
   db-proof that a valid-JWT non-member is refused even with RLS deliberately loosened in the test.
4. **[MED, design] Design-11 factual corrections.** *Status:* **applied this commit** (edition, gate
   topology, sign-off path, SCF tie, evidence-binding proof). *Acceptance:* doc 11 contains no
   "2027→refused", no "composes SCF/SOCIE", no "statement_sign_offs is the FS path" wording. (Met.)
5. **[MED, completion] SCF + SOCIE face composition on the reporting layer.** The honest build gap
   (faces exist only in disabled World B). *Action:* Slice-1 (C) completion — compose both faces from
   their evidence families; tie SCF opening+movement=closing to SFP cash **server-side** (not only
   presence). *Acceptance:* executed composition proofs for SOCIE and SCF with independently-reviewed
   numbers; a server tie refusing a broken rollforward. *(No activation; proof on a disposable stack.)*
6. **[LOW, hygiene] Stale `persistenceGate` comment** ("no DB schema / Edge Function on this branch")
   contradicts the pin. *Action:* correct the comment. *Acceptance:* comment matches reality.

## Ownership
- **Implementation owner: NORMAL** — production code / Edge Functions / migrations / fixtures; executes
  items 1(b), 2, 3, 5, 6 only on explicit owner authorisation (and items 1a/1c are the repo owner's).
- **Independent reviewer: BLACK** (this lane) — verifies each acceptance proof against a pinned commit,
  read-only; does not implement.
- Items are independently verifiable; none enables FS, changes hosted state, or implements the others
  automatically. The P0 containment precedes the rest.
