import { useWorkspaceCommercialState } from "@/hooks/useWorkspaceCommercialState";
import { paidActionState } from "@/lib/commercial/paidActions";
import { DRAFT_PRINT_MARK } from "@/lib/commercial/reportingPack";

/**
 * Printing a workspace page cannot be prevented, so a workspace whose account does not hold REPORTING_PACK_EXPORT
 * prints DRAFT_PRINT_MARK on every printed page: a fixed-position element repeats on each page of a print, in the
 * top margin area and diagonally across the page. Hidden on screen. Unknown or loading counts as not entitled.
 */
export function DraftPrintMark({ companyId }: { companyId: string | null | undefined }) {
  const { state, loading } = useWorkspaceCommercialState(companyId);
  if (paidActionState(state, "REPORTING_PACK_EXPORT", loading).status === "allowed") return null;
  return <DraftPrintMarkView />;
}

export function DraftPrintMarkView() {
  return (
    <div aria-hidden="true" data-testid="draft-print-mark" className="cfo-draft-print-mark">
      <style>{`.cfo-draft-print-mark { display: none; }
@media print {
  .cfo-draft-print-mark { display: block; }
  .cfo-draft-print-mark span { position: fixed; left: 0; right: 0; text-align: center; font-weight: 700; color: rgba(0,0,0,0.55); z-index: 2147483647; pointer-events: none; }
  .cfo-draft-print-mark .cfo-draft-top { top: 0; font-size: 8pt; letter-spacing: 0.04em; }
  .cfo-draft-print-mark .cfo-draft-diagonal { top: 45%; font-size: 1.6rem; color: rgba(0,0,0,0.12); transform: rotate(-30deg); }
}`}</style>
      <span className="cfo-draft-top">{DRAFT_PRINT_MARK}</span>
      <span className="cfo-draft-diagonal">{DRAFT_PRINT_MARK}</span>
    </div>
  );
}
