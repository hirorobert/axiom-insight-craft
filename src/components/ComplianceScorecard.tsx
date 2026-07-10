import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ComplianceScorecard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Compliance Scorecard</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Compliance scorecard is not available yet.
        </p>
      </CardContent>
    </Card>
  );
}

export default ComplianceScorecard;