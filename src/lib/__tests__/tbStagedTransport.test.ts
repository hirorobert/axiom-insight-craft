import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM release tool without type declarations
import {
  APPROVED_COMMIT, BATCHES, BOOTSTRAP_PREDECESSOR, KINDS, REGISTERED_TRANSPORT_FORMS, TRANSPORT_DIR,
  checkTransportMirror, committedBytes, renderAll, renderApply, renderBootstrap, renderStage, transportForms,
} from "../../../scripts/release/tbStagedTransport.mjs";
import { BATCHES as FS_BATCHES, renderAll as renderFsAll } from "../../../scripts/release/stagedTransport.mjs";

import { RELEASE_JOURNAL } from "../../../scripts/ci/releaseJournal.mjs";
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";

const ROOT = path.resolve(__dirname, "../../..");

describe("Trial Balance exact-byte staged transport", () => {
  it("pins the merged-main source bytes, wrappers and read-only postconditions", () => {
    expect(APPROVED_COMMIT).toBe("5c69b1795be3020dbcd145dcab9f3828b3993814");
    expect(BOOTSTRAP_PREDECESSOR).toEqual({ id: 71, hash: "0eb1405df641e956ca43b4ad652f9ca263029352637e98d1ce482d5c2bb19910" });
    expect(BATCHES.map((b) => b.batch)).toEqual(["tb-portfolio-a1", "tb-decisions-b1"]);
    for (const b of BATCHES) {
      for (const kind of KINDS) {
        const a = kind === "source" ? b.sourceArtifact : b[kind];
        const committed = committedBytes(a.path);
        expect(committed.length, `${b.batch}/${kind} bytes`).toBe(a.bytes);
        expect(crypto.createHash("sha256").update(committed).digest("hex"), `${b.batch}/${kind} hash`).toBe(a.sha256);
        expect(fs.readFileSync(path.join(ROOT, a.path)).equals(committed), `${b.batch}/${kind} checkout`).toBe(true);
      }
    }
  });

  it("renders exactly nine tracked transport files and all journal forms are deterministic", () => {
    const rendered = renderAll();
    expect(Object.keys(rendered)).toHaveLength(9);
    for (const [rel, text] of Object.entries(rendered)) expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toBe(text);
    for (const f of transportForms()) {
      const reg = REGISTERED_TRANSPORT_FORMS[f.name];
      expect([reg.bytes, reg.sha256, reg.withFinalLf]).toEqual([f.bytes, ...f.hashes]);
      expect(f.text.endsWith("\n")).toBe(false);
    }
    expect(Object.keys(renderFsAll())).toHaveLength(21); // existing FS transport remains a separate five-batch route
    expect(FS_BATCHES.map((b) => b.batch)).toEqual(["fs-controls-r1", "fs-journey-r1", "fs-bounds-r1", "fs-capacity-r1", "fs-memo-r1"]);
  }, 30_000);

  it("pins predecessor identity and refusal ordering before every executable step", () => {
    const bootstrap = renderBootstrap();
    expect(bootstrap).toContain(`c_predecessor CONSTANT text[] := ARRAY['${BOOTSTRAP_PREDECESSOR.hash}']::text[]`);
    expect(bootstrap).toContain("TB_TRANSPORT_WRONG_PREDECESSOR");
    expect(bootstrap).toContain("LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;");
    for (const [i, b] of BATCHES.entries()) {
      const text = renderApply(i);
      expect(text).toContain("c_predecessor CONSTANT text[]");
      expect(text).not.toContain("c_expected_predecessor");
      expect(text).toContain("TB_TRANSPORT_WRONG_PREDECESSOR");
      expect(text).toContain("TB_TRANSPORT_STAGE_MISSING_OR_MODIFIED");
      expect(text).toContain("TB_TRANSPORT_UNCERTAIN_STATE");
      expect(text).toContain("TB_TRANSPORT_ALREADY_APPLIED");
      expect(text.indexOf("LOCK TABLE drizzle.__drizzle_migrations")).toBeLessThan(text.indexOf("SELECT count(*), max(j.id)"));
      expect(text.indexOf("TB_TRANSPORT_WRONG_PREDECESSOR")).toBeLessThan(text.indexOf("EXECUTE v_wrapper"));
      expect(text.indexOf("EXECUTE v_wrapper")).toBeLessThan(text.indexOf("UPDATE cfoclose_tb_release.staged_artifacts"));
      expect(text).not.toMatch(/\b(BEGIN\s+TRANSACTION|COMMIT|ROLLBACK)\b/i);
      expect(text).toContain(b.wrapper.sha256);
    }
  });

  it("rejects tampered transport text in the same way the migration-authority check will", () => {
    const f = transportForms()[1];
    expect(checkTransportMirror(`0072_${f.name}`, f.text).problems).toEqual([]);
    expect(checkTransportMirror(`0072_${f.name}`, f.text.replace("Exact source", "Tampered source")).problems.length).toBeGreaterThan(0);
    expect(checkTransportMirror("0072_unregistered", f.text).problems.length).toBeGreaterThan(0);
    expect(path.join(ROOT, TRANSPORT_DIR)).toContain("staged-transport-tb");
  });
});


