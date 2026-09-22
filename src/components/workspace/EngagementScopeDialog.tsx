/**
 * EngagementScopeDialog — declare, add to, or amend the engagement mandate.
 *
 * Three distinct actions, not one conflated "amend" flow:
 *   declare — first-time service selection for a brand-new engagement. No reason: there is no
 *             prior scope to explain a change against.
 *   add     — "Start another service": pure addition on top of an existing mandate. Ordinary
 *             service discovery, not a correction — no reason required, same as declare. Existing
 *             services are shown as already active (not toggleable here) so this surface can never
 *             also be used to withdraw one.
 *   amend   — "Amend this engagement": can withdraw a service. A reason is required ONLY when the
 *             change actually withdraws something (removed.length > 0) — adding a service through
 *             this surface is no more material than through "add", so it carries no friction either.
 *             Withdrawing is material (it can affect retained work's standing) so it stays audited.
 *
 * All three write through the validated append-only commands. Nothing is ever edited or deleted:
 * withdrawing an outcome appends a REVOKE event.
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
import { LAUNCH_COPY } from "@/lib/workspace/onboardingState";
import { serviceAvailability } from "@/lib/jurisdiction/registry";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { deriveScopeChange, isScopeSaveDisabled } from "@/lib/workspace/engagementScopeChange";

export default function EngagementScopeDialog({
  open,
  onOpenChange,
  mode,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "declare" | "add" | "amend";
}) {
  const { mandate, engagement, createEngagement, grantCapability, revokeCapability } =
    useEngagement();

  const { company } = useWorkspace();
  const jurisdiction = company?.filing_jurisdiction ?? null;
  const current = mandate?.granted ?? [];
  const [selected, setSelected] = useState<EngagementCapability[]>([]);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // No universal default. On declare nothing is pre-selected; "add" starts from the current
  // mandate (its own services are locked on, see the list below — this surface only adds); amend
  // opens on the mandate that actually exists, fully toggleable either way.
  useEffect(() => {
    if (open) {
      setSelected(mode === "declare" ? [] : [...current]);
      setReason("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  const toggle = (cap: EngagementCapability) => {
    // "add" is addition-only: an already-granted capability can never be turned off here — that is
    // what "Amend this engagement" is for. Never a silent removal via the low-friction surface.
    if (mode === "add" && current.includes(cap)) return;
    setSelected((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    );
  };

  const { added, removed, removalRequiresReason } = deriveScopeChange(mode, current, selected);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (mode === "declare" || !engagement) {
        await createEngagement(selected);
        toast.success("Engagement opened.");
      } else if (mode === "add") {
        for (const cap of added) await grantCapability(cap);
        toast.success(added.length === 1 ? "Service added." : "Services added.");
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

  const disabled = isScopeSaveDisabled({
    mode,
    saving,
    selected,
    change: deriveScopeChange(mode, current, selected),
    reason,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg rounded-none">
        <DialogHeader>
          <DialogTitle className="text-[17px] font-semibold tracking-tight">
            {mode === "declare" ? LAUNCH_COPY.launchpadHeading : mode === "add" ? "Start another service" : LAUNCH_COPY.scopeEditor}
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            {mode === "declare"
              ? "Choose what you want to complete. Anything you do not select stays out of this workspace; you can change it later."
              : mode === "add"
                ? "Add a service to this engagement. Your existing services are unaffected — nothing here can withdraw one."
                : "Adding or withdrawing a service appends an entry to the engagement file. Completed work is never removed."}
          </DialogDescription>
        </DialogHeader>

        <ul className="divide-y divide-border border-y border-border -mx-6">
          {CAPABILITY_OUTCOMES.map((o) => {
            const on = selected.includes(o.capability);
            const alreadyActive = mode === "add" && current.includes(o.capability);
            // A service already in scope can always be withdrawn (amend); a new jurisdiction-dependent one needs the jurisdiction first.
            const avail = current.includes(o.capability) ? { available: true as const } : serviceAvailability(o.capability, jurisdiction);
            return (
              <li key={o.capability}>
                <button
                  type="button"
                  onClick={() => toggle(o.capability)}
                  aria-pressed={on}
                  disabled={!avail.available || alreadyActive}
                  className="w-full text-left px-6 py-3 flex items-start gap-3 hover:bg-secondary/50 transition-colors disabled:opacity-60"
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
                    {alreadyActive && (
                      <span className="block text-[11px] text-muted-foreground/70 leading-snug mt-1">
                        Already part of this engagement.
                      </span>
                    )}
                    {!avail.available && !alreadyActive && (
                      <span className="block text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-1">
                        {(avail as { message: string }).message}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {removalRequiresReason && (
          <div className="space-y-1.5">
            <label className="text-[12px] text-muted-foreground" htmlFor="scope-reason">
              Reason for withdrawing {removed.length === 1 ? "this service" : "these services"}
            </label>
            <Textarea
              id="scope-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Client no longer requires the tax computation for this period."
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
                : mode === "add"
                  ? "Add service"
                  : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}