import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface PeriodCloseManagerProps {
  userId: string;
}

export function PeriodCloseManager(_props: PeriodCloseManagerProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Period Close</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Period close management is not available yet.
        </p>
      </CardContent>
    </Card>
  );
}

export default PeriodCloseManager;