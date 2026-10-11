# Delta for Lovable: commercial-p3 (sandbox licence isolation), corrected submission

**This is a delta, and it restarts commercial-p3 at P3-1.** It replaces the earlier p3 instruction (`handoff-commercial-p3-20261011`). Everything else in `COMMERCIAL_LAUNCH_LOVABLE_CHECKLIST.md` stands.
- Hosted state already recorded in the repository: r5, c1, p1 and p2 are applied (drizzle `0046`–`0052`). The hosted journal head is **53**.
- The earlier p3 wrapper, `20261031100000_sandbox_licence_isolation.wrapper.sql` (50,109 B, SHA-256 `36bd80c0…4baa0`), was submitted once and **failed atomically** with `PT422 CANCELLED_LICENCE_IMMUTABLE`. Nothing was written, and the journal stayed at 53.
- **Never submit that wrapper again.** It is superseded and kept only as a record in `release/wrappers_historical/`. It is not a registered form, so a journal entry for it would fail the repository's migration-authority guard.
- New: **one migration batch**, `commercial-p3`, with the replacement wrapper `20261031110000_sandbox_licence_isolation.wrapper.sql`, and **one Publish**.
- **No Edge Function changes**, so nothing needs to be deployed.

**Rules:** the same as the main checklist.
- Every changing step needs the owner's authorisation, **by step number**. Read-only steps report exactly what they show.
- **Payments stay `PAYMENTS_DISABLED` throughout.** Do not open any payment state under this delta.
- Never delete a licence, payment or audit row. Never edit a wrapper. Never repair data directly or disable a trigger.

## P3-1. Read the state (read-only)

```sql
SELECT (SELECT state FROM public.commercial_platform_state WHERE id = true) AS platform_state,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='commercial_licences' AND column_name='provenance') AS p3_applied,
       (SELECT count(*) FROM drizzle.__drizzle_migrations) AS journal_rows;
SELECT id, status, source, effective_start, effective_end FROM public.commercial_licences WHERE id = 'ba803893-8116-454f-bea2-0f2a7c7f2603';
```

- Expected: `p3_applied` is `false` and `journal_rows` is `53`.
- If `p3_applied` is `true` or `journal_rows` is not 53, **stop and report**. Do not continue.
- If `platform_state` is not `PAYMENTS_DISABLED`, stop and ask the owner to authorise setting it. Use `/commercial/admin` → **Online payment** → `PAYMENTS_DISABLED`, with a reason. The migration refuses to run otherwise.

## P3-2. Preflight (read-only)

Run `release/commercial-p3/preflight.sql`, the corrected version in this package, and paste the **whole** output. It shows, before anything is written:
1. the provenance every licence will get:
   - `SANDBOX_PAYMENT (WILL BE CONTAINED)`;
   - `SANDBOX_PAYMENT (STAYS CANCELLED; PROVENANCE RECORDED)`, for a sandbox licence that is already cancelled;
   - `REVIEW_REQUIRED`;
2. licence `ba803893-…` with its checkout intent's environment;
3. any genuine term that a sandbox payment ended;
4. the counts and digests to compare after.

## P3-3. Apply *(owner authorisation)*

Apply `release/wrappers/20261031110000_sandbox_licence_isolation.wrapper.sql` **byte for byte**: **54,295 bytes, SHA-256 `12a7e92421978e3c4bf2aaa939021558762c1ec47cf69baf703c0ee660adae83`**.
- It checks its own size and hash before running anything, and refuses unless p2 is applied and payments are disabled.
- It is one statement: on any error nothing changes, and the journal must stay at 53. Report the error verbatim and stop.
- On success the journal has **54** rows.

## P3-4. Postcondition (read-only)

Run `release/commercial-p3/postcondition.sql`, the corrected version in this package, and paste the **whole** output. Report it in two separate parts.

**Part 1: containment.** This is the migration's result, and it must be complete. The DO block must report `POSTCONDITION OK.` It proves, on the live data:
- **A3:** for every account holding a sandbox licence, the live access functions report a plan, company capacity and named-user seats only from a non-sandbox current term, or none at all. The active sandbox licence no longer grants anything.
- **A4:** every cancelled sandbox licence is still `CANCELLED`, with the account, source and dates it was cancelled with. Its cancellation record is intact.
- **A5:** no continuation term exists unless it restores a term proven genuine, to the end that term's own grant record states. Right after the migration there are none.
- **A2:** every sandbox licence has its audit row.
- **A6:** payments are still disabled.

Then compare **PART B** with the preflight's section 4. These five values must be **identical**: `licence_terms_md5`, `cancelled_licences_md5`, `intents_md5`, `payment_events_md5` and `audit_history_md5`. Together they show that no licence term, cancelled licence, checkout, payment or earlier audit row changed. Also paste PART C1:
- provenance by status;
- licence `ba803893-…`;
- each sandbox licence with the plan, company capacity and seats its account has now.

**Part 2: owner decisions still open.** These are **not** a failure of containment. PART C2 lists them:
- licences still `REVIEW_REQUIRED`;
- terms a sandbox payment ended, each with its `next_step`, for example `RESTORABLE …` or `OWNER DECISION: …`.

Report them as open decisions. Do not resolve or restore anything at this step.

## P3-5. Review and restoration *(owner authorisation per row; skip if P3-4 listed none)*

Follow `SANDBOX_LICENCE_ISOLATION.md` §5:
- **`REVIEW_REQUIRED` rows:** for each, check the provider's own dashboard. Then resolve it **once**, with a reason, using `admin_resolve_licence_provenance` (production, sandbox or manual).
  - A row reviewed as sandbox is contained at once. A cancelled one stays `CANCELLED`.
  - Licence `ba803893-…`, if listed here, is resolved as `SANDBOX_PAYMENT`.
- **Terms ended by a sandbox upgrade:** call `admin_restore_term_ended_by_sandbox` once for each term.
  - It **adds a continuation term**, to the end recorded by the term's own grant. The original licence is never changed.
  - It refuses a term whose environment is unproven. Review a `REVIEW_REQUIRED` licence first.
  - It also refuses a term that has changed since, a term with no recorded grant end, an end already past, an overlap, and a second restore.
  - Report any refusal verbatim. **Do not work around it**: an unrecorded original end is the owner's decision, not a repair.

Re-run the postcondition. It must still read `POSTCONDITION OK.`, and `intents_md5` and `payment_events_md5` must still equal the preflight. Review actions add audit rows of their own, so `audit_history_md5` may change only by those. Any row that stays open in PART C2 remains an owner decision: report it, and keep payments disabled until the owner has decided every row.

## P3-6. Publish *(owner authorisation)*

Publish from the release commit named in `RELEASE.txt`. The new frontend:
- shows a test payment as **"Test payment received · No plan was activated"**;
- lists a test order on **Orders** as **"Test payment · no access"**.

## Changed expectation for the later sandbox stage (main checklist, Stage D)

A sandbox purchase is now recorded but **never activates a plan**:
- the status page reads "Test payment received" and "No plan was activated";
- Orders reads "Test payment · no access";
- the buyer's account has no plan;
- `get_my_billing_summary` returns no licence status.

That is the correct, passing result. "Plan active for 12 months" now appears **only** for production payments, which come in Stage E.
