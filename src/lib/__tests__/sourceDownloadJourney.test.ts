/**
 * The original-file retrieval journey (scripts/e2e/sourceDownloadJourney.mjs, CI job real-app-e2e) needs a local Supabase stack,
 * so it cannot run in this suite. What this suite pins is what CAN be checked without one: the journey signs in for real, refuses
 * anything but a loopback stack, covers each required refusal, keeps operator actions apart from the user flows, and the CI job runs
 * it without a secret; the Edge Function holds the same rules as the unit-tested decision module; and no Storage policy is widened.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("the journey script", () => {
  const src = read("scripts/e2e/sourceDownloadJourney.mjs");
  it("signs people in with passwords and refuses anything but a loopback stack", () => {
    expect(src).toMatch(/signInWithPassword/);
    expect(src).toMatch(/assertLocalStack/);
  });
  it("covers authorized retrieval with byte integrity and a short expiry, and the real clock expiry", () => {
    for (const needle of ["byte for byte", "expires_in <= 120", "exp.exp - exp.iat <= 120", "stops working after its expiry", "waiting"]) expect(src, needle).toContain(needle);
  });
  it("covers every refusal: no right, cross-company, injected fields, no session, direct bucket, revoked, missing object", () => {
    for (const needle of ["no right on the company", "cross-company", "path, bucket or user", "no session", "Direct bucket restrictions", "revokes the collaborator", "no longer in storage"]) expect(src, needle).toContain(needle);
  });
  it("the collaborator's grant and revocation go through the OWNER's own RPCs, not the service role", () => {
    expect(src).toMatch(/owner\.c\.rpc\("grant_workspace_capability"/);
    expect(src).toMatch(/owner\.c\.rpc\("revoke_workspace_capability"/);
    expect(src).not.toMatch(/admin\.rpc\("(grant|revoke)_workspace_capability"/);
    expect(src).not.toMatch(/admin\.from\("workspace_capability_grants"\)\.(insert|update)/);
  });
  it("records the residual window and what is not proven, and keeps operator actions listed apart", () => {
    expect(src).toMatch(/DOWNLOAD-URL-OUTLIVES-REVOCATION-UNTIL-EXPIRY/);
    expect(src).toMatch(/operatorActionsByServiceRole/);
    expect(src).toMatch(/notProven: \[[^\]]*invitations[^\]]*membership acceptance[^\]]*rollout configuration/);
  });
});

describe("signed URLs are never printed", () => {
  it("both journeys redact tokens in everything they print or record", () => {
    const api = read("scripts/e2e/sourceDownloadJourney.mjs"), main = read("scripts/e2e/localStackJourney.mjs");
    // Literal substrings (not patterns): the assertions name the exact redaction code that must stay in the journeys.
    expect(api).toContain("const redact = ");
    expect(api).toContain("const log = (s) => { const t = redact(s);");
    expect(api).toContain("detail: r === true ? undefined : JSON.parse(redact(");
    expect(main).toContain('replace(/([?&](token|apikey|access_token)=)[^&]*/gi, "$1…")');
    // and the redaction itself behaves: a token in a URL or a JSON url/token field never survives
    const redact = (text: string) => String(text).replace(/([?&](?:token|apikey|access_token)=)[^&"\s]*/gi, "$1…").replace(/("(?:url|signedUrl|token)"\s*:\s*)"[^"]*"/gi, '$1"…"');
    const out = redact(JSON.stringify({ a: { url: "http://kong:8000/x?token=SECRET&download=a" }, b: "see http://h/y?token=SECRET2 end", token: "SECRET3" }));
    expect(out).not.toMatch(/SECRET/);
  });
  it("the retrieval policy proposals exist and say they are not implemented", () => {
    const p = read("docs/release/source-download/POLICY_PROPOSALS.md");
    expect(p).toMatch(/PROPOSED; NOT IMPLEMENTED/);
    for (const h of ["accounting / evidence capabilities", "after plan expiry", "without claiming a download completed"]) expect(p, h).toContain(h);
  });
});

