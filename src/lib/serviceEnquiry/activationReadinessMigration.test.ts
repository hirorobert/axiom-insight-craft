// STATIC contract for migration 20260922100000_service_enquiry_activation_readiness.sql. The BEHAVIOURAL proof (real PostgreSQL,
// real roles, real concurrency) is scripts/db-proof/serviceEnquiries.mjs; this pins the properties that must not regress:
// the status vocabulary agrees with the TypeScript model, authorization is unchanged, and the search builds no dynamic SQL.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_STATUSES, NOTIFICATION_TRANSITIONS } from "../../../supabase/functions/_shared/serviceEnquiryContract";

const ROOT = path.resolve(__dirname, "../../..");
const FILE = "20260922100000_service_enquiry_activation_readiness.sql";
const RAW = fs.readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");
const SQL = RAW.replace(/--.*$/gm, "");
const ORIGINAL = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260921100000_service_enquiry_intake.sql"), "utf8").replace(/--.*$/gm, "");
const bodyOf = (name: string) => new RegExp(`FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(SQL)?.[0] ?? "";

describe("readiness migration hygiene", () => {
  it("is timestamped, sorts before only the later, unrelated discard-authority migration, and leaves the original enquiry migration untouched", () => {
    expect(FILE).toMatch(/^\d{14}_[A-Za-z0-9._-]+\.sql$/);
    const all = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    // 20260922180000_discard_trial_balance_authority.sql, 20260923100000_upload_lifecycle_retire_and_replace.sql and
    // 20260923120000_workspace_user_engine_actor_and_source_sweeper.sql and 20260923130000_workspace_capability_access_bridge.sql are later, unrelated migrations (trial-balance discard/lifecycle
    // authority, user-based validation, source sweeper) that now sort after this one — none touches service_enquiry_* objects.
    // 20260923140000_upload_lifecycle_hardening.sql (PR #32 security-review hardening) is later still and equally unrelated.
    expect(all[all.length - 1]).toBe("20260923140000_upload_lifecycle_hardening.sql");
    expect(all[all.length - 2]).toBe("20260923130000_workspace_capability_access_bridge.sql");
    expect(all[all.length - 3]).toBe("20260923120000_workspace_user_engine_actor_and_source_sweeper.sql");
    expect(all[all.length - 4]).toBe("20260923100000_upload_lifecycle_retire_and_replace.sql");
    expect(all[all.length - 5]).toBe("20260922180000_discard_trial_balance_authority.sql");
    expect(all[all.length - 6]).toBe(FILE);
    expect(all[all.length - 7]).toBe("20260921100000_service_enquiry_intake.sql");
    expect(RAW.includes("\u0000")).toBe(false);
    expect(RAW).not.toMatch(/^(<{7}|={7}|>{7})/m);
  });

  it("drops no table and no column, deletes no data, and touches only the enquiry outbox and search objects", () => {
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|FUNCTION|POLICY|TYPE)\b/i);
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
    for (const m of SQL.matchAll(/ALTER TABLE (public\.[a-z_]+)/g)) expect(m[1]).toBe("public.service_enquiry_notifications");
    // the only UPDATEs are the two status conversions of the not-yet-live outbox, plus the guarded claim/complete bodies
    const topLevelUpdates = SQL.split(/CREATE OR REPLACE FUNCTION/)[0].match(/UPDATE public\.[a-z_]+ SET [^;]+;/g) ?? [];
    expect(topLevelUpdates).toEqual([
      "UPDATE public.service_enquiry_notifications SET status = 'queued'   WHERE status = 'pending';",
      "UPDATE public.service_enquiry_notifications SET status = 'accepted' WHERE status = 'sent';",
    ]);
  });

  it("adds no grant of any kind and no policy: authorization is exactly as before (service_role has no write privilege)", () => {
    expect(SQL).not.toMatch(/\bGRANT\b/i);
    expect(SQL).not.toMatch(/CREATE POLICY|DISABLE ROW LEVEL SECURITY|ALTER POLICY/i);
    expect(SQL).not.toMatch(/SECURITY INVOKER/i);
    for (const name of ["enquiry_notification_claim", "enquiry_notification_complete", "service_enquiry_ack_state", "staff_list_service_enquiries", "staff_get_service_enquiry"]) {
      expect(bodyOf(name), name).toMatch(/SECURITY DEFINER/);
      expect(bodyOf(name), name).toMatch(/SET search_path = pg_catalog, public/);
    }
    // the trigger function is not callable by any client role
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.service_enquiry_notification_transition_guard\(\) FROM PUBLIC, anon, authenticated;/);
    // signatures are unchanged, so the original migration's REVOKE/GRANT statements still govern them
    expect(SQL).toMatch(/enquiry_notification_claim\(p_limit INTEGER DEFAULT 10, p_enquiry_id UUID DEFAULT NULL\)/);
    expect(SQL).toMatch(/enquiry_notification_complete\(\s*p_id\s+UUID,\s*p_outcome\s+TEXT,\s*p_provider_message_id TEXT DEFAULT NULL,\s*p_error_code\s+TEXT DEFAULT NULL\s*\)/);
    expect(ORIGINAL).toMatch(/GRANT EXECUTE ON FUNCTION public\.enquiry_notification_claim\(INTEGER, UUID\) TO service_role;/);
    expect(ORIGINAL).toMatch(/GRANT EXECUTE ON FUNCTION public\.staff_list_service_enquiries\(TEXT\[\], TEXT\[\], TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER\) TO authenticated;/);
  });

  it("the outbox functions stay service_role only and the staff functions refuse non-staff before reading anything", () => {
    for (const name of ["enquiry_notification_claim", "enquiry_notification_complete"]) expect(bodyOf(name), name).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'[\s\S]*?ERRCODE = '42501'/);
    for (const name of ["staff_list_service_enquiries", "staff_get_service_enquiry"]) {
      const b = bodyOf(name);
      expect(b, name).toMatch(/public\.current_platform_staff_role\(\) IS NULL[\s\S]*?ERRCODE = '42501'/);
      expect(b.indexOf("current_platform_staff_role()"), name).toBeLessThan(b.indexOf("FROM public.service_enquiries"));
    }
  });
});

describe("the status vocabulary agrees between the database and the TypeScript model", () => {
  it("the CHECK constraint lists exactly the six model statuses", () => {
    const list = /chk_service_enquiry_notification_status\s+CHECK \(status IN \(([^)]*)\)\)/.exec(SQL)?.[1] ?? "";
    expect([...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()).toEqual([...NOTIFICATION_STATUSES].sort());
  });

  it("the transition guard permits exactly the model's transition graph", () => {
    const guard = bodyOf("service_enquiry_notification_transition_guard");
    const permitted: string[] = [];
    for (const m of guard.matchAll(/OLD\.status = '([a-z]+)'\s+AND NEW\.status (?:= '([a-z]+)'|IN \(([^)]*)\))/g)) {
      const tos = m[2] ? [m[2]] : [...m[3].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
      for (const to of tos) permitted.push(`${m[1]}->${to}`);
    }
    const model = Object.entries(NOTIFICATION_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`));
    expect(permitted.sort()).toEqual(model.sort());
  });

  it("delivered and bounced are refused without a verified provider event, and NO function body sets them", () => {
    expect(bodyOf("service_enquiry_notification_transition_guard")).toMatch(/NEW\.status IN \('delivered', 'bounced'\)[\s\S]*?app\.enquiry_provider_event[\s\S]*?<> 'verified'[\s\S]*?ERRCODE = '23514'/);
    for (const name of ["enquiry_notification_claim", "enquiry_notification_complete"]) expect(bodyOf(name), name).not.toMatch(/'delivered'|'bounced'/);
    expect(ORIGINAL + SQL).not.toMatch(/app\.enquiry_provider_event['"]?\s*,\s*['"]verified/); // nothing in the migrations ever sets the marker
  });

  it("the completion function accepts accepted/retry/failed/blocked only, and completes only an in-flight row", () => {
    const b = bodyOf("enquiry_notification_complete");
    expect(b).toMatch(/p_outcome NOT IN \('accepted', 'retry', 'failed', 'blocked'\)/);
    expect(b).toMatch(/v_row\.status <> 'processing'[\s\S]*?'changed', false/);
    expect(b).toMatch(/SET status = 'accepted', sent_at = now\(\)/);
  });

  it("the receipt-level state calls accepted and delivered 'sent', failed and bounced 'unavailable', everything else 'pending'", () => {
    const b = bodyOf("service_enquiry_ack_state");
    expect(b).toMatch(/WHEN 'accepted'\s+THEN 'sent'/);
    expect(b).toMatch(/WHEN 'delivered' THEN 'sent'/);
    expect(b).toMatch(/WHEN 'failed'\s+THEN 'unavailable'/);
    expect(b).toMatch(/WHEN 'bounced'\s+THEN 'unavailable'/);
    expect(b).toMatch(/ELSE 'pending'/);
  });

  it("the claim marks rows processing under a lease and never claims a row twice (FOR UPDATE SKIP LOCKED)", () => {
    const b = bodyOf("enquiry_notification_claim");
    expect(b).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(b).toMatch(/SET status = 'processing'/);
    expect(b).toMatch(/interval '10 minutes'/);
    expect(b).toMatch(/LEASE_EXPIRED/);
  });
});

