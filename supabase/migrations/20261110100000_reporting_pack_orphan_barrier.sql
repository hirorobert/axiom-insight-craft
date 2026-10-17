-- 20261110100000_reporting_pack_orphan_barrier.sql — a database barrier for deleting an unsealed Reporting Pack object
-- (interim orphan cleanup, #149; separate from any release and from the cleanup approval itself). Forward-only. One new
-- service-role function; nothing existing changes.
--
-- Why a barrier, not a grace period. seal_reporting_pack_server takes the issuance row FOR UPDATE, then refuses when
-- expires_at <= clock_timestamp(), then seals and commits — all under that one row lock. A seal whose check passed just
-- before expiry is therefore committed (or rolled back) while it still holds the lock, however long that takes. A grace
-- period assumes the seal finishes quickly; it cannot exclude a seal transaction that stays open longer.
--
-- reporting_pack_orphan_deletable(issuance) takes the SAME row lock. It waits for any in-flight seal to commit or roll back
-- (bounded by a lock timeout: 'busy' instead of waiting forever), then decides under the lock:
--   sealed               consumed_at is set (the seal committed): never delete;
--   may_still_be_sealed  expires_at > clock_timestamp(): a seal can still succeed: keep;
--   deletable            expired and unsealed: no seal can ever succeed afterwards (the seal re-checks expiry with
--                        clock_timestamp() and expires_at can never change — reporting_pack_issuances_immutable);
--   no_issuance          no issuance row exists for this id: nothing can ever seal it (issuances are never deleted);
--   busy                 the row lock was not obtained within the timeout: keep, retry later.
-- Deleting the object after 'deletable' (through the Storage API) can therefore never race a seal.

DO $preflight$
BEGIN
  IF to_regprocedure('public.seal_reporting_pack_server(uuid,uuid,text)') IS NULL OR to_regclass('public.reporting_pack_issuances') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the sealing authority this barrier waits on is missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.reporting_pack_orphan_deletable(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the orphan barrier is already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.reporting_pack_orphan_deletable(p_issuance_id uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.reporting_pack_issuances%ROWTYPE;
BEGIN
  IF p_issuance_id IS NULL THEN RETURN 'no_issuance'; END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  BEGIN
    SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE id = p_issuance_id FOR UPDATE;
  EXCEPTION WHEN lock_not_available THEN
    RETURN 'busy';
  END;
  IF v_row.id IS NULL THEN RETURN 'no_issuance'; END IF;
  IF v_row.consumed_at IS NOT NULL THEN RETURN 'sealed'; END IF;
  IF v_row.expires_at > clock_timestamp() THEN RETURN 'may_still_be_sealed'; END IF;
  RETURN 'deletable';
END;
$$;

REVOKE ALL ON FUNCTION public.reporting_pack_orphan_deletable(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reporting_pack_orphan_deletable(uuid) TO service_role;