describe("the Edge Function", () => {
  const fn = read("supabase/functions/trial-balance-source-download/index.ts");
  it("authenticates, binds the upload to the company, re-authorizes with the shared capability predicate on every request and signs a short-lived URL", () => {
    expect(fn).toMatch(/runSourceDownload\(/);
    expect(fn).toMatch(/can_user_act_on_workspace/);
    expect(fn).toMatch(/DOWNLOAD_CAPABILITY/);
    expect(fn).toMatch(/createSignedUrl\(path, seconds/);
    expect(fn).toMatch(/\.eq\("id", uploadId\)/);
  });
  it("reads only the columns it needs, never writes, and never echoes the URL or token into its log", () => {
    expect(fn).toMatch(/select\("id, company_id, user_id, file_path, file_name, file_size, source_file_hash"\)/);
    // The function writes no table itself: its only writes are the two database functions that take the issuance decision and record a refusal (no direct insert exists).
    expect(fn).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    // The missing-object mapping lives in a tested helper; an inline pattern here once lost its backslash and turned every missing object into a 502.
    expect(fn).toMatch(/storageErrorIsMissingObject\(\(error as/);
    expect(fn).not.toMatch(/test\(String\(\(error as/);
    expect([...fn.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual(["can_user_act_on_workspace", "decide_trial_balance_source_download_issuance", "record_trial_balance_source_download_denial"]);
    const logLine = fn.split("\n").find((l) => l.includes("console.log")) ?? "";
    expect(logLine).not.toMatch(/\burl\b|token|signedUrl/);
  });
  it("the shared module's capability is the one that governs uploading, and the expiry is short", () => {
    const shared = read("supabase/functions/_shared/sourceDownload.ts");
    expect(shared).toMatch(/DOWNLOAD_CAPABILITY = "manage_source_files"/);
    expect(read("supabase/functions/_shared/sourceUpload.ts")).toMatch(/SOURCE_CAPABILITY = "manage_source_files"/);
    expect(shared).toMatch(/DOWNLOAD_EXPIRY_SECONDS = 60/);
  });
});

describe("direct bucket restrictions are preserved", () => {
  it("no migration widens a Storage policy; the only migration naming the function is the decision-record table", () => {
    const sqlFiles = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    // The newest policy on this bucket is still the personal-folder one; a migration naming the retrieval function would be a sign of drift.
    for (const f of sqlFiles) {
      const sql = read(`supabase/migrations/${f}`);
      // 20261211100000 is the decision-record table and the membership trigger: it may name the function, but it adds no Storage policy.
      if (f.startsWith("20261211100000_")) expect(sql, f).not.toMatch(/storage\.objects|CREATE\s+POLICY[^;]*storage/i);
      else expect(sql, f).not.toMatch(/trial-balance-source-download/);
    }
  });
});

describe("the CI job", () => {
  const wf = read(".github/workflows/ci.yml");
  const start = wf.indexOf("\n  real-app-e2e:");
  const next = wf.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  const job = next < 0 ? wf.slice(start) : wf.slice(start, start + 1 + next);
  it("runs the retrieval journey on the local stack, always; no link, push, deploy, login or secret", () => {
    expect(job).toMatch(/if: always\(\)\n\s+run: node scripts\/e2e\/sourceDownloadJourney\.mjs real-app-evidence\/source-download/);
    expect(job).toMatch(/real-app-evidence\/source-download\/edge-runtime\.log/);
    expect(job).not.toMatch(/secrets\.|environment:|vars\.|supabase\s+(link|login|db\s+push|functions\s+deploy)/);
  });
  it("no step name contains a colon followed by a space (it would void every check on the pull request)", () => {
    for (const m of job.matchAll(/^\s+- name: (.*)$/gm)) expect(m[1], m[1].slice(0, 60)).not.toMatch(/: /);
  });
});