describe("public-reference search is parameterised, wildcard-free and index-bounded", () => {
  const list = bodyOf("staff_list_service_enquiries");

  it("builds no dynamic SQL and uses no LIKE/ILIKE/regex operator against a table column", () => {
    expect(list).not.toMatch(/\bEXECUTE\b/i);
    expect(list).not.toMatch(/\bLIKE\b|\bILIKE\b|~~|\bSIMILAR TO\b/i);
    expect(list).not.toMatch(/\|\|\s*p_search|p_search\s*\|\|/); // the raw parameter is never concatenated into anything
  });

  it("normalises whitespace and case and caps the term at 100 characters before it touches a row", () => {
    expect(list).toMatch(/left\(regexp_replace\(lower\(btrim\(coalesce\(p_search, ''\)\)\), '\\s\+', ' ', 'g'\), 100\)/);
    expect(list).toMatch(/upper\(regexp_replace\(v_term, '\[\\s-\]\+', '', 'g'\)\)/);
  });

  it("the reference branch only ever sees 'CFQ' + hex (validated by regex), so it cannot hold a wildcard", () => {
    expect(list).toMatch(/v_compact ~ '\^CFQ\[0-9A-F\]\{1,12\}\$'/);
    expect(list).toMatch(/v_compact ~ '\^\[0-9A-F\]\{4,12\}\$'/);
    expect(list).toMatch(/v_ref_low := 'CFQ' \|\| v_compact;/);
  });

  it("looks up references by an index range scan on the compact reference, capped, and the index exists", () => {
    expect(list).toMatch(/replace\(r\.public_reference, '-', ''\) COLLATE "C" >= v_ref_low/);
    expect(list).toMatch(/replace\(r\.public_reference, '-', ''\) COLLATE "C" <\s+v_ref_low \|\| chr\(127\)/);
    expect(list).toMatch(/LIMIT 200/);
    expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS idx_service_enquiries_reference_compact\s+ON public\.service_enquiries \(\(replace\(public_reference, '-', ''\) COLLATE "C"\)\)/);
  });

  it("keeps the literal organisation and email substring search, the page cap and the raw notification statuses", () => {
    expect(list).toMatch(/position\(v_term IN lower\(coalesce\(e\.organization, ''\)\)\) > 0/);
    expect(list).toMatch(/position\(v_term IN e\.requester_email\) > 0/);
    expect(list).toMatch(/greatest\(1, least\(coalesce\(p_limit, 25\), 100\)\)/);
    expect(list).toMatch(/'acknowledgement', \(SELECT n\.status FROM public\.service_enquiry_notifications n WHERE n\.enquiry_id = f\.id AND n\.kind = 'requester_acknowledgement'\)/);
    expect(list).not.toMatch(/'message'|f\.message|'payload'/); // list rows still carry no free text
  });

  it("a 'CFQ…' term searches references only; other terms may also match organisation or email", () => {
    expect(list).toMatch(/v_ref_only := true/);
    expect(list).toMatch(/v_text := NOT v_ref_only AND v_term <> ''/);
  });
});
