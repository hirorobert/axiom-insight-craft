// STATIC contract for migration 20260921100000_service_enquiry_intake.sql. It reads the file and pins the properties that make
// the authority safe: no client write path, RLS with no policies, exact function grants, forward-only, no seeded staff, no
// attachment surface, the exact transition matrix. The BEHAVIOURAL proof (real PostgreSQL, real roles, real concurrency) is
// scripts/db-proof/serviceEnquiries.mjs, which runs in CI on a throwaway database.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const FILE = "20260921100000_service_enquiry_intake.sql";
const RAW = fs.readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");
const SQL = RAW.replace(/--.*$/gm, ""); // code without comments

const TABLES = ["platform_staff_members", "platform_staff_audit", "service_enquiries", "service_enquiry_events", "service_enquiry_status_transitions", "service_enquiry_notifications", "service_enquiry_rate_limits"];
const SERVICE_ONLY_FUNCTIONS = ["submit_service_enquiry", "enquiry_notification_claim", "enquiry_notification_complete", "platform_staff_grant", "platform_staff_revoke"];
const STAFF_FUNCTIONS = ["staff_list_service_enquiries", "staff_get_service_enquiry", "staff_transition_service_enquiry", "staff_assign_service_enquiry", "staff_add_service_enquiry_note", "staff_list_platform_staff", "current_platform_staff_role"];

