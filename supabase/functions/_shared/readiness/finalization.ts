import { FRESHNESS_MAX_MS } from "./rulePack.ts";
import type { Freshness, ReadinessInput } from "./types.ts";

/**
 * Finalization holds that do NOT depend on the accounting rules but on WHAT was reviewed and HOW FRESH the source is.
 *
 * Two separate bindings (audit defect D5):
 *   REVIEW      the REVIEWED mark recorded the content hash the reviewer saw. FINAL must present the same hash.
 *               The content hash covers the approved decisions and every input; it does not cover pull times.
 *   FRESHNESS   for QuickBooks-bound inputs, a separate, expiring attestation made by a server pull and bound to
 *               the content hash. Identical books can renew it without a new review; changed books change the
 *               content hash and so need re-review.
 *
 * Residual limitation, stated in the pack: an edit made in QuickBooks after the last pull and before commit is not
 * detected ("Source re-read at <time>").
 */
export function reviewHolds(input: Pick<ReadinessInput, "review" | "content_sha256_now">): string[] {
  if (input.review === undefined) return [];
  if (!input.review || !input.review.reviewed_content_sha256) return ["REVIEW_MISSING"];
  return input.review.reviewed_content_sha256 === input.content_sha256_now ? [] : ["REVIEW_STALE"];
}

export function freshnessHolds(f: Freshness | undefined, contentSha256Now: string | undefined): string[] {
  if (!f || f.source !== "qbo") return [];
  const a = f.attestation;
  if (!a) return ["SOURCE_FRESHNESS_UNDETERMINED"];
  const life = Date.parse(a.expires_at) - Date.parse(a.pulled_at);
  if (!(life > 0 && life <= FRESHNESS_MAX_MS)) return ["SOURCE_FRESHNESS_INVALID"];
  if (a.outcome !== "confirmed") return ["SOURCE_CHANGED"];
  if (a.tb_fingerprint !== f.bound?.tb_fingerprint) return ["SOURCE_CHANGED:tb"];
  if (f.bound?.gl_fingerprint && a.gl_fingerprint !== f.bound.gl_fingerprint) return ["SOURCE_CHANGED:gl"];
  if (!f.now || Date.parse(a.expires_at) <= Date.parse(f.now)) return ["SOURCE_FRESHNESS_STALE"];
  if (a.bound_content_sha256 !== contentSha256Now) return ["SOURCE_FRESHNESS_MISMATCH"];
  return [];
}
