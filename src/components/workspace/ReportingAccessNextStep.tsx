import { useAuth } from "@/contexts/AuthContext";
import { useReportingAccess } from "@/hooks/useReportingAccess";
import { InternalBetaTeamAccess } from "@/components/InternalBetaTeamAccess";
/** Missing reporting access is explained in the workflow; it is never bypassed here. */
export function ReportingAccessNextStep({companyId,owner}: {companyId:string;owner:boolean}) {
  const access=useReportingAccess(companyId);
  const {user}=useAuth();
  if(access.state!=="disabled")return null;
  return <section className="my-5 space-y-3" aria-label="Reporting access next step">
    <h2 className="text-base font-semibold">Continue to financial statements</h2>
    <p className="text-sm text-muted-foreground">Reporting is not available for this company and account yet. Your saved trial balances remain available. Enrollment, company rollout and the reporting master switch must all permit access.</p>
    {owner && user ? <InternalBetaTeamAccess companyId={companyId} members={[{userId:user.id,displayName:"Your owner account",role:"owner"}]} />
      : <p className="text-sm">Ask this company’s owner or reporting administrator to check your access.</p>}
  </section>;
}
