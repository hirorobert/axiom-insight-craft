# PR #32 — upload lifecycle: deployment order

Production is changed only by the owner (or Lovable on the owner's instruction), after the independent review
has passed. Nothing in this document has been run against production.

## 0. Read-only preflight (production, before anything is applied)

Run `scripts/db-preflight/uploadLifecyclePreflight.sql`. It contains SELECT statements only.

- §7 must be empty. §8 must show `matches` or `unset` for every period.
  Any `names_retired` row blocks `20260923100000`. That migration refuses to run, with nothing changed, until a
  person decides which upload the period should name.
- §9 must be empty. A stale pointer blocks `20260923150000` in the same way.

Record the output with the release.

## 1. Migrations: one `supabase db push`, in filename order

1. `20260922180000_discard_trial_balance_authority.sql`
2. `20260923100000_upload_lifecycle_retire_and_replace.sql`. Its first statement is the existing-data refusal; no
   DDL runs before it, so a refusal leaves no partial state even without a wrapping transaction.
3. `20260923120000_workspace_user_engine_actor_and_source_sweeper.sql`. This creates the pg_cron job
   `trial-balance-source-sweeper`. The job stays inert (`not_configured`) until step 5 configures its URL.
4. `20260923130000_workspace_capability_access_bridge.sql`
5. `20260923140000_upload_lifecycle_hardening.sql`
6. `20260923150000_upload_pointer_and_source_binding.sql`. Its first statement refuses while any fiscal period
   names a non-active upload.

## 2. Pause the sweeper cron (service role / SQL editor)

```sql
SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE jobname = 'trial-balance-source-sweeper';
```

## 3. Edge Functions

Deploy in any order, all from the same commit:

- `process-trial-balance`
- `kinga-comparative-engine`
- `trial-balance-storage-cleanup`
- `trial-balance-source-signer`
- `trial-balance-source-sweeper` (`verify_jwt = false`, per `supabase/config.toml`)

## 4. Frontend

Merge to `main`; Lovable deploys the frontend.

## 5. Resume the sweeper

```sql
SELECT public.tbu_configure_source_sweeper('https://<production-ref>.supabase.co/functions/v1/trial-balance-source-sweeper');  -- service_role
SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname = 'trial-balance-source-sweeper';
```

Then run:

```
SWEEPER_SUPABASE_URL=… SWEEPER_SUPABASE_SERVICE_ROLE_KEY=… node scripts/sweeper_readiness.mjs --owner
```

It must report READY.

## 6. Verify

- Re-run preflight §9. It must be empty.
- `scripts/rls_regression.mjs` against the environment must pass.
