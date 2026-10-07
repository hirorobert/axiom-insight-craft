import { useEffect, useRef, useState } from "react";
import { contextChangeAnnouncement, type WorkbenchContext } from "@/lib/workbench/context";

/** Announces an explicit change of company, period or report version in a polite live region. */
export function ContextAnnouncer({ context }: { context: WorkbenchContext }) {
  const prev = useRef(context);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const m = contextChangeAnnouncement(prev.current, context);
    prev.current = context;
    if (m) setMessage(m);
  }, [context]);
  return <div role="status" aria-live="polite" className="sr-only">{message}</div>;
}
