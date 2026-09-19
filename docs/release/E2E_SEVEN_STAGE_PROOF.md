# Seven-stage browser proof (local, non-production)

What this is: the real workspace UI, driven in a real browser, talking through the real TypeScript transport to a
**disposable PostgreSQL 16** that replays every repository migration, through the loopback bridge
(`scripts/db-proof/serve.mjs`). Identity is `LOCAL_SIMULATED_IDENTITY` — a simulated `auth.uid()` named by a header — **not GoTrue**.
It is **not** hosted acceptance (`HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT`). The harness banner says so on the page.

The seven stages are **Sources, Structure, Statements, Notes & Policies, Validate, Professional Review, Final Outputs**
(`WORKSPACE_STAGES`). Scenario `multicash`: six cash accounts (bank, mobile money, cash on hand, a donor-restricted account, an ECL
allowance, an overdraft), a comparative year, a budget, notes and policies.

## How it is run (repeatable)

```
DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> DB_PROOF_SEED_FILE=<file> node scripts/db-proof/serve.mjs   # fresh DB
npx vite --host 127.0.0.1 --port 8181                                                                              # dev server (harness only)
```

Open `http://127.0.0.1:8181/dev-harness/financial-statements.html?scenario=multicash&bridge=http://127.0.0.1:54999&as=<user>&company=A`
and run the phases of `dev-harness/e2e/phases.mjs` (each drives the UI through its own controls and returns named pass/fail checks
with the observed detail). Identities: `preparer`, `partner`, `viewer` (members of company A), `outsider` (no membership), `ownerB`
(owner of company B, not a member of A), and company B itself (`company=B`, never allow-listed). The viewport is the desktop pane, then
375 × 812 for the mobile sweep. Phase order and what each asserts:

| Phase (identity) | Asserted |
|---|---|
| `preparerBuildsAndSaves` (preparer) | six CSV evidence files accepted with no diagnostics through the panel (cash account map; current and comparative cash ledgers; current and comparative equity movements; notes and policies); statement set complete; no blocking or insufficient-evidence finding; first save = version 1; the header and print show **Version 1**; server readiness "ready"; a preparer's Reviewed is refused by the server (`FORBIDDEN`); **direct RPC** `fs_set_publication_state` refused for preparer, viewer, outsider and the other company's owner |
| `partnerPublishesV1` (partner) | reload restores version 1; Reviewed then Final accepted; five exports all named `…-v1.…`; canonical, evidence and audit JSON carry the **same lineage** (report id, version, content hash, evaluation run); CSV exports carry the lineage tag |
| `partnerAddsXlsxBudget` (partner) | an `.xlsx` cannot be added until a sheet is chosen; the hidden sheet is labelled and disclosed (`OTHER_HIDDEN_SHEETS`); the **same budget as CSV converges on the same identity** (exact replay); the new evidence is a new version (2); the budget comparison is shown from the report; Reviewed then Final on version 2; version 1 opens read-only under its own number and state (`FINAL`), with no Save, no readiness of the latest, no correction controls |
| `secondSessionCorrects` (tab 2, preparer) | two evidence corrections, saved once, land as contiguous versions 3 and 4 in one atomic group |
| `partnerHitsStaleConflict` (tab 1, partner, still at v2) | the stale save is **refused before any write**, naming both versions ("server is at version 4, this session last saw 2"); the server still holds exactly versions 1–4; discard-and-reload restores version 4 with the corrected evidence in use |
| `partnerPublishesCorrected` (partner) | version 4 accepted as Reviewed, then Final |
| `roleMatrix` viewer / outsider / other-company owner / company B | a viewer sees the saved report, has no Save, and the server refuses an attempted save (nothing written); an outsider and the other company's owner get "Read-only", no saved versions, no publication controls, and **zero rows** through the API; company B shows the honest "Saving is not enabled for this company" |
| `incompleteRefusal` (partner) | a source change that no longer reproduces version 4 says so and starts fresh; saving creates version 5; the server lists the unmet requirements (`MISSING_STATEMENT:…`, `REQUIRED_EVIDENCE_MISSING:…`, `CASHFLOW_LEDGER_AUTHORITY_MISSING`, `DISCLOSURE_CHECKLIST_INCOMPLETE:…`); the UI disables Reviewed/Final; **direct RPC** Reviewed and Final on it → `PT409 BLOCKED`; a Final version cannot be changed |
| `mobileSweep` (375 px) | no horizontal page scroll and no element escaping a scroller, on each of the seven stages |
| keyboard (`tabState`) | the stage tabs use a roving tabindex: ArrowRight/ArrowLeft/Home/End move both selection and focus; the panel is focusable |

The observed results of the final run are recorded in the pull-request description, tied to the exact pushed commit.

## Defects the browser proof found (fixed, each covered by a test)

* **Evidence at another scale than the statements crashed the whole workspace** (`MoneyDenominationMismatchError` during render). It is now
  excluded, with the reason shown, and never combined (`cashPerimeter.test.ts`).
* **A single-row account's ledger-movement fact collided with the cash-flow line built from the same row**, raising a false
  duplicate-fact finding. Aggregates are now computed facts with a derivation (`cashPerimeter.test.ts`, mutation-checked).
* **A historical view showed the working draft's report state and checklist** ("no state recorded", "Missing — evidence required" beside a
  Final version 4). It now shows its own state and the checklist stored in that version (`honestDraft.test.ts`, `persistedAuthority.test.ts`).
* Earlier passes: a save with new evidence wrote no report version; reopening refused a version when newer evidence existed; save status
  stayed "Conflict" after a reload; a `<div>` inside a `<p>`.

## Not covered by this proof

Print-preview page numbering (Chromium margin boxes); a real GoTrue session; any hosted project; load. A viewer is offered a Save that the
server then refuses. See the release package's known limitations.
