import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "../../../../../");
const aliasPath = path.join(
  ROOT,
  "supabase/migrations/20260913054040_56b232d3-6503-4586-8166-151c46a08f0e.sql",
);
const source = fs.readFileSync(aliasPath, "utf8");
const executable = source.replace(/--.*$/gm, "");

/**
 * Normalizes only trailing whitespace/newline differences: CRLF/CR line
 * terminators are folded to LF throughout (a legitimate newline-style
 * difference, not a content difference), then trailing whitespace at the
 * very end of the file only is trimmed. Nothing mid-file is altered, so any
 * real divergence in executable SQL, a function body, a GRANT/REVOKE, or a
 * COMMENT still produces a mismatch.
 */
function normalizeTrailingWhitespaceOnly(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

/** Extracts a top-level statement (through its terminating `;`) by its opening marker. */
function extractStatement(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const end = text.indexOf(";", start);
  if (end === -1) throw new Error(`no terminating ; found for marker: ${marker}`);
  return text.slice(start, end + 1);
}

/** Extracts a full dollar-quoted `CREATE OR REPLACE FUNCTION ... $$;` body by its signature marker. */
function extractFunctionBody(text: string, signatureMarker: string): string {
  const start = text.indexOf(signatureMarker);
  if (start === -1) throw new Error(`function signature not found: ${signatureMarker}`);
  const end = text.indexOf("$$;", text.indexOf("AS $$", start));
  if (end === -1) throw new Error(`no closing $$; found for: ${signatureMarker}`);
  return text.slice(start, end + "$$;".length);
}

describe("Lovable Ω3.0 managed-version ledger alias", () => {
  it("preserves immutable provenance for both the original duplicate and canonical prerequisite", () => {
    expect(source).toContain(
      "f9b20aebec427be664e7249cf420b1ec0957f40d8ae98d6346b9ae20316ba11b",
    );
    expect(source).toContain(
      "3ad41a7cf2280843d49176b20976395b5cff5bdb10f6abe14b734431cb9f11c7",
    );
  });

  it("contains assertions only and no executable schema, privilege, or row mutation", () => {
    expect(executable).not.toMatch(
      /\b(?:CREATE|REPLACE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|COMMENT)\b/i,
    );
    expect(executable).not.toMatch(/\bEXECUTE\b\s+(?:format\s*\(|[^;]+)/i);
    expect(executable).toMatch(/SET search_path TO public, pg_catalog;/);
    expect(executable).toMatch(/DO \$omega3_ledger_alias\$/);
  });

  it("fails closed over every canonical Ω3.0 structural boundary", () => {
    for (const required of [
      "commercial_currencies",
      "commercial_platform_state",
      "commercial_offers",
      "effective_range",
      "effective_history_protected",
      "request_fingerprint",
      "excl_co_no_overlapping_purchasable_periods",
      "chk_ccae_entity_type",
      "uq_co_current_offer",
      "trg_commercial_offers_effective_history_ratchet",
      "trg_commercial_offers_economic_integrity",
      "admin_supersede_commercial_offer",
      "admin_transition_platform_state",
      "cc_select_public",
      "cps_select_admin_only",
    ]) {
      expect(executable).toContain(required);
    }
  });

  it("asserts function hardening, currency authority, and the platform singleton without changing them", () => {
    expect(executable).toContain("p.prosecdef");
    expect(executable).toContain("search_path=public, pg_catalog");
    expect(executable).toContain("has_function_privilege('anon'");
    expect(executable).toContain("has_function_privilege('authenticated'");
    for (const currency of ["TZS", "USD", "KES", "GBP", "EUR"]) {
      expect(executable).toContain(`('${currency}',`);
    }
    expect(executable).toMatch(/WHERE id = true[\s\S]*state IN/);
    expect(executable).toMatch(/IF v_count <> 1 THEN/);
  });
});

// ============================================================
// Ω5 alias-divergence guard — a second Lovable-managed migration-ledger
// alias. Lovable's own tooling wrote 20260913165425_b9a0a379-...sql as an
// independent copy of the forward-only Ω5 billing-projection migration
// (20260914120000_omega5_billing_projection_truth.sql) rather than
// recognizing it as already applied. Both files must remain in the
// migration directory (neither may be edited, deleted, renamed, or
// reapplied — replay-order guards elsewhere pin both filenames), so this
// guard instead proves, directly from source text, that the two files are
// semantically identical: the same executable SQL, the same function
// definitions, the same GRANT/REVOKE/COMMENT statements, and the same
// SECURITY DEFINER/search_path hardening. Only trailing whitespace/newline
// differences are normalized away; any other divergence fails this test.
// ============================================================

describe("Ω5 alias-divergence guard — 20260913165425 vs. 20260914120000 are semantically identical", () => {
  const ALIAS_FILE = "20260913165425_b9a0a379-313f-48ec-8878-e6f0aefff5a7.sql";
  const CANONICAL_FILE = "20260914120000_omega5_billing_projection_truth.sql";
  const aliasFullPath = path.join(ROOT, "supabase/migrations", ALIAS_FILE);
  const canonicalFullPath = path.join(ROOT, "supabase/migrations", CANONICAL_FILE);

  it("both migration files exist in supabase/migrations/", () => {
    expect(fs.existsSync(aliasFullPath)).toBe(true);
    expect(fs.existsSync(canonicalFullPath)).toBe(true);
  });

  it("are byte-for-byte identical after normalizing only trailing whitespace/newline differences — this alone fails on ANY divergence anywhere in the file, including executable SQL, function bodies, grants, revokes, comments, or security properties", () => {
    const aliasRaw = fs.readFileSync(aliasFullPath, "utf8");
    const canonicalRaw = fs.readFileSync(canonicalFullPath, "utf8");
    expect(normalizeTrailingWhitespaceOnly(aliasRaw)).toBe(normalizeTrailingWhitespaceOnly(canonicalRaw));
  });

  // The whole-file equality check above is already sufficient and exhaustive.
  // The remaining assertions in this block are deliberately redundant,
  // component-level checks: if the whole-file check above is ever weakened
  // or narrowed, these still independently pin the specific properties the
  // directive named by name, and their failure messages identify exactly
  // which named property diverged rather than only "files differ".

  it("both define get_my_billing_summary() with an identical SECURITY DEFINER function body", () => {
    const aliasRaw = fs.readFileSync(aliasFullPath, "utf8");
    const canonicalRaw = fs.readFileSync(canonicalFullPath, "utf8");
    const aliasFn = extractFunctionBody(aliasRaw, "CREATE OR REPLACE FUNCTION public.get_my_billing_summary()");
    const canonicalFn = extractFunctionBody(canonicalRaw, "CREATE OR REPLACE FUNCTION public.get_my_billing_summary()");
    expect(normalizeTrailingWhitespaceOnly(aliasFn)).toBe(normalizeTrailingWhitespaceOnly(canonicalFn));
    expect(aliasFn).toMatch(/SECURITY DEFINER/);
    expect(aliasFn).toMatch(/SET search_path = public, pg_catalog/);
  });

  it("both define get_checkout_status(TEXT) with an identical SECURITY DEFINER function body", () => {
    const aliasRaw = fs.readFileSync(aliasFullPath, "utf8");
    const canonicalRaw = fs.readFileSync(canonicalFullPath, "utf8");
    const aliasFn = extractFunctionBody(aliasRaw, "CREATE OR REPLACE FUNCTION public.get_checkout_status(p_saff_reference TEXT)");
    const canonicalFn = extractFunctionBody(canonicalRaw, "CREATE OR REPLACE FUNCTION public.get_checkout_status(p_saff_reference TEXT)");
    expect(normalizeTrailingWhitespaceOnly(aliasFn)).toBe(normalizeTrailingWhitespaceOnly(canonicalFn));
    expect(aliasFn).toMatch(/SECURITY DEFINER/);
    expect(aliasFn).toMatch(/SET search_path = public, pg_catalog/);
  });

  it("both files carry identical REVOKE/GRANT pairs for both functions, in the same order", () => {
    const aliasRaw = fs.readFileSync(aliasFullPath, "utf8");
    const canonicalRaw = fs.readFileSync(canonicalFullPath, "utf8");
    for (const marker of [
      "REVOKE ALL ON FUNCTION public.get_my_billing_summary() FROM PUBLIC, anon;",
      "GRANT EXECUTE ON FUNCTION public.get_my_billing_summary() TO authenticated;",
      "REVOKE ALL ON FUNCTION public.get_checkout_status(TEXT) FROM PUBLIC, anon;",
      "GRANT EXECUTE ON FUNCTION public.get_checkout_status(TEXT) TO authenticated;",
    ]) {
      expect(aliasRaw, `alias file missing: ${marker}`).toContain(marker);
      expect(canonicalRaw, `canonical file missing: ${marker}`).toContain(marker);
    }
    const aliasOrder = [
      aliasRaw.indexOf("REVOKE ALL ON FUNCTION public.get_my_billing_summary()"),
      aliasRaw.indexOf("GRANT EXECUTE ON FUNCTION public.get_my_billing_summary()"),
      aliasRaw.indexOf("REVOKE ALL ON FUNCTION public.get_checkout_status(TEXT)"),
      aliasRaw.indexOf("GRANT EXECUTE ON FUNCTION public.get_checkout_status(TEXT)"),
    ];
    const canonicalOrder = [
      canonicalRaw.indexOf("REVOKE ALL ON FUNCTION public.get_my_billing_summary()"),
      canonicalRaw.indexOf("GRANT EXECUTE ON FUNCTION public.get_my_billing_summary()"),
      canonicalRaw.indexOf("REVOKE ALL ON FUNCTION public.get_checkout_status(TEXT)"),
      canonicalRaw.indexOf("GRANT EXECUTE ON FUNCTION public.get_checkout_status(TEXT)"),
    ];
    expect(aliasOrder.every((v, i) => i === 0 || v > aliasOrder[i - 1])).toBe(true);
    expect(canonicalOrder.every((v, i) => i === 0 || v > canonicalOrder[i - 1])).toBe(true);
  });

  it("both files carry an identical COMMENT ON FUNCTION for both functions", () => {
    const aliasRaw = fs.readFileSync(aliasFullPath, "utf8");
    const canonicalRaw = fs.readFileSync(canonicalFullPath, "utf8");
    const aliasSummaryComment = extractStatement(aliasRaw, "COMMENT ON FUNCTION public.get_my_billing_summary()");
    const canonicalSummaryComment = extractStatement(canonicalRaw, "COMMENT ON FUNCTION public.get_my_billing_summary()");
    expect(normalizeTrailingWhitespaceOnly(aliasSummaryComment)).toBe(normalizeTrailingWhitespaceOnly(canonicalSummaryComment));

    const aliasStatusComment = extractStatement(aliasRaw, "COMMENT ON FUNCTION public.get_checkout_status(TEXT)");
    const canonicalStatusComment = extractStatement(canonicalRaw, "COMMENT ON FUNCTION public.get_checkout_status(TEXT)");
    expect(normalizeTrailingWhitespaceOnly(aliasStatusComment)).toBe(normalizeTrailingWhitespaceOnly(canonicalStatusComment));
  });

  it("the only actual divergence between the two files is a trailing newline at end-of-file (documents the exact, narrow difference this guard tolerates)", () => {
    const aliasRaw = fs.readFileSync(aliasFullPath, "utf8");
    const canonicalRaw = fs.readFileSync(canonicalFullPath, "utf8");
    // Un-normalized raw content must actually differ (otherwise this test
    // would be vacuous) — and that difference must disappear once trailing
    // whitespace/newlines are normalized.
    expect(aliasRaw).not.toBe(canonicalRaw);
    expect(normalizeTrailingWhitespaceOnly(aliasRaw)).toBe(normalizeTrailingWhitespaceOnly(canonicalRaw));
  });
});
