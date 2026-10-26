import { useEffect, useRef } from "react";

const EVENT = "cfoclose:refresh-workspace";
type Request = { companyId: string; periodYear?: number; add: (read: Promise<unknown>) => void };
/** Mounted readers join the same read-only refresh. No remount, financial mutation or draft reset. */
export function useWorkspaceRefresh(companyId: string | null | undefined, read: () => Promise<unknown>, periodYear?: number) {
  const current = useRef(read); current.current = read;
  useEffect(() => {
    const listener = (e: Event) => {
      const request = (e as CustomEvent<Request>).detail;
      if (request.companyId === companyId && (periodYear === undefined || request.periodYear === periodYear)) {
        request.add(Promise.resolve().then(() => current.current()));
      }
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [companyId, periodYear]);
}
export async function refreshWorkspaceReaders(companyId: string, periodYear: number, reads: Array<() => Promise<unknown>>) {
  const pending = reads.map(read => Promise.resolve().then(read));
  window.dispatchEvent(new CustomEvent<Request>(EVENT, { detail: {companyId, periodYear, add: read => pending.push(read)} }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled(pending),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Refresh timed out")), 20000); }),
    ]);
    if (results.some(r => r.status === "rejected" || r.value === false)) throw Error("Some workspace data could not be refreshed");
  } finally { clearTimeout(timer); }
}
