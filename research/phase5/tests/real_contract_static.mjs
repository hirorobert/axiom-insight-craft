#!/usr/bin/env node
// Phase 5 — REAL-CONTRACT STATIC CHECK (executes now).
//
// This parses the ACTUAL latest definition of resolve_account_review_batch (and its statement/class validator) from the
// isolated runtime's migration files — NOT a hosted database, NOT a hand-copied list — and asserts the per-account decisions
// my grouped-acceptance EXPANDS to are field- and semantics-compatible with what the real function consumes and accepts.
//
// HONEST SCOPE: this is a STATIC shape+semantics check against the real definition. It is NECESSARY but NOT SUFFICIENT —
// "matching object shapes alone does not establish compatibility." The SUFFICIENT proof is execution against the real
// function on a disposable PostgreSQL 17 (research/phase5/proof/real_contract_proof.mjs), which this host cannot run
// (no Docker / no local Postgres / Windows embedded-pg unavailable) and which scope-cleanliness forbids wiring into CI here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewSummary, expandGroupToDecisions } from "../prototype/lifecycle.mjs";
import { buildManualDecisions } from "../prototype/manual.mjs";
import { FLAT } from "../fixtures/synthetic.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RPC = fs.readFileSync(path.join(REPO, "supabase/migrations/20261007100000_treatment_authority_and_processing_control.sql"), "utf8");
const VAL = fs.readFileSync(path.join(REPO, "supabase/migrations/20261006100000_mapping_and_processing_authority.sql"), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d)}` : ""}`); } };

