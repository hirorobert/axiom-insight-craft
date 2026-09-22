/**
 * migrationOrderingChecks.test.ts — regression proof for
 * scripts/db-proof/migrationOrderingChecks.mjs, the pure ordering predicates the disposable-
 * database proof scripts (run.mjs, serviceEnquiries.mjs) use in place of the positional
 * `files.length - N` / `files.slice(-N, -M)` assumptions that broke twice this session when a new
 * migration was added after the ones those checks named.
 *
 * This is the SAME module the live proof scripts import — not a reimplementation that could drift.
 * It has no top-level side effects (no database connection), so it is safe to import directly here.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationExists, sortsImmediatelyAfter, sortsStrictlyAfter } from "../../../scripts/db-proof/migrationOrderingChecks.mjs";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../supabase/migrations");
const REAL_FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

const FS_ROLLOUT = "20260919100000_financial_statements_rollout_control.sql";
const FS_PERSIST = "20260919110000_financial_statements_persistence.sql";
const SERVICE_ENQUIRY_INTAKE = "20260921100000_service_enquiry_intake.sql";
const ACTIVATION_READINESS = "20260922100000_service_enquiry_activation_readiness.sql";
const DISCARD_AUTHORITY = "20260922180000_discard_trial_balance_authority.sql";

describe("migrationExists / sortsImmediatelyAfter / sortsStrictlyAfter — pure, no array-length or negative-index reasoning", () => {
  it("migrationExists is true only for a file genuinely present in the list", () => {
    expect(migrationExists(["a.sql", "b.sql"], "a.sql")).toBe(true);
    expect(migrationExists(["a.sql", "b.sql"], "z.sql")).toBe(false);
  });

  it("sortsImmediatelyAfter requires true adjacency, not just relative order", () => {
    expect(sortsImmediatelyAfter(["a.sql", "b.sql", "c.sql"], "a.sql", "b.sql")).toBe(true);
    // a and c are not adjacent (b sits between them) — must fail, proving this is not a vacuous pass-through.
    expect(sortsImmediatelyAfter(["a.sql", "b.sql", "c.sql"], "a.sql", "c.sql")).toBe(false);
    // reversed order must fail.
    expect(sortsImmediatelyAfter(["a.sql", "b.sql", "c.sql"], "b.sql", "a.sql")).toBe(false);
    // a missing file must fail, never throw.
    expect(sortsImmediatelyAfter(["a.sql", "b.sql"], "a.sql", "missing.sql")).toBe(false);
    expect(sortsImmediatelyAfter(["a.sql", "b.sql"], "missing.sql", "b.sql")).toBe(false);
  });

  it("sortsStrictlyAfter accepts any positive gap but rejects equal or reversed order", () => {
    expect(sortsStrictlyAfter(["a.sql", "b.sql", "c.sql", "d.sql"], "a.sql", "d.sql")).toBe(true);
    expect(sortsStrictlyAfter(["a.sql", "b.sql"], "a.sql", "a.sql")).toBe(false);
    expect(sortsStrictlyAfter(["a.sql", "b.sql"], "b.sql", "a.sql")).toBe(false);
    expect(sortsStrictlyAfter(["a.sql"], "a.sql", "missing.sql")).toBe(false);
  });
});

describe("the append-regression this module exists to prevent", () => {
  it("appending ANY number of new, unrelated migration filenames to the end of the list never changes an already-true sortsStrictlyAfter/sortsImmediatelyAfter result", () => {
    const base = ["20260101000000_a.sql", "20260102000000_b.sql", "20260103000000_c.sql"];
    const beforeAdjacent = sortsImmediatelyAfter(base, "20260101000000_a.sql", "20260102000000_b.sql");
    const beforeStrict = sortsStrictlyAfter(base, "20260101000000_a.sql", "20260103000000_c.sql");
    expect(beforeAdjacent).toBe(true);
    expect(beforeStrict).toBe(true);

    // Simulate one, then several, unrelated migrations landing after the fact — exactly what broke
    // the old `files.length - N` / `files.slice(-N, -M)` checks twice this session.
    let withAppends = base;
    for (let i = 1; i <= 5; i++) {
      withAppends = [...withAppends, `2026${String(200 + i)}00000000_unrelated_${i}.sql`];
      expect(sortsImmediatelyAfter(withAppends, "20260101000000_a.sql", "20260102000000_b.sql")).toBe(beforeAdjacent);
      expect(sortsStrictlyAfter(withAppends, "20260101000000_a.sql", "20260103000000_c.sql")).toBe(beforeStrict);
    }
  });

  it("migrationExists is likewise unaffected by anything appended after the checked file", () => {
    let files = ["20260101000000_a.sql"];
    expect(migrationExists(files, "20260101000000_a.sql")).toBe(true);
    for (let i = 1; i <= 5; i++) {
      files = [...files, `2026${String(200 + i)}00000000_unrelated_${i}.sql`];
      expect(migrationExists(files, "20260101000000_a.sql")).toBe(true);
    }
  });

  it("inserting an unrelated file BETWEEN two previously-adjacent migrations correctly flips sortsImmediatelyAfter to false — the check is not a tautology", () => {
    const adjacent = ["20260101000000_a.sql", "20260102000000_b.sql"];
    expect(sortsImmediatelyAfter(adjacent, "20260101000000_a.sql", "20260102000000_b.sql")).toBe(true);
    const interleaved = ["20260101000000_a.sql", "20260101500000_interloper.sql", "20260102000000_b.sql"];
    expect(sortsImmediatelyAfter(interleaved, "20260101000000_a.sql", "20260102000000_b.sql")).toBe(false);
  });
});

describe("the real migrations directory satisfies every ordering relationship the live proof scripts assert", () => {
  it("run.mjs's financial-statements ordering: rollout exists, persistence immediately follows it, and persistence sorts before every known later forward-only addition", () => {
    expect(migrationExists(REAL_FILES, FS_ROLLOUT)).toBe(true);
    expect(sortsImmediatelyAfter(REAL_FILES, FS_ROLLOUT, FS_PERSIST)).toBe(true);
    for (const later of ["20260920100000_workspace_setup_authority.sql", SERVICE_ENQUIRY_INTAKE, ACTIVATION_READINESS, DISCARD_AUTHORITY]) {
      expect(sortsStrictlyAfter(REAL_FILES, FS_PERSIST, later)).toBe(true);
    }
  });

  it("serviceEnquiries.mjs's ordering: both files exist and the activation-readiness migration sorts immediately after the intake migration", () => {
    expect(migrationExists(REAL_FILES, SERVICE_ENQUIRY_INTAKE)).toBe(true);
    expect(migrationExists(REAL_FILES, ACTIVATION_READINESS)).toBe(true);
    expect(sortsImmediatelyAfter(REAL_FILES, SERVICE_ENQUIRY_INTAKE, ACTIVATION_READINESS)).toBe(true);
  });

  it("proves the append-safety claim against the REAL directory too: re-run both proof-script relationships with the newest known migration removed, confirming they still hold on the smaller, earlier-in-time list", () => {
    // This is the mirror image of the synthetic append test above, grounded in real repository
    // history: dropping the newest migration from the list (as if it had not been added yet)
    // changes nothing about the already-established relationships among the earlier files.
    const withoutNewest = REAL_FILES.filter((f) => f !== DISCARD_AUTHORITY);
    expect(sortsImmediatelyAfter(withoutNewest, FS_ROLLOUT, FS_PERSIST)).toBe(true);
    expect(sortsStrictlyAfter(withoutNewest, FS_PERSIST, ACTIVATION_READINESS)).toBe(true);
    expect(sortsImmediatelyAfter(withoutNewest, SERVICE_ENQUIRY_INTAKE, ACTIVATION_READINESS)).toBe(true);
  });
});
