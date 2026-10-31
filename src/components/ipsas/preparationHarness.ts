/**
 * A stateful fake of the preparation functions for the save-handling regressions: every save is HELD until the test releases it,
 * the server keeps what it recorded and answers the next context read with it, and the test can see every call. It models only
 * what the page can observe (receipt, recorded payload, revision id); the server rules themselves are proven in the database proofs.
 */
export const CO = "99999999-9999-4999-8999-999999999999";
export const CO2 = "77777777-7777-4777-8777-777777777777";
const uuidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const assessment = { tb: { certificationId: null, isBlocking: null, requiresReview: null, ppeCarryingClosingMinor: null, ppeCarryingOpeningMinor: null, depreciationExpenseMinor: null },
  confirmedClasses: {}, priorConfirmed: false, ppe: null, bridge: null, workpaperId: null, priorFiguresId: null, presentation: { state: "known", currency: "TZS", exponent: 2 } };

export type Call = { name: string; args: Record<string, unknown> };
type Held = { args: Record<string, unknown>; release: (receipt: "recorded" | "stale" | "lost") => void };

export function heldDb(opts: { grants?: boolean } = {}) {
  const calls: Call[] = [];
  const held: Held[] = [];
  let n = 100;
  const stored: Record<string, { id: string; payload: Record<string, unknown> } | null> = { ppe_workpaper: null, prior_figures: null, grants: null };
  const rev = (kind: string) => (stored[kind] ? { id: stored[kind]!.id, payload: stored[kind]!.payload, sha256: "a".repeat(64), createdAt: "2026-10-30T00:00:00Z" } : null);
  const grantsContext = () => ({ outcome: "available", register: rev("grants"), confirmations: [],
    live: { period: { certificationId: null, start: "2026-01-01", end: "2026-12-31" }, revisionId: stored.grants?.id ?? null, tb: null, presentation: { state: "known", currency: "TZS", exponent: 2 }, confirmedGrants: {}, assessment: null } });
  const hold = (kind: string, args: Record<string, unknown>) => new Promise((resolve) => {
    held.push({ args, release: (how) => {
      if (how === "lost") { resolve({ data: null, error: { message: "network" } }); return; }
      if (how === "stale") { resolve({ data: { outcome: "stale", currentId: stored[kind]?.id ?? null }, error: null }); return; }
      const id = uuidN(++n);
      stored[kind] = { id, payload: structuredClone(args.p_payload as Record<string, unknown>) };
      resolve({ data: { outcome: "recorded", revisionId: id, assessment }, error: null });
    } });
  });
  return {
    calls, held, stored,
    db: { rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args: structuredClone(args) });
      if (name === "ipsas_prep_context") return { data: { outcome: "available", workpaper: rev("ppe_workpaper"), priorFigures: rev("prior_figures"), confirmations: [], assessment }, error: null };
      if (name === "ipsas_grants_context") return { data: grantsContext(), error: null };
      if (name === "ipsas_save_preparation") return hold(String(args.p_kind), args);
      if (name === "ipsas_save_grants") return hold("grants", args);
      return { data: null, error: { message: "unexpected" } };
    } },
  };
}
