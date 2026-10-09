# Reporting r2: sign-off readiness correction (DEFECT D-2)

**Defect.** Hosted acceptance r1, step J4. Release `0693d93`; demo company `659daa94-116c-4803-99f8-157e0bdd4c62`.

- The Sign-off page showed "The reporting state could not be read".
- `POST /rest/v1/rpc/fs_report_readiness` returned `25006 cannot execute CREATE TABLE in a read-only transaction`.
- **Why:** `fs_report_readiness` was declared STABLE, so PostgREST ran it in a READ ONLY transaction. Its check
  composes the statements it binds (`fs_publication_blockers → fs_reporting_dependencies → fs_statement_composition`),
  and composition uses a temporary table.

**Correction.** `supabase/migrations/20261023100000_fs_report_readiness_volatility.sql` does one thing: it declares the
function VOLATILE. PostgREST then runs the client's `POST /rpc` in an ordinary read-write transaction.

- **Unchanged:** the body, owner, ACL, SECURITY DEFINER, `search_path`, the sign-off gate (`fs_publication_blockers`)
  and the binding trigger. All are asserted by the hosted pre/postcondition, using pinned body hashes.
- **Writes nothing persistent:** a readiness read still returns `{ready, blockers}` for one saved version.
- **Not a read-only fix:** VOLATILE does **not** make the temporary table work inside an explicitly read-only
  transaction. That still fails, and the proof asserts it. The fix works because PostgREST no longer opens one.

**Frontend:** unchanged. The published `0693d93` frontend stays; no publish is needed for this correction.

**Proof** (CI, real PostgreSQL): `scripts/db-proof/readinessReadOnly.mjs`. The transport runs calls as PostgREST does,
and the proof uses the exact hosted artifacts below. It shows:
- 25006 reproduced on two existing drafts;
- the preflight passes; the wrapper applies; the postcondition passes;
- re-applying the wrapper is refused;
- both drafts are byte-identical afterwards;
- after a schema reload, readiness names `CLOSE_REVIEW_FINDINGS_NOT_CHECKED`, and REVIEWED is refused;
- a readiness read writes nothing;
- Close Review → a new version → REVIEWED and FINAL by role;
- stale versions are refused by name;
- no other STABLE function the client can call writes.

## Hosted steps (Lovable). Nothing else.

| # | Step | Expected |
|---|---|---|
| 1 | Run `docs/release/reporting-r2/preflight.sql` (read-only). | `PREFLIGHT OK`, plus the demo company's saved versions. **Record those rows.** |
| 2 | Apply `release/wrappers/20261023100000_fs_report_readiness_volatility.wrapper.sql` as **one** migration, byte for byte (exactly its final LF removed is also accepted). | The migration succeeds. If it raises, nothing was changed: stop and report the message. |
| 3 | Run `docs/release/reporting-r2/postcondition.sql` (read-only). | `POSTCONDITION OK`. The saved-version rows are identical to step 1. |
| 4 | Run `NOTIFY pgrst, 'reload schema';` | PostgREST picks up the new volatility. Without this, the old read-only behaviour can persist until its next reload. |
| 5 | Sign in as the demo owner and open Sign-off for FY2025. | Readiness loads for versions 1 and 2, and each names "Close Review has not been checked for this trial balance". **No** "could not be read". |

Then resume acceptance **at J4 on the existing drafts**:
- no uploads, no setup, and no J1–J3;
- J11 stays NOT RUN without a genuine second account.

`ACCEPTANCE_R1_DEMO_SETUP.md` has the full step texts.

| # | Step | Expected |
|---|---|---|
| J4 | Sign-off: try to mark version 2 REVIEWED. | Refused, naming `CLOSE_REVIEW_FINDINGS_NOT_CHECKED`. |
| J5 | Close Review › Findings: run the check, then explain each finding. | No unresolved blocking finding. |
| J6 | Sign-off: "Save a new report version". Do not add evidence: the six files are already stored. | Version 3 shows "ready", with no blocker. Figures match `EXPECTED_TOTALS.csv`. |
| J7 | Mark version 3 REVIEWED (partner or manager), then FINAL (owner). | Both recorded. |
| J8 | Exports. | The FINAL seal shows the recorded approver and both hashes. **Download the PDF and the CSV.** |
| J9 | Notes: change the estimates wording, then open Sign-off. | Version 3 stays FINAL but shows `REPORTING_DEPENDENCIES_STALE`. Marking a stale version REVIEWED is refused. |
| J10 | A company the tester can access that is not enabled. | No reporting navigation; the reporting URLs show "unavailable". |

**Recovery.** The wrapper is atomic: a refusal or failure changes nothing.

- Do not revert to STABLE: that restores the defect.
- To stop reporting for the demo company, use `docs/release/sql/04_deactivate_company.sql`. For everyone, use
  `05_kill_switch.sql`.
- Never delete saved versions.

**After application.** Lovable's journal mirror of the wrapper lands in `drizzle/migrations/` (hosted entry 46). It is
then registered in a close-out, as for r1. Until then, `20261023100000` is listed as pending by the migration guards.
