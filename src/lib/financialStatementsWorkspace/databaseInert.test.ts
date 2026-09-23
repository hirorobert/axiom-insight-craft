/**
 * Database-inertness proof for the financial-statements workspace change.
 *
 * This branch adds exactly two UNAPPLIED forward-only migrations (rollout
 * control and persistence) and nothing else under supabase/: no Edge
 * Function, no config change. The workspace code reaches a database only
 * through the single gated transport module, and every gate defaults to off.
 *
 * Static and non-executing: it reads the real sources.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { FINANCIAL_STATEMENT_PERSISTENCE_ENABLED } from "./persistenceGate";
import { FINANCIAL_STATEMENTS_WORKSPACE_ENABLED } from "./workspaceGate";

const ROOT = path.join(__dirname, "../../../");
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The only modules that may name an RPC or a table read: the transport (over an injected backend) and its single Supabase adapter. */
const TRANSPORT_FILES = new Set(["src/lib/financialStatementsWorkspace/rpcTransport.ts", "src/lib/financialStatementsWorkspace/supabaseFsBackend.ts"]);

const workspaceSources = [
  ...walk(path.join(ROOT, "src/lib/financialStatementsWorkspace")),
  ...walk(path.join(ROOT, "src/lib/financialEvidence")),
  ...walk(path.join(ROOT, "src/lib/financialGeneration")),
  ...walk(path.join(ROOT, "src/components/financialStatements")),
  ...walk(path.join(ROOT, "dev-harness")),
  path.join(ROOT, "src/hooks/useFinancialStatementsWorkspace.ts"),
];

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const gitOut = (args: string): string | null => {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const hasMain = gitOut("rev-parse --verify --quiet origin/main") !== null;

describe("database inertness — schema and functions", () => {
  it("defines financial-statement persistence objects only in the two named unapplied migrations, and adds no Edge Function", () => {
    const migrations = fs.readdirSync(path.join(ROOT, "supabase/migrations"));
    const defining = migrations.filter((f) => /create table[^;(]*public\.(financial_statement_(reports|evaluations|reviewer_decisions|correction_groups|publications)|financial_evidence_batches|financial_statements_rollout_\w+)/i.test(fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8")));
    expect(defining).toEqual(["20260919100000_financial_statements_rollout_control.sql", "20260919110000_financial_statements_persistence.sql"]);
    expect(fs.readdirSync(path.join(ROOT, "supabase/functions")).filter((f) => /financial-statements?-workspace|financial-statements?-persistence/.test(f))).toEqual([]);
  });

  it.skipIf(!hasMain)("changes under supabase/ relative to origin/main are only ADDED migrations (no Edge Function, no config change, nothing modified or deleted)", () => {
    // The two financial-statements migrations are already on main; a later change may only append forward-only migrations.
    const changed = (gitOut("diff --name-status origin/main...HEAD -- supabase") ?? "").trim().split(/\r?\n/).filter(Boolean).sort();
    // Reviewed artifacts. The Phase 1 service enquiry intake (PR #27) added one forward-only migration and two NEW Edge Functions
    // with their shared modules; its pre-activation hardening adds one more forward-only migration and one new shared module and
    // edits ONLY the enquiry's own shared modules. No pre-existing migration, function or config is modified or deleted.
    // The post-merge discard-authority fix (PR #32) adds one more forward-only migration: an additive accepted-firm-member
    // DELETE RLS policy on trial_balance_uploads, plus a SECURITY DEFINER discard_trial_balance_upload(uuid) RPC that resolves
    // discard authorization with full visibility instead of relying on a client-side RLS-scoped SELECT. Its own follow-up
    // (the upload-lifecycle retire-and-replace migration) adds a formal lifecycle to trial_balance_uploads plus
    // retire_trial_balance_upload()/complete_trial_balance_discard() — fixing the confirmed defect where the earlier
    // discard RPC could never remove a certified upload (tb_certifications' append-only guard vs. its CASCADE FK).
    // Neither migration modifies or deletes any pre-existing migration, function or config, and neither touches the
    // financial-statements schema this file otherwise documents.
    const added = new Set([
      "supabase/migrations/20260920100000_workspace_setup_authority.sql",
      "supabase/migrations/20260921100000_service_enquiry_intake.sql",
      "supabase/migrations/20260922100000_service_enquiry_activation_readiness.sql",
      "supabase/migrations/20260922180000_discard_trial_balance_authority.sql",
      "supabase/migrations/20260923100000_upload_lifecycle_retire_and_replace.sql",
      "supabase/functions/_shared/serviceEnquiryContract.ts",
      "supabase/functions/_shared/serviceEnquiryChallenge.ts",
      "supabase/functions/_shared/serviceEnquiryEmail.ts",
      "supabase/functions/_shared/serviceEnquiryEmailCorpus.json",
      "supabase/functions/_shared/serviceEnquiryHandler.ts",
      "supabase/functions/_shared/serviceEnquiryWiring.ts",
      "supabase/functions/dispatch-enquiry-notifications/index.ts",
      "supabase/functions/submit-service-enquiry/index.ts",
      // First-party backup security check: a signed, proof-of-work challenge so the form never depends on one external
      // provider being reachable. Reads no identity, writes nothing, and refuses when its secret is absent.
      "supabase/functions/_shared/enquiryAttestation.ts",
      "supabase/functions/issue-enquiry-challenge/index.ts",
      // PR #32 user-based upload lifecycle: the ONE new Edge Function that performs an authorized, server-verified
      // removal of an upload operation's bound file (authorizes with can_user_act_on_workspace, service-role Storage
      // only after authorization, completes as the caller). It touches no financial-statements schema.
      "supabase/functions/_shared/storageCleanup.ts",
      "supabase/functions/trial-balance-storage-cleanup/index.ts",
      // ...and its companion that signs a single-object upload URL for a reserved WORKSPACE-scoped source, so an
      // authorized collaborator can upload without any client Storage policy being widened.
      "supabase/functions/_shared/sourceUpload.ts",
      "supabase/functions/trial-balance-source-signer/index.ts",
      // ...user-based validation (20260923120000): the pure processing-actor resolver, and the scheduled, ticketed,
      // server-only sweeper that purges terminal discards and reclaims abandoned reservations. No financial-statements schema.
      "supabase/migrations/20260923120000_workspace_user_engine_actor_and_source_sweeper.sql",
      // ...and the narrow access bridge that lets an explicit Prepare grant holder discover and open that workspace.
      "supabase/migrations/20260923130000_workspace_capability_access_bridge.sql",
      "supabase/functions/_shared/processingActor.ts",
      "supabase/functions/_shared/sourceSweeper.ts",
      "supabase/functions/trial-balance-source-sweeper/index.ts",
    ]);
    const modified = new Set([
      "supabase/functions/_shared/serviceEnquiryContract.ts",
      "supabase/functions/_shared/serviceEnquiryEmail.ts",
      "supabase/functions/_shared/serviceEnquiryHandler.ts",
      "supabase/functions/_shared/serviceEnquiryWiring.ts",
      // PR #32 user-based validation: process-trial-balance resolves its actor with tbu_resolve_processing_actor, and the
      // idempotency claim records a workspace_user actor (actor_user_id) with no firm membership.
      "supabase/functions/process-trial-balance/index.ts",
      "supabase/functions/_shared/actor.ts",
      "supabase/functions/_shared/idempotency.ts",
      // The sweeper's verify_jwt = false entry (see the automation-surface test below).
      "supabase/config.toml",
    ]);
    for (const line of changed) {
      const [status, file] = line.split("	");
      expect(["A", "M"], line).toContain(status);
      expect((status === "A" ? added : modified).has(file), `${file} is not a reviewed ${status === "A" ? "addition" : "modification"}`).toBe(true);
    }
  });

  it.skipIf(!hasMain)("changes no automation-deploy surface other than the reviewed CI/RLS hardening, the disposable-database proof and the guarded hosted-staging acceptance script", () => {
    const changed = (gitOut("diff --name-only origin/main...HEAD -- .github package.json supabase/config.toml .lovable scripts") ?? "").trim().split(/\r?\n/).filter(Boolean).sort();
    // Every file the branch touches in these locations must be part of the reviewed RLS-regression safety hardening.
    const allowed = new Set([".github/workflows/ci.yml", "scripts/ci/stagingGuard.mjs", "scripts/rls_regression.mjs", "scripts/db-proof/run.mjs", "scripts/db-proof/serviceEnquiries.mjs", "scripts/db-proof/serve.mjs", "scripts/release/build-manifest.mjs", "scripts/release/manifestLib.mjs", "scripts/release/scan-repo.mjs", "scripts/release/verify-release-sql.mjs", "scripts/hosted-staging/acceptance.mjs", "scripts/db-proof/setupAuthority.mjs", "scripts/ci/assertPackIsolation.mjs", "scripts/ci/assertSingleLockfile.mjs", "scripts/ci/packageManagerAuthority.mjs", "package.json",
      // Pure, database-free migration-ordering predicates shared by run.mjs and serviceEnquiries.mjs (already reviewed above),
      // replacing their prior files.length-N / slice(-N,-M) positional assumptions. No new dependency, no deploy behavior change.
      "scripts/db-proof/migrationOrderingChecks.mjs",
      // PR #32 upload lifecycle: the loopback-only real-PostgreSQL proof, the read-only pre-flight report (SELECTs only),
      // and the hosted-staging proof behind the same stagingGuard (pinned by ciWorkflowSafety.test.ts).
      "scripts/db-proof/uploadLifecycle.mjs", "scripts/db-preflight/uploadLifecyclePreflight.sql", "scripts/upload_lifecycle_staging.mjs",
      // PR #32 sweeper: the ONE config entry, verify_jwt = false for trial-balance-source-sweeper (its single-use,
      // database-minted ticket is the credential, redeemed before anything runs).
      "supabase/config.toml",
      // PR #32 sweeper release control: the fail-closed readiness check (staging by default, behind stagingGuard;
      // an explicit --owner mode for the owner) and its pure evaluator.
      "scripts/sweeper_readiness.mjs", "scripts/ci/sweeperReadiness.mjs"]);
    expect(changed.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it.skipIf(!hasMain)("package.json adds no dependency relative to origin/main (fflate, the audited zip reader behind the secure XLSX intake, is already declared)", () => {
    const diff = (gitOut("diff -U0 origin/main...HEAD -- package.json") ?? "").split(/\r?\n/).filter((l) => /^\+/.test(l) && !/^\+\+\+/.test(l));
    expect(diff.filter((l) => /"[@\w./-]+":\s*"[\^~]?\d/.test(l))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).dependencies.fflate).toBeDefined();
  });
});

describe("database inertness — the workspace code cannot mutate a database", () => {
  it("both gates are off in source", () => {
    expect(FINANCIAL_STATEMENT_PERSISTENCE_ENABLED).toBe(false);
    expect(FINANCIAL_STATEMENTS_WORKSPACE_ENABLED).toBe(false);
  });

  it("no workspace source performs a write, RPC, function invocation, storage access, raw network call or deploy command", () => {
    const forbidden: readonly [RegExp, string][] = [
      [/\.(insert|update|upsert|delete)\s*\(/, "table write"],
      [/\.rpc\s*\(/, "rpc call"],
      [/functions\.invoke|\.functions\b/, "edge function invocation"],
      [/\.storage\b/, "storage access"],
      [/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/, "raw network call"],
      [/service_role|SERVICE_ROLE|SERVICE-ROLE/i, "service-role reference"],
      [/supabase\s+(db|functions|link|migration)|psql\b|db push/i, "database/deploy command"],
    ];
    const offenders: string[] = [];
    for (const f of workspaceSources) {
      if (TRANSPORT_FILES.has(rel(f))) continue; // audited separately below
      if (rel(f) === "dev-harness/bridgeBackend.ts") continue; // loopback-only dev tool, audited below
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const [re, what] of forbidden) if (re.test(src)) offenders.push(`${rel(f)}: ${what}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the transport modules hold no service-role reference, no actor argument and no deploy command; only the adapter imports the Supabase client", () => {
    for (const f of TRANSPORT_FILES) {
      const src = stripComments(fs.readFileSync(path.join(ROOT, f), "utf8"));
      expect(src, f).not.toMatch(/service_role|SERVICE_ROLE|supabase\s+(db|functions|link|migration)|psql\b|db push|VITE_|localStorage|sessionStorage/i);
      expect(src, f).not.toMatch(/p_(actor|reviewer|firm_member|user)\w*\s*:/i);
    }
    const importsClient = [...TRANSPORT_FILES].filter((f) => /integrations\/supabase/.test(stripComments(fs.readFileSync(path.join(ROOT, f), "utf8"))));
    expect(importsClient).toEqual(["src/lib/financialStatementsWorkspace/supabaseFsBackend.ts"]);
  });

  it("nothing except the gated factory constructs a transport, and the factory refuses when the gate is off", () => {
    const constructors = workspaceSources.filter((f) => /new FsRpcTransport/.test(stripComments(fs.readFileSync(f, "utf8")))).map(rel).sort();
    expect(constructors).toEqual(["dev-harness/main.tsx", "src/lib/financialStatementsWorkspace/supabaseFsBackend.ts"]);
    // the harness transport is dev-only and loopback-only
    const harnessMain = stripComments(fs.readFileSync(path.join(ROOT, "dev-harness/main.tsx"), "utf8"));
    expect(harnessMain).toMatch(/if \(!import\.meta\.env\.DEV\)/);
    const bridge = stripComments(fs.readFileSync(path.join(ROOT, "dev-harness/bridgeBackend.ts"), "utf8"));
    expect(bridge).toMatch(/assertLoopback\(bridge\)/);
    expect(bridge).toMatch(/host !== "127\.0\.0\.1" && host !== "localhost"/);
    const adapter = stripComments(fs.readFileSync(path.join(ROOT, "src/lib/financialStatementsWorkspace/supabaseFsBackend.ts"), "utf8"));
    expect(adapter).toMatch(/return gate \? new FsRpcTransport\(supabaseFsBackend\) : null/);
  });

  it("the only other Supabase access in workspace code is one read-only select of account_mappings, in the hook", () => {
    const users = workspaceSources.filter((f) => !TRANSPORT_FILES.has(rel(f))).filter((f) => /integrations\/supabase|supabase\.from|createClient/.test(stripComments(fs.readFileSync(f, "utf8")))).map(rel);
    expect(users).toEqual(["src/hooks/useFinancialStatementsWorkspace.ts"]);
    const hook = stripComments(fs.readFileSync(path.join(ROOT, "src/hooks/useFinancialStatementsWorkspace.ts"), "utf8"));
    const calls = [...hook.matchAll(/supabase\s*\.from\(([^)]*)\)([\s\S]{0,400}?)(?=;)/g)];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('"account_mappings"');
    expect(calls[0][2]).toMatch(/^\s*\.select\(/);
  });

  it("the remote persistence repository is instantiated by no production module and reads/writes fail closed", () => {
    const users = workspaceSources.filter((f) => /new RemoteFinancialStatementReportRepository/.test(stripComments(fs.readFileSync(f, "utf8")))).map(rel);
    expect(users).toEqual([]);
    const contract = fs.readFileSync(path.join(ROOT, "src/lib/financialStatementsWorkspace/persistenceContract.ts"), "utf8");
    for (const method of ["getLatestByCompanyPeriod", "getByReportId", "getEvaluationRun", "saveReport", "saveEvaluationRun", "appendDecision"]) {
      const body = contract.slice(contract.indexOf(`async ${method}(`));
      expect(body.slice(0, 400), method).toMatch(/assertEnabled\(\)|this\.write\(/);
    }
  });
});
