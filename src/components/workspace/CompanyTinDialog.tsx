/**
 * CompanyTinDialog — the one place a TRA TIN gets set from the workspace.
 *
 * The masthead used to link to /settings, which has no TIN field — a dead end.
 * This puts the input exactly where the warning is raised.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

/** A real TRA TIN is exactly 9 digits, conventionally shown as 123-456-789. */
export function isTinValid(raw: string): boolean {
  return /^\d{9}$/.test(raw.replace(/\D/g, ""));
}

/**
 * Single source of truth for TIN input feedback. Returns null when the value is
 * acceptable, otherwise a plain-language reason the Save button stays disabled.
 */
export function validateTin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "Enter the 9-digit TIN issued by the Tanzania Revenue Authority.";
  if (/[^0-9\s-]/.test(trimmed)) return "Digits, spaces and dashes only — no letters or symbols.";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 9) return `Too short — ${digits.length} of 9 digits entered.`;
  if (digits.length > 9) return `Too long — ${digits.length} digits entered, a TRA TIN has exactly 9.`;
  if (/^0+$/.test(digits)) return "A TIN cannot be all zeros.";
  return null;
}

/** Formats to 123-456-789 as the user types, without fighting the caret. */
function formatTinInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 9);
  const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(Boolean);
  return parts.join("-");
}

export default function CompanyTinDialog({
  open,
  onOpenChange,
  companyId,
  companyName,
  currentTin,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  companyId: string;
  companyName: string;
  currentTin: string | null;
  onSaved: (tin: string) => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(currentTin && /\d/.test(currentTin) ? formatTinInput(currentTin) : "");
      setTouched(false);
    }
  }, [open, currentTin]);

  const error = validateTin(value);
  const valid = error === null;
  const showError = touched && !valid;

  const save = async () => {
    if (!valid || saving) {
      setTouched(true);
      return;
    }
    setSaving(true);
    try {
      const formatted = formatTinInput(value);
      const { error } = await supabase
        .from("companies")
        .update({ tin: formatted })
        .eq("id", companyId);
      if (error) throw error;
      onSaved(formatted);
      toast.success("TIN saved.");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the TIN.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set TRA Tax Identification Number</DialogTitle>
          <DialogDescription>
            {companyName} — required before any TRA document, filing pack or export can be produced.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="workspace-tin">TIN</Label>
          <Input
            id="workspace-tin"
            value={value}
            inputMode="numeric"
            autoFocus
            maxLength={11}
            aria-invalid={showError}
            aria-describedby="workspace-tin-help"
            placeholder="123-456-789"
            className={showError ? "border-destructive focus-visible:ring-destructive" : undefined}
            onChange={(e) => setValue(formatTinInput(e.target.value))}
            onBlur={() => setTouched(true)}
            onKeyDown={(e) => { if (e.key === "Enter") { setTouched(true); save(); } }}
          />
          {showError ? (
            <p id="workspace-tin-help" role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          ) : (
            <p id="workspace-tin-help" className="text-[12px] text-muted-foreground">
              Exactly 9 digits, formatted as 123-456-789 while you type.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!valid || saving}>
            {saving ? "Saving…" : "Save TIN"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
