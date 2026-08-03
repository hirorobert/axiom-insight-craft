/**
 * FirstRunEngagement — the single first-run surface.
 *
 * Replaces the old dead-end (empty state → "Manage" dialog → nested "Add
 * company" dialog → back to the same empty state with "reload the page").
 * One inline form, four fields that actually matter, and on success we route
 * straight into the workspace. No nested modals, no manual reload.
 */

import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowRight } from "lucide-react";
import { validateTin } from "@/components/workspace/CompanyTinDialog";

const FYE_OPTIONS = [
  { value: "12-31", label: "31 December" },
  { value: "06-30", label: "30 June" },
  { value: "03-31", label: "31 March" },
  { value: "09-30", label: "30 September" },
];

function formatTin(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 9);
  return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(Boolean).join("-");
}

export default function FirstRunEngagement({
  onCreated,
}: {
  onCreated: (companyId: string, periodYear: number) => void;
}) {
  const { user } = useAuth();
  const defaultYear = new Date().getFullYear() - 1;

  const [name, setName] = useState("");
  const [tin, setTin] = useState("");
  const [fye, setFye] = useState("12-31");
  const [periodYear, setPeriodYear] = useState(String(defaultYear));
  const [framework, setFramework] = useState("ifrs_for_smes");
  const [tinTouched, setTinTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const tinError = tin.trim() ? validateTin(tin) : null;
  const showTinError = tinTouched && !!tinError;
  const canSubmit = name.trim().length > 1 && !tinError && !saving;

  const yearOptions = Array.from({ length: 6 }, (_, i) => defaultYear + 1 - i);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !canSubmit) return;
    setSaving(true);
    try {
      const year = parseInt(periodYear, 10);
      const { data, error } = await supabase
        .from("companies")
        .insert({
          name: name.trim(),
          tin: tin.trim() || null,
          fiscal_year_end: `${year}-${fye}`,
          currency: "TZS",
          reporting_framework: framework,
          user_id: user.id,
        })
        .select("id")
        .single();
      if (error) throw error;
      toast.success("Engagement created.");
      onCreated(data.id as string, year);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the engagement.");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-md space-y-6">
      <div className="space-y-1.5">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Step 1 of 2 · Set up engagement
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Who are you preparing for?
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          One client, one financial year. You upload the trial balance next.
        </p>
      </div>

      <div className="space-y-4 border border-border p-5">
        <div className="space-y-2">
          <Label htmlFor="fr-name">Client name</Label>
          <Input
            id="fr-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Kamanga Medics Limited"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="fr-year">Financial year</Label>
            <Select value={periodYear} onValueChange={setPeriodYear}>
              <SelectTrigger id="fr-year"><SelectValue /></SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fr-fye">Year ends</Label>
            <Select value={fye} onValueChange={setFye}>
              <SelectTrigger id="fr-fye"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FYE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="fr-framework">Reporting framework</Label>
          <Select value={framework} onValueChange={setFramework}>
            <SelectTrigger id="fr-framework"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ifrs_for_smes">IFRS for SMEs — private companies</SelectItem>
              <SelectItem value="ipsas_accrual">IPSAS Accrual — public sector</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="fr-tin">
            TRA TIN <span className="text-muted-foreground">— optional now</span>
          </Label>
          <Input
            id="fr-tin"
            value={tin}
            inputMode="numeric"
            maxLength={11}
            aria-invalid={showTinError}
            className={showTinError ? "border-destructive focus-visible:ring-destructive" : undefined}
            onChange={(e) => setTin(formatTin(e.target.value))}
            onBlur={() => setTinTouched(true)}
            placeholder="123-456-789"
          />
          {showTinError ? (
            <p role="alert" className="text-[12px] text-destructive">{tinError}</p>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              Needed only before a TRA filing pack is produced. You can add it later.
            </p>
          )}
        </div>
      </div>

      <Button type="submit" size="lg" className="w-full gap-2" disabled={!canSubmit}>
        {saving ? "Creating…" : "Continue to trial balance"}
        {!saving && <ArrowRight className="h-4 w-4" />}
      </Button>
    </form>
  );
}
