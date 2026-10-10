# Commercial candidate (batch `commercial-c1`, PR #101)

Reporting stays a **pilot**: demo and allow-listed companies only. Its accounting is **not independently validated**. Nothing here was applied to the hosted database, deployed or published. Each hosted step is listed in `COMMERCIAL_C1_LOVABLE_CHECKLIST.md` and needs the owner's authorisation.

## 1. What changes

| Area | Change | Evidence |
|---|---|---|
| Sealed exports | A signed report's framework, edition and entity name come from its saved version, never from live company settings. Version 6 is preserved | `scripts/db-proof/signoffPolicy.mjs` "Sealed identity" group (24/24): company renamed, early application elected and framework changed, yet exports are byte-identical |
| Commercial offer | Software sold by agreement and activated manually; *Request activation* everywhere; no checkout. Specialist services (forecasting, budgeting, financial analysis, accounting policies, close support) are enquiries, not features. Financial reporting is a pilot | `landingPage.test.ts`, `publicClaimRegistry.test.ts`, `noCheckoutClaims` |
| Enquiries | Activation requests naming a catalogue plan; service-preselected forms; tracked staff replies with honest delivery status | `20261025100000`; `commercialEnquiries.mjs` 18/18 |
| One adjustment path | The Reconcile panel wrote and approved adjusting entries from the browser. That path is closed: client writes are revoked, history is read-only, and adjustments go through Close Review › Adjustments | `20261026100000`; `legacyAdjustmentsRetirement.mjs` 16/16 |
| Workspace purpose | Client, test or training, recorded append-only by the owner; the account home is grouped by company with period dates | `20261027100000`; `workspacePurpose.mjs` 17/17 |
| Periods | The launchpad's first period follows the company's stated year-end and currency, instead of calendar-year TZS | `20261028100000`; `periodFromCompany.mjs` 12/12 |
| Journey fixes | Consistent equation wording; prerequisite-aware next actions; readable requirement names; evidence collected on Statements with explicit states; comparatives recovery; file summary first; readable findings; no upload without an open engagement; evidence checked against recorded period dates | `COMMERCIAL_C1_SCREEN_TRACE.md`; unit tests; `reportingJourney.mjs` 20/20 |

## 2. Release order (owner-authorised, in Lovable)

1. Merge PR #101. Merging applies nothing.
2. `reporting-r5`: preflight → `20261024100000` wrapper → postcondition (`docs/release/reporting-r5/`).
3. `commercial-c1`: preflight → `20261025100000`, `20261026100000`, `20261027100000`, `20261028100000` wrappers, in that order → postcondition (`docs/release/commercial-c1/`).
4. Deploy `submit-service-enquiry` and `dispatch-enquiry-notifications`.
5. Publish the frontend, then verify the live build identity (checklist section A).

The frontend is safe before step 3:
- the account home reads workspace purpose fail-soft;
- Reconcile only reads;
- a workspace without the new period function keeps the legacy period.

## 3. Proofs and checks

- **Wrappers:** `selfCheckingWrappers.mjs` passes 107/107 for `commercial-c1` and 32/32 for `reporting-r5`. Both run in CI from the committed bytes.
- **Real application, end to end:** CI job `real-app-e2e`. It runs `supabase start` with real Auth, PostgREST, RLS, Storage and Edge Functions, and drives the production build in headless Chrome; see §4.
- **Release Gate:** frozen install, lint, typecheck, the full suite, build and pack isolation.

## 4. Real-application journey

See the PR's latest `real-app-evidence` artifact (`journey.log`, `results.json`, screenshots at 1280 and 375 px). The journey found and fixed three defects that isolated tests could not:
- the launchpad's calendar-year TZS period;
- uploads possible for an unopened period;
- a hidden table header overflowing phone screens.

## 5. Outside this release (explicit requirements)

- **Legal review** of the terms and privacy pages before any paid go-live.
- **Independent accounting validation** of the financial-reporting pilot.
- **Custom SMTP** and the enquiry email secrets; enrolment of staff and commercial administrators (`docs/operations/COMMERCIAL_ADMIN_GUIDE.md`).
- **Owner decisions:**
  - the comparative-period link (period_year − 1 today);
  - an in-app activation screen;
  - whether the two staff roles should differ in power.
