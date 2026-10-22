-- CFOClose Trial Balance staged transport bootstrap. GENERATED; do not edit.
-- The two TB wrappers and their source/postcondition evidence are inert until a registered apply migration executes them.
DO $cfoclose_tb_transport_bootstrap$
DECLARE
  c_predecessor CONSTANT text[] := ARRAY['0eb1405df641e956ca43b4ad652f9ca263029352637e98d1ce482d5c2bb19910']::text[];
  c_expected_predecessor CONSTANT bigint := 71;
  v_n bigint;
  v_pred_id bigint;
  v_role name;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_tb_release_transport', 0));
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1 OR v_pred_id <> c_expected_predecessor
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'TB_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF to_regnamespace('cfoclose_tb_release') IS NOT NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_ALREADY_INSTALLED: the TB transport schema exists; uncertain state requires review' USING ERRCODE = '55000';
  END IF;
  CREATE SCHEMA cfoclose_tb_release;
  COMMENT ON SCHEMA cfoclose_tb_release IS 'Release-only exact-byte transport for the Trial Balance batches; never exposed to clients.';
  CREATE TABLE cfoclose_tb_release.staged_artifacts (
    batch text NOT NULL, kind text NOT NULL CHECK (kind IN ('source','wrapper','postcondition')), body text NOT NULL,
    body_bytes integer NOT NULL, body_sha256 text NOT NULL, staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    staged_by name NOT NULL DEFAULT session_user, consumed_at timestamptz,
    PRIMARY KEY (batch, kind)
  );
  CREATE TABLE cfoclose_tb_release.transport_events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch text NOT NULL,
    event text NOT NULL CHECK (event IN ('staged','applied')), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT clock_timestamp(), by_role name NOT NULL DEFAULT session_user
  );
  CREATE FUNCTION cfoclose_tb_release.approved_artifact(p_batch text, p_kind text, OUT bytes integer, OUT sha256 text)
    LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT a.bytes, a.sha256 FROM (VALUES
        ('tb-portfolio-a1', 'source', 26579, 'a9eb6ca77c26a29e7c6f4230e0466fa4320e07d5537ec1f2a6baafaf989873f7'),
        ('tb-portfolio-a1', 'wrapper', 28141, 'c07611e571c7c65bf986a47ea6105b9c99e7c898d65c18f53c9afc652d34e08d'),
        ('tb-portfolio-a1', 'postcondition', 4473, '80c6181a3f03261aa1e90fe404c97720cb9e8263ba5bde51c55c93d6553dc36e'),
        ('tb-decisions-b1', 'source', 99185, '223d15e3e7ee2d941af1c4152f7c206b6aceabee96624ae990b8ddf4282db216'),
        ('tb-decisions-b1', 'wrapper', 100714, 'dab3fa1720468119b5f24f97ed045c2116f7a086c75125e1db9f45f9b5b8e4d8'),
        ('tb-decisions-b1', 'postcondition', 11218, '1cd683a26f3c22c22c2e8f9e9a9508b52087d4c678891c5f4aee92088937a98f')
      ) AS a(batch, kind, bytes, sha256) WHERE a.batch = p_batch AND a.kind = p_kind
    $fn$;
  CREATE FUNCTION cfoclose_tb_release.staged_artifacts_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE v_ok record;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_REFUSED: staged rows start unconsumed' USING ERRCODE = '55000'; END IF;
        NEW.body_bytes := octet_length(convert_to(NEW.body, 'UTF8'));
        NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        SELECT * INTO v_ok FROM cfoclose_tb_release.approved_artifact(NEW.batch, NEW.kind);
        IF v_ok.bytes IS NULL OR v_ok.bytes <> NEW.body_bytes OR v_ok.sha256 <> NEW.body_sha256 THEN
          RAISE EXCEPTION 'TB_TRANSPORT_STAGE_REFUSED: % % is not an approved exact byte identity', NEW.batch, NEW.kind USING ERRCODE = '55000';
        END IF;
        INSERT INTO cfoclose_tb_release.transport_events(batch, event, detail)
          VALUES (NEW.batch, 'staged', jsonb_build_object('kind', NEW.kind, 'bytes', NEW.body_bytes, 'sha256', NEW.body_sha256));
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        IF coalesce(current_setting('cfoclose_tb_release.applying', true), '') <> OLD.batch
           OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
           OR (NEW.batch, NEW.kind, NEW.body, NEW.body_bytes, NEW.body_sha256, NEW.staged_at, NEW.staged_by)
              IS DISTINCT FROM (OLD.batch, OLD.kind, OLD.body, OLD.body_bytes, OLD.body_sha256, OLD.staged_at, OLD.staged_by)
          THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_IMMUTABLE: only the owning apply may consume a row' USING ERRCODE = '55000'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'TB_TRANSPORT_STAGE_IMMUTABLE: evidence is append-only' USING ERRCODE = '55000';
    END
    $fn$;
  CREATE FUNCTION cfoclose_tb_release.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    BEGIN RAISE EXCEPTION 'TB_TRANSPORT_EVIDENCE_IMMUTABLE: % is refused', TG_OP USING ERRCODE = '55000'; END
    $fn$;
  CREATE TRIGGER trg_staged_artifacts_guard BEFORE INSERT OR UPDATE OR DELETE ON cfoclose_tb_release.staged_artifacts
    FOR EACH ROW EXECUTE FUNCTION cfoclose_tb_release.staged_artifacts_guard();
  CREATE TRIGGER trg_staged_artifacts_no_truncate BEFORE TRUNCATE ON cfoclose_tb_release.staged_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_tb_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_append_only BEFORE UPDATE OR DELETE ON cfoclose_tb_release.transport_events
    FOR EACH ROW EXECUTE FUNCTION cfoclose_tb_release.append_only_guard();
  CREATE TRIGGER trg_transport_events_no_truncate BEFORE TRUNCATE ON cfoclose_tb_release.transport_events
    FOR EACH STATEMENT EXECUTE FUNCTION cfoclose_tb_release.append_only_guard();
  ALTER TABLE cfoclose_tb_release.staged_artifacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cfoclose_tb_release.transport_events ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON SCHEMA cfoclose_tb_release FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_tb_release FROM PUBLIC;
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA cfoclose_tb_release FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA cfoclose_tb_release FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA cfoclose_tb_release FROM %I', v_role);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA cfoclose_tb_release FROM %I', v_role);
    END IF;
  END LOOP;
END
$cfoclose_tb_transport_bootstrap$;