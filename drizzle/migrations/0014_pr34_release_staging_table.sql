-- Release staging table for the controlled PR #34 production release.
-- Holds the verbatim bytes of the six authorized migration files from reviewed head
-- c2c1e8e171f4c23b428d7affc14ae3ee103020ed together with their SHA-256 digests, so each
-- authorized file is applied exactly as reviewed with its own atomic envelope intact.
-- Not part of the application schema; retired at the end of the release.
CREATE TABLE IF NOT EXISTS public._pr34_migration_bodies (
  name        TEXT        NOT NULL PRIMARY KEY,
  body        TEXT        NOT NULL,
  sha256_hex  TEXT        NOT NULL,
  staged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at  TIMESTAMPTZ NULL
);

ALTER TABLE public._pr34_migration_bodies ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public._pr34_migration_bodies IS 'Release-only staging of authorized PR #34 migration bodies. Not application data.';

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON public._pr34_migration_bodies FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON public._pr34_migration_bodies FROM anon';
  EXECUTE 'REVOKE ALL ON public._pr34_migration_bodies FROM authenticated';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    EXECUTE 'GRANT SELECT, INSERT ON public._pr34_migration_bodies TO sandbox_exec';
  END IF;
END
$$;

COMMENT ON TABLE public._pr34_probe IS 'DEPRECATED: transient release probe, superseded by _pr34_migration_bodies. Unused.';