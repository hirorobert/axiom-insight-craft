import { TaskEditContext } from "./taskEditState";
import { useCallback, useContext } from "react";
import { useBeforeUnload, useBlocker } from "react-router-dom";
import { isManagementPath } from "./managementState";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** Mounted only outside management. The window owns its blocker while open: one active router blocker. */
export function TaskNavigationProtection() {
  const { edits, current } = useContext(TaskEditContext)!;
  const dirty = Object.values(edits).some((e) => e.dirty), busy = Object.values(edits).some((e) => e.busy);
  const blocker = useBlocker(({ nextLocation }) => !isManagementPath(nextLocation.pathname) && Object.values(current.current).some((e) => e.dirty || e.busy));
  useBeforeUnload(useCallback((e) => { if (dirty || busy) { e.preventDefault(); e.returnValue = ""; } }, [dirty, busy]));
  return <Dialog open={blocker.state === "blocked"} onOpenChange={(open) => { if (!open && blocker.state === "blocked") blocker.reset(); }}>
    <DialogContent onInteractOutside={(e) => e.preventDefault()}>
      <DialogHeader><DialogTitle>{busy ? "Work is still being saved" : "Leave this task?"}</DialogTitle><DialogDescription>{busy ? "Wait for the result. Leaving does not cancel the server operation." : "The selected file or unsaved edits will be discarded. Records already saved remain available."}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => { if (blocker.state === "blocked") blocker.reset(); }}>Keep working</Button>
        {!busy && <Button variant="destructive" onClick={() => { Object.values(edits).forEach((e) => e.discard?.()); if (blocker.state === "blocked") blocker.proceed(); }}>Discard unsaved work</Button>}</div>
    </DialogContent>
  </Dialog>;
}
