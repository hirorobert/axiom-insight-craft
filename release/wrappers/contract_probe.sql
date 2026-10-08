-- CFOClose hosted-executor contract probe. Changes nothing, by construction: ONE statement that raises before it reads
-- or writes anything. Submitted through the hosted migrator BEFORE the first wrapper (docs/release/
-- MILESTONE_I1B_SIGNOFF_RELEASE.md, step 4.0), it must fail with RELEASE_CONTRACT_PROBE and leave the hosted journal
-- exactly as it was (no new drizzle.__drizzle_migrations row). Any other outcome is a stop condition: the executor does
-- not record its journal row atomically with the submitted statement, and no wrapper is submitted.
DO $cfoclose_contract_probe$
BEGIN
  RAISE EXCEPTION 'RELEASE_CONTRACT_PROBE: refused by design; nothing was changed' USING ERRCODE = '55000';
END
$cfoclose_contract_probe$;
