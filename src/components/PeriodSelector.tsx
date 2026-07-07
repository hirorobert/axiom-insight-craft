import { useEffect, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface PeriodSelectorProps {
  companyId: string;
  uploadId?: string;
  onPeriodCreated?: (periodId: string) => void;
}

interface PriorPeriod {
  id: string;
  period_label: string;
  fiscal_year_end: string;
}

export function PeriodSelector({ companyId, uploadId, onPeriodCreated }: PeriodSelectorProps) {
  const [yearEnd, setYearEnd] = useState<Date | undefined>();
  const [priorPeriodId, setPriorPeriodId] = useState<string>("");
  const [priorPeriods, setPriorPeriods] = useState<PriorPeriod[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("fiscal_periods")
        .select("id, period_label, fiscal_year_end")
        .eq("company_id", companyId)
        .order("fiscal_year_end", { ascending: false });
      if (!error && data) setPriorPeriods(data);
    })();
  }, [companyId]);

  const handleSubmit = async () => {
    if (!yearEnd) {
      toast.error("Pick a fiscal year-end date");
      return;
    }
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const year = yearEnd.getFullYear();
      const payload = {
        company_id: companyId,
        fiscal_year_end: format(yearEnd, "yyyy-MM-dd"),
        period_label: `FY${year}`,
        prior_period_id: priorPeriodId || null,
        reporting_currency: "TZS",
        accounting_basis: "IFRS",
        created_by: user.id,
        active_upload_id: uploadId ?? null,
      };
      const { data, error } = await supabase
        .from("fiscal_periods")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;
      toast.success(`Fiscal period ${payload.period_label} created`);
      onPeriodCreated?.(data.id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create fiscal period");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-lg">Fiscal Period</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Fiscal Year-End Date</Label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full justify-start text-left font-normal",
                  !yearEnd && "text-muted-foreground",
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {yearEnd ? format(yearEnd, "d MMMM yyyy") : "Pick a date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={yearEnd}
                onSelect={setYearEnd}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>
        </div>

        <div className="space-y-2">
          <Label>Link Prior Year (optional)</Label>
          <Select value={priorPeriodId} onValueChange={setPriorPeriodId}>
            <SelectTrigger>
              <SelectValue placeholder="Select prior period" />
            </SelectTrigger>
            <SelectContent>
              {priorPeriods.length === 0 && (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  No prior periods
                </div>
              )}
              {priorPeriods.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.period_label} ({p.fiscal_year_end})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button onClick={handleSubmit} disabled={saving} className="w-full">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Fiscal Period
        </Button>
      </CardContent>
    </Card>
  );
}