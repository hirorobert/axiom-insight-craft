-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261222100000 — Transfers between cash accounts are not cash flows (S2-A01); a post-closing trial balance is a finding only a
-- reviewer's recorded acceptance clears (S2-A02). AUTHORED, NOT APPLIED to any hosted database. Forward-only; builds on
-- 20261111100000 (fs_evidence_statements), 20261123100000 (server compilation, applied) and 20261124100000 (only review_close may
-- record ACCEPT_FINDING). The compiler identity that carries both is accepted by 20261222200000 (a separate file).
--
--   1. fs_evidence_statements (the server's twin of the browser's direct-method generator) — four anchored changes, each
--      asserted to occur exactly once in the LIVE function text; every other line is unchanged:
--        · a ledger row whose activity is TRANSFER_BETWEEN_CASH_ACCOUNTS (ledger evidence schema 1.1.0: the row names the other
--          cash account in counter_cash_account_code) enters no presented line, no activity subtotal and no net movement. It
--          still counts in its account's roll-forward (fact:cashroll:ledger:*, unchanged), so a transfer between two cash
--          accounts of the perimeter reconciles both accounts and changes no cash-flow figure;
--        · a transfer row without a counter account, naming itself, or without an amount — or an ordinary row naming a counter
--          account — makes the batch unreadable (the existing EVIDENCE_ROWS_UNREADABLE blocker; no figure from it);
--        · for every pair of accounts, the transfer legs recorded between them must net to zero within the period, else
--          CASHFLOW_TRANSFER_UNMATCHED:<role>:<account>:<account>:<net minor units> (money entering or leaving the pair is a cash
--          flow). A transfer naming an account outside the cash perimeter needs that account's own leg, which is a ledger row on
--          a non-cash account: the existing CASHFLOW_LEDGER_ACCOUNT_NOT_CASH blocker refuses it;
--        · a current-period ledger with no presentable row composes no statement AND no ledger-completeness figures (the
--          browser generator yields no statement and therefore no ledger authority).
--      A ledger without transfer rows (every batch stored today: schema 1.0.0 has neither the activity nor the column) composes
--      byte-identical figures, blockers and statementsSha256, so no reviewed version goes stale.
--   2. fs_server_compilation_blocker — one anchored change: an actionable finding of the rule `comprehensive-income-activity`
--      (rule pack 2.4.0: a nil statement of comprehensive income beside a statement of financial position with balances, the
--      shape of a post-closing trial balance) no longer makes SERVER_COMPILATION_FINDINGS once the latest finding decision on
--      it is ACCEPT_FINDING with a recorded reason (only review_close can record one, 20261124100000; fs_unresolved_blocking_count
--      already honours it). Every other finding, and every mandatory rule, blocks exactly as before; a REJECT, a DEFER or an
--      acceptance without a reason does not clear it.
--
--   DEPLOYMENT ORDER: apply this migration and 20261222200000 (the owner's Lovable migrator), THEN redeploy
--   compile-financial-report with the regenerated bundle, THEN publish the frontend.
--
-- PREFLIGHT: the functions exist with the anchors this migration expects; not already applied. POSTCONDITION: each anchored
-- change is present. Nothing is granted; no table is altered; no row is read, written or rewritten. No function this migration
-- touches takes a lock it did not take before (the helpers are pure reads, called inside the callers' existing transactions).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regprocedure('public.fs_evidence_statements(uuid,integer)') IS NULL OR to_regprocedure('public.fs_server_compilation_blocker(uuid,text,integer)') IS NULL
     OR to_regprocedure('public._fs_ev_cell(jsonb,jsonb,text)') IS NULL OR to_regprocedure('public._fs_ev_minor(text,integer)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261111100000 and 20261123100000 must be applied first; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF position('TRANSFER_BETWEEN_CASH_ACCOUNTS' IN pg_get_functiondef('public.fs_evidence_statements(uuid,integer)'::regprocedure)) > 0
     OR position('_fs_finding_accepted_by_reviewer' IN pg_get_functiondef('public.fs_server_compilation_blocker(uuid,text,integer)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261222100000 is already applied; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── Helpers (internal; no API role may call them) ───────────────────────────────────────────────────────────────────
-- A ledger batch whose transfer rows are not readable as the 1.1.0 shape (financialEvidence/schemas.ts; intake refuses each).
CREATE OR REPLACE FUNCTION public._fs_ev_transfer_rows_unreadable(p_doc jsonb, p_scale integer)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(p_doc -> 'rows', '[]'::jsonb)) x
     CROSS JOIN LATERAL (SELECT public._fs_ev_cell(p_doc, x, 'activity') = 'TRANSFER_BETWEEN_CASH_ACCOUNTS' AS t,
                                public._fs_ev_cell(p_doc, x, 'counter_cash_account_code') AS counter,
                                public._fs_ev_cell(p_doc, x, 'cash_account_code') AS own,
                                CASE WHEN public._fs_ev_cell(p_doc, x, 'receipt') <> '' THEN public._fs_ev_minor(public._fs_ev_cell(p_doc, x, 'receipt'), p_scale)
                                     ELSE -public._fs_ev_minor(public._fs_ev_cell(p_doc, x, 'payment'), p_scale) END AS amount) c
     WHERE c.t <> (c.counter <> '') OR (c.counter <> '' AND c.counter = c.own) OR (c.t AND (c.own = '' OR c.amount IS NULL)));
$$;
-- The transfer pairs of a readable ledger batch whose legs do not net to zero (accounts named in code-point order).
CREATE OR REPLACE FUNCTION public._fs_ev_transfer_blockers(p_doc jsonb, p_scale integer, p_role text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg('CASHFLOW_TRANSFER_UNMATCHED:' || p_role || ':' || q.a || ':' || q.b || ':' || q.net::text ORDER BY q.a COLLATE "C", q.b COLLATE "C"), '{}')
    FROM (SELECT least(c.own COLLATE "C", c.counter COLLATE "C") AS a, greatest(c.own COLLATE "C", c.counter COLLATE "C") AS b, sum(c.amount) AS net
            FROM jsonb_array_elements(coalesce(p_doc -> 'rows', '[]'::jsonb)) x
           CROSS JOIN LATERAL (SELECT public._fs_ev_cell(p_doc, x, 'counter_cash_account_code') AS counter, public._fs_ev_cell(p_doc, x, 'cash_account_code') AS own,
                                      CASE WHEN public._fs_ev_cell(p_doc, x, 'receipt') <> '' THEN public._fs_ev_minor(public._fs_ev_cell(p_doc, x, 'receipt'), p_scale)
                                           ELSE -public._fs_ev_minor(public._fs_ev_cell(p_doc, x, 'payment'), p_scale) END AS amount) c
           WHERE public._fs_ev_cell(p_doc, x, 'activity') = 'TRANSFER_BETWEEN_CASH_ACCOUNTS'
           GROUP BY 1, 2 HAVING sum(c.amount) <> 0) q;
$$;
-- A finding the reviewer may accept with a reason instead of correcting the source: today exactly one rule, whose legitimate
-- case (a genuinely dormant entity) no correction can satisfy. Latest decision wins, as in fs_unresolved_blocking_count.
CREATE OR REPLACE FUNCTION public._fs_finding_accepted_by_reviewer(p_report_id text, p_finding jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(p_finding ->> 'ruleId' = 'comprehensive-income-activity' AND p_finding ->> 'outcome' = 'FAIL' AND p_finding ->> 'failureSeverity' = 'HIGH'
    AND (SELECT d.decision ->> 'decisionType' = 'ACCEPT_FINDING' AND length(btrim(coalesce(d.decision ->> 'rationale', ''))) >= 3
           FROM public.financial_statement_reviewer_decisions d
          WHERE d.report_id = p_report_id AND d.decision #>> '{target,kind}' = 'FINDING_KEY' AND d.decision #>> '{target,findingKey}' = p_finding ->> 'findingKey'
            AND d.decision ->> 'decisionType' IN ('ACCEPT_FINDING', 'REJECT_FINDING', 'DEFER', 'REQUEST_EVIDENCE')
          ORDER BY d.seq DESC LIMIT 1), false);
$$;
REVOKE ALL ON FUNCTION public._fs_ev_transfer_rows_unreadable(jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_ev_transfer_blockers(jsonb, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_finding_accepted_by_reviewer(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

DO $s2_install$
DECLARE
  v_sig_ev  constant text := 'public.fs_evidence_statements(uuid,integer)';
  v_sig_bl  constant text := 'public.fs_server_compilation_blocker(uuid,text,integer)';
  v_def     text;
  v_from    text[];
  v_to      text[];
  i         integer;
  v_n       integer;
BEGIN
  -- ── 1. fs_evidence_statements ──
  v_from := ARRAY[
    E'                  ELSE -public._fs_ev_minor(public._fs_ev_cell(d.doc, x, ''payment''), v_scale) END\n        FROM (SELECT v_pick -> ''doc'' AS doc) d CROSS JOIN LATERAL jsonb_array_elements(d.doc -> ''rows'') x;',
    E'      IF EXISTS (SELECT 1 FROM pg_temp.fs_ev_cf c WHERE c.pid = v_pid AND (c.amount IS NULL OR c.activity = '''' OR c.label = '''')) THEN',
    E'        v_blockers := v_blockers || (''EVIDENCE_ROWS_UNREADABLE:TRANSACTION_LEDGER:'' || v_role);\n      END IF;',
    E'  IF NOT EXISTS (SELECT 1 FROM pg_temp.fs_ev_cf WHERE pid = ''CURRENT'') THEN DELETE FROM pg_temp.fs_ev_cf WHERE true; END IF;'];
  v_to := ARRAY[
    E'                  ELSE -public._fs_ev_minor(public._fs_ev_cell(d.doc, x, ''payment''), v_scale) END\n        FROM (SELECT v_pick -> ''doc'' AS doc) d CROSS JOIN LATERAL jsonb_array_elements(d.doc -> ''rows'') x\n'
      || E'       -- [20261222100000] a transfer between two cash accounts of the perimeter is in no presented line (its account''s roll-forward keeps it)\n'
      || E'       WHERE public._fs_ev_cell(d.doc, x, ''activity'') IS DISTINCT FROM ''TRANSFER_BETWEEN_CASH_ACCOUNTS'';',
    E'      IF EXISTS (SELECT 1 FROM pg_temp.fs_ev_cf c WHERE c.pid = v_pid AND (c.amount IS NULL OR c.activity = '''' OR c.label = ''''))\n'
      || E'         OR public._fs_ev_transfer_rows_unreadable(v_pick -> ''doc'', v_scale) THEN  -- [20261222100000]',
    E'        v_blockers := v_blockers || (''EVIDENCE_ROWS_UNREADABLE:TRANSACTION_LEDGER:'' || v_role);\n'
      || E'      ELSE\n        v_blockers := v_blockers || public._fs_ev_transfer_blockers(v_pick -> ''doc'', v_scale, v_role);  -- [20261222100000]\n      END IF;',
    E'  IF NOT EXISTS (SELECT 1 FROM pg_temp.fs_ev_cf WHERE pid = ''CURRENT'') THEN DELETE FROM pg_temp.fs_ev_cf WHERE true; v_ledger_doc := NULL; END IF;  -- [20261222100000] no statement, no ledger authority'];
  v_def := pg_get_functiondef(v_sig_ev::regprocedure);
  FOR i IN 1 .. array_length(v_from, 1) LOOP
    v_n := (length(v_def) - length(replace(v_def, v_from[i], ''))) / length(v_from[i]);
    IF v_n <> 1 THEN RAISE EXCEPTION 'PREFLIGHT: fs_evidence_statements anchor % occurs % times, expected 1; nothing was changed', i, v_n USING ERRCODE = 'PT422'; END IF;
    v_def := replace(v_def, v_from[i], v_to[i]);
  END LOOP;
  EXECUTE v_def;

  -- ── 2. fs_server_compilation_blocker ──
  v_from := ARRAY[E'IF EXISTS(SELECT 1 FROM jsonb_array_elements(c.evaluation->''findings'') f WHERE f->>''actionable''=''true''\n'];
  v_to := ARRAY[E'IF EXISTS(SELECT 1 FROM jsonb_array_elements(c.evaluation->''findings'') f WHERE f->>''actionable''=''true'' AND NOT public._fs_finding_accepted_by_reviewer(p_report_id, f)\n'];
  v_def := pg_get_functiondef(v_sig_bl::regprocedure);
  v_n := (length(v_def) - length(replace(v_def, v_from[1], ''))) / length(v_from[1]);
  IF v_n <> 1 THEN RAISE EXCEPTION 'PREFLIGHT: fs_server_compilation_blocker anchor occurs % times, expected 1; nothing was changed', v_n USING ERRCODE = 'PT422'; END IF;
  EXECUTE replace(v_def, v_from[1], v_to[1]);

  -- ── POSTCONDITION ──
  v_def := pg_get_functiondef(v_sig_ev::regprocedure);
  IF position('IS DISTINCT FROM ''TRANSFER_BETWEEN_CASH_ACCOUNTS''' IN v_def) = 0 OR position('_fs_ev_transfer_rows_unreadable' IN v_def) = 0
     OR position('_fs_ev_transfer_blockers' IN v_def) = 0 OR position('v_ledger_doc := NULL; END IF;  -- [20261222100000]' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_evidence_statements does not exclude transfers between cash accounts' USING ERRCODE = 'PT422';
  END IF;
  IF position('_fs_finding_accepted_by_reviewer(p_report_id, f)' IN pg_get_functiondef(v_sig_bl::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_server_compilation_blocker does not honour the reviewer''s acceptance' USING ERRCODE = 'PT422';
  END IF;
END
$s2_install$;
