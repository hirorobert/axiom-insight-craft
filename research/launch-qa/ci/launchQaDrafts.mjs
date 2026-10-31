// Launch-acceptance QA — the drafts facility for scenario E's STALE sub-check (NORMAL, CI/integration; evidence branch #144).
// A deterministic stale replacement cannot be produced from the browser (FirstUpload re-reads the current version at click
// time), so the authentic check is the draft-commit CONTRACT exactly as scripts/e2e/draftJourney.mjs proves it: a commit
// naming the active upload with an expected version one behind must answer 409 replace_conflict and keep the current
// upload. Everything goes through the user's own session and the real trial-balance-draft function; the period, engagement
// and confirmation come from the active upload and its entity — nothing is guessed.
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "trial-balance-files"; // the drafts and workspace uploads bucket (20261106100000)
const ACTIVE = ["active_unprocessed", "active_processing", "active_processed", "blocked"];
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const key = () => crypto.randomBytes(18).toString("base64url");

export function draftsFacility({ apiUrl, anonKey, admin }) {
  const session = async (u) => {
    const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
    if (error) throw new Error(`sign-in for the drafts facility failed: ${error.message}`);
    return { c, token: data.session.access_token };
  };
  const fn = async (s, body) => {
    const res = await fetch(`${apiUrl}/functions/v1/trial-balance-draft`, { method: "POST", headers: { Authorization: `Bearer ${s.token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, body: json };
  };
  const activeOf = async (companyId, periodYear) =>
    (await admin.from("trial_balance_uploads").select("id, version, lifecycle_state, period_id, engagement_id").eq("company_id", companyId).eq("period_year", periodYear).in("lifecycle_state", ACTIVE)).data ?? [];
  return {
    /**
     * As `user`, a draft commit that replaces the period's active upload naming an expected version one BEHIND the current
     * one. Returns the server's answer and whether the current upload was kept; the refused commit is then cancelled.
     */
    async staleReplace(user, companyId, periodYear) {
      const before = await activeOf(companyId, periodYear);
      if (before.length !== 1) return { executed: false, reason: `expected one active upload, found ${before.length}` };
      const cur = before[0];
      const co = (await admin.from("companies").select("name").eq("id", companyId).single()).data;
      const per = cur.period_id ? (await admin.from("fiscal_periods").select("reporting_currency, reporting_start, reporting_end").eq("id", cur.period_id).maybeSingle()).data : null;
      const s = await session(user);
      const bytes = Buffer.from(`code,name,debit,credit\n1000,Cash at bank (stale replacement),1500.00,0\n3000,Share capital,0,1500.00\n`);
      const { data: reserved, error } = await s.c.rpc("reserve_trial_balance_draft", { p_file_name: "E-stale-replacement.csv", p_file_size: bytes.length, p_content_sha256: sha(bytes), p_idempotency_key: key() });
      if (error) return { executed: false, reason: `reserve: ${error.message}` };
      const d = reserved[0];
      const signed = await fn(s, { action: "sign", draft_id: d.draft_id });
      if (signed.body?.outcome !== "signed") return { executed: false, reason: `sign: ${JSON.stringify(signed.body)}` };
      const up = await s.c.storage.from(BUCKET).uploadToSignedUrl(signed.body.path, signed.body.token, new Blob([bytes], { type: "text/csv" }));
      if (up.error) return { executed: false, reason: `upload: ${up.error.message}` };
      const confirmation = { entity: co?.name ?? "", period: per ? `${per.reporting_start} – ${per.reporting_end}` : String(periodYear), currency: per?.reporting_currency ?? "" };
      const stale = await fn(s, { action: "commit", draft_id: d.draft_id, commit_key: key(), company_id: companyId, period_year: periodYear,
        period_id: cur.period_id ?? null, engagement_id: cur.engagement_id ?? null, confirmation,
        replaces_upload_id: cur.id, expected_version: Number(cur.version) - 1 });
      if (stale.body?.commit_id) await fn(s, { action: "cancel", commit_id: stale.body.commit_id });
      const after = await activeOf(companyId, periodYear);
      return { executed: true, status: stale.status, outcome: stale.body?.outcome ?? null, accepted: stale.status < 300 && stale.body?.outcome === "committed",
        currentKept: after.length === 1 && after[0].id === cur.id && Number(after[0].version) === Number(cur.version), currentId: cur.id };
    },
  };
}
