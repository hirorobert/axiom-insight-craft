import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyPublicSectorAccount } from "./publicSectorClassification.ts";

Deno.test("IPSAS classifies government transfers without manual review", () => {
  assertEquals(
    classifyPublicSectorAccount("Government Grant Personal Emolument", "ipsas_accrual")?.classification,
    "revenue",
  );
  assertEquals(
    classifyPublicSectorAccount("Subvention Development Foreign", "ipsas_accrual")?.classification,
    "revenue",
  );
});

Deno.test("IPSAS classifies public service delivery expenditure", () => {
  assertEquals(
    classifyPublicSectorAccount("Classroom Teaching Supplies", "ipsas_accrual")?.classification,
    "operating_expenses",
  );
  assertEquals(
    classifyPublicSectorAccount("Hospitals, clinics and health facilities Monetary", "ipsas_accrual")?.classification,
    "non_current_assets",
  );
});

Deno.test("public-sector vocabulary never leaks into private-sector engagements", () => {
  assertEquals(classifyPublicSectorAccount("Subvention Capital", "ifrs_for_smes"), null);
  assertEquals(classifyPublicSectorAccount("User Fee", null), null);
});

Deno.test("unknown IPSAS headings remain unresolved instead of being guessed", () => {
  assertEquals(classifyPublicSectorAccount("Unidentified Control Item 997", "ipsas_accrual"), null);
});