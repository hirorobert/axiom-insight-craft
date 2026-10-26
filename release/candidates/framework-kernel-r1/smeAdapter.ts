/** Compatibility adapter to the existing compiler; does NOT generalise its database contracts or publication gates. */
import { IFRS_FOR_SMES_2015 } from "@/lib/frameworkPacks/ifrsForSmes";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { readStoredReport } from "@/lib/financialGeneration/composedReport";
import { compileSavedReport } from "@/lib/reporting/serverCompilation";
import { KernelRefusal, type KernelAdapter } from "./kernel";

/** The build proof verifies this value against the current generated compiler bytes, not a running deployment. */
export function smeProofAdapter(compilerSourceSha256: string): KernelAdapter {
  return {
    descriptor: {
      schema: "framework-kernel-descriptor/1",
      pack: { family: "IFRS_FOR_SMES", packId: IFRS_FOR_SMES_2015.id, edition: IFRS_FOR_SMES_2015.edition.id, revision: IFRS_FOR_SMES_2015.packVersion },
      canonicalKind: "IFRS_FOR_SMES",
      // Dates bound the existing profile; resolving an adoption election remains a separate governed operation.
      periodStarts: { from: IFRS_FOR_SMES_2015.edition.effectiveForPeriodsBeginningOnOrAfter, before: "2027-01-01" },
      adapter: { id: "legacy-sme-compiler", version: "1", sourceSha256: compilerSourceSha256 },
      encodingSha256: sha256Hex(canonicalStringify(IFRS_FOR_SMES_2015)),
    },
    async assemble(snapshot) {
      const result = await compileSavedReport({
        // In-memory bridge over a supplied proof snapshot. This is NOT authentication or a real database receipt.
        rpc: async (name, args) => {
          if (name !== "fs_server_compile_input" || args.p_company_id !== snapshot.identity.companyId
            || args.p_report_id !== snapshot.identity.reportId || args.p_report_version !== snapshot.identity.reportVersion) {
            throw new KernelRefusal("LEGACY_SOURCE_SCOPE_MISMATCH");
          }
          return { data: snapshot.payload, error: null };
        },
        select: async () => { throw new KernelRefusal("LEGACY_TABLE_READ_FORBIDDEN"); },
      }, { companyId: snapshot.identity.companyId!, reportId: snapshot.identity.reportId!, reportVersion: snapshot.identity.reportVersion! });
      if (!result.matches) throw new KernelRefusal("LEGACY_DOCUMENT_CHANGED");
      return readStoredReport(result.canonicalDocument);
    },
  };
}
