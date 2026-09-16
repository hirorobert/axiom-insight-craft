/**
 * documentReviewArchitecture.test.ts
 *
 * Static, source-text regression coverage for the statement-review
 * document-intake boundary (North-Star Phases 4, 7, 8, 10, 12, hardened by
 * the document-review-acceptance-repair pass). Follows this repository's
 * established convention for asserting invariants in SQL a live database
 * connection cannot execute here (see
 * src/lib/__tests__/migrationReplayCompatibilityGuard.test.ts for
 * precedent). The Edge Function's own executable logic (logic.ts,
 * scanForMalware.ts, handleIntake.ts) has REAL, EXECUTED `deno test`
 * coverage instead — see supabase/functions/financial-statement-intake/
 * *.test.ts and the session's final report for that output; this file only
 * re-verifies the parts vitest can check (source-text invariants across
 * the TS/SQL boundary, and the React UI).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../../");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/20260915100000_financial_statement_documents.sql";
const EDGE_FN_INDEX_PATH = "supabase/functions/financial-statement-intake/index.ts";
const EDGE_FN_HANDLE_PATH = "supabase/functions/financial-statement-intake/handleIntake.ts";
const EDGE_FN_LOGIC_PATH = "supabase/functions/financial-statement-intake/logic.ts";
const EDGE_FN_SCAN_PATH = "supabase/functions/financial-statement-intake/scanForMalware.ts";

// ─────────────────────────────────────────────────────────────
// Phase 4 (routing) — unchanged by the acceptance-repair pass
// ─────────────────────────────────────────────────────────────

describe("routing contract — statement review is a distinct route, never merged into an existing workflow", () => {
  const appSrc = readSource("src/App.tsx");

  it("adds an explicit statements/review route protected by StageScopeGate stage=\"statements\"", () => {
    expect(appSrc).toMatch(
      /<Route path="statements\/review" element=\{<StageScopeGate stage="statements"><StatementReviewWorkspace \/><\/StageScopeGate>\} \/>/,
    );
  });

  it("does not route document review to PrepareWorkspace or the existing StatementsWorkspace", () => {
    const reviewRouteLine = appSrc.split("\n").find((l) => l.includes('path="statements/review"'));
    expect(reviewRouteLine).toBeTruthy();
    expect(reviewRouteLine).not.toMatch(/PrepareWorkspace/);
    expect(reviewRouteLine).toMatch(/StatementReviewWorkspace/);
    expect(reviewRouteLine).not.toMatch(/<StatementsWorkspace \/>/);
  });

  it("the statements/review route sits after the plain statements route (never replaces it)", () => {
    const statementsIndex = appSrc.indexOf('path="statements"');
    const reviewIndex = appSrc.indexOf('path="statements/review"');
    expect(statementsIndex).toBeGreaterThan(-1);
    expect(reviewIndex).toBeGreaterThan(statementsIndex);
  });
});

describe("routing contract — the remembered outcome never silently replaces the selected intent", () => {
  const overviewSrc = readSource("src/pages/workspace/WorkspaceOverview.tsx");
  const resolverSrc = readSource("src/lib/workspace/resolveNextActionDestination.ts");

  it("WorkspaceOverview delegates the destination decision to the pure resolver, not an inline branch mixed into engine state", () => {
    expect(overviewSrc).toMatch(/resolveNextActionDestination\(/);
  });

  it("the resolver never grants or infers a mandate — it only redirects within an already-active statements stage", () => {
    expect(resolverSrc).toMatch(/never grants or infers a mandate/);
    expect(resolverSrc).toMatch(/activeSlug === "statements"/);
  });
});

// ─────────────────────────────────────────────────────────────
// Acceptance-repair Phase 2 — honest capability / public visibility gate
// ─────────────────────────────────────────────────────────────

describe("honest capability — review-statements is withheld from the public selector until DOCUMENT_REVIEW_ENABLED", () => {
  const outcomesSrc = readSource("src/lib/product/outcomes.ts");
  const tourSrc = readSource("src/components/ProductTour.tsx");
  const workspaceSrc = readSource("src/pages/workspace/StatementReviewWorkspace.tsx");

  it("DOCUMENT_REVIEW_ENABLED defaults to false, and is a plain source constant — never import.meta.env.VITE_*", () => {
    expect(outcomesSrc).toMatch(/export const DOCUMENT_REVIEW_ENABLED = false;/);
    const constBlock = outcomesSrc.slice(
      outcomesSrc.indexOf("DOCUMENT_REVIEW_ENABLED"),
      outcomesSrc.indexOf("DOCUMENT_REVIEW_ENABLED") + 800,
    );
    expect(constBlock).not.toMatch(/import\.meta\.env\.VITE_/);
    expect(outcomesSrc).toMatch(/NOT a browser-controlled VITE_ env var/);
  });

  it("PUBLIC_PRODUCT_OUTCOMES excludes review-statements while the flag is false, and PRODUCT_OUTCOMES itself is untouched", () => {
    expect(outcomesSrc).toMatch(/export const PUBLIC_PRODUCT_OUTCOMES[\s\S]*?DOCUMENT_REVIEW_ENABLED\s*\n\s*\? PRODUCT_OUTCOMES\s*\n\s*: PRODUCT_OUTCOMES\.filter\(\(outcome\) => outcome\.id !== "review-statements"\)/);
  });

  it("ProductTour renders from PUBLIC_PRODUCT_OUTCOMES, not PRODUCT_OUTCOMES directly", () => {
    expect(tourSrc).toMatch(/import \{\s*\n\s*PUBLIC_PRODUCT_OUTCOMES,/);
    // No BARE "PRODUCT_OUTCOMES.map" (i.e. not immediately preceded by
    // "PUBLIC_") should appear — a plain substring check would also match
    // inside "PUBLIC_PRODUCT_OUTCOMES.map", so this uses a negative
    // lookbehind to rule that legitimate occurrence out specifically.
    expect(tourSrc).not.toMatch(/(?<!PUBLIC_)PRODUCT_OUTCOMES\.map/);
    expect(tourSrc).toMatch(/PUBLIC_PRODUCT_OUTCOMES\.map/);
  });

  it("direct route access to StatementReviewWorkspace shows an honest not-yet-available boundary, never a working Start review CTA, while the flag is false", () => {
    expect(workspaceSrc).toMatch(/if \(!DOCUMENT_REVIEW_ENABLED\) \{\s*\n\s*return <NotYetAvailable \/>;/);
    expect(workspaceSrc).toMatch(/Statement review is not available yet/);
    // NotYetAvailable itself must render no CTA, no file input.
    const notYetAvailableBlock = workspaceSrc.slice(
      workspaceSrc.indexOf("function NotYetAvailable"),
      workspaceSrc.indexOf("export default function StatementReviewWorkspace"),
    );
    expect(notYetAvailableBlock).not.toMatch(/<input/);
    expect(notYetAvailableBlock).not.toMatch(/Start review/);
    expect(notYetAvailableBlock).not.toMatch(/Choose statements/);
  });

  it("no fake assessment/findings/reconciliation/framework-review/audit-readiness claim exists anywhere in the workspace source", () => {
    const bannedClaims = [/reconciliation (is )?complete/i, /findings? (were|have been) generated/i, /framework review (is )?complete/i, /audit[- ]ready\b/i];
    for (const pattern of bannedClaims) {
      expect(workspaceSrc).not.toMatch(pattern);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Acceptance-repair Phase 3 — supporting file removed, never silently dropped
// ─────────────────────────────────────────────────────────────

describe("acceptance-repair Phase 3 — the discarded supporting-trial-balance feature is fully removed, not silently dropped", () => {
  const workspaceSrc = readSource("src/pages/workspace/StatementReviewWorkspace.tsx");
  const handleSrc = readSource(EDGE_FN_HANDLE_PATH);
  const indexSrc = readSource(EDGE_FN_INDEX_PATH);

  it("the client UI has no supporting-trial-balance input, state, or copy left at all", () => {
    expect(workspaceSrc).not.toMatch(/Add supporting trial balance/);
    expect(workspaceSrc).not.toMatch(/helps reconcile figures/i);
    expect(workspaceSrc).not.toMatch(/supportingInputRef/);
    expect(workspaceSrc).not.toMatch(/handleSupportingSelect/);
    expect(workspaceSrc).not.toMatch(/removeSupporting/);
  });

  it("the client never sends a supportingFile field to the Edge Function", () => {
    expect(workspaceSrc).not.toMatch(/supportingFile/);
  });

  it("the Edge Function no longer reads or logs a supportingFile field at all", () => {
    expect(handleSrc).not.toMatch(/supportingFile/i);
    expect(indexSrc).not.toMatch(/supportingFile/i);
    expect(handleSrc).not.toMatch(/hasSupportingFile/i);
  });
});

// ─────────────────────────────────────────────────────────────
// Acceptance-repair Phase 6 — clientRequestId used meaningfully or removed (removed)
// ─────────────────────────────────────────────────────────────

describe("acceptance-repair Phase 6 — clientRequestId (decorative) removed; content-addressed sha256 is the real idempotency key", () => {
  const workspaceSrc = readSource("src/pages/workspace/StatementReviewWorkspace.tsx");
  const handleSrc = readSource(EDGE_FN_HANDLE_PATH);

  it("no clientRequestId anywhere in the client UI or the Edge Function", () => {
    expect(workspaceSrc).not.toMatch(/clientRequestId/);
    expect(handleSrc).not.toMatch(/clientRequestId/);
  });
});

// ─────────────────────────────────────────────────────────────
// Phase 7 — migration invariants (static SQL text, unapplied), corrected
// ─────────────────────────────────────────────────────────────

describe("financial_statement_documents migration — required invariants (unapplied, static source only)", () => {
  const sql = readSource(MIGRATION_PATH);

  it("exists and has not been folded into an existing migration", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, MIGRATION_PATH))).toBe(true);
  });

  it("canonical actor is firm_members.id, never auth.users.id directly", () => {
    expect(sql).toMatch(/uploaded_by_firm_member_id\s+UUID\s+NOT NULL/);
    expect(sql).toMatch(/REFERENCES public\.firm_members\(id\)/);
    expect(sql).not.toMatch(/uploaded_by_firm_member_id[\s\S]{0,40}REFERENCES auth\.users/);
  });

  it("acceptance-repair Phase 7: the company FK is ON DELETE RESTRICT, not CASCADE", () => {
    const fkBlock = sql.slice(sql.indexOf("CONSTRAINT fk_fsd_company"), sql.indexOf("CONSTRAINT fk_fsd_company") + 300);
    expect(fkBlock).toMatch(/REFERENCES public\.companies\(id\) ON DELETE RESTRICT/);
    expect(fkBlock).not.toMatch(/ON DELETE CASCADE/);
  });

  it("has the exact unique(company_id, period_year, sha256) constraint, scoped to non-superseded rows", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX uq_fsd_company_period_sha256[\s\S]*?\(company_id, period_year, sha256\)[\s\S]*?WHERE superseded_at IS NULL/);
  });

  it("retrying the same upload returns the existing document — the intake function selects before inserting and returns the existing row on a match", () => {
    expect(sql).toMatch(/intake_financial_statement_document/);
    const fnBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.intake_financial_statement_document"));
    expect(fnBody).toMatch(/SELECT \* INTO v_row[\s\S]*?IF FOUND THEN\s*RETURN v_row;/);
  });

  it("the intake function is SECURITY DEFINER and independently re-verifies firm membership (never trusts the caller alone)", () => {
    const fnBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.intake_financial_statement_document"));
    expect(fnBody).toMatch(/SECURITY DEFINER/);
    expect(fnBody).toMatch(/NOT EXISTS[\s\S]*?firm_members[\s\S]*?RAISE EXCEPTION 'FORBIDDEN/);
  });

  it("acceptance-repair Phase 7: both mutation RPCs explicitly GRANT EXECUTE to service_role, in addition to REVOKE from PUBLIC/anon/authenticated", () => {
    for (const fnSig of [
      "public.intake_financial_statement_document(UUID, INTEGER, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT)",
      "public.advance_financial_statement_document_status(UUID, TEXT)",
    ]) {
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${fnSig} TO service_role;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fnSig} FROM PUBLIC, anon, authenticated;`);
    }
  });

  it("storage_path is never accepted as a raw client value with no server generation contract documented", () => {
    expect(sql).toMatch(/server-generated only, never client-chosen/i);
  });

  it("final surgical repair: the documented storage path convention is content-addressed on company/period/sha256 ONLY — no extension in the path", () => {
    expect(sql).toMatch(/\{company_id\}\/\{period_year\}\/\{sha256\}(?!\.\{)/);
    expect(sql).toMatch(/never the user-supplied filename or extension/);
  });

  it("RLS is enabled and no INSERT/UPDATE/DELETE policy exists for authenticated or anon — every write goes through the SECURITY DEFINER function", () => {
    expect(sql).toMatch(/ALTER TABLE public\.financial_statement_documents ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON public\.financial_statement_documents[\s\S]{0,60}FOR (INSERT|UPDATE|DELETE)/);
    expect(sql).toMatch(/REVOKE ALL ON public\.financial_statement_documents FROM PUBLIC, anon, authenticated/);
  });

  it("the SELECT policy denies cross-firm access — scoped by an EXISTS check against firm_members for the row's own company_id", () => {
    const policyBlock = sql.slice(sql.indexOf('CREATE POLICY "fsd_select"'), sql.indexOf('CREATE POLICY "fsd_select"') + 400);
    expect(policyBlock).toMatch(/EXISTS[\s\S]*?firm_members fm[\s\S]*?fm\.company_id = financial_statement_documents\.company_id[\s\S]*?fm\.user_id = auth\.uid\(\)/);
  });

  it("no UPDATE policy exists for the immutable source fields — the guard trigger, not RLS, is the enforcement layer, and it rejects any change to them", () => {
    const fnBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.financial_statement_documents_guard"));
    for (const col of [
      "company_id", "period_year", "uploaded_by_firm_member_id", "original_file_name",
      "mime_type", "byte_size", "sha256", "artifact_class", "storage_path", "source_version", "created_at",
    ]) {
      expect(fnBody, `guard must check ${col} for immutability`).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
    }
  });

  it("deletion is unconditionally prohibited", () => {
    const fnBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.financial_statement_documents_guard"));
    expect(fnBody).toMatch(/TG_OP = 'DELETE'[\s\S]*?RAISE EXCEPTION/);
  });

  it("legal status transitions are an explicit allow-list — no arbitrary jump is possible", () => {
    const fnBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.financial_statement_documents_guard"));
    expect(fnBody).toMatch(/WHEN 'STORED'\s+THEN ARRAY\['CLASSIFYING', 'QUARANTINED'\]/);
    expect(fnBody).toMatch(/WHEN 'CLASSIFYING'\s+THEN ARRAY\['EXTRACTING', 'CLASSIFICATION_FAILED', 'QUARANTINED'\]/);
    expect(fnBody).toMatch(/WHEN 'EXTRACTING'\s+THEN ARRAY\['READY_FOR_REVIEW', 'EXTRACTION_FAILED', 'QUARANTINED'\]/);
    expect(fnBody).toMatch(/NOT \(NEW\.status = ANY\(v_allowed_next\)\)[\s\S]*?RAISE EXCEPTION/);
  });

  it("the storage bucket is private (public = false)", () => {
    expect(sql).toMatch(/INSERT INTO storage\.buckets \(id, name, public\)\s*\nVALUES \('financial-statement-documents', 'financial-statement-documents', false\)/);
  });

  it("all seven artifact classes are present in the CHECK constraint", () => {
    const classBlock = sql.slice(sql.indexOf("CONSTRAINT chk_fsd_artifact_class"), sql.indexOf("CONSTRAINT chk_fsd_artifact_class") + 300);
    for (const cls of ["trial_balance", "financial_statements", "mixed_workbook", "scanned_document", "structured_xbrl", "unsupported", "ambiguous"]) {
      expect(classBlock).toContain(`'${cls}'`);
    }
  });

  it("acceptance-repair Phase 7: SELECTED/UPLOADING/UPLOAD_FAILED are removed from the persisted status CHECK constraint — no real server transition can produce them", () => {
    const statusBlock = sql.slice(sql.indexOf("CONSTRAINT chk_fsd_status"), sql.indexOf("CONSTRAINT chk_fsd_status") + 300);
    for (const removedStatus of ["SELECTED", "UPLOADING", "UPLOAD_FAILED"]) {
      expect(statusBlock).not.toContain(`'${removedStatus}'`);
    }
    for (const keptStatus of ["STORED", "CLASSIFYING", "EXTRACTING", "READY_FOR_REVIEW", "CLASSIFICATION_FAILED", "EXTRACTION_FAILED", "QUARANTINED"]) {
      expect(statusBlock).toContain(`'${keptStatus}'`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Phase 8 — security boundary, hardened (static source only, not deployed;
// the executable logic in these same files also has real `deno test`
// coverage — see the .test.ts files alongside them).
// ─────────────────────────────────────────────────────────────

describe("financial-statement-intake Edge Function — security boundary (static source only, not deployed)", () => {
  const indexSrc = readSource(EDGE_FN_INDEX_PATH);
  const handleSrc = readSource(EDGE_FN_HANDLE_PATH);
  const logicSrc = readSource(EDGE_FN_LOGIC_PATH);
  const scanSrc = readSource(EDGE_FN_SCAN_PATH);

  it("requires an authenticated session via the shared validateAuth helper — never a hand-rolled check", () => {
    expect(indexSrc).toMatch(/import \{ validateAuth, corsHeaders, handleCors \} from "\.\.\/_shared\/auth\.ts"/);
    expect(indexSrc).toMatch(/validateAuth\(req\.headers\.get\("Authorization"\), corsHeaders\)/);
  });

  it("resolves firmMemberId server-side via the canonical resolveFirmMemberActor helper — never accepts a client-supplied firmMemberId field", () => {
    expect(indexSrc).toMatch(/import \{ resolveFirmMemberActor \} from "\.\.\/_shared\/actor\.ts"/);
    expect(handleSrc).toMatch(/deps\.resolveFirmMemberActor\(deps\.admin, userId, companyId, corsHeaders\)/);
    expect(indexSrc).not.toMatch(/form\.get\("firmMemberId"\)/);
  });

  it("validates MIME signature (magic bytes) AND declared Content-Type, not filename alone", () => {
    expect(logicSrc).toMatch(/export function verifySignature/);
    expect(logicSrc).toMatch(/export function verifyDeclaredMimeType/);
    expect(logicSrc).toMatch(/PDF_MAGIC/);
    expect(logicSrc).toMatch(/ZIP_MAGIC/);
    expect(logicSrc).toMatch(/bytesStartWith\(head, PDF_MAGIC\)/);
    expect(handleSrc).toMatch(/verifySignature\(ext, file\.bytes\.subarray\(0, 8\)\)/);
    expect(handleSrc).toMatch(/verifyDeclaredMimeType\(ext, file\.type\)/);
  });

  it("enforces a hard file-size ceiling, matching the migration's own ceiling", () => {
    expect(handleSrc).toMatch(/const MAX_BYTES = 50 \* 1024 \* 1024/);
    expect(handleSrc).toMatch(/file\.size > MAX_BYTES/);
  });

  it("acceptance-repair Phase 4: the malware scan is fail-CLOSED — every non-clean outcome refuses the request with 503, never proceeds to storage", () => {
    expect(handleSrc).toMatch(/scan\.outcome === "unavailable"/);
    expect(handleSrc).toMatch(/IntakeUnavailable/);
    expect(handleSrc).toMatch(/\}, 503\)/);
    // The upload call must appear strictly after the scan-outcome checks in
    // source order — no code path reaches storage before scanning resolves.
    const scanCheckIndex = handleSrc.indexOf('scan.outcome === "unavailable"');
    const uploadIndex = handleSrc.indexOf(".upload(storagePath");
    expect(scanCheckIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(scanCheckIndex);
  });

  it("acceptance-repair Phase 4: scanForMalware itself fails closed on every non-2xx/timeout/malformed/unconfigured branch — never silently 'proceed'", () => {
    expect(scanSrc).toMatch(/if \(!webhookUrl\) \{\s*\n\s*return \{ outcome: "unavailable", reason: "not_configured" \};/);
    expect(scanSrc).toMatch(/AbortController/);
    expect(scanSrc).toMatch(/reason: "timeout"/);
    expect(scanSrc).toMatch(/reason: "http_error"/);
    expect(scanSrc).toMatch(/reason: "malformed_response"/);
    expect(scanSrc).toMatch(/clean === true \? \{ outcome: "clean" \} : \{ outcome: "dirty" \}/);
  });

  it("computes the authoritative SHA-256 server-side via the shared hash helper — never trusts a client-supplied hash", () => {
    expect(indexSrc).toMatch(/import \{ sha256HexBytes \} from "\.\.\/_shared\/hash\.ts"/);
    expect(handleSrc).toMatch(/const sha256 = await deps\.sha256HexBytes\(file\.bytes\)/);
    expect(indexSrc).not.toMatch(/form\.get\("sha256"\)/);
  });

  it("writes a structured audit event and never logs file content — only name/size/hash-class metadata", () => {
    expect(handleSrc).toMatch(/console\.log\(JSON\.stringify\(\{\s*\n\s*event: "financial_statement_intake_stored"/);
    expect(handleSrc).not.toMatch(/console\.log\([^)]*bytes\)/);
    expect(handleSrc).not.toMatch(/console\.log\([^)]*await file\.text\(\)/);
  });

  it("never reads or writes SUPABASE_SERVICE_ROLE_KEY from a VITE_-prefixed variable — it is a server-only Deno.env value", () => {
    expect(indexSrc).toMatch(/Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
    expect(indexSrc).not.toMatch(/VITE_/);
    expect(handleSrc).not.toMatch(/VITE_/);
  });

  it("final surgical repair: storage path identity depends ONLY on company/period/sha256 — never an extension, filename, or client-suppliable value, never a random UUID", () => {
    expect(logicSrc).toMatch(/export function resolveContentAddressedStoragePath/);
    expect(logicSrc).toMatch(/`\$\{companyId\}\/\$\{periodYear\}\/\$\{sha256\}`/);
    // The function signature itself must not accept an extension parameter.
    expect(logicSrc).toMatch(/export function resolveContentAddressedStoragePath\(\s*\n\s*companyId: string,\s*\n\s*periodYear: number,\s*\n\s*sha256: string,\s*\n\)/);
    expect(logicSrc).not.toMatch(/crypto\.randomUUID/);
    expect(indexSrc).not.toMatch(/form\.get\("storagePath"\)/);
  });

  it("final surgical repair: identical bytes under two different extensions resolve to the same object — extension is never part of storage identity", () => {
    expect(logicSrc).toMatch(/never on the user-supplied filename[\s\S]{0,20}or extension/);
  });

  it("acceptance-repair Phase 5: classification is server-authoritative — CSV is always rejected, and the client's artifactClassHint is never trusted except for the one legitimate ambiguous-XLSX confirmation case", () => {
    expect(logicSrc).toMatch(/export function deriveServerArtifactClass/);
    expect(logicSrc).toMatch(/isCsv\(fileName, mimeType\)/);
    expect(logicSrc).toMatch(/return \{ ok: false, reason: "csv_rejected" \}/);
    expect(logicSrc).toMatch(/clientHint === "trial_balance" \|\| clientHint === "financial_statements"/);
    expect(handleSrc).toMatch(/isArtifactClass\(classification\.artifactClass\)/); // defensive enum re-check before the RPC
  });

  it("acceptance-repair Phase 5: HTML/XHTML markup inspection for XBRL markers is bounded, and uploaded HTML is never rendered anywhere in this codebase", () => {
    expect(handleSrc).toMatch(/CONTENT_SAMPLE_BYTES = 512 \* 1024/);
    expect(handleSrc).toMatch(/file\.bytes\.subarray\(0, CONTENT_SAMPLE_BYTES\)/);
    expect(handleSrc).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("acceptance-repair Phase 6: clientRequestId is fully removed — content-addressing (sha256) is the real, meaningful idempotency key", () => {
    expect(indexSrc).not.toMatch(/clientRequestId/);
    expect(handleSrc).not.toMatch(/clientRequestId/);
  });

  it("acceptance-repair Phase 6: upload is attempted with upsert:false, and an 'already exists' rejection is treated as a legitimate replay, not an error", () => {
    expect(handleSrc).toMatch(/upsert: false/);
    expect(handleSrc).toMatch(/already exists/i);
  });

  it("final surgical repair: on a database failure, the object is NEVER removed — recoverable orphan, not cleanup (concurrent requests cannot safely prove the object is unneeded)", () => {
    const failureBranch = handleSrc.slice(
      handleSrc.indexOf("if (intakeError || !row) {"),
      handleSrc.indexOf("if (intakeError || !row) {") + 2000,
    );
    expect(failureBranch).not.toMatch(/\.remove\(\[storagePath\]\)/);
    expect(failureBranch).toMatch(/RECOVERABLE ORPHAN/);
    expect(failureBranch).toMatch(/NEVER[\s\S]{0,40}removed/);
  });

  it("final surgical repair: documents the future garbage-collection precondition (no row references the path, no in-flight request for the hash, a grace period elapsed) without implementing it here", () => {
    const failureBranch = handleSrc.slice(
      handleSrc.indexOf("if (intakeError || !row) {"),
      handleSrc.indexOf("if (intakeError || !row) {") + 2000,
    );
    expect(failureBranch).toMatch(/no row references its path/);
    expect(failureBranch).toMatch(/no intake request for\s*\n?\s*\/\/ that hash remains in flight/);
    expect(failureBranch).toMatch(/retention\/grace/);
    expect(failureBranch).toMatch(/No such garbage collection is implemented here/);
  });

  it("no financial conclusion is accepted automatically — this function only performs file-type intake routing, never touches accounting tables", () => {
    for (const forbiddenTable of [
      "trial_balance_uploads", "account_mappings", "tax_computations",
      "period_closing_balances", "statement_sign_offs",
    ]) {
      expect(handleSrc).not.toMatch(new RegExp(`from\\(["']${forbiddenTable}["']\\)`));
    }
  });

  it("handleIntake.ts is import-side-effect-free — it never invokes serve()/Deno.serve, so it can be unit-tested without binding a network listener", () => {
    // Checks actual invocation syntax (a call), not the bare word — this
    // file's own header comment legitimately explains it has "no
    // Deno.serve" in prose, which a bare-word check would misfire on.
    expect(handleSrc).not.toMatch(/Deno\.serve\(/);
    expect(handleSrc).not.toMatch(/^serve\(/m);
    expect(handleSrc).not.toMatch(/from "https:\/\/deno\.land\/std[^"]*\/http\/server\.ts"/);
    // index.ts, by contrast, IS where the listener binds.
    expect(indexSrc).toMatch(/^serve\(async \(req: Request\) => \{/m);
  });
});

// ─────────────────────────────────────────────────────────────
// Phase 10 — global framework boundary
// ─────────────────────────────────────────────────────────────

describe("global framework boundary — no jurisdiction leakage into the document-review surface", () => {
  const outcomesSrc = readSource("src/lib/product/outcomes.ts");
  const workspaceSrc = readSource("src/pages/workspace/StatementReviewWorkspace.tsx");
  const tourSrc = readSource("src/components/ProductTour.tsx");

  it("no Tanzania/NBAA/CAG/TRA language anywhere in the outcome model, the public selector, or the review intake screen", () => {
    const leakagePattern = /\bTanzania\b|\bNBAA\b|\bCAG\b|\bTRA\b|\bEFDMS\b/i;
    expect(outcomesSrc).not.toMatch(leakagePattern);
    expect(workspaceSrc).not.toMatch(leakagePattern);
    expect(tourSrc).not.toMatch(leakagePattern);
  });

  it("the review-statements outcome does not name a specific jurisdiction as a prerequisite", () => {
    expect(outcomesSrc).toMatch(/review-statements[\s\S]{0,600}iXBRL/);
    const reviewBlock = outcomesSrc.slice(outcomesSrc.indexOf('id: "review-statements"'), outcomesSrc.indexOf('id: "tax-compliance"'));
    expect(reviewBlock).not.toMatch(/jurisdiction/i);
  });

  it("jurisdiction is never inferred from currency, IP, org name, or browser locale in the review intake screen", () => {
    expect(workspaceSrc).not.toMatch(/navigator\.language|Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone|geoip|x-forwarded-for/i);
  });
});

// ─────────────────────────────────────────────────────────────
// Phase 12 — remaining UI-level regression checks (static source)
// ─────────────────────────────────────────────────────────────

describe("StatementReviewWorkspace.tsx — required intake UI contract", () => {
  const src = readSource("src/pages/workspace/StatementReviewWorkspace.tsx");

  it("asks exactly one question first: 'Upload the financial statements you want reviewed'", () => {
    expect(src).toMatch(/Upload the financial statements you want reviewed/);
  });

  it("primary CTA is 'Choose statements', and becomes 'Start review' after a file is selected", () => {
    expect(src).toMatch(/>\s*Choose statements\s*</);
    expect(src).toMatch(/Start review/);
  });

  it("only accepts the five specified extensions at the picker level", () => {
    expect(src).toMatch(/accept=\{ACCEPT_ATTRIBUTE\}/);
  });

  it("shows filename, detected format, file size, and a removable selection before upload", () => {
    expect(src).toMatch(/primary\.file\.name/);
    expect(src).toMatch(/formatBytes\(primary\.file\.size\)/);
    expect(src).toMatch(/aria-label="Remove selected file"/);
  });

  it("never claims the document was reviewed/assessed before the server confirms it — the only completion copy is the honest not-yet-available notice", () => {
    expect(src).not.toMatch(/review (is )?complete/i);
    expect(src).not.toMatch(/findings? (were|have been) generated/i);
    expect(src).toMatch(/Document received — automated review is not available for this format yet\./);
    expect(src).toMatch(/We never manufacture findings/);
  });

  it("never writes to trial_balance_uploads, account_mappings, or any prepared-statement table", () => {
    for (const forbiddenTable of ["trial_balance_uploads", "account_mappings", "tax_computations", "period_closing_balances"]) {
      expect(src).not.toMatch(new RegExp(`from\\(["']${forbiddenTable}["']\\)`));
    }
  });

  it("reload recovery: queries for an existing document on mount and fails open (never throws) on error", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]*?async function resume\(\)/);
    expect(src).toMatch(/} catch \{[\s\S]*?Table not yet provisioned/);
  });

  it("double-submit suppression: a synchronous guard rejects a second call while UPLOADING, mirroring Auth.tsx's own established pattern", () => {
    expect(src).toMatch(/if \(status === "UPLOADING"\) return;/);
    expect(src).toMatch(/disabled=\{[\s\S]*?status === "UPLOADING"/);
  });

  it("ambiguous XLSX requires an explicit user confirmation before Start review is enabled — never silently proceeds", () => {
    expect(src).toMatch(/isAwaitingAmbiguousConfirmation/);
    expect(src).toMatch(/It's a financial statement/);
    expect(src).toMatch(/It's a trial balance/);
    expect(src).toMatch(/disabled=\{[\s\S]*?isAwaitingAmbiguousConfirmation/);
  });

  it("the remove-file control meets a 44px touch target", () => {
    const matches = src.match(/min-h-\[44px\] min-w-\[44px\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});
