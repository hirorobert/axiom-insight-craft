/**
 * documentReviewArchitecture.test.ts
 *
 * Static, source-text regression coverage for the statement-review
 * document-intake boundary (North-Star Phases 4, 7, 8, 10, 12). Follows
 * this repository's established convention for asserting invariants in SQL
 * a live database connection cannot execute here, and in Edge Function code
 * no Deno runtime can execute here (see
 * src/lib/__tests__/migrationReplayCompatibilityGuard.test.ts and
 * supabase/functions/_shared/actor.ts's own header comment for precedent).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../../");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/20260915100000_financial_statement_documents.sql";
const EDGE_FN_PATH = "supabase/functions/financial-statement-intake/index.ts";

// ─────────────────────────────────────────────────────────────
// Phase 4 — routing contract
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
// Phase 7 — migration invariants (static SQL text, unapplied)
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

  it("storage_path is never accepted as a raw client value with no server generation contract documented", () => {
    expect(sql).toMatch(/server-generated only, never client-chosen/i);
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

  it("all seven artifact classes and the full status vocabulary are present in their CHECK constraints", () => {
    for (const cls of ["trial_balance", "financial_statements", "mixed_workbook", "scanned_document", "structured_xbrl", "unsupported", "ambiguous"]) {
      expect(sql).toContain(`'${cls}'`);
    }
    for (const status of ["SELECTED", "UPLOADING", "STORED", "CLASSIFYING", "EXTRACTING", "READY_FOR_REVIEW", "UPLOAD_FAILED", "CLASSIFICATION_FAILED", "EXTRACTION_FAILED", "QUARANTINED"]) {
      expect(sql).toContain(`'${status}'`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Phase 8 — security boundary (static source only, not deployed)
// ─────────────────────────────────────────────────────────────

describe("financial-statement-intake Edge Function — security boundary (static source only, not deployed)", () => {
  const fnSrc = readSource(EDGE_FN_PATH);

  it("requires an authenticated session via the shared validateAuth helper — never a hand-rolled check", () => {
    expect(fnSrc).toMatch(/import \{ validateAuth, corsHeaders, handleCors \} from "\.\.\/_shared\/auth\.ts"/);
    expect(fnSrc).toMatch(/validateAuth\(req\.headers\.get\("Authorization"\), corsHeaders\)/);
  });

  it("resolves firmMemberId server-side via the canonical resolveFirmMemberActor helper — never accepts a client-supplied firmMemberId field", () => {
    expect(fnSrc).toMatch(/import \{ resolveFirmMemberActor \} from "\.\.\/_shared\/actor\.ts"/);
    expect(fnSrc).toMatch(/resolveFirmMemberActor\(admin, auth!\.userId, companyId, corsHeaders\)/);
    expect(fnSrc).not.toMatch(/form\.get\("firmMemberId"\)/);
  });

  it("validates MIME signature (magic bytes), not filename/declared-mimetype alone", () => {
    expect(fnSrc).toMatch(/function verifySignature/);
    expect(fnSrc).toMatch(/PDF_MAGIC/);
    expect(fnSrc).toMatch(/ZIP_MAGIC/);
    expect(fnSrc).toMatch(/bytesStartWith\(head, PDF_MAGIC\)/);
  });

  it("enforces a hard file-size ceiling before reading the full file into memory only once, matching the migration's own ceiling", () => {
    expect(fnSrc).toMatch(/const MAX_BYTES = 50 \* 1024 \* 1024/);
    expect(fnSrc).toMatch(/file\.size > MAX_BYTES/);
  });

  it("documents the archive-bomb mitigation for this stage explicitly (no decompression happens at intake)", () => {
    expect(fnSrc).toMatch(/Archive-bomb note/i);
  });

  it("has a named malware/quarantine extension point and is honest that it is a no-op until configured", () => {
    expect(fnSrc).toMatch(/MALWARE_SCAN_WEBHOOK_URL/);
    expect(fnSrc).toMatch(/explicitly a no-op today/);
  });

  it("computes the authoritative SHA-256 server-side via the shared hash helper — never trusts a client-supplied hash", () => {
    expect(fnSrc).toMatch(/import \{ sha256HexBytes \} from "\.\.\/_shared\/hash\.ts"/);
    expect(fnSrc).toMatch(/const sha256 = await sha256HexBytes\(bytes\)/);
    expect(fnSrc).not.toMatch(/form\.get\("sha256"\)/);
  });

  it("accepts a clientRequestId for idempotency-safety-net purposes, logged but never itself the dedup boundary (content hash is)", () => {
    expect(fnSrc).toMatch(/clientRequestId/);
  });

  it("writes a structured audit event and never logs file content — only name/size/hash-class metadata", () => {
    expect(fnSrc).toMatch(/console\.log\(JSON\.stringify\(\{\s*\n\s*event: "financial_statement_intake_stored"/);
    expect(fnSrc).not.toMatch(/console\.log\([^)]*bytes\)/);
    expect(fnSrc).not.toMatch(/console\.log\([^)]*await file\.text\(\)/);
  });

  it("never reads or writes SUPABASE_SERVICE_ROLE_KEY from a VITE_-prefixed variable — it is a server-only Deno.env value", () => {
    expect(fnSrc).toMatch(/Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
    expect(fnSrc).not.toMatch(/VITE_/);
  });

  it("stores to a private, non-public bucket path with no client-suppliable storage path", () => {
    expect(fnSrc).toMatch(/const BUCKET = "financial-statement-documents"/);
    expect(fnSrc).toMatch(/const storagePath = `\$\{companyId\}\/\$\{periodYear\}\/\$\{crypto\.randomUUID\(\)\}/);
    expect(fnSrc).not.toMatch(/form\.get\("storagePath"\)/);
  });

  it("never accepts a client-supplied artifact class as final truth for a rejection-critical rule — re-enforces CSV-never-becomes-statements server-side independently of the client hint", () => {
    expect(fnSrc).toMatch(/function rejectCsvAsStatements/);
    expect(fnSrc).toMatch(/rejectCsvAsStatements\(file\.name, file\.type, artifactClassHint\)/);
  });

  it("no financial conclusion is accepted automatically — this function only performs file-type intake routing, never touches accounting tables", () => {
    for (const forbiddenTable of [
      "trial_balance_uploads", "account_mappings", "tax_computations",
      "period_closing_balances", "statement_sign_offs",
    ]) {
      expect(fnSrc).not.toMatch(new RegExp(`from\\(["']${forbiddenTable}["']\\)`));
    }
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

  it("offers an optional secondary 'Add supporting trial balance' input, never required", () => {
    expect(src).toMatch(/Add supporting trial balance/);
    expect(src).toMatch(/Optional — helps reconcile figures during review\./);
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

  it("both the remove-file and remove-supporting-file controls meet a 44px touch target", () => {
    const matches = src.match(/min-h-\[44px\] min-w-\[44px\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