// ── Extract the real function's consumed decision fields and accepted vocabularies, straight from the SQL. ──
const fnStart = RPC.indexOf("FUNCTION public.resolve_account_review_batch");
const fnBody = RPC.slice(fnStart, RPC.indexOf("$function$", RPC.indexOf("$function$", fnStart) + 1) + 11);
const consumedFields = new Set([...fnBody.matchAll(/(?:elem|v_decision)\s*(?:->>|\?)\s*'([a-z_]+)'/g)].map((m) => m[1]));
// The authoritative accepted set is the NOT IN validation (raises INVALID_DECISION_ACTION): 4 actions.
const actionSet = new Set((fnBody.match(/v_decision_action NOT IN\s*\(([^)]*)\)/s) || [, ""])[1].match(/'([A-Z_]+)'/g)?.map((s) => s.replace(/'/g, "")) || []);
const bsClasses = new Set((VAL.match(/balance_sheet' AND v_classification IN\s*\(([^)]*)\)/s) || [, ""])[1].match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, "")) || []);
const isClasses = new Set((VAL.match(/income_statement' AND v_classification IN\s*\(([^)]*)\)/s) || [, ""])[1].match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, "")) || []);
console.log(`  [real contract] consumed decision fields: ${[...consumedFields].sort().join(", ")}`);
console.log(`  [real contract] accepted decision_action: ${[...actionSet].sort().join(", ")}`);
console.log(`  [real contract] supported BS classes: ${[...bsClasses].sort().join(", ")}`);
console.log(`  [real contract] supported IS classes: ${[...isClasses].sort().join(", ")}`);

check("the real function was located and its decision contract parsed", consumedFields.size >= 10 && actionSet.size >= 3 && bsClasses.size === 5 && isClasses.size === 5,
  { consumed: consumedFields.size, actions: [...actionSet] });

// ── Build grouped proposals from a synthetic TB and EXPAND them to the exact per-account payloads. ──
const upload = { id: "up-static", company_id: "co-A", source_digest: FLAT.source_digest };
const s = buildReviewSummary({ upload, headers: FLAT.headers, dataRows: FLAT.dataRows });
const decisions = s.groups.flatMap((g) => expandGroupToDecisions(g, `confirmed ${g.treatment.classification}`));
check("grouped acceptance expands to one decision per groupable account", decisions.length >= 12, { n: decisions.length });

// 1. Every field we emit is one the real function CONSUMES (no stray/unknown fields; minimal payload).
const ALLOWED = new Set([...consumedFields, "line_item"]); // line_item is consumed via account_mapping_content in 20261006
const unknownFields = [...new Set(decisions.flatMap((d) => Object.keys(d)))].filter((k) => !ALLOWED.has(k));
check("every field we send is consumed by the real function (no unknown fields)", unknownFields.length === 0, { unknownFields, allowed: [...ALLOWED].sort() });

// 2. Required identity/action fields present on every decision.
check("every decision carries account_name + proposal_type + decision_action", decisions.every((d) => d.account_name && d.proposal_type && d.decision_action));

// 3. proposal_type is never the forbidden AUTO_MAPPED_RULE; it is MACHINE_SUGGESTION (reviewer-confirmed).
check("proposal_type is MACHINE_SUGGESTION — never AUTO_MAPPED_RULE (which the real function rejects 42501)",
  decisions.every((d) => d.proposal_type === "MACHINE_SUGGESTION") && /AUTO_MAPPED_RULE_NOT_AUTHORIZED/.test(fnBody));

// 4. decision_action is in the real accepted set.
check("decision_action (USER_ACCEPTED_SUGGESTION) is in the real accepted set", decisions.every((d) => actionSet.has(d.decision_action)));

// 5. statement/classification pairing is in the real supported subset; cash_flow/activities never proposed.
const pairOk = (d) => (d.statement === "balance_sheet" && bsClasses.has(d.classification)) || (d.statement === "income_statement" && isClasses.has(d.classification));
check("every statement/classification pairing is in the real supported subset (no STATEMENT_CLASSIFICATION_MISMATCH)", decisions.every(pairOk), { bad: decisions.filter((d) => !pairOk(d)).map((d) => `${d.statement}/${d.classification}`) });
check("no decision proposes a cash_flow statement or an activity classification (real function rejects these 22023)",
  decisions.every((d) => d.statement !== "cash_flow" && !["operating_activities", "investing_activities", "financing_activities"].includes(d.classification)));

// 6. Flags are TRI-STATE: present only as boolean true when the group confirmed a flag candidate; never sent as false.
const flagKeys = ["is_cash_account", "is_retained_earnings", "is_payroll_account"];
check("authoritative flags are only ever present as `true` (tri-state; never a manufactured false)",
  decisions.every((d) => flagKeys.every((k) => !(k in d) || d[k] === true)));

// 7. Determinism => a retry sends a byte-identical payload => the real function's request_hash matches => safe replay.
const decisions2 = s.groups.flatMap((g) => expandGroupToDecisions(g, `confirmed ${g.treatment.classification}`));
check("expansion is deterministic (a retry replays byte-identically; real request_hash would match)", JSON.stringify(decisions) === JSON.stringify(decisions2));

// 8. Our refusal vocabulary aligns with the real function's (same codes raised by the real SQL).
for (const code of ["UPLOAD_COMPANY_MISMATCH", "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "NOT_A_MEMBER_OF_COMPANY", "EMPTY_DECISION_BATCH"]) {
  check(`refusal code '${code}' exists in the real function`, fnBody.includes(code));
}

// 9. The MANUAL multi-account path emits USER_MANUAL_CLASSIFICATION payloads that are equally server-compatible.
const manual = buildManualDecisions(
  [{ account_key: "9000", account_code: "9000", account_name: "Suspense account" }, { account_key: "9100", account_code: "9100", account_name: "Clearing account" }],
  { statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", flag_candidate: null }, "treated as current assets");
check("manual decisions use decision_action USER_MANUAL_CLASSIFICATION (in the real accepted set)", manual.every((d) => d.decision_action === "USER_MANUAL_CLASSIFICATION" && actionSet.has(d.decision_action)));
check("manual decisions use proposal_type NONE (not AUTO_MAPPED_RULE) and a supported statement/class pair", manual.every((d) => d.proposal_type === "NONE" && pairOk(d)));
const manualUnknown = [...new Set(manual.flatMap((d) => Object.keys(d)))].filter((k) => !ALLOWED.has(k) && k !== "account_key");
check("manual decisions carry no field the real function does not consume (account_key is the local identity, not sent)", manualUnknown.length === 0, { manualUnknown });

console.log(`\n${pass}/${pass + fail} static real-contract checks passed.`);
console.log("NOTE: static shape+semantics only. Execution against the real function (success + refusal + lifecycle) is in");
console.log("research/phase5/proof/real_contract_proof.mjs — replayable on a disposable PostgreSQL 17; NOT executed on this host.");
process.exit(fail ? 1 : 0);
