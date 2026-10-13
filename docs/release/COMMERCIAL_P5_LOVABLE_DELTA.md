# Delta for Lovable: commercial-p5 (verified charge outcomes)

**This is a delta.** It follows commercial-p4, which is applied as drizzle `0054` (hosted id 55).

**This package supersedes every earlier deploy or Publish source.**

**What "supersedes" means here, and what it does not:**
- **It includes the earlier application changes.** The release commit's frontend and Edge Function code contains everything from the business-email release (`004a055`), `handoff-commercial-p4r-20261012` and every earlier package.
- **It replaces their deployment instructions.** Publish and deploy only from this release commit. Using an older package's build after it would undo part of it.
- **It does NOT repeat any migration.** commercial-p4 and everything before it are already applied on the hosted database and stay applied. The only migration in this delta is `20261102100000` (commercial-p5). The package carries only that wrapper. No earlier wrapper, preflight or postcondition is to be run again.

If the business-email release has not been published yet, publishing this release commit publishes it too.

This release brings:
- **one migration batch**, `commercial-p5`;
- **three Edge Function deploys**: the shared settlement code changed;
- **one Publish**: the admin page gains "Charges needing a decision".

Payments, prices and Snippe stay exactly as they are. Nothing here charges, refunds or activates anyone.

**Rules:**
- Every changing step needs the owner's authorisation, **by step number**. Read-only steps report exactly what they show.
- Leave `commercial_platform_state` as it is. Set no secret. Never edit a wrapper.
- Never delete or edit a payment, intent, licence or audit row.

## P5-1. Read the state (read-only)

```sql
SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) AS journal_rows,
       to_regclass('public.payment_recovery_cases') IS NOT NULL AS p5_applied,
       (SELECT state FROM public.commercial_platform_state WHERE id = true) AS platform_state;
```

Expect `journal_rows = 55` and `p5_applied = false`. Record `platform_state`: it must be unchanged at the end.

## P5-2. Preflight (read-only)

Run `release/commercial-p5/preflight.sql` and paste the **whole** output:
1. **exposure:** intents CFOClose closed with no provider-reported outcome while a provider session existed;
2. **historical dropped charges** (1b): webhook deliveries answered `DUPLICATE` whose provider transaction has no payment event. **Report them; do not act on them.** This release does not record them; each needs a separate, owner-approved decision.
3. the digests to compare after.

## P5-3. Apply *(owner authorisation)*

Apply `release/wrappers/20261102100000_verified_charge_outcomes.wrapper.sql` **byte for byte**. Its size and SHA-256 are in `RELEASE.txt`.
- On any error, report it verbatim and stop. The journal must still read 55.
- On success, it reads **56**.

## P5-4. Postcondition (read-only)

Run `release/commercial-p5/postcondition.sql`.
- It must report `POSTCONDITION OK.`
- Every digest must be **identical** to the preflight's: the migration writes no row.

## P5-5. Deploy *(owner authorisation; only after P5-4 passed)*

Deploy exactly these Edge Functions from the release commit. Their files and hashes are in `release/FUNCTIONS_MANIFEST.json`.
- `commercial-payment-status`
- `commercial-webhook-polar`
- `commercial-webhook-snippe`

## P5-6. Publish *(owner authorisation; only after P5-4 passed)*

Publish the release commit.

## P5-7. Confirm (read-only)

- Re-run P5-1: expect `journal_rows = 56`, `p5_applied = true`, and `platform_state` unchanged.
- `/commercial/admin` shows "Charges needing a decision", with none waiting.
- The signed-in checkout read still shows `MOBILE_MONEY` as unavailable, with the card option unchanged.
