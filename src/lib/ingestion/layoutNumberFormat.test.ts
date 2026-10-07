/**
 * The trial-balance-layout handler (supabase/functions/_shared/trialBalanceLayout.ts) and number formats — the activation
 * finding: a file whose amounts read plausibly in several formats (different values) must show that ambiguity, must
 * never be pre-selected silently, and must not be confirmed without an explicit choice. Confirmation still validates the
 * entire file deterministically. Driven with doubles for the network edges only.
 */
import * as XLSX from "xlsx";
import { describe, expect, it, vi } from "vitest";
import { handleLayoutRequest, type LayoutDeps } from "../../../supabase/functions/_shared/trialBalanceLayout";
import type { XlsxLike } from "../../../supabase/functions/_shared/tbSource";

const USER = "11111111-1111-4111-8111-111111111111";
const UPLOAD = "33333333-3333-4333-8333-333333333333";
// BHD (three decimals). "500,000" is 500000 (comma thousands) or 500.000 (comma decimals): the format changes the value.
const AMBIGUOUS = "Code;Name;Soll;Haben\n1000;Bank;500,000;\n3000;Capital;;500,000\n";
const CLEAR = 'Code;Name;Soll;Haben\n1000;Bank;"1.500,250";\n3000;Capital;;"1.500,250"\n';
const LAYOUT = (numberFormat: string) => ({ format: "layout-template/1", sheet: { kind: "csv" }, headerRow: 1, numberFormat, balanceSign: null,
  columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben", balance: null, dimensions: [] } });

function deps(csv: string) {
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === "tbu_resolve_processing_actor") return { data: [{ actor_type: "workspace_user", firm_member_id: null, authority_basis: "workspace_owner" }], error: null };
    if (name === "authorize_trial_balance_processing") return { data: { allowed: true, code: "ALLOWED" }, error: null };
    if (name === "tbu_upload_source_bound") return { data: true, error: null };
    if (name === "layout_record_confirmation") return { data: { outcome: "confirmed", confirmationId: "c1", confirmationNo: 1 }, error: null };
    return { data: null, error: { code: "42883", message: "no double" } };
  });
  const q = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: [], error: null }) };
  const d: LayoutDeps = {
    loadUpload: async () => ({ id: UPLOAD, company_id: "c", file_path: "p/tb.csv", file_name: "tb.csv", lifecycle_state: "active_unprocessed", period_year: 2025 }),
    rpc: rpc as never, db: { from: () => q } as never,
    download: async () => new TextEncoder().encode(csv),
    reportingCurrency: async () => "BHD",
    xlsx: XLSX as unknown as XlsxLike,
  };
  return { d, rpc };
}
type Report = { layoutFits: boolean; numberFormats: { ambiguous: boolean; consistent: string[]; textCells: number; examples: { row: number; text: string; readings: Record<string, string> }[] } };

describe("number formats in the layout handler", () => {
  it("inspect: with custom headers (no automatic amount columns) the evidence still comes from the file — ambiguous, not 'no evidence'", async () => {
    const { d } = deps(AMBIGUOUS);
    const r = await handleLayoutRequest(USER, { action: "inspect", uploadId: UPLOAD }, d);
    const nf = (r.body.sheets as { numberFormats: { ambiguous: boolean; textCells: number } }[])[0].numberFormats;
    expect(nf.textCells).toBeGreaterThan(0);
    expect(nf.ambiguous).toBe(true);
  });
  it("validate: the whole file's chosen amount columns are assessed; the ambiguity and each reading are reported", async () => {
    const { d } = deps(AMBIGUOUS);
    const r = await handleLayoutRequest(USER, { action: "validate", uploadId: UPLOAD, layout: LAYOUT("dot_comma") }, d);
    const rep = r.body.report as Report;
    expect(rep.layoutFits).toBe(true);
    expect(rep.numberFormats.ambiguous).toBe(true);
    expect(rep.numberFormats.consistent).toEqual(expect.arrayContaining(["comma_dot", "dot_comma"]));
    expect(rep.numberFormats.examples[0]).toMatchObject({ row: 2, text: "500,000", readings: { comma_dot: "500000", dot_comma: "500.000" } });
  });
  it("confirm: refused (NUMBER_FORMAT_AMBIGUOUS) without an explicit choice — nothing recorded; recorded with it", async () => {
    const a = deps(AMBIGUOUS);
    const refused = await handleLayoutRequest(USER, { action: "confirm", uploadId: UPLOAD, layout: LAYOUT("dot_comma"), expectedConfirmationNo: 0 }, a.d);
    expect([refused.status, refused.body.code]).toEqual([422, "NUMBER_FORMAT_AMBIGUOUS"]);
    expect(a.rpc.mock.calls.some(([n]) => n === "layout_record_confirmation")).toBe(false);
    const b = deps(AMBIGUOUS);
    const done = await handleLayoutRequest(USER, { action: "confirm", uploadId: UPLOAD, layout: LAYOUT("dot_comma"), expectedConfirmationNo: 0, numberFormatConfirmed: true }, b.d);
    expect([done.status, done.body.status]).toEqual([200, "confirmed"]);
    const recorded = b.rpc.mock.calls.find(([n]) => n === "layout_record_confirmation")![1] as { p_validation: { numberFormats: { ambiguous: boolean } }; p_row_dispositions: unknown[] };
    expect(recorded.p_validation.numberFormats.ambiguous).toBe(true);
    expect(recorded.p_row_dispositions).toHaveLength(3); // every row of the file
  });
  it("the chosen format decides the values, deterministically: the same file and layout give the same report every time", async () => {
    const run = async (fmt: string) => (await handleLayoutRequest(USER, { action: "validate", uploadId: UPLOAD, layout: LAYOUT(fmt) }, deps(AMBIGUOUS).d)).body.report as { totals: { debit: string } };
    expect((await run("dot_comma")).totals.debit).toBe("500.000");
    expect((await run("comma_dot")).totals.debit).toBe("500000.000");
    expect(JSON.stringify(await run("dot_comma"))).toBe(JSON.stringify(await run("dot_comma")));
  });
  it("an unambiguous file needs no extra confirmation", async () => {
    const { d, rpc } = deps(CLEAR);
    const v = await handleLayoutRequest(USER, { action: "validate", uploadId: UPLOAD, layout: LAYOUT("dot_comma") }, d);
    expect((v.body.report as Report).numberFormats.ambiguous).toBe(false);
    const c = await handleLayoutRequest(USER, { action: "confirm", uploadId: UPLOAD, layout: LAYOUT("dot_comma"), expectedConfirmationNo: 0 }, d);
    expect(c.body.status).toBe("confirmed");
    expect(rpc.mock.calls.some(([n]) => n === "layout_record_confirmation")).toBe(true);
  });
});
