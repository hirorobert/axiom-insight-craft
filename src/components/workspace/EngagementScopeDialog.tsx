/**
 * EngagementScopeDialog — declare or amend the engagement mandate.
 *
 * Both paths write through the validated append-only commands. Nothing is ever
 * edited or deleted: withdrawing an outcome appends a REVOKE event. A reason is
 * required for every amendment because the event stream is the professional
 * record of why the mandate changed.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Check } from "lucide-react";
import {
  CAPABILITY_OUTCOMES,
  type EngagementCapability,
} from "@/lib/workspace/mandate";
import { useEngagement } from "@/contexts/EngagementContext";

export default function EngagementScopeDialog({
  open,
  onOpenChange,
  mode,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "declare" | "amend";
}) {
  const { mandate, engagement, createEngagement, grantCapability, revokeCapability } =
    useEngagement();

  const current = mandate?.granted ?? [];
  const [selected, setSelected] = useState<EngagementCapability[]>([]);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // No universal default. On declare nothing is pre-selected; on amend the
  // dialog opens on the mandate that actually exists.
  useEffect(() => {
    if (open) {
      setSelected(mode === "amend" ? [...current] : []);
      setReason("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  const toggle = (cap: EngagementCapability) =>
    setSelected((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    );

  const added = selected.filter((c) => !current.includes(c));
  const removed = current.filter((c) => !selected.includes(c));
  const changed = added.length > 0 || removed.length > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      if (mode === "declare" || !engagement) {
        await createEngagement(selected);
        toast.success("Engagement opened.");
      } else {
        for (const cap of added) await grantCapability(cap, reason || undefined);
        for (const cap of removed) await revokeCapability(cap, reason || undefined);
        toast.success("Engagement scope amended. The change is recorded in the file.");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the mandate.");
    } finally {
      setSaving(false);
    }
  };

  const disabled =
    saving ||
    selected.length === 0 ||
    (mode === "declare" ? false : !changed || reason.trim().length < 3);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg rounded-none">
        <DialogHeader>
          <DialogTitle className="text-[17px] font-semibold tracking-tight">
            {mode === "declare"
              ? "What are you preparing for this client?"
              : "Amend engagement scope"}
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            {mode === "declare"
              ? "Choose the outcomes you were engaged to deliver. Anything you do not select stays out of this engagement; you can amend it later."
              : "Adding or withdrawing an outcome appends an entry to the engagement file. Completed work is never removed."}
          </DialogDescription>
        </DialogHeader>

        <ul className="divide-y divide-border border-y border-border -mx-6">
          {CAPABILITY_OUTCOMES.map((o) => {
            const on = selected.includes(o.capability);
            return (
              <li key={o.capability}>
                <button
                  type="button"
                  onClick={() => toggle(o.capability)}
                  aria-pressed={on}
                  className="w-full text-left px-6 py-3 flex items-start gap-3 hover:bg-secondary/50 transition-colors"
                >
                  <span
                    className={[
                      "mt-0.5 w-4 h-4 shrink-0 border flex items-center justify-center",
                      on ? "bg-primary border-primary text-primary-foreground" : "border-border",
                    ].join(" ")}
                  >
                    {on && <Check className="w-3 h-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium text-foreground">
                      {o.title}
                    </span>
                    <span className="block text-[12px] text-muted-foreground leading-snug">
                      {o.description}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {mode === "amend" && (
          <div className="space-y-1.5">
            <label className="text-[12px] text-muted-foreground" htmlFor="scope-reason">
              Reason for the amendment
            </label>
            <Textarea
              id="scope-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Client engaged us for the tax computation on 12 March."
              className="rounded-none text-[13px]"
              rows={2}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="rounded-none">
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={disabled} className="rounded-none">
            {saving
              ? "Saving…"
              : mode === "declare"
                ? "Open engagement"
                : "Record amendment"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}