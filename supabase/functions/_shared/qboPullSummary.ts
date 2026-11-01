/**
 * qboPullSummary — what the provenance record needs to know about a converted file: how many accounts the REAL trial-balance reader finds in it and the
 * SHA-256 of its normalised accounting result (qboTrialBalance.normalisedAccountingResult, the string charter A2 compares across sources). Reading the
 * canonical CSV with the same reader every upload uses means the hash of a connector import equals the hash of the same books imported from a file.
 *
 * Pure. The workbook library is never needed for CSV, so a stub that throws if it is touched is passed to the reader.
 */
import { readTrialBalanceSource, type XlsxLike } from "./tbSource.ts";
import { normalisedAccountingResult } from "./qboTrialBalance.ts";

const NO_WORKBOOK = new Proxy({}, { get() { throw new Error("a CSV is never read as a workbook"); } }) as unknown as XlsxLike;

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PullSummary { accountCount: number; resultSha256: string; blocking: boolean }

export async function summariseCanonicalCsv(csv: Uint8Array, currency: string, periodYear: number): Promise<PullSummary> {
  const r = readTrialBalanceSource(csv, { fileName: "quickbooks-online.csv", periodYear, currency }, NO_WORKBOOK);
  return { accountCount: r.accounts.length, resultSha256: await sha256Hex(normalisedAccountingResult(r.accounts)), blocking: r.blocking };
}
