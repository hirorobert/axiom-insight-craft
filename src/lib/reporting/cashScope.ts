// reporting/cashScope.ts — which accounts each presented period's cash perimeter is about (DEFECT D-3). Pure.
//
// The cash accounts of a period are the accounts of THAT period's authoritative reporting input (fs_reporting_input:
// the period's certification with its approved adjustments applied) whose reviewed classification is cash. They are never
// the company's cash-flagged accounts at large: an account from another year's trial balance is not in this period's
// perimeter, whatever its code. Nothing is assumed: an input that does not carry its accounts in the expected shape is
// refused, never read as "no cash accounts".

import { z } from "zod";
import type { ScopedAccount } from "@/lib/financialGeneration/cashPerimeter";

const minor = z.string().regex(/^-?\d+$/);
const accountSchema = z.object({
  accountKey: z.string().min(1),
  isCashAccount: z.boolean().nullable(),
  debitMinor: minor,
  creditMinor: minor,
}).passthrough();
const periodSchema = z.object({ accounts: z.array(accountSchema) }).passthrough();

export interface CashScopeInput {
  readonly current: readonly ScopedAccount[];
  /** null when the reporting input has no available comparative period. */
  readonly comparative: readonly ScopedAccount[] | null;
}

const toScoped = (accounts: z.infer<typeof accountSchema>[]): ScopedAccount[] =>
  accounts.map((a) => ({ accountKey: a.accountKey, isCashAccount: a.isCashAccount, zero: BigInt(a.debitMinor) - BigInt(a.creditMinor) === 0n }));

/** The cash scope of each period from fs_reporting_input, or null when the input does not carry its accounts. */
export function cashScopeFromReportingInput(input: { readonly current?: unknown; readonly comparative?: unknown }): CashScopeInput | null {
  const cur = periodSchema.safeParse(input.current);
  if (!cur.success) return null;
  const cmpRaw = input.comparative as { state?: unknown } | null | undefined;
  if (!cmpRaw || cmpRaw.state !== "available") return { current: toScoped(cur.data.accounts), comparative: null };
  const cmp = periodSchema.safeParse(cmpRaw);
  if (!cmp.success) return null;
  return { current: toScoped(cur.data.accounts), comparative: toScoped(cmp.data.accounts) };
}

/** The current period's reviewed cash accounts (for messages and the single-account tie). */
export const reviewedCashKeys = (accounts: readonly ScopedAccount[]) => accounts.filter((a) => a.isCashAccount === true).map((a) => a.accountKey).sort();
