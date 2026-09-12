-- Ω∞ A+ closure — disposable-Postgres CI contract test harness.
--
-- This file runs ONCE, before the real migration chain, against a
-- throwaway `postgres:16` service container in GitHub Actions. It is NOT
-- a migration and is never applied to Supabase staging/production. Its
-- only purpose is to make a vanilla Postgres instance schema-compatible
-- enough for the real supabase/migrations/*.sql chain to apply: real
-- Supabase provides the `auth`/`storage` schemas, the anon/authenticated/
-- service_role Postgres roles, and auth.uid()/auth.role() out of the box;
-- a bare postgres:16 container does not.
--
-- service_role is granted BYPASSRLS, matching real Supabase's own
-- semantics (the service key is meant to bypass RLS entirely — every
-- "GRANT ALL ... TO service_role" pattern in this repository's migrations
-- assumes that).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── auth schema stub ────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mirrors real Supabase's own auth.uid()/auth.role() semantics: derived
-- from a per-session GUC the test harness sets via `SET request.jwt.claim.sub
-- = '<uuid>'` / `SET request.jwt.claim.role = '<role>'` before running a
-- query AS a given simulated user — the same idiom PostgREST uses per-request
-- in a real Supabase deployment, just set manually here instead of by a
-- JWT-parsing proxy in front of Postgres.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '')
$$;

-- ── storage schema stub (minimal — only what a handful of unrelated
--    pre-existing migrations' storage.objects policies reference) ──────────

CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  public BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id  TEXT REFERENCES storage.buckets(id),
  name       TEXT,
  owner      UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_to_array(name, '/')
$$;

GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO anon, authenticated, service_role;