describe("TB transport integration with the real migration-authority guard", () => {
  function withMirrors(run: (dir: string, tags: string[]) => void, register = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-transport-authority-"));
    const added: string[] = [];
    const removed: [string, unknown][] = [];
    const registry = RELEASE_JOURNAL as Record<string, unknown>;
    try {
      fs.cpSync(path.join(ROOT, "supabase/migrations"), path.join(dir, "supabase/migrations"), { recursive: true });
      fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
      const jf = path.join(dir, "drizzle/migrations/meta/_journal.json");
      const journal = JSON.parse(fs.readFileSync(jf, "utf8"));
      // The hosted mirrors (0071–0073) now exist; re-simulate them from a journal truncated before the first one.
      const names = transportForms().map((f) => f.name);
      const firstHosted = journal.entries.findIndex((e: { tag: string }) => names.some((n) => e.tag.endsWith(`_${n}`)));
      if (firstHosted >= 0) {
        for (const e of journal.entries.slice(firstHosted)) {
          fs.rmSync(path.join(dir, "drizzle/migrations", `${e.tag}.sql`), { force: true });
          fs.rmSync(path.join(dir, "drizzle/migrations/meta", `${String(e.idx).padStart(4, "0")}_snapshot.json`), { force: true });
          if (e.tag in registry) { removed.push([e.tag, registry[e.tag]]); delete registry[e.tag]; }
        }
        journal.entries = journal.entries.slice(0, firstHosted);
      }
      let when = journal.entries.at(-1).when;
      const tags: string[] = [];
      for (const form of transportForms()) {
        const idx = journal.entries.length;
        const tag = `${String(idx).padStart(4, "0")}_${form.name}`;
        if (tag in registry) throw new Error(`refuse to replace an existing registration: ${tag}`);
        fs.writeFileSync(path.join(dir, "drizzle/migrations", `${tag}.sql`), form.text);
        fs.copyFileSync(
          path.join(dir, "drizzle/migrations/meta", `${String(idx - 1).padStart(4, "0")}_snapshot.json`),
          path.join(dir, "drizzle/migrations/meta", `${String(idx).padStart(4, "0")}_snapshot.json`),
        );
        journal.entries.push({ idx, version: "7", when: (when += 1000), tag, breakpoints: true });
        if (register) { registry[tag] = { kind: "tb_staged_transport", sha256: form.hashes[0] }; added.push(tag); }
        tags.push(tag);
      }
      fs.writeFileSync(jf, JSON.stringify(journal, null, 2));
      run(dir, tags);
    } finally {
      for (const tag of added) delete registry[tag];
      for (const [tag, v] of removed) registry[tag] = v;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("accepts all three registered canonical mirrors, covers both TB sources and retains existing FS/payment coverage", () => {
    withMirrors((dir) => {
      const r = checkMigrationAuthority(dir);
      expect(r.errors).toEqual([]);
      expect(r.pending).toEqual(["20261122100000_tb_decision_catalogue_read_predicate.sql", "20261123100000_fs_server_compilation.sql", "20261124100000_fs_publication_integrity_gate.sql", "20261125100000_fs_final_authority.sql", "20261126100000_fs_document_structure.sql", "20261127100000_fs_track_a_authority_hardening.sql", "20261128100000_companies_framework_change_guard.sql", "20261201100000_assistant_controls.sql", "20261202100000_internal_beta_policy.sql", "20261203100000_internal_beta_admin_activation.sql", "20261204100000_internal_beta_team_bootstrap.sql", "20261205100000_fs_equipment_preparation.sql", "20261206100000_fs_equipment_multiclass.sql", "20261207100000_ipsas_accrual_preparation.sql", "20261208100000_ipsas_grants.sql", "20261210100000_ipsas_statement_review.sql", "20261211100000_source_access_authority_repairs.sql"]); // applied after the TB batches (track-a-r1 is authored, not applied); the simulation truncates the journal before them; the integrity gate is pending everywhere
      expect(r.mirrored.filter((m: { how: string }) => m.how === "tb_staged_transport").map((m: { source: string }) => m.source))
        .toEqual(BATCHES.map((b) => b.source));
      for (const b of FS_BATCHES) expect(r.mirrored.some((m: { source: string; how: string }) => m.source === b.source && m.how === "staged_transport")).toBe(true);
      expect(r.releaseApplied).toContainEqual({ tag: "0070_customer_checkout_abandon", source: "20261119100000_customer_checkout_abandon.sql" });
    });
  }, 120_000);

  it("refuses unregistered canonical-looking mirrors rather than silently trusting their names", () => {
    withMirrors((dir, tags) => {
      const r = checkMigrationAuthority(dir);
      expect(r.ok).toBe(false);
      for (const tag of tags) expect(r.errors.some((e: string) => e.includes(tag))).toBe(true);
    }, false);
  }, 120_000);

  it("refuses a modified mirror through checkMigrationAuthority itself", () => {
    withMirrors((dir, tags) => {
      fs.appendFileSync(path.join(dir, "drizzle/migrations", `${tags[1]}.sql`), "\n-- altered");
      const r = checkMigrationAuthority(dir);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e: string) => e.includes(tags[1]) && /reviewed content|registered/.test(e))).toBe(true);
    });
  }, 120_000);

  it("refuses a changed covered source even when the transport mirror and registration are untouched", () => {
    withMirrors((dir) => {
      fs.appendFileSync(path.join(dir, "supabase/migrations", BATCHES[1].source), "\n-- altered");
      const r = checkMigrationAuthority(dir);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e: string) => e.includes("covered TB source") && e.includes(BATCHES[1].source))).toBe(true);
    });
  }, 120_000);

  it("revokes only the three newly created helper signatures and starts the documented cutover with a hold", () => {
    const bootstrap = renderBootstrap();
    expect(bootstrap).not.toMatch(/ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA/i);
    for (const signature of [
      "cfoclose_tb_release.approved_artifact(text, text)",
      "cfoclose_tb_release.staged_artifacts_guard()",
      "cfoclose_tb_release.append_only_guard()",
    ]) {
      expect(bootstrap).toContain(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`);
      expect(bootstrap).toContain(`REVOKE EXECUTE ON FUNCTION ${signature} FROM %I`);
    }
    const doc = fs.readFileSync(path.join(ROOT, "docs/release/tb-workflow/README.md"), "utf8");
    expect(doc.indexOf("| 0 | **Hold processing")).toBeGreaterThan(-1);
    expect(doc.indexOf("| 0 | **Hold processing")).toBeLessThan(doc.indexOf("| 1 | Install"));
    expect(doc).toContain("p_hold => true, p_canary_company_ids => ARRAY[]::uuid[]");
    expect(doc).toContain("**Processing remains held.**");
  });
});
