# Delta for Lovable: commercial-p3 (sandbox licence isolation)

**This is a delta.** It adds only what is new since `handoff-commercial-closure-20261010` (release `9ac3456`). Everything else in `COMMERCIAL_LAUNCH_LOVABLE_CHECKLIST.md` stands.
- Hosted state already recorded in the repository: r5, c1, p1 and p2 are applied (drizzle `0046`–`0052`).
- New: **one migration batch**, `commercial-p3`, and **one Publish**.
- **No Edge Function changes**, so nothing needs to be deployed.

**Rules:** the same as the main checklist.
- Every changing step needs the owner's authorisation, **by step number**. Read-only steps report exactly what they show.
- **Payments stay `PAYMENTS_DISABLED` throughout.** Do not open any payment state under this delta.
- Never delete a licence, payment or audit row. Never edit a wrapper.

## P3-1. Read the state (read-only)

```sql
SELECT (SELECT state FROM public.commercial_platform_state WHERE id = true) AS platform_state,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='commercial_licences' AND column_name='provenance') AS p3_applied;
SELECT id, status, source, effective_start, effective_end FROM public.commercial_licences WHERE id = 'ba803893-8116-454f-bea2-0f2a7c7f2603';
```

- If `p3_applied` is `true`, skip to **P3-4**.
- If `platform_state` is not `PAYMENTS_DISABLED`, stop and ask the owner to authorise setting it. Use `/commercial/admin` → **Online payment** → `PAYMENTS_DISABLED`, with a reason. The migration refuses to run otherwise.

## P3-2. Preflight (read-only)

Run `release/commercial-p3/preflight.sql` and paste the **whole** output. It shows, before anything is written:
1. the provenance every licence will get, and which will be contained (`SANDBOX_PAYMENT (WILL BE CONTAINED)`) or listed for review (`REVIEW_REQUIRED`);
2. licence `ba803893-…` with its checkout intent's environment;
3. any genuine term that a sandbox payment ended;
4. the counts and digests to compare after.

## P3-3. Apply *(owner authorisation)*

Apply `release/wrappers/20261031100000_sandbox_licence_isolation.wrapper.sql` **byte for byte**: 50,109 bytes, SHA-256 `36bd80c0950a17d79586cd907b839e33529563ef51f222230bc83f1f17d4baa0`. It checks its own size and hash before running anything, and refuses unless p2 is applied and payments are disabled.

## P3-4. Postcondition (read-only)

Run `release/commercial-p3/postcondition.sql`.
- It must report `POSTCONDITION OK.`
- Its section-4 counts must equal the preflight's: `licences`, `licence_terms_md5`, `intents` and `payment_events`. `audit_events` grows by exactly the number of contained licences.
- Paste its listing:
  - provenance by status;
  - licence `ba803893-…`, which should be `SANDBOX` / `SANDBOX_PAYMENT` if the preflight showed it as sandbox;
  - any `REVIEW_REQUIRED` rows;
  - any term to restore.

## P3-5. Review and containment *(owner authorisation per row; skip if P3-4 listed none)*

Follow `SANDBOX_LICENCE_ISOLATION.md` §5:
- **`REVIEW_REQUIRED` rows:** for each, check the provider's own dashboard. Then resolve it **once**, with a reason, using `admin_resolve_licence_provenance` (production, sandbox or manual).
  - Licence `ba803893-…`, if listed here, is resolved as `SANDBOX_PAYMENT`.
- **Terms ended by a sandbox upgrade:** restore each with `admin_restore_term_ended_by_sandbox`. It restores the end recorded by the term's own grant, once, audited, and refuses if the term has changed since.

Re-run the postcondition: it must still read `POSTCONDITION OK.` Resolve every row before any payment state is opened again.

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