const functions = [...SQL.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_0-9]+)\(/g)].map((m) => m[1]);
const bodyOf = (name: string) => new RegExp(`FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(SQL)?.[0] ?? "";

describe("migration hygiene", () => {
  it("is a timestamped, forward-only, additive file placed last in the chain", () => {
    expect(FILE).toMatch(/^\d{14}_[A-Za-z0-9._-]+\.sql$/);
    const all = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    // Later migrations may only be the reviewed pre-activation hardening (20260922100000) followed by the
    // later, unrelated discard-authority and upload-lifecycle migrations (trial-balance discard/replace);
    // nothing else follows it.
    expect(all.slice(all.indexOf(FILE) + 1)).toEqual([
      "20260922100000_service_enquiry_activation_readiness.sql",
      "20260922180000_discard_trial_balance_authority.sql",
      "20260923100000_upload_lifecycle_retire_and_replace.sql",
      "20260923120000_workspace_user_engine_actor_and_source_sweeper.sql",
      "20260923130000_workspace_capability_access_bridge.sql",
      "20260923140000_upload_lifecycle_hardening.sql",
      "20260923150000_upload_pointer_and_source_binding.sql",
    ]);
    expect(RAW.includes("\u0000")).toBe(false);
    expect(RAW).not.toMatch(/^(<{7}|={7}|>{7})/m);
  });

  it("contains no destructive statement: no DROP, no ALTER of any pre-existing object, no data deletion outside a guarded function", () => {
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|FUNCTION|POLICY|TRIGGER|INDEX|TYPE)\b/i);
    const alters = [...SQL.matchAll(/ALTER TABLE (public\.[a-z_]+)\s+([A-Z ]+)/g)].map((m) => `${m[1]} ${m[2].trim()}`);
    expect(alters.length).toBe(TABLES.length);
    for (const a of alters) {
      expect(TABLES.some((t) => a.startsWith(`public.${t}`)), a).toBe(true);
      expect(a).toMatch(/ENABLE ROW LEVEL SECURITY$/);
    }
    // the only DELETE is the opportunistic pruning of rate-limit windows inside submit_service_enquiry
    const deletes = [...SQL.matchAll(/DELETE FROM public\.([a-z_]+)/g)].map((m) => m[1]);
    expect(deletes).toEqual(["service_enquiry_rate_limits"]);
  });

  it("creates exactly the seven canonical tables and modifies no other table", () => {
    expect([...SQL.matchAll(/CREATE TABLE public\.([a-z_]+)/g)].map((m) => m[1]).sort()).toEqual([...TABLES].sort());
  });

  it("seeds NO platform staff and trusts no email address: no top-level INSERT into the staff table, no address literal", () => {
    const topLevel = SQL.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$;/g, "");
    expect(topLevel).not.toMatch(/INSERT INTO public\.platform_staff_(members|audit)/);
    expect(topLevel).not.toMatch(/INSERT INTO auth\./);
    expect(SQL).not.toMatch(/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it("has no attachment, file or upload surface, and no Phase 2 donor/tax entity", () => {
    expect(SQL).not.toMatch(/\b(attachment|file_name|file_path|file_size|upload|bytea|storage\.)/i);
    expect(SQL).not.toMatch(/\b(donor_award|award_id|donor_pack|transaction_map|approval_chain|donor_report|tax_computation|kinga)\b/i);
  });
});

describe("row-level security and table privileges", () => {
  it("enables RLS on every canonical table and defines NO policy (no row is reachable by any client role)", () => {
    for (const t of TABLES) expect(SQL, t).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
    expect(SQL).not.toMatch(/CREATE POLICY/i);
  });

  it("revokes every privilege on every table from PUBLIC, anon, authenticated AND service_role", () => {
    for (const t of TABLES) expect(SQL, t).toMatch(new RegExp(`REVOKE ALL ON public\\.${t} FROM PUBLIC, anon, authenticated, service_role`));
  });

  it("grants nothing on tables except SELECT to service_role — no client role and no write privilege anywhere", () => {
    const grants = [...SQL.matchAll(/GRANT\s+([A-Z, ]+?)\s+ON\s+(?!FUNCTION)([^;]+?)\s+TO\s+([^;]+);/g)].map((m) => ({ priv: m[1].trim(), on: m[2].trim(), to: m[3].trim() }));
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g.priv, JSON.stringify(g)).toBe("SELECT");
      expect(g.to, JSON.stringify(g)).toBe("service_role");
    }
  });

  it("never grants anything to anon", () => {
    expect(SQL).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/i);
  });
});

describe("function privileges and authorization", () => {
  it("every created function is explicitly revoked from PUBLIC, anon and authenticated before any grant", () => {
    for (const fn of functions) expect(SQL, fn).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
  });

  it("the submit, dispatch and staff-enrolment functions are executable by service_role ONLY", () => {
    for (const fn of SERVICE_ONLY_FUNCTIONS) {
      expect(SQL, fn).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role;`));
      expect(SQL, fn).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO[^;]*(authenticated|anon|PUBLIC)`));
      expect(bodyOf(fn), fn).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'[\s\S]*?ERRCODE = '42501'/);
    }
  });

  it("the staff functions are granted to authenticated only, and each refuses anyone who is not ACTIVE platform staff", () => {
    for (const fn of STAFF_FUNCTIONS) expect(SQL, fn).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated;`));
    for (const fn of STAFF_FUNCTIONS.filter((f) => f !== "current_platform_staff_role")) {
      expect(bodyOf(fn), fn).toMatch(/public\.current_platform_staff_role\(\) IS NULL[\s\S]*?ERRCODE = '42501'/);
    }
  });

  it("platform staff is a separate authority: the role check reads platform_staff_members and never a company role", () => {
    expect(bodyOf("current_platform_staff_role")).toMatch(/FROM public\.platform_staff_members[\s\S]*?is_active/);
    for (const fn of [...STAFF_FUNCTIONS, ...SERVICE_ONLY_FUNCTIONS]) expect(bodyOf(fn), fn).not.toMatch(/firm_members|companies|role IN \('owner'/i);
  });

  it("every SECURITY DEFINER function pins its search_path", () => {
    for (const fn of functions) {
      const b = bodyOf(fn);
      if (/SECURITY DEFINER/.test(b)) expect(b, fn).toMatch(/SET search_path = pg_catalog, public/);
    }
  });
});

