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

/** A real TRA TIN is 9 digits, conventionally shown as 123-456-789. */
export function isTinValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 12;
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

  useEffect(() => {
    if (open) setValue(currentTin && /\d/.test(currentTin) ? currentTin : "");
  }, [open, currentTin]);

  const valid = isTinValid(value);

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const digits = value.replace(/\D/g, "");
      const formatted = digits.length === 9
        ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
        : digits;
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
            placeholder="123-456-789"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          />
          <p className="text-[12px] text-muted-foreground">
            9 digits as issued by the Tanzania Revenue Authority. Dashes optional.
          </p>
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
