/**
 * R0 release: functions with an OPEN registered defect refuse on the server, before authentication or any read or write
 * (supabase/functions/_shared/openDefectRestriction.ts). The real handlers are also called on PostgreSQL by
 * scripts/db-proof/tbHandlerCharacterization.mjs (REQ-RESTRICTED-*).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OPEN_DEFECT_RESTRICTIONS, openDefectRefusal, SERVICE_RESTRICTED_BODY, WITHHELD_SERVICES } from "../../../supabase/functions/_shared/openDefectRestriction";

const fnSrc = (fn: string) => readFileSync(resolve(__dirname, `../../../supabase/functions/${fn}/index.ts`), "utf8").replace(/\r\n/g, "\n");
const claude = readFileSync(resolve(__dirname, "../../../CLAUDE.md"), "utf8");

describe("open-defect restrictions", () => {
  it("restricts exactly the two functions whose registered defects are open", () => {
    expect(OPEN_DEFECT_RESTRICTIONS).toEqual({
      "kinga-findings-engine": "mapping-tenancy-001",
      "maono-compute": "untracked-classification-tables-001",
    });
    // Each key is a registered, still-open defect (lifting the restriction is the fix's own change).
    const registered: Record<string, string> = {
      "mapping-tenancy-001": "DEFECT-KINGA-MAPPING-TENANCY-001",
      "untracked-classification-tables-001": "DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001",
    };
    for (const k of Object.values(OPEN_DEFECT_RESTRICTIONS)) expect(claude).toContain(registered[k]);
  });
  it("answers 503 with neutral copy (no engine or defect names); unrestricted functions get null", async () => {
    const r = openDefectRefusal("maono-compute", { "Access-Control-Allow-Origin": "*" })!;
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toEqual({ ...SERVICE_RESTRICTED_BODY });
    expect(JSON.stringify(body)).not.toMatch(/kinga|maono|hesabu|safisha|defect/i);
    expect(openDefectRefusal("process-trial-balance", {})).toBeNull();
    expect(openDefectRefusal("maono-cashflow", {})).toBeNull();
  });
  it("withholds exactly tax, notes and the management letter from R0, with the same refusal", async () => {
    expect(WITHHELD_SERVICES).toEqual({
      "kinga-tax-engine": "withheld-r0", "generate-disclosure-notes": "withheld-r0", "generate-management-letter": "withheld-r0",
    });
    for (const fn of Object.keys(WITHHELD_SERVICES)) {
      const r = openDefectRefusal(fn, {})!;
      expect([r.status, await r.json()], fn).toEqual([503, { ...SERVICE_RESTRICTED_BODY }]);
    }
    // Their defects are recorded for the change that releases them.
    expect(claude).toContain("DEFECT-WITHHELD-TAX-NOTES-LETTER-001");
  });
  for (const fn of [...Object.keys(OPEN_DEFECT_RESTRICTIONS), ...Object.keys(WITHHELD_SERVICES)]) {
    it(`${fn} refuses right after the CORS preflight, before authentication, a client, or any read`, () => {
      const src = fnSrc(fn);
      const handler = src.indexOf("serve(async (req");
      const options = src.indexOf('if (req.method === "OPTIONS")', handler);
      const guard = src.indexOf(`openDefectRefusal("${fn}", corsHeaders)`, handler);
      expect(options).toBeGreaterThan(handler);
      expect(guard).toBeGreaterThan(options);
      const between = src.slice(options, guard);
      expect(between).not.toMatch(/createClient\(|\.from\(|\.rpc\(|getUser|getClaims|req\.json\(/);
      expect(src.slice(guard, guard + 200)).toMatch(/if \(restricted\) return restricted;/);
    });
  }
});
