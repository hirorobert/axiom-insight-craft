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
import { resolveComparisonBase, unreviewedChanges, unreviewedPaths } from "../../../scripts/ci/inertBase.mjs";

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
/**
 * The exact comparison base (scripts/ci/inertBase.mjs): GitHub's pull_request base SHA or push "before" SHA in CI,
 * origin/main only when no CI base is supplied. A missing, malformed, absent, unrelated or stale base FAILS the checks
 * below with a controlled diagnostic — they never skip.
 */
const BASE = resolveComparisonBase({ env: process.env, git: gitOut }) as { ok: true; sha: string; source: string } | { ok: false; diagnostic: string };
const baseSha = (): string => {
  if (!BASE.ok) throw new Error(BASE.diagnostic);
  return BASE.sha;
};
/** A git command whose failure is a failure (never an empty result read as "nothing changed"). */
const gitStrict = (args: string): string => {
  const out = gitOut(args);
  if (out === null) throw new Error(`git ${args} failed`);
  return out;
};

describe("database inertness — schema and functions", () => {
  it("resolves a trustworthy, exact comparison base (fail-closed: never skipped)", () => {
    expect(BASE.ok, BASE.ok ? "" : BASE.diagnostic).toBe(true);
    if (BASE.ok) expect(BASE.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("defines financial-statement persistence objects only in the two named unapplied migrations, and adds no Edge Function", () => {
    const migrations = fs.readdirSync(path.join(ROOT, "supabase/migrations"));
    const defining = migrations.filter((f) => /create table[^;(]*public\.(financial_statement_(reports|evaluations|reviewer_decisions|correction_groups|publications)|financial_evidence_batches|financial_statements_rollout_\w+)/i.test(fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8")));
    expect(defining).toEqual(["20260919100000_financial_statements_rollout_control.sql", "20260919110000_financial_statements_persistence.sql"]);
    expect(fs.readdirSync(path.join(ROOT, "supabase/functions")).filter((f) => /financial-statements?-workspace|financial-statements?-persistence/.test(f))).toEqual([]);
  });

  it("changes under supabase/ relative to the exact base are only reviewed ADDED or MODIFIED exact files (no Edge Function, no config change, nothing deleted)", () => {
    // The two financial-statements migrations are already on main; a later change may only append forward-only migrations.
    // --no-renames: a move is reported as a removal plus an addition, and each must be an exact reviewed file.
    const changed = gitStrict(`diff --no-renames --name-status ${baseSha()}...HEAD -- supabase`);
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
      // One 12-month commercial term (forward-only; retires the self-serve monthly offers, adds INSERT-only guards and stop-renewal).
      "supabase/migrations/20261001120000_annual_commercial_term.sql",
      // Withheld-service grant refusal (forward-only; one AFTER INSERT trigger on engagement_mandate_events refusing NEW
      // grants of TAX_COMPUTATION / COMPLIANCE_REVIEW / FILING_PREPARATION / MONITORING; no row changed). No financial-statements schema.
      "supabase/migrations/20261002100000_refuse_withheld_service_grants.sql",
      // Classification-save fix (applied as hosted journal entry 0027): re-creates resolve_account_review_batch identical to
      // 20260925140000 except ONE call schema-qualified as extensions.digest (pinned by accountReviewDigestQualification.test.ts).
      // No financial-statements schema.
      "supabase/migrations/20261003100000_account_review_digest_schema_qualification.sql",
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
      // ...and the security-review hardening (F-01..F-05): history immutability, current-authority upload visibility,
      // claimed purges and stale-discard resolution, plus the shared engine rule that refuses a non-active upload.
      "supabase/migrations/20260923140000_upload_lifecycle_hardening.sql",
      // ...and the final hardening (N-01 pointer follows the lifecycle, N-02 canonical source binding).
      "supabase/migrations/20260923150000_upload_pointer_and_source_binding.sql",
      "supabase/migrations/20260923160000_personal_upload_lifecycle_audit.sql",
      "supabase/migrations/20260923170000_upload_binding_and_personal_authority.sql",
      // The Edge Functions' mirror of the database's one source-path rule (tbu_path_well_formed).
      "supabase/functions/_shared/sourcePath.ts",
      "supabase/functions/_shared/uploadLifecycle.ts",
      "supabase/functions/_shared/processingActor.ts",
      "supabase/functions/_shared/sourceSweeper.ts",
      "supabase/functions/trial-balance-source-sweeper/index.ts",
      // CFO Close capabilities, entitlements and pricing (20260925100000): the forward-only catalogue/authority/walls
      // migration, the shared paid-action gate for Edge Functions, and the neutral comparative-assurance endpoint whose
      // one handler both it and the legacy kinga-comparative-engine adapter serve. No financial-statements schema.
      "supabase/migrations/20260925100000_global_capabilities_entitlements_pricing.sql",
      "supabase/functions/_shared/paidAction.ts",
      // process-trial-balance's source-download failure path (L-1 / L-2): pure classification + checked recovery. No schema.
      "supabase/functions/_shared/processingSource.ts",
      "supabase/functions/_shared/comparativeAssurance.ts",
      "supabase/functions/comparative-assurance-engine/index.ts",
      // Named-user billing suspension and invitation reservations (20260925110000), the official Reporting Pack
      // issuance binding (20260925120000), and the service-role named-user activity check Edge Functions share. No
      // financial-statements schema.
      "supabase/migrations/20260925110000_named_user_billing_suspension_and_invitation_lifecycle.sql",
      "supabase/migrations/20260925120000_reporting_pack_issuance_binding.sql",
      "supabase/functions/_shared/namedUserAccess.ts",
      // No free plan / Solo / plan x capability matrix (20260925130000), capability authorization with the Close
      // Assurance and reconciliation write walls (20260925140000), and the minimum predicate grant (20260925150000).
      // No financial-statements schema.
      "supabase/migrations/20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql",
      "supabase/migrations/20260925140000_workspace_capability_authorization.sql",
      "supabase/migrations/20260925150000_can_user_act_on_workspace_minimum_grant.sql",
      // The processing entitlement wall: a NEW forward migration (the applied chain is never edited). No financial-statements schema.
      "supabase/migrations/20260926160000_trial_balance_processing_entitlement_wall.sql",
      // The canonical source of Lovable's hosted entry 0023 (xbrl_concept_map read policy; release-only probe RLS). No financial-statements schema.
      "supabase/migrations/20260927041019_security_fix_probe_and_xbrl_concept_map.sql",
      // Remove a processed trial balance from active use (retire, no successor): a NEW forward migration. No financial-statements schema.
      "supabase/migrations/20260927100000_trial_balance_remove_from_active_use.sql",
      // Reconciliation server authority (forward-only): completeness from stored rows, server-recorded match runs and
      // decisions, escalated/rejected exceptions kept unresolved, client-role forgery guards. No financial-statements schema.
      "supabase/migrations/20261004100000_reconciliation_server_authority.sql",
      // Evidence ingestion authority (forward-only): one serialized server path for evidence rows, provenance-based row
      // identity (additive nullable columns + a partial unique index), no client-role row inserts. No financial-statements schema.
      "supabase/migrations/20261005100000_safisha_ingestion_authority.sql",
      // ...and the two parked migrations' quarantined copies (S1 record): renamed `.sql.historical`, moved out of the
      // replayed chain, original SQL byte for byte after a comment-only notice (verified by
      // scripts/db-proof/lib/parkedMigrations.mjs).
      "supabase/migrations_historical/20261004100000_reconciliation_server_authority.sql.historical",
      "supabase/migrations_historical/20261005100000_safisha_ingestion_authority.sql.historical",
      // S1 mapping and processing authority (forward-only; PENDING HOSTED APPLICATION): server-written account mappings
      // with review provenance, the supported-combination review RPC, tbu_request_reprocess, append-only certification
      // invalidation and server-owned upload processing fields. No financial-statements schema.
      "supabase/migrations/20261006100000_mapping_and_processing_authority.sql",
      // H1 (forward-only; PENDING HOSTED APPLICATION): processing release control (numeric engine generation, hold, drain,
      // append-only events) and CONFIRM_ACCOUNT_TREATMENT bound to an engine-emitted request. No financial-statements schema.
      "supabase/migrations/20261007100000_treatment_authority_and_processing_control.sql",
      // ...and the treatment request identity the engine (E1) will use; identical bytes to public.treatment_request_id.
      "supabase/functions/_shared/treatmentRequest.ts",
      // E1: the exact class-side amounts contract (tb-amounts/1) the engine writes and validates. Pure module; no schema.
      "supabase/functions/_shared/tbAmounts.ts",
      // S2 (20261008100000): attempts, the fence, dependency revisions and read-time authority — a NEW forward-only
      // migration pending hosted application — and E2's consumer authority guard (authority or refuse) and the function-path
      // doubles of the attempt functions (test-only, never deployed).
      "supabase/migrations/20261008100000_processing_attempt_authority.sql",
      "supabase/functions/_shared/tbAuthority.ts",
      // R0 release: the server-side restriction of the functions whose registered defects are open (refuse first).
      "supabase/functions/_shared/openDefectRestriction.ts",
      "supabase/functions/process-trial-balance/functionpath/attemptDouble.ts",
      // Official Reporting Pack bytes are generated, stored and sealed by the server (B-4, N-1): the Edge Function
      // and its pure handler. No financial-statements schema.
      "supabase/functions/_shared/reportingPackSeal.mjs",
      "supabase/functions/_shared/reportingPackSeal.d.mts",
      "supabase/functions/seal-reporting-pack/index.ts",
      // Trial-balance ingestion integrity: the pure ingestion core process-trial-balance runs on an upload (exact
      // minor-unit money, explicit period and currency, one identity per account, safe totals, row lineage) and the
      // bytes → rows reader it uses. Pure modules; no schema, no new Edge Function.
      "supabase/functions/_shared/tbIngestion.ts",
      "supabase/functions/_shared/tbSource.ts",
      // ...and its Deno function-path tests: the real handler with only the network edges (Supabase client, std serve)
      // replaced by in-memory doubles through an import map used by the tests alone. Never deployed (not under a
      // function's entry point), no schema.
      "supabase/functions/process-trial-balance/functionpath/functionPath.test.ts",
      "supabase/functions/process-trial-balance/functionpath/supabaseDouble.ts",
      "supabase/functions/process-trial-balance/functionpath/serverDouble.ts",
      "supabase/functions/process-trial-balance/functionpath/import_map.json",
      // ...and the mixed-version probe (the same doubles over the release scenarios, for scripts/compat/tbMixedVersions.mjs).
      "supabase/functions/process-trial-balance/functionpath/compatProbe.ts",
      // I1-A A1 (20261009100000): currency-registry/1 and explicit reporting periods — a NEW forward-only migration pending
      // hosted application (its preflight refuses incompatible data; nothing is backfilled or repaired) — and the engine's
      // copy of the registry (generated; parity-tested with the browser copy and the migration seed).
      "supabase/migrations/20261009100000_currency_registry_and_reporting_periods.sql",
      "supabase/functions/_shared/currencyRegistry.ts",
      // I1-A A2 (20261010100000): layout templates and confirmations — a NEW forward-only migration pending hosted
      // application — and ONE new Edge Function, trial-balance-layout (the manual layout editor's server: inspect, validate,
      // confirm, save template; it writes only layout_templates / layout_confirmations through two service-role writer
      // functions that derive the actor from the JWT and require prepare_close), with its pure shared modules.
      "supabase/migrations/20261010100000_layout_templates_and_confirmations.sql",
      "supabase/functions/trial-balance-layout/index.ts",
      "supabase/functions/_shared/trialBalanceLayout.ts",
      "supabase/functions/_shared/layoutProfile.ts",
      "supabase/functions/_shared/layoutConfirmationRead.ts",
      // I1-B (20261011100000): one file registered as two years (current and prior) sharing a managed source object — a
      // NEW forward-only migration pending hosted application. Touches no financial-statements schema.
      "supabase/migrations/20261011100000_two_period_shared_source.sql",
      // I1-C (20261012100000): controls for AI-assisted layout suggestions (consent, provider gates, quota, cost cap) —
      // a NEW forward-only migration pending hosted application — and ONE new Edge Function, layout-assist, shipped with
      // NO provider wired (every request refused before anything is read). Writes only ai_layout_assist_runs through two
      // service-role functions; never a financial table, never a layout confirmation.
      "supabase/migrations/20261012100000_layout_assist_controls.sql",
      "supabase/functions/layout-assist/index.ts",
      "supabase/functions/_shared/layoutAssist.ts",
      // Close Review increment 8 (20261013100000): the append-only comments-and-history timeline, behind the financial-statements rollout; capability-checked writer. A NEW forward-only migration pending hosted application.
      "supabase/migrations/20261013100000_close_review_timeline.sql",
      // Close Review I2 (20261014100000): findings on the authoritative trial balance (tb-anomaly-catalogue/1), lifecycle on the shared timeline; behind the financial-statements rollout. A NEW forward-only migration pending hosted application.
      "supabase/migrations/20261014100000_close_review_findings.sql",
      // Close Review I3 (20261015100000): approved adjustments (adjustment/1, approval-policy/1) as a layer over the authoritative trial balance; behind the financial-statements rollout. A NEW forward-only migration pending hosted application.
      "supabase/migrations/20261015100000_close_review_adjustments.sql",
      // Financial Statements (20261016100000): fs_reporting_input — the authoritative, adjusted reporting input (read-only). A NEW forward-only migration pending hosted application.
      "supabase/migrations/20261016100000_fs_reporting_input.sql",
      // Sign-off (20261017100000): fs_publication_blockers re-created with the Close Review and authoritative-input requirements (byte-pinned to its 20260919110000 body plus the marked additions); first-period declarations. A NEW forward-only migration pending hosted application.
      "supabase/migrations/20261017100000_signoff_completion_requirements.sql",
      // Statement composition (20261018100000): presentation-line vocabulary, append-only assignments and elections, the database-composed statements.
      "supabase/migrations/20261018100000_fs_statement_composition.sql",
      // Notes and schedules (20261019100000): requirement and schedule vocabulary, append-only decisions, disclosure texts and schedules, fs_notes_status.
      "supabase/migrations/20261019100000_fs_notes_and_schedules.sql",
      // Comparatives (20261020100000): append-only bridges, two-person restatements, approvals bound to the comparative identity; composition v2.
      "supabase/migrations/20261020100000_fs_comparatives.sql",
      // Sign-off binding (20261021100000): fs_reporting_dependencies, publication blockers v2, append-only publication bindings.
      "supabase/migrations/20261021100000_fs_signoff_binding.sql",
      // Reporting closure (20261022100000): comprehensive income decisions and blockers; the authenticated approver on every binding.
      "supabase/migrations/20261022100000_fs_reporting_closure.sql",
      // Readiness correction (20261023100000): fs_report_readiness declared VOLATILE; nothing else changes.
      "supabase/migrations/20261023100000_fs_report_readiness_volatility.sql",
      // Statement sign-off policy (20261024100000): policy events, set/read, enforcement and recording in the binding.
      "supabase/migrations/20261024100000_fs_signoff_approval_policy.sql",
      // Commercial enquiries (20261025100000): activation requests, specialist-service enquiries, tracked staff replies.
      "supabase/migrations/20261025100000_commercial_enquiries.sql",
      // One adjustment path (20261026100000): client writes to the legacy adjusting journal revoked; history read-only.
      "supabase/migrations/20261026100000_retire_browser_adjusting_journal_writes.sql",
    ]);
    const modified = new Set([
      // I1-A A2: the ingestion reader gains the confirmed-layout path (absent a layout, byte-identical — characterization
      // over every corpus case), and the function-path database double can answer for a table that does not exist yet.
      "supabase/functions/_shared/tbSource.ts",
      "supabase/functions/process-trial-balance/functionpath/supabaseDouble.ts",
      // ...and the named-user helper's rpc parameter type, so the shared auth module type-checks against the real
      // supabase-js types (Deno check of trial-balance-layout). Types only; payloads unchanged (paidAction.test.ts).
      "supabase/functions/_shared/namedUserAccess.ts",
      // I1-B: the storage-cleanup function maps the database's 'source_shared' answer (one year of a two-year file was
      // discarded; its file is kept for the other year). No deletion rule changes.
      "supabase/functions/_shared/storageCleanup.ts",
      // Workbench activation (PR #75): the layout handler reports the whole file's number-format evidence for the chosen
      // amount columns and refuses an ambiguous format without an explicit choice (NUMBER_FORMAT_AMBIGUOUS). No schema.
      "supabase/functions/_shared/trialBalanceLayout.ts",
      // I1-A A1: the ingestion core reads its exponents from currency-registry/1 (every previously supported currency keeps
      // its exponent; characterization-tested).
      "supabase/functions/_shared/tbIngestion.ts",
      "supabase/functions/_shared/serviceEnquiryContract.ts",
      "supabase/functions/_shared/serviceEnquiryEmail.ts",
      "supabase/functions/_shared/serviceEnquiryHandler.ts",
      "supabase/functions/_shared/serviceEnquiryWiring.ts",
      // PR #32 user-based validation: process-trial-balance resolves its actor with tbu_resolve_processing_actor, and the
      // idempotency claim records a workspace_user actor (actor_user_id) with no firm membership.
      "supabase/functions/process-trial-balance/index.ts",
      // PR #34 release blocker P-1 (after main received PR #34 in production): the processing entitlement helpers
      // (processingEntitlementRefusal, isEntitlementWallError) added to the reviewed paid-action gate. No financial-statements schema.
      "supabase/functions/_shared/paidAction.ts",
      // PR #32 N-01: the comparative engine refuses a stale period pointer (non-active or foreign upload).
      "supabase/functions/kinga-comparative-engine/index.ts",
      "supabase/functions/_shared/actor.ts",
      "supabase/functions/_shared/idempotency.ts",
      // The sweeper's verify_jwt = false entry (see the automation-surface test below).
      "supabase/config.toml",
      // CFO Close walls: the paid-action gate in the Close Insights engines, the filing-pack and management-letter
      // generators; neutral customer-visible wording (no internal engine names) in their responses and in the shared
      // certified-trial-balance reader; the disclosure-notes generator's credit line. Accounting logic unchanged.
      "supabase/functions/maono-compute/index.ts",
      "supabase/functions/maono-risk/index.ts",
      "supabase/functions/maono-decide/index.ts",
      "supabase/functions/maono-cashflow/index.ts",
      "supabase/functions/maono-root-cause/index.ts",
      "supabase/functions/maono-monitor/index.ts",
      "supabase/functions/generate-xbrl/index.ts",
      "supabase/functions/generate-management-letter/index.ts",
      "supabase/functions/generate-disclosure-notes/index.ts",
      "supabase/functions/_shared/certifiedTbSource.ts",
      // S1 provenance consumption (20261006100000): process-trial-balance's function-path suite pins that only a company
      // mapping linked to a review decision is trusted (absent/cleared/malformed links, pre-S1 rows, mixed accounts,
      // precedence, tenant isolation). Never deployed (not under a function's entry point), no schema.
      "supabase/functions/process-trial-balance/functionpath/functionPath.test.ts",
      // ...and the mixed-version probe's fixture: saved review decisions are LINKED company mappings since S1 (older handlers
      // ignore the field). Never deployed, no schema.
      "supabase/functions/process-trial-balance/functionpath/compatProbe.ts",
      // Named-user activity (20260925110000): the shared membership checks and the service-role membership lookups
      // also require an ACTIVE named user (a billing-suspended member gets an outsider's 403); the invitation function
      // reserves the seat before any email and releases it when the email fails. Accounting logic unchanged.
      "supabase/functions/_shared/auth.ts",
      "supabase/functions/_shared/actor.ts",
      "supabase/functions/invite-firm-member/index.ts",
      "supabase/functions/kinga-tax-engine/index.ts",
      // E2 (W3): the findings engine computes only from the period's authoritative trial balance (or refuses).
      "supabase/functions/kinga-findings-engine/index.ts",
      // R0: tax, notes and the management letter are withheld on the server (WITHHELD_SERVICES): the same refusal as the
      // open-defect restrictions, before authentication or any read or write. No schema, no business logic.
      "supabase/functions/_shared/openDefectRestriction.ts",
      // ...and so does the one Comparative Assurance implementation, for both periods.
      "supabase/functions/_shared/comparativeAssurance.ts",
      // B-5: the evidence-attachment RPC error is a failure, never ignored.
      "supabase/functions/safisha-ingest/index.ts",
      // Reconciliation server authority (20261004100000): the matcher records its result through the service-role RPC
      // (actor from the verified JWT); the resolver calls its service-role-only RPC with the service client.
      "supabase/functions/safisha-match/index.ts",
      "supabase/functions/safisha-resolve/index.ts",
    ]);
    // Files a reviewed change takes OUT of supabase/: the two parked reconciliation migrations, never applied to the hosted
    // database, quarantined (S1 record, PPG-1 precedent) to supabase/migrations_historical/ (added above).
    const removed = new Set([
      "supabase/migrations/20261004100000_reconciliation_server_authority.sql",
      "supabase/migrations/20261005100000_safisha_ingestion_authority.sql",
    ]);
    expect(unreviewedChanges(changed, { added, modified, removed })).toEqual([]);
  });

  it("changes no automation-deploy surface other than the reviewed CI/RLS hardening, the disposable-database proof and the guarded hosted-staging acceptance script", () => {
    const changed = gitStrict(`diff --name-only ${baseSha()}...HEAD -- .github package.json supabase/config.toml .lovable scripts`);
    // Every file the branch touches in these locations must be part of the reviewed RLS-regression safety hardening.
    const allowed = new Set([".github/workflows/ci.yml", "scripts/ci/stagingGuard.mjs", "scripts/rls_regression.mjs", "scripts/db-proof/run.mjs", "scripts/db-proof/serviceEnquiries.mjs", "scripts/db-proof/serve.mjs", "scripts/release/build-manifest.mjs", "scripts/release/manifestLib.mjs", "scripts/release/scan-repo.mjs", "scripts/release/verify-release-sql.mjs", "scripts/hosted-staging/acceptance.mjs", "scripts/db-proof/setupAuthority.mjs", "scripts/ci/assertPackIsolation.mjs", "scripts/ci/assertSingleLockfile.mjs", "scripts/ci/packageManagerAuthority.mjs", "package.json",
      // Pure, database-free migration-ordering predicates shared by run.mjs and serviceEnquiries.mjs (already reviewed above),
      // replacing their prior files.length-N / slice(-N,-M) positional assumptions. No new dependency, no deploy behavior change.
      "scripts/db-proof/migrationOrderingChecks.mjs",
      // Readiness evidence under real RLS: loopback-only; creates and drops ONLY its own uniquely named database; reads
      // through the app's own readReconciliationEvidence; probes (never changes) the write surface. No deploy behaviour.
      "scripts/db-proof/reconciliationEvidence.mjs",
      // Old/new client × old/new server for the trial-balance release: git-extracted versions, Deno + in-memory doubles,
      // no network database, no deploy behaviour.
      "scripts/compat/tbMixedVersions.mjs",
      // The account-home hotfix's disposable proof (loopback-only; creates and drops ONLY its own uniquely named
      // database; raw vs application-confirmed concurrency outcomes). No deploy behaviour.
      "scripts/db-proof/hubTrialBalanceReview.mjs",
      // PR #32 upload lifecycle: the loopback-only real-PostgreSQL proof, the read-only pre-flight report (SELECTs only),
      // and the hosted-staging proof behind the same stagingGuard (pinned by ciWorkflowSafety.test.ts).
      "scripts/db-proof/uploadLifecycle.mjs", "scripts/db-preflight/uploadLifecyclePreflight.sql", "scripts/upload_lifecycle_staging.mjs",
      // PR #32 sweeper: the ONE config entry, verify_jwt = false for trial-balance-source-sweeper (its single-use,
      // database-minted ticket is the credential, redeemed before anything runs).
      "supabase/config.toml",
      // PR #32 sweeper release control: the fail-closed readiness check (staging by default, behind stagingGuard;
      // an explicit --owner mode for the owner) and its pure evaluator.
      "scripts/sweeper_readiness.mjs", "scripts/ci/sweeperReadiness.mjs",
      // PR #32 staging browser acceptance: behind the same stagingGuard; a dependency-free CDP driver (no package.json
      // change), a staging-only frontend build with no readable .env, and pure checks.
      "scripts/browser_acceptance.mjs", "scripts/browser-acceptance/cdp.mjs", "scripts/browser-acceptance/stagingFrontend.mjs",
      "scripts/browser-acceptance/checks.mjs",
      // CFO Close capabilities: the loopback-only real-PostgreSQL entitlement proof and the customer-visible legacy-name
      // sweep (a read-only source scanner).
      "scripts/db-proof/entitlements.mjs", "scripts/ci/legacyNameSweep.mjs",
      // Named-user billing suspension, invitation reservations and the official Reporting Pack: the loopback-only
      // real-PostgreSQL proof, and the read-only migration-authority parity guard.
      "scripts/db-proof/billingSuspension.mjs", "scripts/ci/assertMigrationAuthority.mjs",
      // Disposable-database contract harness, section E only: asserts the CURRENT catalogue (the original offers kept but
      // retired by 20260925100000, the four current offers non-purchasable) instead of the retired offers being active.
      "scripts/db-contract-tests/10_static_contract_assertions.sql",
      // The plan catalogue / capability authorization / minimum-grant proof (disposable PostgreSQL only).
      "scripts/db-proof/planCapabilities.mjs",
      // The disposable-database storage stub gains storage.objects.metadata (size, mimetype), as Supabase Storage has it,
      // so the official Reporting Pack's stored-object check is proven (test shim only; never applied to a hosted project).
      "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql",
      // Static-guard helper: guards judge an atomic (one DO envelope) migration by the statements it executes. Read-only.
      "scripts/ci/atomicEnvelope.mjs",
      // Migration-authority rule 8: the reviewed PR #34 release journal (strict validation of Drizzle 0013–0021). Read-only.
      "scripts/ci/releaseJournal.mjs",
      // Trial-balance verdict surface: the build-output guard that the development-only gallery (src/dev/, dev/*.html)
      // and its synthetic fixtures never reach dist/. Read-only file scan; no database, network or deploy behavior.
      "scripts/ci/assertDevGalleryExcluded.mjs",
      // One 12-month commercial term (20261001120000): the loopback-only real-PostgreSQL proof and the READ-ONLY
      // production preflight audit (SELECT statements only; proven read-only by that proof, T-08).
      "scripts/db-proof/annualTerm.mjs", "scripts/db-preflight/annualTermPreflight.sql",
      // Withheld-service grant refusal (20261002100000): the loopback-only real-PostgreSQL proof. No deploy behaviour.
      "scripts/db-proof/serviceWithholding.mjs",
      // Reconciliation server authority (20261004100000): the loopback-only real-PostgreSQL proof. No deploy behaviour.
      "scripts/db-proof/reconciliationAuthority.mjs",
      // ...and its old/new function × schema matrix, with byte-identical copies of main's two reconciliation handlers
      // (pinned by git blob hash; never deployed — not under supabase/).
      "scripts/db-proof/reconciliationFunctionMatrix.mjs",
      "scripts/db-proof/fixtures/functions-main-e8962f2/match.index.ts",
      "scripts/db-proof/fixtures/functions-main-e8962f2/resolve.index.ts",
      "scripts/db-proof/fixtures/functions-main-e8962f2/manifest.json",
      // ...and its READ-ONLY pre-apply impact report and post-apply verification (SELECT only; proven read-only by
      // reconciliationAuthority.mjs).
      "scripts/db-preflight/reconciliationAuthorityPreflight.sql", "scripts/db-preflight/reconciliationAuthorityVerify.sql",
      // Evidence ingestion (20261005100000): the loopback-only proof running the real safisha-ingest handler (main's, pinned by
      // git blob hash, and this tree's), the shared handler harness, and the READ-ONLY duplicate inspection. No deploy behaviour.
      "scripts/db-proof/safishaIngestion.mjs", "scripts/db-proof/lib/functionHarness.mjs",
      // S1 record: the hash-verified reader of the two quarantined (never applied) reconciliation migrations, used only by
      // their revival-candidate proofs and the obsolete r5 renderer. Read-only; no deploy behaviour.
      "scripts/db-proof/lib/parkedMigrations.mjs",
      // H2: the real process-trial-balance handler on real PostgreSQL — the characterization proof, its pure known-defect
      // ledger rules and the ledger itself. Loopback-only; no deploy behaviour; the handler is not modified.
      "scripts/db-proof/tbHandlerCharacterization.mjs", "scripts/db-proof/lib/defectLedger.mjs",
      "scripts/db-proof/fixtures/h2-known-defects.json",
      // H1 (20261007100000): the loopback-only real-PostgreSQL proof (with the real handler). No deploy behaviour.
      "scripts/db-proof/h1Authority.mjs",
      // S2 (20261008100000): the loopback-only real-PostgreSQL proof. No deploy behaviour.
      "scripts/db-proof/s2Authority.mjs",
      "scripts/db-proof/fixtures/functions-main-e8962f2/ingest.index.ts", "scripts/db-preflight/safishaIngestionPreflight.sql",
      "scripts/db-preflight/safishaIngestionVerify.sql",
      // S1 (20261006100000): the loopback-only real-PostgreSQL proof. No deploy behaviour.
      "scripts/db-proof/mappingProcessingAuthority.mjs",
      // The release application proofs (Lovable's stated hosted-executor contract; drizzle-orm migrate() compatibility), their
      // shared disposable base, and the guarded-entry and inspection renderer they prove
      // (loopback-only; release-journal tooling; no deploy behaviour).
      "scripts/db-proof/migratorRelease.mjs", "scripts/release/guardedEntry.mjs", "scripts/db-proof/hostedExecutorRelease.mjs",
      "scripts/db-proof/lib/releaseBase.mjs", "scripts/release/renderRelease2026_10.mjs",
      // This guard's own fail-closed base resolver and exact-file review (no deploy behaviour), and the CI check that the
      // guard executed with zero skipped tests.
      // I1-A A1 (20261009100000): the loopback-only real-PostgreSQL proof of periods and currency. No deploy behaviour.
      "scripts/db-proof/periodsAuthority.mjs",
      // I1-A A2 (20261010100000): the loopback-only real-PostgreSQL proof with the real layout and processing handlers.
      "scripts/db-proof/layoutAuthority.mjs",
      // I1-B (20261011100000): the loopback-only real-PostgreSQL proof of two-year registration and shared-source cleanup.
      "scripts/db-proof/sharedSourceAuthority.mjs",
      // I1-C (20261012100000): the loopback-only real-PostgreSQL proof of the layout-assist controls and the real function.
      "scripts/db-proof/layoutAssistAuthority.mjs",
      // ...and the provider evaluation harness an enablement must pass (production pipeline, owner thresholds). No deploy behaviour.
      "scripts/ai/layoutAssistEval.ts",
      // ...its release-order proof (main → A1 → A2 → generation 4, real handlers at every stage) and the read-only
      // function-closure manifest tool (every file a deploy ships, with SHA-256). No deploy behaviour.
      "scripts/db-proof/releaseOrder.mjs", "scripts/release/functionClosure.mjs",
      "scripts/db-proof/closeReviewAuthority.mjs",
      // The milestone release-order proof (main's schema → the seven migrations one at a time, legacy uploads, the real
      // sweeper and both storage-cleanup handlers at every stage; loopback-only). No deploy behaviour.
      "scripts/db-proof/milestoneReleaseOrder.mjs",
      // The self-checking release wrappers: the generator (reads committed migration bytes, writes release/wrappers/; no
      // network, no database) and its loopback-only real-PostgreSQL proof. No deploy behaviour.
      "scripts/release/selfCheckingWrapper.mjs", "scripts/db-proof/selfCheckingWrappers.mjs",
      // The coverage-matrix renderer (reads src/lib/frameworkPacks, writes docs/reporting; no network, no database).
      "scripts/release/renderCoverageMatrix.mjs",
      "scripts/db-proof/statementComposition.mjs",
      "scripts/db-proof/notesSchedules.mjs",
      "scripts/db-proof/lib/reportingKit.mjs",
      "scripts/db-proof/comparatives.mjs",
      "scripts/db-proof/signoffBinding.mjs",
      // The reporting workbench: its loopback-only real-PostgreSQL proof, the loopback bridge for the dev harness (a
      // throwaway database; reads and the reporting functions only) and the headless-browser journey over it. No deploy
      // behaviour.
      "scripts/db-proof/reportingWorkbench.mjs", "scripts/db-proof/serveReporting.mjs", "scripts/browser-acceptance/reportingJourney.mjs",
      "scripts/db-proof/reportingClosure.mjs",
      // The reporting release: its loopback-only mixed-version / forward-recovery proof, the read-only deployed-bundle
      // verifier (hashes a downloaded tree; executes nothing) and the review-package renderer (writes docs only).
      "scripts/db-proof/reportingRelease.mjs", "scripts/release/verifyDeployedClosure.mjs", "scripts/release/renderReviewPackage.mjs",
      // Hosted acceptance r1: the loopback-only proof of the acceptance fixture set and the fixture renderer (writes docs only).
      "scripts/db-proof/acceptanceFixtures.mjs", "scripts/release/renderAcceptanceFixtures.mjs",
      // DEFECT D-2: the loopback-only readiness proof.
      "scripts/db-proof/readinessReadOnly.mjs",
      // DEFECT D-3: the loopback-only cash perimeter scope proof.
      "scripts/db-proof/cashPerimeterScope.mjs",
      // The loopback-only sign-off policy proof.
      "scripts/db-proof/signoffPolicy.mjs",
      // The commercial candidate (commercial-c1): enquiry additions and the retirement of browser adjusting-journal writes.
      "scripts/db-proof/commercialEnquiries.mjs", "scripts/db-proof/legacyAdjustmentsRetirement.mjs",
      "scripts/ci/inertBase.mjs", "scripts/ci/assertTestsExecuted.mjs"]);
    expect(unreviewedPaths(changed, allowed)).toEqual([]);
  });

  it("package.json adds no dependency relative to the exact base (fflate, the audited zip reader behind the secure XLSX intake, is already declared)", () => {
    const diff = gitStrict(`diff -U0 ${baseSha()}...HEAD -- package.json`).split(/\r?\n/).filter((l) => /^\+/.test(l) && !/^\+\+\+/.test(l));
    // Reviewed exception (workbench F1): two TEST-ONLY devDependencies, exact-pinned, used by the jsdom keyboard/focus
    // tests and axe-core accessibility checks (src/lib/workbench/testkit/dom.ts). Never a runtime dependency.
    const REVIEWED_DEV_DEPENDENCIES = new Set(['+    "axe-core": "4.10.3",', '+    "jsdom": "26.1.0",']);
    expect(diff.filter((l) => /"[@\w./-]+":\s*"[\^~]?\d/.test(l) && !REVIEWED_DEV_DEPENDENCIES.has(l))).toEqual([]);
    const pkgNow = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    for (const name of ["axe-core", "jsdom"]) {
      expect(pkgNow.dependencies?.[name], `${name} must never be a runtime dependency`).toBeUndefined();
      if (pkgNow.devDependencies?.[name] !== undefined) expect(pkgNow.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkgNow.dependencies.fflate).toBeDefined();
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
      if (rel(f) === "dev-harness/bridgeBackend.ts" || rel(f) === "dev-harness/reporting/bridgeDb.ts") continue; // loopback-only dev tools, audited below
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
    // the reporting harness transport is dev-only and loopback-only too
    expect(stripComments(fs.readFileSync(path.join(ROOT, "dev-harness/reporting/main.tsx"), "utf8"))).toMatch(/if \(!import\.meta\.env\.DEV\)/);
    const reportingBridge = stripComments(fs.readFileSync(path.join(ROOT, "dev-harness/reporting/bridgeDb.ts"), "utf8"));
    expect(reportingBridge).toMatch(/assertLoopback\(bridge\);\n {2}const post/);
    expect(reportingBridge).toMatch(/host !== "127\.0\.0\.1" && host !== "localhost"/);
    const adapter = stripComments(fs.readFileSync(path.join(ROOT, "src/lib/financialStatementsWorkspace/supabaseFsBackend.ts"), "utf8"));
    expect(adapter).toMatch(/return gate \? new FsRpcTransport\(supabaseFsBackend\) : null/);
  });

  it("the only other Supabase access in workspace code is one read-only select of account_mappings, in the hook", () => {
    const users = workspaceSources.filter((f) => !TRANSPORT_FILES.has(rel(f))).filter((f) => /integrations\/supabase|supabase\.from|createClient/.test(stripComments(fs.readFileSync(f, "utf8")))).map(rel);
    expect(users).toEqual(["src/components/financialStatements/FinancialStatementsWorkspace.tsx", "src/hooks/useFinancialStatementsWorkspace.ts"]);
    const hook = stripComments(fs.readFileSync(path.join(ROOT, "src/hooks/useFinancialStatementsWorkspace.ts"), "utf8"));
    const calls = [...hook.matchAll(/supabase\s*\.from\(([^)]*)\)([\s\S]{0,400}?)(?=;)/g)];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('"account_mappings"');
    expect(calls[0][2]).toMatch(/^\s*\.select\(/);
    // The gated component's ONE read: the authoritative reporting input (a STABLE, read-only SECURITY DEFINER function,
    // 20261016100000), through a dynamic import inside the gate. No .from(), no other RPC, no write.
    const component = stripComments(fs.readFileSync(path.join(ROOT, "src/components/financialStatements/FinancialStatementsWorkspace.tsx"), "utf8"));
    expect(component).not.toMatch(/supabase\s*\.from\(/);
    expect(component).not.toMatch(/^import .*integrations\/supabase/m);
    expect([...component.matchAll(/"([a-z_]+)",\s*\{\s*p_company_id/g)].map((m) => m[1])).toEqual(["fs_reporting_input"]);
    expect(component.match(/supabase\.rpc/g)).toHaveLength(1);
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
