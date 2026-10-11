# Delta for Lovable: commercial-p4 (payment reversal authority)

**This is a delta.** It follows commercial-p3, which is applied as drizzle `0053` (hosted id 54).
- New: **one migration batch**, `commercial-p4`.
- New: **three Edge Function deploys**: the shared settlement code changed.
- New: **one Publish**: the admin screen's refund buttons changed.
- Snippe customer checkout stays **disabled**. Nothing here enables a payment route, approves a price or charges anyone.

**Rules:**
- Every changing step needs the owner's authorisation, **by step number**. Read-only steps report exactly what they show.
- Leave `commercial_platform_state` as it is. Never edit a wrapper. Never delete or edit a payment, licence or audit row.
- **Do not repair historical discrepancies.** Report them only.

## P4-1. Read the state (read-only)

```sql
SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) AS journal_rows,
       to_regprocedure('public._record_payment_reversal_core(uuid,text,text,text,bigint,text,text,text,text,uuid,jsonb)') IS NOT NULL AS p4_applied;
```

Expect `journal_rows = 54` and `p4_applied = false`. Otherwise stop and report.

## P4-2. Preflight (read-only)

Run `release/commercial-p4/preflight.sql` and paste the **whole** output:
1. every existing reversal;
2. the **historical discrepancies**, meaning existing reversals the new rules would refuse;
3. the counts and digests to compare after.

## P4-3. Apply *(owner authorisation)*

Apply `release/wrappers/20261101100000_payment_reversal_authority.wrapper.sql` **byte for byte**. Its size and SHA-256 are in `RELEASE.txt`.
- It checks its own size and hash before running anything, and refuses unless commercial-p3 is applied.
- On any error, report it verbatim and stop. The journal must still read 54.
- On success, the journal reads **55**.

## P4-4. Postcondition (read-only)

Run `release/commercial-p4/postcondition.sql`.
- It must report `POSTCONDITION OK.`
- Section 1 must list the **same** discrepancies as the preflight.
- Section 2's counts and digests must be **identical** to the preflight's: the migration writes no row.

## P4-5. Deploy *(owner authorisation)*

Deploy exactly these Edge Functions from the release commit. Their files and hashes are in `release/FUNCTIONS_MANIFEST.json`.
- `commercial-payment-status`
- `commercial-webhook-polar`
- `commercial-webhook-snippe`

Do not set any secret.

## P4-6. Publish *(owner authorisation)*

Publish the release commit. The admin "Refunds and disputes" buttons now read "End the licence now" and "Keep the licence". "End the licence now" really ends access.

## After

Snippe refunds can now be recorded with `admin_record_provider_refund` (`PAYMENT_REVERSAL_AUTHORITY.md` §5). There are none to record while Snippe is disabled.
