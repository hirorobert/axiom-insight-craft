import { useEffect, useRef } from "react";
import type { VersionConflict } from "@/lib/workbench/expectedVersion";

/**
 * Shown when the server refused a write because the record changed. States that nothing was recorded and offers a
 * reload of the latest version. Focus moves to the notice so the person hears it.
 */
export function ConflictNotice({ conflict, what, onReload }: { conflict: VersionConflict; what: string; onReload: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="mb-3 border-l-[3px] border-[#7a4a00] bg-[#fdf8ee] px-3 py-2 text-sm text-[#5c3800]">
      <span aria-hidden="true" className="mr-1 font-bold">!</span>
      Not saved: {what} changed after you opened it{conflict.detail ? ` (${conflict.detail})` : ""}. Your change was not recorded.{" "}
      <button type="button" className="ml-1 rounded-md border border-input bg-background px-2 py-0.5" onClick={onReload}>Reload the latest version</button>
    </div>
  );
}
