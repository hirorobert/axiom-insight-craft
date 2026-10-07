// In-memory doubles of the S2 attempt functions (20261008100000) for the function-path tests: tb_begin_attempt,
// tb_snapshot_dependencies and tb_finalize_attempt, with the outcomes the database gives (claimed / replay / in progress /
// conflict / refused, the fence on finalize). The real functions are proven on PostgreSQL by scripts/db-proof/s2Authority.mjs
// and, with the real handler, by scripts/db-proof/tbHandlerCharacterization.mjs; these doubles only let the handler's own
// branches run in Deno. A certification is stored with the field names the previous commit_tb_certification double used
// (p_is_blocking, p_rows_snapshot, …) so the tests read every engine the same way.
import type { Row, World } from "./supabaseDouble.ts";

let seq = 0;
const ok = (data: unknown) => ({ data, error: null });

export function installAttemptDoubles(w: World): void {
  w.rpc.tb_begin_attempt = (a) => {
    const up = w.tables.trial_balance_uploads?.find((u) => u.id === a.p_upload_id);
    if (!up) return ok({ outcome: "refused", code: "UPLOAD_NOT_FOUND" });
    const keys = (w.tables.idempotency_keys ??= []);
    const key = keys.find((k) => k.company_id === up.company_id && k.client_request_id === a.p_client_request_id);
    if (key) {
      if (key.request_hash !== a.p_request_hash) return ok({ outcome: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
      if (key.status === "reserved") return ok({ outcome: "in_progress", engine_run_id: key.engine_run_id });
      return ok({ outcome: "replay", result: key.replay_result ?? { status: key.status } });
    }
    if (up.source_file_hash && up.source_file_hash !== a.p_source_file_hash) return ok({ outcome: "refused", code: "SOURCE_CHANGED" });
    const latest = (w.tables.tb_certifications ?? []).filter((c) => c.upload_id === up.id)
      .sort((x, y) => Number(y.sequence_no ?? 0) - Number(x.sequence_no ?? 0))[0];
    if (latest && !(w.tables.tb_certification_invalidations ?? []).some((i) => i.certification_id === latest.id)) {
      return ok({ outcome: "refused", code: "REPROCESS_REQUIRED" });
    }
    const current = (w.tables.engine_runs ?? []).find((r) => r.id === up.current_engine_run_id);
    if (current?.status === "running") return ok({ outcome: "refused", code: "IN_PROGRESS", engine_run_id: current.id });
    const attemptNo = Number(up.processing_attempt ?? 0) + 1;
    const run: Row = {
      id: `run-${++seq}`, status: "running", function_name: "process-trial-balance", company_id: up.company_id,
      engine_version: a.p_engine_version, engine_generation: a.p_engine_generation, attempt_no: attemptNo,
      input_hash: a.p_input_hash, source_record_id: up.id, actor_type: a.p_actor_type,
    };
    (w.tables.engine_runs ??= []).push(run);
    keys.push({ id: `key-${seq}`, company_id: up.company_id, client_request_id: a.p_client_request_id, request_hash: a.p_request_hash, status: "reserved", engine_run_id: run.id });
    Object.assign(up, { status: "validating", source_file_hash: up.source_file_hash ?? a.p_source_file_hash, current_engine_run_id: run.id, processing_attempt: attemptNo });
    return ok({ outcome: "claimed", engine_run_id: run.id, key_id: `key-${seq}`, attempt_no: attemptNo });
  };

  w.rpc.tb_snapshot_dependencies = (a) => {
    const run = (w.tables.engine_runs ?? []).find((r) => r.id === a.p_engine_run_id);
    if (!run || run.status !== "running") return { data: null, error: { code: "PT409", message: "ATTEMPT_NOT_CURRENT" } };
    const deps = (w.tables.engine_run_dependencies ??= []);
    for (const k of a.p_keys as { scope: string; key: string }[]) deps.push({ engine_run_id: run.id, scope: k.scope, dep_key: k.key });
    return ok({ recorded: (a.p_keys as unknown[]).length });
  };

  w.rpc.tb_finalize_attempt = (a) => {
    const r = a.p_result as {
      outcome: "certified" | "failed"; error_code?: string;
      upload: { status: string; is_valid: boolean; processing_result: unknown; validation_report?: unknown; accounting_errors: unknown };
      certification?: { normalized_input_hash: string; output_hash: string; is_blocking: boolean; requires_review: boolean; exceptions: unknown[]; rows_snapshot: unknown[] };
    };
    const run = (w.tables.engine_runs ?? []).find((x) => x.id === a.p_engine_run_id);
    const up = run && w.tables.trial_balance_uploads?.find((u) => u.id === run.source_record_id);
    if (!run || !up || run.status !== "running" || up.current_engine_run_id !== run.id) {
      return { data: null, error: { code: "PT409", message: "ATTEMPT_NOT_CURRENT" } };
    }
    let certId: string | null = null;
    if (r.outcome === "certified" && r.certification) {
      certId = `cert-${++seq}`;
      (w.tables.tb_certifications ??= []).push({
        id: certId, upload_id: up.id, sequence_no: seq, engine_run_id: run.id, source_file_hash: up.source_file_hash,
        p_engine_run_id: run.id, p_upload_id: up.id, p_company_id: up.company_id, p_source_file_hash: up.source_file_hash,
        p_normalized_input_hash: r.certification.normalized_input_hash, p_output_hash: r.certification.output_hash,
        p_is_blocking: r.certification.is_blocking, p_requires_review: r.certification.requires_review,
        p_exceptions: r.certification.exceptions, p_rows_snapshot: r.certification.rows_snapshot,
      });
    }
    Object.assign(up, {
      status: r.upload.status, is_valid: r.upload.is_valid, processing_result: r.upload.processing_result,
      validation_report: r.upload.validation_report ?? null, accounting_errors: r.upload.accounting_errors, processed_at: new Date().toISOString(),
    });
    run.status = r.outcome === "certified" ? "completed" : "failed";
    run.error_code = r.outcome === "certified" ? null : r.error_code;
    const key = (w.tables.idempotency_keys ?? []).find((k) => k.engine_run_id === run.id);
    if (key) {
      key.status = run.status === "completed" ? "completed" : "failed";
      key.replay_result = run.status === "completed" ? { status: "completed", reference_id: certId, reference_table: "tb_certifications" } : { status: "failed", error_code: r.error_code };
    }
    return ok({ outcome: r.outcome, certification_id: certId, error_code: r.outcome === "failed" ? r.error_code : null });
  };
}
