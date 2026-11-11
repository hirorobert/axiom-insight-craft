-- 20261221100000_financial_table_member_write_revocation.sql — the remaining financial and evidence tables become
-- server-written only (forward-only; nothing edited; no row changed).
--
-- Defect closed (second-pass hostile validation 2026-11-11: S2-S01, S2-S03, S2-S04; security appendix A1, A2, B-01..B-04,
-- B-09, B-10, C.1): after 20261212100000 (four legacy tax tables) the replayed chain still lets an authenticated member
-- INSERT/UPDATE (sometimes DELETE) these tables directly through PostgREST — a permissive client write policy AND the
-- write privilege (Supabase's default privileges give `authenticated` ALL on every new public table, and no migration
-- ever revoked it). Several predicates accept ANY firm_members row, including an invitation that was never accepted.
-- Among them: period_closing_balances (read as authoritative by hesabu-validate, generate-xbrl, kinga-tax-engine and
-- maono-compute), statement_sign_offs, the MAONO engine outputs and the SAFISHA/EFDMS evidence tables.
--
-- A. SERVER-WRITTEN ONLY from here (18 tables). Every client write policy below is dropped and INSERT, UPDATE, DELETE,
--    TRUNCATE, REFERENCES and TRIGGER (and MAINTAIN on PostgreSQL 17+) are revoked from PUBLIC, anon and authenticated,
--    at table and column level — every write-class privilege, not only what the chain granted, because a hosted
--    read-back has shown grants BROADER than the chain (PR #124: authenticated held DELETE/TRUNCATE/REFERENCES/TRIGGER/
--    MAINTAIN on statement_sign_offs). The writer of each table is named; none is a browser page:
--      period_closing_balances   pcb_insert, pcb_update                 kinga-tax-engine (service role; withheld)
--      statement_sign_offs       sso_insert, sso_update_partner_owner,  no routed page writes it (PeriodCloseManager is
--                                sso_update_preparer                    unrouted; KingaTaxPanel is mounted only by the
--                                                                       unrouted Tax page); FINAL runs on the fs_* chain
--      tax_losses                tl_insert, tl_update                   none in this repository
--      account_pl_mapping        account_pl_mapping_write/_update/_delete  none (read by maono-compute, restricted)
--      variance_runs             runs_insert                            maono-compute (restricted: 503 before any write)
--      variance_analyses         analyses_insert                        maono-compute (restricted)
--      cashflow_forecasts        cashflow_insert                        maono-cashflow (service role from this release)
--      maono_insights            insights_insert                        maono-risk (service role from this release);
--                                                                       maono-decide / maono-root-cause (withheld)
--      board_packs               board_packs_insert                     maono_write_board_pack (SECURITY DEFINER)
--      filing_obligations        filing_obligations_member_write        none in this repository
--      safisha_reconciliations   safisha_recon_insert, safisha_recon_update  safisha-categorize / safisha-score (service
--                                                                       role from this release)
--      safisha_transactions      safisha_txn_insert                     server ingestion only (service role)
--      safisha_exceptions        safisha_exc_insert                     safisha-categorize / -score (service role from
--                                                                       this release); safisha_resolve_exception (SD)
--      efdms_z_reports           efdms_insert                           safisha-efdms-ingest (service role from this release)
--      efdms_reconciliation      efdms_recon_write                      safisha-efdms-ingest (service role from this release)
--      efdms_records             "Users can ingest EFDMS records for their companies", efdms_company_ownership_insert
--                                                                       none (the panel's direct writes were removed)
--      canonical_financial_records  canonical_records_insert, canonical_records_insert_restrictive   none
--      ingestion_batches         ingestion_batches_insert, ingestion_batches_insert_restrictive      none
--    The Edge Functions named "service role from this release" verify the caller first (accepted, active named member
--    via _shared/actor.ts resolveFirmMemberActor, plus prepare_close) and MUST be deployed BEFORE this is applied.
--
-- B. PROFESSIONAL INPUT, kept and tightened (3 tables). variance_budgets: budget_submit now requires prepare_close
--    through workspace_capability_allowed (an accepted, active named member with a current plan) instead of any
--    membership row; budget_approve is unchanged (review_close, maker-checker). variance_materiality is unchanged
--    (variance_materiality_write already requires review_close through workspace_capability_allowed). variance_alerts:
--    the alert is engine output (maono_write_alert); alerts_acknowledge, which let ANY membership row (no acceptance,
--    no capability) rewrite severity, codes and detail of any alert, is replaced: a member holding review_close may
--    acknowledge an unacknowledged alert once, as themselves, and UPDATE is granted only on acknowledged_by,
--    acknowledged_at and acknowledgment_note. All three lose TRUNCATE, REFERENCES and TRIGGER (and MAINTAIN);
--    variance_budgets loses DELETE (it never had a delete policy).
--
-- Unchanged: every SELECT policy and the SELECT privilege (what the engines recorded stays readable to the members who
-- could read it), service_role, every trigger, every SECURITY DEFINER writer. No row is inserted, updated or deleted.
--
-- Concurrency: one statement (this DO block), so it applies completely or not at all whatever the migrator's
-- transaction mode. SET LOCAL lock_timeout bounds each lock wait: behind a long-running transaction on one of these
-- tables it fails with 55P03 and changes nothing, instead of queueing indefinitely; re-apply when the table is free.
--
-- Supersedes, for the client path, the unpromoted statement_sign_offs candidate
-- docs/fin-integrity/candidate-migration/20261103100000_signoff_authorization_hardening.sql (PR #124): with no client
-- write privilege or policy left on the table there is no client signature for its trigger to judge.

DO $migration$
DECLARE
  -- A: server-written only.
  v_server CONSTANT TEXT[] := ARRAY[
    'period_closing_balances', 'statement_sign_offs', 'tax_losses', 'account_pl_mapping',
    'variance_runs', 'variance_analyses', 'cashflow_forecasts', 'maono_insights', 'board_packs',
    'filing_obligations',
    'safisha_reconciliations', 'safisha_transactions', 'safisha_exceptions',
    'efdms_z_reports', 'efdms_reconciliation', 'efdms_records',
    'canonical_financial_records', 'ingestion_batches'];
  -- B: professional input, kept.
  v_input  CONSTANT TEXT[] := ARRAY['variance_budgets', 'variance_materiality', 'variance_alerts'];
  v_roles  CONSTANT TEXT[] := ARRAY['public', 'anon', 'authenticated'];
  v_maintain CONSTANT BOOLEAN := current_setting('server_version_num')::int >= 170000;   -- MAINTAIN exists from PG17
  v_table  TEXT;
  v_role   TEXT;
  v_priv   TEXT;
  v_col    TEXT;
BEGIN
  -- ── 0. Preflight ───────────────────────────────────────────────────────────────────────────────────────────────────
  SET LOCAL lock_timeout = '5s';
  FOREACH v_table IN ARRAY v_server || v_input LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: public.% does not exist; nothing was changed', v_table USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM unnest(v_server) t
                  WHERE has_table_privilege('authenticated', 'public.' || t, 'INSERT')
                     OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
                     OR has_any_column_privilege('authenticated', 'public.' || t, 'INSERT')
                     OR has_any_column_privilege('authenticated', 'public.' || t, 'UPDATE'))
     AND NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = ANY (v_server)
                        AND cmd <> 'SELECT' AND roles <> ARRAY['service_role']::name[]) THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: client writes to these financial tables are already retired; nothing was changed' USING ERRCODE = 'P0001';
  END IF;

  -- ── A.1 The client write policies (every INSERT / UPDATE / DELETE / ALL policy the chain leaves on these tables) ──
  DROP POLICY IF EXISTS "pcb_insert"                                         ON public.period_closing_balances;
  DROP POLICY IF EXISTS "pcb_update"                                         ON public.period_closing_balances;
  DROP POLICY IF EXISTS "sso_insert"                                         ON public.statement_sign_offs;
  DROP POLICY IF EXISTS "sso_update_partner_owner"                           ON public.statement_sign_offs;
  DROP POLICY IF EXISTS "sso_update_preparer"                                ON public.statement_sign_offs;
  DROP POLICY IF EXISTS "tl_insert"                                          ON public.tax_losses;
  DROP POLICY IF EXISTS "tl_update"                                          ON public.tax_losses;
  DROP POLICY IF EXISTS "account_pl_mapping_write"                           ON public.account_pl_mapping;
  DROP POLICY IF EXISTS "account_pl_mapping_update"                          ON public.account_pl_mapping;
  DROP POLICY IF EXISTS "account_pl_mapping_delete"                          ON public.account_pl_mapping;
  DROP POLICY IF EXISTS "runs_insert"                                        ON public.variance_runs;
  DROP POLICY IF EXISTS "analyses_insert"                                    ON public.variance_analyses;
  DROP POLICY IF EXISTS "cashflow_insert"                                    ON public.cashflow_forecasts;
  DROP POLICY IF EXISTS "insights_insert"                                    ON public.maono_insights;
  DROP POLICY IF EXISTS "board_packs_insert"                                 ON public.board_packs;
  DROP POLICY IF EXISTS "filing_obligations_member_write"                    ON public.filing_obligations;
  DROP POLICY IF EXISTS "safisha_recon_insert"                               ON public.safisha_reconciliations;
  DROP POLICY IF EXISTS "safisha_recon_update"                               ON public.safisha_reconciliations;
  DROP POLICY IF EXISTS "safisha_txn_insert"                                 ON public.safisha_transactions;
  DROP POLICY IF EXISTS "safisha_exc_insert"                                 ON public.safisha_exceptions;
  DROP POLICY IF EXISTS "efdms_insert"                                       ON public.efdms_z_reports;
  DROP POLICY IF EXISTS "efdms_recon_write"                                  ON public.efdms_reconciliation;
  DROP POLICY IF EXISTS "Users can ingest EFDMS records for their companies" ON public.efdms_records;
  DROP POLICY IF EXISTS "efdms_company_ownership_insert"                     ON public.efdms_records;
  DROP POLICY IF EXISTS "canonical_records_insert"                           ON public.canonical_financial_records;
  DROP POLICY IF EXISTS "canonical_records_insert_restrictive"               ON public.canonical_financial_records;
  DROP POLICY IF EXISTS "ingestion_batches_insert"                           ON public.ingestion_batches;
  DROP POLICY IF EXISTS "ingestion_batches_insert_restrictive"               ON public.ingestion_batches;

  -- ── A.2 Every write-class privilege, table and column level ────────────────────────────────────────────────────────
  FOREACH v_table IN ARRAY v_server LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
    IF v_maintain THEN
      EXECUTE format('REVOKE MAINTAIN ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
    END IF;
    -- A column-level grant survives a table-level REVOKE (precedent 20261006100000, 20261212100000); none may remain.
    FOR v_col IN SELECT a.attname FROM pg_attribute a
                  WHERE a.attrelid = ('public.' || quote_ident(v_table))::regclass AND a.attnum > 0 AND NOT a.attisdropped LOOP
      EXECUTE format('REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE public.%2$I FROM PUBLIC, anon, authenticated', v_col, v_table);
    END LOOP;
    EXECUTE format('COMMENT ON TABLE public.%I IS %L', v_table,
      coalesce(obj_description(('public.' || quote_ident(v_table))::regclass, 'pg_class') || ' ', '')
      || 'Read-only to clients since 20261221100000: written only by server code (service role or a SECURITY DEFINER function).');
  END LOOP;

  -- ── B. Professional input: tightened, not removed ─────────────────────────────────────────────────────────────────
  DROP POLICY IF EXISTS "budget_submit" ON public.variance_budgets;
  CREATE POLICY "budget_submit" ON public.variance_budgets FOR INSERT TO authenticated
    WITH CHECK (public.workspace_capability_allowed(company_id, auth.uid(), 'prepare_close')
                AND submitted_by = auth.uid()
                AND approved_by IS NULL);
  REVOKE DELETE ON TABLE public.variance_budgets FROM PUBLIC, anon, authenticated;

  -- variance_alerts: the alert itself is engine output (maono_write_alert); a member may only ACKNOWLEDGE it, once, as
  -- themselves, holding review_close — and may change nothing else (column-level UPDATE on the three acknowledgement
  -- columns only; maono_alerts_append_only still guards the core fields for every role).
  DROP POLICY IF EXISTS "alerts_acknowledge" ON public.variance_alerts;
  REVOKE INSERT, UPDATE, DELETE ON TABLE public.variance_alerts FROM PUBLIC, anon, authenticated;
  FOR v_col IN SELECT a.attname FROM pg_attribute a
                WHERE a.attrelid = 'public.variance_alerts'::regclass AND a.attnum > 0 AND NOT a.attisdropped LOOP
    EXECUTE format('REVOKE INSERT (%1$I), UPDATE (%1$I) ON TABLE public.variance_alerts FROM PUBLIC, anon, authenticated', v_col);
  END LOOP;
  GRANT UPDATE (acknowledged_by, acknowledged_at, acknowledgment_note) ON TABLE public.variance_alerts TO authenticated;
  CREATE POLICY "alerts_acknowledge" ON public.variance_alerts FOR UPDATE TO authenticated
    USING (acknowledged_at IS NULL
           AND public.workspace_capability_allowed(company_id, auth.uid(), 'review_close'))
    WITH CHECK (acknowledged_by = auth.uid()
                AND acknowledged_at IS NOT NULL
                AND public.workspace_capability_allowed(company_id, auth.uid(), 'review_close'));

  FOREACH v_table IN ARRAY v_input LOOP
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
    IF v_maintain THEN
      EXECUTE format('REVOKE MAINTAIN ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
    END IF;
    FOR v_col IN SELECT a.attname FROM pg_attribute a
                  WHERE a.attrelid = ('public.' || quote_ident(v_table))::regclass AND a.attnum > 0 AND NOT a.attisdropped LOOP
      EXECUTE format('REVOKE REFERENCES (%1$I) ON TABLE public.%2$I FROM PUBLIC, anon, authenticated', v_col, v_table);
    END LOOP;
  END LOOP;
  -- Signed-out callers never enter professional input (anon holds nothing here in the chain; a hosted drift is removed).
  REVOKE INSERT, UPDATE, DELETE ON TABLE public.variance_budgets, public.variance_materiality FROM anon;

  -- ── Postcondition ─────────────────────────────────────────────────────────────────────────────────────────────────
  FOREACH v_table IN ARRAY v_server LOOP
    FOREACH v_role IN ARRAY v_roles LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] || CASE WHEN v_maintain THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::TEXT[] END LOOP
        IF has_table_privilege(v_role, 'public.' || v_table, v_priv) THEN
          RAISE EXCEPTION 'POSTCONDITION_FAILED: % still holds % on public.%', v_role, v_priv, v_table USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
      IF has_any_column_privilege(v_role, 'public.' || v_table, 'INSERT') OR has_any_column_privilege(v_role, 'public.' || v_table, 'UPDATE')
         OR has_any_column_privilege(v_role, 'public.' || v_table, 'REFERENCES') THEN
        RAISE EXCEPTION 'POSTCONDITION_FAILED: % still holds a column-level write privilege on public.%', v_role, v_table USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    IF NOT has_table_privilege('authenticated', 'public.' || v_table, 'SELECT')
       OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table AND cmd = 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION_FAILED: what the engines recorded must remain readable (public.%)', v_table USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = ANY (v_server)
                AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL') AND roles <> ARRAY['service_role']::name[]) THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: a client write policy remains on a server-written financial table' USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_table IN ARRAY v_input LOOP
    FOREACH v_role IN ARRAY v_roles LOOP
      FOREACH v_priv IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'] || CASE WHEN v_maintain THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::TEXT[] END LOOP
        IF has_table_privilege(v_role, 'public.' || v_table, v_priv) THEN
          RAISE EXCEPTION 'POSTCONDITION_FAILED: % still holds % on public.%', v_role, v_priv, v_table USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END LOOP;
    IF has_table_privilege('anon', 'public.' || v_table, 'INSERT') OR has_table_privilege('anon', 'public.' || v_table, 'UPDATE')
       OR has_table_privilege('anon', 'public.' || v_table, 'DELETE') THEN
      RAISE EXCEPTION 'POSTCONDITION_FAILED: anon still holds a write privilege on public.%', v_table USING ERRCODE = 'P0001';
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION_FAILED: public.% must remain readable', v_table USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.variance_budgets', 'DELETE')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'variance_budgets' AND policyname = 'budget_submit'
                     AND with_check LIKE '%workspace_capability_allowed%prepare_close%') THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: variance_budgets submission is not capability-bound' USING ERRCODE = 'P0001';
  END IF;
  IF has_table_privilege('authenticated', 'public.variance_alerts', 'INSERT') OR has_table_privilege('authenticated', 'public.variance_alerts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.variance_alerts', 'DELETE')
     OR has_any_column_privilege('authenticated', 'public.variance_alerts', 'INSERT')
     OR NOT has_column_privilege('authenticated', 'public.variance_alerts', 'acknowledged_at', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.variance_alerts', 'severity', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.variance_alerts', 'message', 'UPDATE')
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'variance_alerts' AND cmd <> 'SELECT') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'variance_alerts' AND policyname = 'alerts_acknowledge'
                     AND cmd = 'UPDATE' AND with_check LIKE '%acknowledged_by = auth.uid()%' AND with_check LIKE '%review_close%') THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: variance_alerts must allow only a capability-bound, self-attributed acknowledgement' USING ERRCODE = 'P0001';
  END IF;
END
$migration$;
