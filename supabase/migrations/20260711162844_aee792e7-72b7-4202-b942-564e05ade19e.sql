CREATE OR REPLACE FUNCTION safisha_append_evidence_file(
  p_recon_id    UUID,
  p_source_type TEXT,
  p_filename    TEXT,
  p_rows        INTEGER
) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE safisha_reconciliations
  SET evidence_files = evidence_files || jsonb_build_array(
        jsonb_build_object(
          'source_type', p_source_type,
          'filename',    p_filename,
          'rows',        p_rows,
          'uploaded_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
      )
  WHERE id = p_recon_id;
$$;