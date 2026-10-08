/**
 * 20261017100000 (sign-off completion requirements) re-creates fs_publication_blockers. Pinned here: the new body is
 * the 20260919110000 body BYTE FOR BYTE plus exactly the two marked [20261017100000] additions (and their two
 * variables) — nothing else changed; fs_set_publication_state is not re-created (one sign-off path); no withheld tax
 * service is referenced. Behaviour is proven on real PostgreSQL by scripts/db-proof/closeReviewAuthority.mjs
 * ("Sign-off"), and run.mjs proves the earlier persistence contracts on the chain before this migration.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8");
const fnBody = (sql: string) => {
  const i = sql.indexOf("CREATE OR REPLACE FUNCTION public.fs_publication_blockers(p_company_id UUID, p_report_id TEXT, p_version INTEGER)");
  return sql.slice(i, sql.indexOf("$$;", i) + 3);
};
const NEW = read("20261017100000_signoff_completion_requirements.sql");
const OLD = read("20260919110000_financial_statements_persistence.sql");

describe("20261017100000 — fs_publication_blockers re-created with only the marked additions", () => {
  it("removing the two marked additions and their variables gives the original body exactly", () => {
    let b = fnBody(NEW);
    const start = b.indexOf("  -- [20261017100000] A trial-balance report is final only");
    const end = b.indexOf("  IF NOT EXISTS (SELECT 1 FROM public.financial_statement_evaluations e");
    expect(start).toBeGreaterThan(0);
    b = b.slice(0, start) + b.slice(end);
    const compStart = b.indexOf("    -- [20261017100000] The first-period exception");
    const compEnd = b.indexOf("    END IF;", compStart) + "    END IF;".length;
    b = b.slice(0, compStart) + "    IF v_req.comparatives_required AND NOT v_comp_any THEN v_out := array_append(v_out, 'COMPARATIVE_PERIOD_MISSING'); END IF;" + b.slice(compEnd);
    b = b.replace("  v_input    JSONB;\n  v_hashes   TEXT[];\n", "");
    expect(b).toBe(fnBody(OLD));
  });
  it("one sign-off path: the publication function is not re-created; grants stay revoked from clients; no tax engine", () => {
    expect(NEW).not.toMatch(/FUNCTION public\.fs_set_publication_state/);
    expect(NEW).toMatch(/REVOKE ALL ON FUNCTION public\.fs_publication_blockers\(UUID, TEXT, INTEGER\) FROM PUBLIC, anon, authenticated;/);
    expect(NEW).not.toMatch(/kinga|tax_computations|generate-disclosure-notes|generate-management-letter/i);
  });
  it("the new requirements are named and fail closed (a non-current input is never treated as current)", () => {
    for (const code of ["REPORTING_INPUT_NOT_AUTHORITATIVE:", "REPORTING_INPUT_STALE", "CLOSE_REVIEW_FINDINGS_NOT_CHECKED", "CLOSE_REVIEW_BLOCKING_FINDINGS:", "CLOSE_REVIEW_ADJUSTMENTS_UNDECIDED:"]) {
      expect(NEW, code).toContain(`'${code}`);
    }
    expect(NEW).toMatch(/IF v_input ->> 'state' IS DISTINCT FROM 'current' THEN/);
    expect(NEW).toMatch(/array_length\(v_hashes, 1\) <> 1 OR v_hashes\[1\] IS DISTINCT FROM v_input ->> 'inputSha256'/);
  });
});

describe("the server's blockers in plain words", () => {
  it("every new requirement has words; the code stays visible; unknown codes are shown as is", async () => {
    const { blockerSentence } = await import("./serverBlockers");
    expect(blockerSentence("CLOSE_REVIEW_BLOCKING_FINDINGS:2")).toBe("2 blocking Close Review findings are unresolved.");
    expect(blockerSentence("CLOSE_REVIEW_ADJUSTMENTS_UNDECIDED:1")).toBe("1 adjustment is awaiting approval or rejection.");
    expect(blockerSentence("REPORTING_INPUT_NOT_AUTHORITATIVE:no_authority")).toMatch(/no authority/);
    for (const c of ["REPORTING_INPUT_STALE", "CLOSE_REVIEW_FINDINGS_NOT_CHECKED", "COMPARATIVE_PERIOD_MISSING"]) expect(blockerSentence(c), c).toBeTruthy();
    expect(blockerSentence("MISSING_STATEMENT:STATEMENT_OF_CASH_FLOWS")).toBeNull();
    const ui = fs.readFileSync(path.join(ROOT, "src/components/financialStatements/EvidenceUi.tsx"), "utf8");
    expect(ui).toMatch(/<span className="font-mono">\(\{b\}\)<\/span>/);
  });
});
