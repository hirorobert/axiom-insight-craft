import { Navigate, useLocation, useParams } from "react-router-dom";
import { WORKBENCH_LEGACY_ALIASES } from "@/lib/workbench/routes";

/** Workbench alias: a legacy segment goes to its one canonical destination, keeping the query (report version). */
export function WorkbenchAliasRedirect({ segment }: { segment: string }) {
  const { companyId, periodYear } = useParams<{ companyId: string; periodYear: string }>();
  const { search, hash } = useLocation();
  return <Navigate to={`/workspace/${companyId}/${periodYear}/${WORKBENCH_LEGACY_ALIASES[segment]}${search}${hash}`} replace />;
}
