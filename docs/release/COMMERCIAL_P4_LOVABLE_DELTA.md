# Delta for Lovable: commercial-p4 (payment reversal authority), superseding the Snippe readiness package

**This package supersedes `handoff-snippe-tz-readiness-20261011` (release `735903b`).** Its release commit contains everything in that one, plus the reversal fix.
- **Do not deploy or Publish from the older package, before or after this one.** Its Edge Functions predate the change to `settle.ts`. Deploying them after this release would put the old reversal handling back.
- If the older package was already deployed, nothing is lost: this one replaces the same four functions.

Hosted state recorded in the repository: commercial-p3 is applied as drizzle `0053` (hosted id 54).

This release brings:
- **one migration batch**, `commercial-p4`;
- **four Edge Function deploys**;
- **one Publish**.

Snippe customer checkout stays **disabled**. Nothing here enables a payment route, approves a price, refunds or charges anyone.

**Rules:**
- Every changing step needs the owner's authorisation, **by step number**. Read-only steps report exactly what they show.
- Leave `commercial_platform_state` as it is. Set, change or read no `SNIPPE_*` secret. Change no Polar setting.
- Never edit a wrapper. Never delete or edit a payment, licence or audit row.
- **Do not repair historical discrepancies.** Report them only.

## P4-1. Read the state (read-only)

```sql
SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) AS journal_rows,
       to_regprocedure('public._record_payment_reversal_core(uuid,text,text,text,bigint,text,text,text,text,uuid,jsonb)') IS NOT NULL AS p4_applied;
```

Expect `journal_rows = 54` and `p4_applied = false`.

Then run `release/commercial-p4/purchasing_gate.sql` and paste the whole output. It must report `PURCHASING GATE OK`, which proves three independent things:
1. `commercial_platform_state` is `PAYMENTS_DISABLED`;
2. **no** TZS or TZ offer is purchasable, checked regardless of the platform state;
3. the public price list carries no TZS or TZ price.

**Historical offers are not purchasing authority.** The gate **lists** every TZS or TZ row and changes none. The two known legacy rows are expected, and are left exactly as they are:
- `95dc943c-9d5e-433f-906c-5528bd0302cd` `SANDBOX-TEST-PAID-TZ`;
- `68d35bb6-1663-4045-910e-97c983cee690` `SANDBOX-TEST-PAID-GLOBAL`.

Both are under the legacy plan `PAID`, active and **not** purchasable. Keep each row's `row_md5` from this output for P4-7.

Also, signed in, `GET commercial-create-checkout?planCode=SOLO` must show `MOBILE_MONEY` as unavailable.

If any check fails, stop and report. Never delete, deactivate or edit an offer to make the gate pass.

## P4-2. Preflight (read-only)

Run `release/commercial-p4/preflight.sql` and paste the **whole** output:
1. every existing reversal;
2. the **historical discrepancies**, meaning existing reversals the new rules would refuse;
3. the counts and digests to compare after.

## P4-3. Apply *(owner authorisation)*

Apply `release/wrappers/20261101100000_payment_reversal_authority.wrapper.sql` **byte for byte**. Its size and SHA-256 are in `RELEASE.txt`.
- It checks its own size and hash before running anything, and refuses unless commercial-p3 is applied.
- On any error, report it verbatim and stop. The journal must still read 54, and do not continue to P4-5.
- On success, the journal reads **55**.

## P4-4. Postcondition (read-only)

Run `release/commercial-p4/postcondition.sql`.
- It must report `POSTCONDITION OK.`
- Section 1 must list the **same** discrepancies as the preflight.
- Section 2's counts and digests must be **identical** to the preflight's: the migration writes no row.

## P4-5. Deploy *(owner authorisation; only after P4-4 passed)*

Deploy exactly these four Edge Functions from the release commit. Their files and SHA-256 are in `release/FUNCTIONS_MANIFEST.json`.
- `commercial-create-checkout`
- `commercial-payment-status`
- `commercial-webhook-polar`
- `commercial-webhook-snippe`

Do not set any secret.

## P4-6. Publish *(owner authorisation; only after P4-4 passed)*

Publish the release commit. The admin "Refunds and disputes" buttons now read "End the licence now" and "Keep the licence". "End the licence now" really ends access: that is why this Publish comes after the migration.

## P4-7. Confirm (read-only)

- Re-run the P4-1 query: expect `journal_rows = 55` and `p4_applied = true`.
- Re-run `release/commercial-p4/purchasing_gate.sql`: it must report `PURCHASING GATE OK` again, and every listed row's `row_md5` must equal P4-1's.
- Signed in, `GET commercial-create-checkout?planCode=SOLO` must still show `MOBILE_MONEY` as unavailable, with the card option unchanged. This is the deployed code's `SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false`, checked independently of the database.

## After

An administrator can now **record** a Snippe refund that was **already completed outside CFOClose**, with `admin_record_provider_refund` (`PAYMENT_REVERSAL_AUTHORITY.md` §5). It issues no refund and contacts no one. There is nothing to record while Snippe is disabled. Whether Snippe can refund at all is unconfirmed.
