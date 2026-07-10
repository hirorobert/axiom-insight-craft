import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface AdjustingJournalPanelProps {
  [key: string]: unknown;
}

export function AdjustingJournalPanel(_props: AdjustingJournalPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Adjusting Journals</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Adjusting journal panel is not available yet.
        </p>
      </CardContent>
    </Card>
  );
}

export default AdjustingJournalPanel;