describe("write-path integrity", () => {
  it("events, the staff audit trail and the transition table are append-only/immutable (row triggers AND truncate triggers)", () => {
    for (const t of ["service_enquiry_events", "platform_staff_audit", "service_enquiry_status_transitions"]) {
      expect(SQL, t).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON public\\.${t}[\\s\\S]{0,120}service_enquiry_append_only_guard`));
      expect(SQL, t).toMatch(new RegExp(`BEFORE TRUNCATE ON public\\.${t}`));
    }
  });

  it("the enquiry row's content is immutable and status/assignee change only through the transition functions' write-path flag", () => {
    const guard = bodyOf("service_enquiries_write_guard");
    expect(guard).toMatch(/current_setting\('app\.service_enquiry_write_path', true\)/);
    expect(guard).toMatch(/TG_OP = 'DELETE'[\s\S]*?RAISE EXCEPTION/);
    for (const col of ["message", "subject", "requester_email", "payload", "idempotency_key", "request_fingerprint", "public_reference", "submitted_at"]) expect(guard, col).toContain(`NEW.${col}`);
    for (const fn of ["staff_transition_service_enquiry", "staff_assign_service_enquiry"]) {
      const b = bodyOf(fn);
      expect(b, fn).toMatch(/FOR UPDATE/);
      expect(b, fn).toMatch(/set_config\('app\.service_enquiry_write_path', 'rpc', true\)/);
    }
  });

  it("a transition validates against the transition TABLE under a row lock and appends its event in the SAME function", () => {
    const b = bodyOf("staff_transition_service_enquiry");
    expect(b).toMatch(/FROM public\.service_enquiries WHERE id = p_enquiry_id FOR UPDATE/);
    expect(b).toMatch(/FROM public\.service_enquiry_status_transitions t WHERE t\.from_status = v_e\.status AND t\.to_status = p_to_status/);
    expect(b).toMatch(/UPDATE public\.service_enquiries SET status = p_to_status[\s\S]*?INSERT INTO public\.service_enquiry_events/);
    expect(b).toMatch(/STATUS_CHANGED[\s\S]*?ERRCODE = '40001'/);
  });

  it("submission is ONE function: per-key advisory lock, idempotency check, rate limit, enquiry + event + both outbox rows", () => {
    const b = bodyOf("submit_service_enquiry");
    expect(b).toMatch(/pg_advisory_xact_lock\(hashtextextended\('service_enquiry:'/);
    expect(b).toMatch(/idempotency_conflict/);
    expect(b).toMatch(/rate_limited/);
    expect(b).toMatch(/INSERT INTO public\.service_enquiries[\s\S]*?INSERT INTO public\.service_enquiry_events[\s\S]*?INSERT INTO public\.service_enquiry_notifications[\s\S]*?INSERT INTO public\.service_enquiry_notifications/);
  });

  it("the public reference is server-generated (default), unique, patterned and derived from random bits — never an id or a sequence", () => {
    expect(SQL).toMatch(/public_reference\s+TEXT\s+NOT NULL DEFAULT public\.generate_service_enquiry_reference\(\)/);
    expect(SQL).toMatch(/uq_service_enquiries_reference UNIQUE \(public_reference\)/);
    expect(bodyOf("generate_service_enquiry_reference")).toMatch(/gen_random_uuid\(\)/);
    expect(bodyOf("generate_service_enquiry_reference")).not.toMatch(/nextval|serial|sequence|\bid\b/i);
  });

  it("the idempotency key is a UUID with a unique constraint, bound to a stored 64-hex request fingerprint", () => {
    expect(SQL).toMatch(/idempotency_key\s+UUID\s+NOT NULL/);
    expect(SQL).toMatch(/uq_service_enquiries_idempotency UNIQUE \(idempotency_key\)/);
    expect(SQL).toMatch(/request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/);
  });

  it("notification error text cannot be stored — a machine code only", () => {
    expect(SQL).toMatch(/last_error_code ~ '\^\[A-Z0-9_\]\{1,64\}\$'/);
  });
});

describe("the transition matrix", () => {
  it("the seeded transition rows are exactly the specified 18 pairs; spam, withdrawn and closed are terminal", () => {
    const block = /INSERT INTO public\.service_enquiry_status_transitions[\s\S]*?VALUES([\s\S]*?);/.exec(SQL)?.[1] ?? "";
    const pairs = [...block.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const expected = [
      "submitted>triage", "submitted>spam", "submitted>withdrawn",
      "triage>awaiting_client", "triage>scoping", "triage>declined", "triage>spam",
      "awaiting_client>triage", "awaiting_client>scoping", "awaiting_client>withdrawn",
      "scoping>awaiting_client", "scoping>proposal_sent", "scoping>declined",
      "proposal_sent>accepted", "proposal_sent>declined", "proposal_sent>withdrawn",
      "accepted>closed", "declined>closed",
    ].sort();
    expect(pairs).toEqual(expected);
    for (const terminal of ["spam", "withdrawn", "closed"]) expect(pairs.some((p) => p.startsWith(`${terminal}>`))).toBe(false);
  });
});
